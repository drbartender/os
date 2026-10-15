// The ONLY module that talks to Google for the Inbox email feed (the
// anthropicClient.js precedent, spec 2026-10-14 section 10). Raw fetch, no SDK:
// a service-account JWT signed with Node's own crypto is exchanged for an
// access token "as" the business mailbox (domain-wide delegation), then the
// Gmail REST API is called with it. Read-only scope; the feed never sends,
// labels or deletes mail.
//
// Hosts are pinned constants, no env var can redirect them. The private key
// never leaves this module and is never logged, not even its length. An error
// carries a class, an HTTP status and the stage that failed (token or api),
// never a response body: Google's error bodies can quote the request, and a
// Gmail body is someone's mail.
//
// Under NODE_ENV=test it refuses to build a real client unless a test injects
// a stub, so a missed mock can never reach Google.
//
// TREAT null AS A REAL RETURN VALUE: with GMAIL_SERVICE_ACCOUNT_KEY unset (the
// dev box, and production until Dallas sets the key) createGmailClient returns
// null and the caller does nothing.

const crypto = require('node:crypto');

// A code constant, never env (spec decision 2): a key under domain-wide
// delegation can read EVERY mailbox in the Workspace, so which one it reads
// must not be configurable.
const GMAIL_MAILBOX = 'contact@drbartender.com';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALL_TIMEOUT_MS = 20000;
const TOKEN_SKEW_S = 60;
const PARSE_FAIL = 'GMAIL_SERVICE_ACCOUNT_KEY does not parse';
const GMAIL_ID_RE = /^[A-Za-z0-9_-]+$/;

class GmailError extends Error {
  constructor(cls, status, stage) {
    super(cls);
    this.name = cls;
    this.class = cls;
    this.status = status;
    this.stage = stage;
  }
}

// The token endpoint answers a bad grant with 400 (invalid_grant: a revoked
// key, a wrong mailbox, a skewed clock) and missing delegation with 401
// (unauthorized_client); both are the key failing, so every token 4xx short of
// 429 is an auth error. On the Gmail API a 403 is also auth (the Gmail API not
// enabled on the Cloud project, or the scope not delegated). A 404 on one
// message is its own class: history can name a message that is gone by the
// time it is fetched (a draft autosave, a deletion), and the sync drops it
// rather than failing the whole window on it.
function errorFor(status, stage, path) {
  if (status === 429 || status >= 500) return new GmailError('GmailUnavailableError', status, stage);
  if (stage === 'token') return new GmailError('GmailAuthError', status, stage);
  if (status === 401 || status === 403) return new GmailError('GmailAuthError', status, stage);
  if (status === 404 && path.startsWith('/history')) return new GmailError('GmailHistoryGoneError', status, stage);
  if (status === 404 && path.startsWith('/messages/')) return new GmailError('GmailNotFoundError', status, stage);
  return new GmailError('GmailRequestError', status, stage);
}

// Free the socket without reading the body into anything.
function discard(res) {
  try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch { /* nothing to free */ }
}

function rawKey() { return String(process.env.GMAIL_SERVICE_ACCOUNT_KEY || '').trim(); }

// Returns { key, error }. The parse runs in a try and never surfaces the
// parser's own message, which on current Node quotes a fragment of the input.
function readKey() {
  const raw = rawKey();
  if (!raw) return { key: null, error: null };
  try {
    const json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!json || typeof json.client_email !== 'string' || typeof json.private_key !== 'string'
      || !json.client_email || !json.private_key) {
      return { key: null, error: PARSE_FAIL };
    }
    crypto.createPrivateKey(json.private_key); // a key that will not load fails here, not on the first call
    return { key: { clientEmail: json.client_email, privateKey: json.private_key }, error: null };
  } catch {
    return { key: null, error: PARSE_FAIL };
  }
}

function isConfigured() { return Boolean(readKey().key); }
function configurationError() { return readKey().error; }

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }

function signJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: key.clientEmail, sub: GMAIL_MAILBOX, scope: GMAIL_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.privateKey).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

function buildClient(key, fetch) {
  let token = null;
  let tokenExp = 0;
  let minting = null; // one token request in flight, shared by concurrent callers

  // Every failure in here leaves as a GmailError at the token stage, so a
  // network fault reaching the token host is never reported as the Gmail API.
  async function mintToken() {
    let assertion;
    try { assertion = signJwt(key); } catch { throw new GmailError('GmailAuthError', 0, 'token'); } // a key that will not sign
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    let res;
    let json;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!res.ok) { discard(res); throw errorFor(res.status, 'token', '/token'); }
      json = await res.json();
    } catch (err) {
      if (err instanceof GmailError) throw err;
      throw new GmailError('GmailUnavailableError', 0, 'token'); // network, timeout or a body that is not JSON; no message text
    }
    if (!json || typeof json.access_token !== 'string' || !json.access_token) throw new GmailError('GmailAuthError', res.status, 'token');
    const ttl = Number(json.expires_in);
    token = json.access_token;
    tokenExp = Date.now() / 1000 + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600);
    return token;
  }

  function accessToken() {
    if (token && Date.now() / 1000 < tokenExp - TOKEN_SKEW_S) return Promise.resolve(token);
    if (!minting) minting = mintToken().finally(() => { minting = null; });
    return minting;
  }

  async function call(path, params = {}) {
    try {
      const tok = await accessToken();
      const url = new URL(`${GMAIL_API}${path}`);
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        // Gmail takes a list (historyTypes) as a repeated parameter, never a comma list.
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) {
        discard(res);
        // A refused bearer is not reused: the next call mints a fresh token.
        // Only this call's own token is dropped, never a newer one.
        if (res.status === 401 && token === tok) { token = null; tokenExp = 0; }
        return { error: errorFor(res.status, 'api', path) };
      }
      return { data: await res.json() };
    } catch (err) {
      if (err instanceof GmailError) return { error: err };
      return { error: new GmailError('GmailUnavailableError', 0, 'api') }; // network, timeout or a body that is not JSON; no message text
    }
  }

  return {
    getProfile: () => call('/profile'),
    listLabels: () => call('/labels'),
    listMessages: ({ q, pageToken, maxResults = 100 } = {}) => call('/messages', { q, pageToken, maxResults, includeSpamTrash: false }),
    listHistory: ({ startHistoryId, historyTypes = ['messageAdded', 'labelAdded'], pageToken } = {}) => call('/history', { startHistoryId, historyTypes, pageToken }),
    // Gmail ids are url-safe tokens. Anything else is refused: an empty id, '.'
    // or '..' would reach the LIST endpoint (the URL parser collapses dot
    // segments) and hand back the wrong shape.
    getMessage: (id) => (typeof id === 'string' && GMAIL_ID_RE.test(id)
      ? call(`/messages/${id}`, { format: 'full' })
      : Promise.resolve({ error: new GmailError('GmailRequestError', 0, 'api') })),
  };
}

let injected = null;
let cached = null; // { raw, fetch, client }: one client per key, so the token is reused across ticks

function __setGmailClientForTests(stub) { injected = stub; }
function __resetGmailClient() { injected = null; cached = null; }

const defaultFetch = (...args) => globalThis.fetch(...args);

function createGmailClient({ fetch = defaultFetch } = {}) {
  if (injected) return injected;
  const { key } = readKey();
  if (!key) return null;
  if (process.env.NODE_ENV === 'test') {
    throw new Error('gmailClient refuses to build a real Gmail client under NODE_ENV=test; inject a stub');
  }
  const raw = rawKey();
  if (!cached || cached.raw !== raw || cached.fetch !== fetch) {
    cached = { raw, fetch, client: buildClient(key, fetch) };
  }
  return cached.client;
}

module.exports = {
  GMAIL_MAILBOX,
  GMAIL_SCOPE,
  GmailError,
  isConfigured,
  configurationError,
  createGmailClient,
  __setGmailClientForTests,
  __resetGmailClient,
};
