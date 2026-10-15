---
spec: docs/superpowers/specs/2026-10-14-inbox-email-zola-design.md   # including section 17 (fleet fold-ins and planning amendments)
lanes:
  - id: gmail-client
    footprint:
      - .claude/CLAUDE.md
      - .env.example
      - ARCHITECTURE.md
      - README.md
      - scripts/gmail-probe.js
      - scripts/sensitive-paths.txt
      - server/utils/gmailClient.js
      - server/utils/gmailClient.test.js
    blockedBy: []
    review: full-fleet   # a credential that can read every Workspace mailbox
  - id: email-feed
    footprint:
      - ARCHITECTURE.md
      - README.md
      - client/src/components/inbox/ContextViews.js
      - client/src/components/inbox/FeedsLine.js
      - client/src/components/inbox/ReplyBar.js
      - client/src/components/inbox/ReplyBar.test.js
      - client/src/components/inbox/Thread.js
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/inboxFormat.js
      - client/src/components/inbox/inboxFormat.test.js
      - client/src/components/inbox/inboxItemViews.test.js
      - client/src/components/inbox/inboxListViews.test.js
      - client/src/components/inbox/inboxThread.js
      - client/src/components/inbox/inboxThread.test.js
      - client/src/pages/website/legal/PrivacyPage.js
      - server/db/schema.sql
      - server/index.js
      - server/routes/admin/inbox.js
      - server/routes/admin/inbox.test.js
      - server/utils/inbox/aliases.js
      - server/utils/inbox/aliases.test.js
      - server/utils/inbox/classify.js
      - server/utils/inbox/constants.js
      - server/utils/inbox/context.js
      - server/utils/inbox/contextFormat.js
      - server/utils/inbox/details.js
      - server/utils/inbox/engine.js
      - server/utils/inbox/engine.test.js
      - server/utils/inbox/feeds.js
      - server/utils/inbox/gmailSync.js
      - server/utils/inbox/gmailSync.test.js
      - server/utils/inbox/mailText.js
      - server/utils/inbox/mailText.test.js
      - server/utils/inbox/payload.js
      - server/utils/inbox/payload.test.js
      - server/utils/inbox/people.js
      - server/utils/inbox/people.test.js
      - server/utils/inbox/personKey.js
      - server/utils/inbox/personKey.test.js
      - server/utils/inbox/readGmail.js
      - server/utils/inbox/readZola.js
      - server/utils/inbox/readers.test.js
      - server/utils/inbox/reasons.js
      - server/utils/inbox/reply.js
      - server/utils/inbox/replyRules.js
      - server/utils/inbox/replyRules.test.js
      - server/utils/inbox/rules.js
      - server/utils/inbox/rules.events.test.js
      - server/utils/inbox/rules.replies.test.js
      - server/utils/inbox/rules.states.test.js
      - server/utils/inbox/rules.testkit.js
      - server/utils/inbox/subjects.js
      - server/utils/inbox/subjects.test.js
      - server/utils/inbox/thread.js
      - server/utils/inbox/thread.test.js
      - server/utils/inbox/zolaLeads.js
      - server/utils/inbox/zolaLeads.test.js
    blockedBy: [gmail-client]
    review: full-fleet   # server/utils/inbox/** and schema.sql are sensitive; stores message text; viewer filter
  - id: zola-leads
    footprint:
      - ARCHITECTURE.md
      - server/utils/inbox/constants.js
      - server/utils/inbox/context.js
      - server/utils/inbox/contextFormat.js
      - server/utils/inbox/gmailSync.js
      - server/utils/inbox/gmailSync.test.js
      - server/utils/inbox/reply.js
      - server/utils/inbox/zolaLeads.js
      - server/utils/inbox/zolaLeads.test.js
      - server/utils/inbox/zolaMail.js
      - server/utils/inbox/zolaMail.test.js
    blockedBy: [email-feed]
    review: full-fleet   # creates client rows from parsed third-party mail
  - id: email-ai
    footprint:
      - .claude/CLAUDE.md
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/inboxListViews.test.js
      - server/utils/inbox/aiRead.js
      - server/utils/inbox/aiRead.test.js
      - server/utils/inbox/classify.js
      - server/utils/inbox/payload.js
      - server/utils/inbox/payload.test.js
      - server/utils/inbox/readJob.js
      - server/utils/inbox/readJob.test.js
      - server/utils/inbox/rules.js
      - server/utils/inbox/rules.states.test.js
      - server/utils/inbox/subjects.js
      - server/utils/inbox/subjects.test.js
    blockedBy: [email-feed]
    review: full-fleet   # the paid external API that receives message text
  - id: zola-draft
    footprint:
      - ARCHITECTURE.md
      - client/src/components/admin/SourceBadge.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/overview/FunnelCard.js
      - scripts/sensitive-paths.txt
      - server/db/schema.sql
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/lifecycle.js
      - server/routes/proposals/lifecycle.sendGuard.test.js
      - server/routes/proposals/list.js
      - server/routes/proposals/metadata.js
      - server/utils/inbox/gmailSync.js
      - server/utils/inbox/zolaLeads.js
      - server/utils/zolaProposalDraft.js
      - server/utils/zolaProposalDraft.test.js
    blockedBy: [zola-leads]
    review: full-fleet   # proposal rows and the Send path
---

# Inbox piece 3: email and Zola, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email in the business mailbox and Zola's notices become Inbox items on the same person as their texts, a reply from Gmail closes them, and the AI read judges email with a pitch flag and a personal-mail check.

**Architecture:** A 60-second `gmail_sync` scheduler reads the mailbox through a raw-fetch Gmail client under a service account, applies the counting rules at sync time, and writes `gmail_messages`; two readers (`readGmail.js`, `readZola.js`) map those rows into the engine's event shape, where identity resolves at read time (`people.js`), replies close by `classify.countsAsReply`, and the page gets captions, chips and a viewer filter. Zola notices create lead rows, clients and draft proposals through the Thumbtack precedents.

**Tech Stack:** Node 26 (`fetch`, `crypto.sign`), Express, raw SQL on Neon Postgres, `node --test`, React 18 (CRA), the existing Anthropic read job. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-14-inbox-email-zola-design.md` (read sections 3, 5, 6, 7 and 17 before any task).

## Global Constraints

- The repo is public: no real person's name, email address, phone number or message text in code, tests, fixtures, commits or docs. Fixtures use invented couples ("Alex B & Sam C"), addresses at `example.com`, numbers `555-01xx`.
- The only addresses in code are the business mailbox constant, its aliases, and Zola's vendor address (system senders). The older Gmail address of the business goes in Render's `INBOX_OWN_EMAILS`, never in the repo.
- Dev box: run nothing that reaches a provider. The suites stub the Gmail client; `scripts/gmail-probe.js` is the one Gmail call allowed from the dev box, run by Dallas with the key in that command's environment only.
- Dev DB is shared: read-only beyond the suites' own rows, one suite at a time (`node --test <file>`), no TEMP tables, read the pass count.
- No em dashes in copy or docs. API JSON snake_case, JS camelCase. Errors are `AppError` subclasses. Parameterized SQL only. Schema changes idempotent, enumerated CHECKs as drop-and-re-add DO blocks.
- Every lane: full fleet before merge; `npm run check:filesize`; files under 700 lines (split before 1000).
- Lanes are cut with `npm run worktree:new <lane-id>` under `../worktrees/`, built there, squash-merged from `os` by `scripts/merge-lane.sh`, never pushed without Dallas's own imperative cue.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise; each line's test is pinned to the task named.
1. A Sent mail whose To is a client's Reply-To relay while the stored inbound came from their real address: it must still answer the client (Task 9 test `outbound resolves by the inbound it answers before recipients`).
2. A Zola message notice stored AFTER the Gmail reply that answered it (backfill order): the reply must still close the lead (Task 9 test `zola join works in both storage orders`).
3. An inbound from a client whose stored email differs only in case from the From header: it must resolve to the client (Task 7 test `resolveEmail ignores case`).
4. A message notice from Zola's vendor address that fails DKIM: it must create nothing (Task 14 test `gate refuses dkim fail`).
5. A mail addressed to dallas@ AND contact@ from an unknown sender: it is business, not personal, and every admin sees it (Task 10 test `isPersonal false when another alias is in copy`).

---

## Lane gmail-client

### Task 1: The Gmail client

**Files:**
- Create: `server/utils/gmailClient.js`
- Test: `server/utils/gmailClient.test.js`

**Interfaces:**
- Produces: `isConfigured()`, `createGmailClient({ fetch } = {})` returning `null` or a client with `getProfile()`, `listMessages({ q, pageToken })`, `listHistory({ startHistoryId, historyTypes, pageToken })`, `getMessage(id)`, `listLabels()`; each resolves `{ data }` or `{ error }` where `error` is one of `GmailAuthError` (401, 403), `GmailHistoryGoneError` (404 on history), `GmailUnavailableError` (429, 5xx, timeout), `GmailRequestError` (anything else), each with `.status` and `.class`. Exports `GMAIL_MAILBOX` (the business address), `GMAIL_SCOPE`, `__setGmailClientForTests(stub)`, `__resetGmailClient()`.

- [ ] **Step 1: Write the failing tests**

```js
// server/utils/gmailClient.test.js
require('dotenv').config();
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const gc = require('./gmailClient');

function fakeKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return Buffer.from(JSON.stringify({ client_email: 'feed@example.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' })).toString('base64');
}
const saved = {};
beforeEach(() => { saved.key = process.env.GMAIL_SERVICE_ACCOUNT_KEY; saved.env = process.env.NODE_ENV; gc.__resetGmailClient(); });
afterEach(() => { process.env.GMAIL_SERVICE_ACCOUNT_KEY = saved.key; process.env.NODE_ENV = saved.env; gc.__resetGmailClient(); });

test('unconfigured: isConfigured false and createGmailClient null', () => {
  delete process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.createGmailClient(), null);
});
test('a key that does not parse is reported with a fixed message, never a fragment', () => {
  process.env.GMAIL_SERVICE_ACCOUNT_KEY = Buffer.from('{"client_email": "x@example.com", "private_key": ').toString('base64');
  assert.equal(gc.isConfigured(), false);
  assert.equal(gc.configurationError(), 'GMAIL_SERVICE_ACCOUNT_KEY does not parse');
});
test('under NODE_ENV=test it refuses to build a real client', () => {
  process.env.NODE_ENV = 'test'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  assert.throws(() => gc.createGmailClient(), /refuses to build a real Gmail client under NODE_ENV=test/);
});
test('token request carries sub, scope and aud, and calls only the pinned hosts', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ emailAddress: 'mailbox@example.com', historyId: '42' }), { status: 200 });
  };
  const client = gc.createGmailClient({ fetch });
  const { data } = await client.getProfile();
  assert.equal(data.historyId, '42');
  const body = new URLSearchParams(calls[0].init.body);
  const [, payload] = body.get('assertion').split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.sub, gc.GMAIL_MAILBOX);
  assert.equal(claims.scope, gc.GMAIL_SCOPE);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(calls[1].url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile'));
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
});
test('errors map by status and carry no body', async () => {
  process.env.NODE_ENV = 'development'; process.env.GMAIL_SERVICE_ACCOUNT_KEY = fakeKey();
  let n = 0;
  const fetch = async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    n += 1;
    return new Response('{"error":{"message":"SECRET BODY"}}', { status: [401, 404, 503][n - 1] });
  };
  const client = gc.createGmailClient({ fetch });
  const a = await client.getProfile(); assert.equal(a.error.class, 'GmailAuthError');
  const b = await client.listHistory({ startHistoryId: '1' }); assert.equal(b.error.class, 'GmailHistoryGoneError');
  const c = await client.getProfile(); assert.equal(c.error.class, 'GmailUnavailableError');
  assert.ok(!JSON.stringify([a, b, c]).includes('SECRET BODY'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/utils/gmailClient.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the client**

```js
// server/utils/gmailClient.js
// The ONLY module that talks to Google for the Inbox feed (the anthropicClient.js
// precedent). Raw fetch, no SDK: a signed JWT exchanged for an access token "as"
// the business mailbox, then Gmail REST. Hosts are pinned; the key never leaves
// this module and is never logged.
const crypto = require('node:crypto');

const GMAIL_MAILBOX = 'contact@drbartender.com'; // a code constant, not env (spec decision 2: blast radius)
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALL_TIMEOUT_MS = 20000;
const TOKEN_SKEW_S = 60;
const PARSE_FAIL = 'GMAIL_SERVICE_ACCOUNT_KEY does not parse';

class GmailError extends Error { constructor(cls, status) { super(cls); this.class = cls; this.status = status; } }
function errorFor(status, path) {
  if (status === 401 || status === 403) return new GmailError('GmailAuthError', status);
  if (status === 404 && path.includes('/history')) return new GmailError('GmailHistoryGoneError', status);
  if (status === 429 || status >= 500) return new GmailError('GmailUnavailableError', status);
  return new GmailError('GmailRequestError', status);
}

let parsed = null; let parseError = null;
function readKey() {
  const raw = String(process.env.GMAIL_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) { parsed = null; parseError = null; return null; }
  try {
    const json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!json.client_email || !json.private_key) throw new Error('shape');
    parsed = { clientEmail: json.client_email, privateKey: json.private_key }; parseError = null;
  } catch (_) { parsed = null; parseError = PARSE_FAIL; } // never the parser's own message
  return parsed;
}
function isConfigured() { return Boolean(readKey()); }
function configurationError() { readKey(); return parseError; }

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function signJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: key.clientEmail, sub: GMAIL_MAILBOX, scope: GMAIL_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.privateKey).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

let injected = null;
function __setGmailClientForTests(stub) { injected = stub; }
function __resetGmailClient() { injected = null; parsed = null; parseError = null; }

function createGmailClient({ fetch = (...a) => globalThis.fetch(...a) } = {}) {
  if (injected) return injected;
  const key = readKey();
  if (!key) return null;
  if (process.env.NODE_ENV === 'test') throw new Error('gmailClient refuses to build a real Gmail client under NODE_ENV=test; inject a stub');
  let token = null; let tokenExp = 0;
  async function accessToken() {
    if (token && Date.now() / 1000 < tokenExp - TOKEN_SKEW_S) return token;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(key) });
    const res = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) throw errorFor(res.status, '/token');
    const json = await res.json();
    token = json.access_token; tokenExp = Date.now() / 1000 + Number(json.expires_in || 3600);
    return token;
  }
  async function call(path, params = {}) {
    try {
      const tok = await accessToken();
      const url = new URL(`${GMAIL_API}${path}`);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) return { error: errorFor(res.status, path) };
      return { data: await res.json() };
    } catch (err) {
      if (err instanceof GmailError) return { error: err };
      return { error: new GmailError('GmailUnavailableError', 0) }; // network or timeout; no message text
    }
  }
  return {
    getProfile: () => call('/profile'),
    listLabels: () => call('/labels'),
    listMessages: ({ q, pageToken, maxResults = 100 } = {}) => call('/messages', { q, pageToken, maxResults, includeSpamTrash: false }),
    listHistory: ({ startHistoryId, historyTypes = 'messageAdded,labelAdded', pageToken } = {}) => call('/history', { startHistoryId, historyTypes, pageToken, labelId: undefined }),
    getMessage: (id) => call(`/messages/${encodeURIComponent(id)}`, { format: 'full' }),
  };
}

module.exports = { GMAIL_MAILBOX, GMAIL_SCOPE, isConfigured, configurationError, createGmailClient, GmailError, __setGmailClientForTests, __resetGmailClient };
```

Note: `listHistory` passes `historyTypes` as a repeated query parameter in Gmail's API; set it as two `searchParams.append('historyTypes', …)` calls, one per type, not a comma list. Adjust `call` to accept an array value by appending each element.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test server/utils/gmailClient.test.js`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/gmailClient.js server/utils/gmailClient.test.js
git commit -m "feat(inbox): Gmail client for the mailbox feed, raw fetch under a service account"
```

### Task 2: The probe

**Files:**
- Create: `scripts/gmail-probe.js`

**Interfaces:** Consumes Task 1's `createGmailClient`. Prints three lines and exits 0, or one error class and exits 1.

- [ ] **Step 1: Write the probe**

```js
#!/usr/bin/env node
// One-shot smoke of the Gmail feed key (spec section 10). Run with the key in
// THIS command's environment only:
//   GMAIL_SERVICE_ACCOUNT_KEY=<base64 json> node scripts/gmail-probe.js
// Prints the address the key authenticates as, the label count, and whether
// the Primary category label exists. Prints nothing else. Exit 1 on any error.
const gc = require('../server/utils/gmailClient');
(async () => {
  if (!gc.isConfigured()) { console.error(gc.configurationError() || 'GMAIL_SERVICE_ACCOUNT_KEY unset'); process.exit(1); }
  const client = gc.createGmailClient();
  const p = await client.getProfile();
  if (p.error) { console.error(`profile: ${p.error.class} ${p.error.status}`); process.exit(1); }
  const l = await client.listLabels();
  if (l.error) { console.error(`labels: ${l.error.class} ${l.error.status}`); process.exit(1); }
  const labels = (l.data.labels || []).map((x) => x.id);
  console.log(`authenticated as: ${p.data.emailAddress}`);
  console.log(`labels: ${labels.length}`);
  console.log(`CATEGORY_PERSONAL present: ${labels.includes('CATEGORY_PERSONAL') ? 'yes' : 'NO'}`);
})();
```

- [ ] **Step 2: Syntax-check it (no key on the dev box)**

Run: `node --check scripts/gmail-probe.js && node scripts/gmail-probe.js; echo "exit $?"`
Expected: `GMAIL_SERVICE_ACCOUNT_KEY unset` and `exit 1`.

- [ ] **Step 3: Commit**

```bash
git add scripts/gmail-probe.js
git commit -m "chore(inbox): gmail-probe, the one allowed Gmail call from the dev box"
```

### Task 3: Env, docs, sensitive list

**Files:**
- Modify: `.env.example` (after the `ANTHROPIC_API_KEY` block), `.claude/CLAUDE.md` (Environment Variables table and the Tech Stack list), `README.md` (env table, folder tree under `server/utils/` and `scripts/`), `ARCHITECTURE.md` (Third-Party Integrations), `scripts/sensitive-paths.txt`.

- [ ] **Step 1: Add the rows**

`.env.example`:
```
# Inbox email feed (spec 2026-10-14). Base64 of the service account's JSON key.
# Unset = the Gmail feed is off. Smoke a new key with scripts/gmail-probe.js first.
GMAIL_SERVICE_ACCOUNT_KEY=
# Optional comma list of extra addresses that are "us" and never form an item.
INBOX_OWN_EMAILS=
# Optional. false disables the 60-second Gmail sync. Default on.
RUN_GMAIL_SYNC_SCHEDULER=
```

CLAUDE.md rows (copy the spec's section 13 table rows verbatim, including the BLAST RADIUS sentence and the leak response). Tech Stack: "**Email feed (Inbox)**: the Gmail API, read-only, through `server/utils/gmailClient.js` (raw fetch under a service account with domain-wide delegation; the mailbox is a code constant). The feed reads the business mailbox and never sends."

`scripts/sensitive-paths.txt`, under the Inbox block:
```
# The Gmail feed's credentialed client (spec 2026-10-14): a key that can read
# every Workspace mailbox. The probe is the only dev-box call allowed.
server/utils/gmailClient.js
scripts/gmail-probe.js
```

- [ ] **Step 2: Verify the match and commit**

Run: `node scripts/sensitive-match.js server/utils/gmailClient.js scripts/gmail-probe.js`
Expected: both listed as sensitive.

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md scripts/sensitive-paths.txt
git commit -m "docs(inbox): Gmail feed env rows, integration line, sensitive list"
```

---

## Lane email-feed

### Task 4: Schema

**Files:**
- Modify: `server/db/schema.sql` (append after the `inbox_sends` block; the reads column with the other `inbox_reads` statements)

- [ ] **Step 1: Add the tables**

Paste the spec's section 7 SQL verbatim: `zola_leads` first (with its two indexes), then `gmail_messages` (five indexes), `gmail_sync_state`, `gmail_sync_skips`, then `ALTER TABLE inbox_reads ADD COLUMN IF NOT EXISTS solicitation BOOLEAN;`. Add the drop-and-re-add DO blocks for `gmail_messages_direction_check` and `gmail_messages_kind_check`, the `inbox_reads` pattern:

```sql
DO $$ BEGIN
  ALTER TABLE gmail_messages DROP CONSTRAINT IF EXISTS gmail_messages_kind_check;
  ALTER TABLE gmail_messages ADD CONSTRAINT gmail_messages_kind_check
    CHECK (kind IN ('message','auto_reply','bounce','zola_inquiry','zola_message','zola_closed','zola_unparsed'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply to the dev DB and verify**

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); const fs=require('fs'); pool.query(fs.readFileSync('server/db/schema.sql','utf8')).then(()=>pool.query(\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('gmail_messages','zola_leads','gmail_sync_state','gmail_sync_skips')\")).then(r=>{console.log(r.rows.map(x=>x.table_name).sort().join(','));process.exit(0)})"`
Expected: `gmail_messages,gmail_sync_skips,gmail_sync_state,zola_leads`. (This is how the project applies schema to dev; it is idempotent.)

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "schema(inbox): gmail_messages, zola_leads, gmail_sync_state, gmail_sync_skips, inbox_reads.solicitation"
```

### Task 5: Mail text extraction

**Files:**
- Create: `server/utils/inbox/mailText.js`
- Test: `server/utils/inbox/mailText.test.js`

**Interfaces:**
- Produces: `extractText(payload) -> { text: string|null, attachments: number, hasCalendarOnly: boolean }` where `payload` is Gmail's `message.payload` (parts with `mimeType`, `filename`, `headers`, `body.data` base64url); `stripQuotes(text) -> string`; `stripSignature(text) -> string`; `htmlToText(html) -> string`; `MAIL_TEXT_MAX = 20000`.

- [ ] **Step 1: Write the failing tests** (invented bodies only)

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractText, stripQuotes, stripSignature, htmlToText, MAIL_TEXT_MAX } = require('./mailText');
const b64 = (s) => Buffer.from(s).toString('base64url');
const plain = (s) => ({ mimeType: 'text/plain', body: { data: b64(s) } });

test('plain part wins over html', () => {
  const r = extractText({ mimeType: 'multipart/alternative', parts: [plain('Hi, can we add a mocktail station?'), { mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } }] });
  assert.equal(r.text, 'Hi, can we add a mocktail station?');
});
test('html only is converted, blockquote dropped', () => {
  const r = extractText({ mimeType: 'text/html', body: { data: b64('<div>Yes please<br>thanks</div><blockquote>old stuff</blockquote>') } });
  assert.equal(r.text, 'Yes please\nthanks');
});
test('gmail, apple and outlook quote headers are cut', () => {
  assert.equal(stripQuotes('Sounds good.\n\nOn Mon, Oct 5, 2026 at 3:12 PM Someone <a@example.com> wrote:\n> old'), 'Sounds good.');
  assert.equal(stripQuotes('Yes\n\nFrom: Someone\nSent: Monday\nTo: us\nSubject: Re: x\n\nold'), 'Yes');
  assert.equal(stripQuotes('Ok\n-----Original Message-----\nold'), 'Ok');
  assert.equal(stripQuotes('Ok\n> quoted\n> lines'), 'Ok');
});
test('signatures are cut: -- line, device line, trailing contact block', () => {
  assert.equal(stripSignature('See you then\n-- \nPat\n555-0100'), 'See you then');
  assert.equal(stripSignature('See you then\n\nSent from my phone'), 'See you then');
  assert.equal(stripSignature('See you then\n\nPat Example\nEvents Lead\npat@example.com\nwww.example.com'), 'See you then');
});
test('an empty strip falls back to the original minus quotes', () => {
  const r = extractText({ mimeType: 'text/plain', body: { data: b64('-- \nPat\n555-0100\n\nOn Mon Someone wrote:\n> q') } });
  assert.equal(r.text, '-- \nPat\n555-0100');
});
test('cap, attachments, calendar-only', () => {
  const long = 'x'.repeat(MAIL_TEXT_MAX + 5);
  assert.equal(extractText({ mimeType: 'text/plain', body: { data: b64(long) } }).text.length, MAIL_TEXT_MAX);
  const r = extractText({ mimeType: 'multipart/mixed', parts: [plain('see attached'), { mimeType: 'application/pdf', filename: 'doc.pdf', body: {} }, { mimeType: 'image/png', filename: 'a.png', headers: [{ name: 'Content-Disposition', value: 'inline' }], body: {} }] });
  assert.equal(r.attachments, 2);
  const c = extractText({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/calendar', filename: 'invite.ics', body: { data: b64('BEGIN:VCALENDAR') } }] });
  assert.equal(c.hasCalendarOnly, true); assert.equal(c.text, null);
});
```

- [ ] **Step 2: Run to verify it fails.** `node --test server/utils/inbox/mailText.test.js` fails: module not found.

- [ ] **Step 3: Implement**

Rules to encode (spec 5.7): walk parts depth-first; collect the first `text/plain` and the first `text/html` body that are not attachments (no filename, no `Content-Disposition: attachment`); `attachments` counts parts with a filename or an attachment disposition; `hasCalendarOnly` is true when every non-multipart part is `text/calendar`. `htmlToText`: drop `<style>`, `<script>`, `<blockquote …>…</blockquote>` (non-greedy, repeated), turn `<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, `</h\d>` into `\n`, strip tags, decode `&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric entities, collapse runs of blank lines to one, trim each line. `stripQuotes`: cut at the first line matching `/^On .{3,120} wrote:\s*$/m` (allow the line to wrap: also `/^On .{3,120}\n.{0,80} wrote:/m`), `/^-----Original Message-----/m`, `/^From: .+\n(Sent|Date): .+/m`, and a trailing run of lines starting with `>` (plus the blank line before). `stripSignature`: cut at `/^-- $/m`, at `/^Sent from my .+$/m`, and at a trailing block of at most 6 lines each under 60 chars that contains an email address, a URL (`www.` or `http`) or a digit run of 7+ (the redactor's phone shape). Fallback: if the result is empty and the input had words, return the quote-stripped input unsignatured. Cap at `MAIL_TEXT_MAX`.

- [ ] **Step 4: Run to verify it passes.** Expected: 6 pass.

- [ ] **Step 5: Commit.** `git add server/utils/inbox/mailText.js server/utils/inbox/mailText.test.js && git commit -m "feat(inbox): mail text extraction, quotes and signatures cut"`

### Task 6: Keys and constants

**Files:**
- Modify: `server/utils/inbox/personKey.js`, `server/utils/inbox/personKey.test.js`, `server/utils/inbox/constants.js`, `client/src/components/inbox/inboxFormat.js:26-32`, `client/src/components/inbox/inboxFormat.test.js:14-19`

**Interfaces:**
- Produces: `parsePersonKey` accepts `e-[0-9a-f]{16}` (type `e`) and `z-<canonical int4>` (type `z`); `personKey('e', hex)`, `personKey('z', id)`; constants `PERSONAL_ALIAS`, `PERSONAL_MAILBOX_OWNER_USER_ID = 1`, `ZOLA_VENDOR_ADDRESS = 'weddingvendors@zola.com'`, `ZOLA_RELAY_DOMAIN = 'vmkt-message.zola.com'`, `ZOLA_UNREAD_TEXT = "Zola sent something the OS couldn't read. Open Zola."`, `EMAIL_LINE_MAX = 4000`, `EMAIL_PRECLIP_MAX = 8000`, `GMAIL_SYNC_MAX_PER_TICK = 50`, `GMAIL_SYNC_TICK_MS = 40000`, `GMAIL_LEASE_SECONDS = 120`, `GMAIL_SKIP_ATTEMPTS = 3`, `ZOLA_CLIENT_DAILY_CAP = 20`, `DROPPED_SENDER_DOMAINS` (ReadonlySet: `thumbtack.com`, `cal.com`, `stripe.com`, `twilio.com`, `sentry.io`, `render.com`, `vercel.com`, `google.com`, `accounts.google.com`), `NO_REPLY_LOCAL_RE`, `AUTO_REPLY_SUBJECT_RE`, `zolaLeadUrl(uuid)`, `ZOLA_DASHBOARD_URL`, `gmailThreadUrl(threadId)`.

- [ ] **Step 1: Tests.** In `personKey.test.js` add: `e-` with 16 lowercase hex parses to `{ type: 'e', id }`; 15 or 17 hex, uppercase, or a non-hex char returns null; `z-7` parses, `z-07` and `z-2147483648` return null; `personKey('e', hex)` round-trips. In `inboxFormat.test.js` add the same four accepted keys to the true list and `e-ABCDEF0123456789` plus `z-07` to the false list.

- [ ] **Step 2: Run both** (`node --test server/utils/inbox/personKey.test.js`; `cd client && CI=true npx react-scripts test --watchAll=false src/components/inbox/inboxFormat.test.js`) and see the new cases fail.

- [ ] **Step 3: Implement.** `personKey.js`: `const EMAIL_KEY_RE = /^e-([0-9a-f]{16})$/; const ZOLA_KEY_RE = /^z-(\d{1,10})$/;` with the canonical-int4 test reused for `z`. `inboxFormat.js`: `ROW_KEY = /^[csz]-(0|[1-9]\d{0,9})$/` and `OTHER_KEY = /^(?:p-\d{10}|t-[0-9A-Za-z_-]{1,100}|e-[0-9a-f]{16})$/`. Constants as listed; `NO_REPLY_LOCAL_RE = /^(no[-.]?reply|do[-.]?not[-.]?reply|notifications?|mailer[-.]?daemon|postmaster|alerts|newsletter)$/i`; `AUTO_REPLY_SUBJECT_RE = /^(re:\s*)?(automatic reply|auto[- ]?reply|auto[- ]?response|out of (the )?office)\b/i`; `PERSONAL_ALIAS = 'dallas@drbartender.com'`.

- [ ] **Step 4: Run both suites green. Step 5: Commit** `feat(inbox): e- and z- person keys, feed constants`.

### Task 7: People index for email and Zola

**Files:**
- Modify: `server/utils/inbox/people.js`, `server/utils/inbox/people.test.js`, `server/utils/inbox/aliases.js`, `server/utils/inbox/aliases.test.js`

**Interfaces:**
- Produces on the index: `ownEmails: Set<string>`, `resolveEmail(address) -> key|null` (null for our own), `emailHash(address) -> 16 hex`, `keyByEmailHash: Map<e-key, c-|s- key>`, `zolaLeadsById: Map<number, lead>`, `zolaKey(lead) -> 'c-<id>' | 'z-<id>'`, `leadNameOf(address) -> string|null` (from `email_leads`). `PEOPLE_STAFF_SQL` and `PEOPLE_OPERATORS_SQL` select `u.email`; `PEOPLE_CLIENTS_SQL` selects `email`; new `PEOPLE_ZOLA_LEADS_SQL = 'SELECT id, lead_uuid, couple_label, wedding_date, client_id, closed_at FROM zola_leads'` and `PEOPLE_EMAIL_LEADS_SQL = 'SELECT id, name, email FROM email_leads'`. `buildPeopleIndex` takes `zolaLeads` and `emailLeads` arrays and `env.INBOX_OWN_EMAILS`.
- `aliases.currentKeyOf`: rule 6 (`e-` through `keyByEmailHash`), rule 7 (`z-` through `zolaLeadsById[...].client_id`).

- [ ] **Step 1: Tests** (`people.test.js`, pure over `buildPeopleIndex`):
  - own: the mailbox, `PERSONAL_ALIAS`, `FROM_EMAIL`'s no-reply address, `ADMIN_EMAIL`, each address in `INBOX_OWN_EMAILS`, every operator's `users.email`, Zola's vendor address all resolve to null; a staffer whose `users.email` is on the business domain resolves to `s-<id>`.
  - `resolveEmail ignores case` (Review Focus 3): client stored as `Pat@Example.com`, lookup `pat@example.com` gives `c-<id>`.
  - client before staff when both hold the address; newest client first when two clients share one lowercased address.
  - unknown gives `e-` + `emailHash`; the hash is 16 lowercase hex, stable, and does not contain the address.
  - `keyByEmailHash` maps every client and staff address hash to its key.
  - `zolaKey`: linked lead gives `c-`, unlinked gives `z-`.
  - `aliases.test.js`: an `e-` key whose address is now a client's moves to `c-`; a `z-` key whose lead gained a client moves to `c-`; a key with events stays.

- [ ] **Step 2: Run, see failures. Step 3: Implement** (`emailHash = (a) => crypto.createHash('sha256').update(norm(a)).digest('hex').slice(0, 16)`, `norm = (a) => String(a || '').trim().toLowerCase()`; own set built from `GMAIL_MAILBOX`, `PERSONAL_ALIAS`, `process.env.FROM_EMAIL || 'no-reply@drbartender.com'` as `server/utils/email.js` resolves it (require its `FROM_EMAIL` export; add the export if missing), `env.ADMIN_EMAIL`, `env.INBOX_OWN_EMAILS` split on commas, operators' emails, `ZOLA_VENDOR_ADDRESS`). **Step 4: green. Step 5: Commit** `feat(inbox): email identity in the people index, e- and z- alias folding`.

### Task 8: Zola lead rows (the minimal writer) and the sync job

**Files:**
- Create: `server/utils/inbox/zolaLeads.js`, `server/utils/inbox/zolaLeads.test.js`, `server/utils/inbox/gmailSync.js`, `server/utils/inbox/gmailSync.test.js`

**Interfaces:**
- `zolaLeads.js` produces: `labelKey(label) -> string` (trim, collapse whitespace, case-fold, cut at 120), `findOrCreateLead(db, { label, leadUuid, weddingDate, nowChicagoYmd }) -> { id, created }` (by uuid, then by open label, else insert; fills a missing uuid on a label match; a label with a DIFFERENT uuid than the row's makes a new row), `markClosed(db, id)`. Lane 3 adds client creation and the cap here.
- `gmailSync.js` produces: `makeGmailSyncTick({ client, db, now } = {}) -> async () => summary`, where `summary = { stored, dropped, unparsed, skipped, failed }`; pure helpers `classifyMessage(msg, index, env) -> { action: 'drop'|'store', kind, reason }`, `headersOf(payload) -> Map<lowercase name, value>`, `recipientsOf(headers) -> string[]` (To, Cc, Bcc, lowercased), `isBulk(headers, labelIds)`, `isAutoReply(headers, subject, hasCalendarOnly)`, `isBounce(headers, payload)`, `zolaAuthPasses(headers)`; `GMAIL_FEED_STATUS` reader for feeds.

- [ ] **Step 1: zolaLeads tests** (against the dev DB, cleaning its own rows by a `couple_label` prefix `zz-test-`): find by uuid; find by open label; create; uuid filled on label match; same label with a different uuid makes a second row; closed rows are not matched by label; `labelKey` collapses spacing and case.

- [ ] **Step 2: gmailSync tests** (pure helpers with a fake message shape; the tick with an injected `client` stub and an injected `db` that records queries, the `readJob.test.js` style):
  - lease: claimed when free, refused when another owner holds an unexpired lease, claimed when expired.
  - first sync reads the profile's `historyId` before listing, stores `backfill_page`, processes a page's ids oldest first, sets `backfill_done` after the last page.
  - steady state: `history.list` ids processed; `labelAdded` with `CATEGORY_PERSONAL` re-evaluates; `GmailHistoryGoneError` triggers the dated resync (`q=after:<last_ok_at minus 1 day>`).
  - `classifyMessage` in order: DRAFT/SPAM/TRASH dropped; Zola address goes to the Zola branch before the own-address rule; Sent to only our own addresses dropped; Sent to a dropped domain dropped; inbound from own dropped; inbound from a dropped domain dropped; bounce naming a stored Sent row stored as `bounce` and the Sent row marked failed; auto-reply by header, by subject, and a Sent calendar-only row; known client counts regardless of category; a reply to our Sent row counts regardless of category; unknown in Primary without bulk headers counts; unknown in Updates dropped; `List-Unsubscribe` dropped; no-reply local part dropped.
  - the insert gate: a re-processed id whose insert returned no row runs no side effect.
  - a failing message is recorded in `gmail_sync_skips` with attempts 1, then 2, then skipped at 3 with one Sentry capture, and the window still advances.
  - bounds: at most 50 messages and 40 s per tick; `cache.invalidate` called once per tick.
  - the summary line and `last_error` hold an error class, never a body or address.

- [ ] **Step 3: Implement zolaLeads.js and gmailSync.js.** Tick skeleton:

```js
async function tick() {
  const client = deps.client || createGmailClient();
  if (!client) return null;                                   // feed off
  const lease = await claimLease(db, owner);                  // one UPDATE ... RETURNING
  if (!lease) return null;
  const started = Date.now(); let done = 0; const sum = { stored: 0, dropped: 0, unparsed: 0, skipped: 0, failed: 0 };
  try {
    const index = await loadPeopleIndex(db);
    const ids = lease.backfill_done ? await historyIds(client, lease) : await backfillIds(client, lease, db);
    for (const id of ids.items) {
      if (done >= GMAIL_SYNC_MAX_PER_TICK || Date.now() - started > GMAIL_SYNC_TICK_MS) break;
      await processOne(client, db, index, id, sum);            // its own transaction; records skips
      done += 1;
    }
    if (ids.complete) await advanceCursor(db, ids);           // history id or next backfill page
    await db.query('UPDATE gmail_sync_state SET last_ok_at = NOW(), consecutive_errors = 0, updated_at = NOW() WHERE id = 1');
  } catch (err) {
    await recordTickError(db, err);                           // class only; bumps consecutive_errors
    if (sentryOn && (await consecutiveErrors(db)) === 3) Sentry.captureMessage('[gmail_sync] failing', { level: 'warning' });
  } finally {
    await releaseLease(db, owner); cache.invalidate();
    console.log(`[gmail_sync] stored=${sum.stored} dropped=${sum.dropped} unparsed=${sum.unparsed} skipped=${sum.skipped} failed=${sum.failed}`);
  }
  return sum;
}
```

`processOne`: `BEGIN`; fetch (`getMessage`); on a client error throw (tick-level); parse headers, labels, `extractText`; `classifyMessage`; if drop, `COMMIT`, `sum.dropped++`; else `INSERT ... ON CONFLICT (gmail_id) DO NOTHING RETURNING id`; if no row, `COMMIT`; else side effects (bounce mark: `UPDATE gmail_messages SET failed = true WHERE message_id_header = ANY($1)`; Zola: `findOrCreateLead` and `UPDATE gmail_messages SET zola_lead_id = $1 WHERE id = $2`, in this lane always `kind = 'zola_unparsed'` with `text = null`, the lane 3 parser replaces this), `COMMIT`. On any error after the fetch: `ROLLBACK`, upsert `gmail_sync_skips` (`attempts = attempts + 1`), `sum.failed++`; at `GMAIL_SKIP_ATTEMPTS` capture once and count as skipped. The history window advances when every id in it is stored, dropped, or has attempts >= 1 in skips with the third attempt reached or still pending (the window is retried next tick until each id resolves; an id at 3 attempts no longer holds it).

- [ ] **Step 4: Run both suites green, one at a time. Step 5: Commit** `feat(inbox): gmail_sync tick, counting rules at sync time, zola lead rows`.

### Task 9: The two readers and the engine wiring

**Files:**
- Create: `server/utils/inbox/readGmail.js`, `server/utils/inbox/readZola.js`
- Modify: `server/utils/inbox/details.js`, `server/utils/inbox/engine.js:109-150` (computeSnapshot), `:215-245` (resolveKey), `:160-196` (directoryFor), `server/utils/inbox/readers.test.js`, `server/utils/inbox/engine.test.js`

**Interfaces:**
- `readGmail.js`: `GM_HEADERS_SQL` (every column but subject and text, plus `(text IS NULL OR btrim(text) = '') AS empty_body`, `WHERE at >= $1 AND zola_lead_id IS NULL`), `mapGmailHeaders(rows, index) -> events[]` (a Sent row may yield several events, so it maps the whole set: it needs the stored inbound rows to resolve "the inbound this answers" by `in_reply_to` and `thread_id`), `GM_DETAILS_SQL`, `loadGmailDetails(ids, db) -> Map<ref, { subject, text }>` keyed by `gm:<gmail_id>` and also by each suffixed ref (the loader returns the base and `details.js` looks up by `meta.readRef || ref`).
- `readZola.js`: `ZOLA_HEADERS_SQL` (`WHERE at >= $1 AND (kind LIKE 'zola_%' OR direction = 'out')`, the Sent rows filtered in JS by the join), `mapZolaHeaders(rows, index)`.
- Event meta exactly as spec 5.1: `source: 'gm'`, `id`, `gmailId`, `threadId`, `address`, `fromName`, `attachments`, `textBearing`, `empty`, `failed`, `readRef`, `legalHold` (left false here; lane 4 sets it), and for Zola `zolaLeadId`, `template`, `leadUuid`.

- [ ] **Step 1: Tests** in `readers.test.js` (insert rows with `gmail_id` prefixed `zz-test-`, clean up after): inbound maps to `c-` for a client address, `s-` for staff, `e-` for unknown, nothing for own; a Sent row to a client gives one `out` event with `author: null`, `textBearing: true`; a Sent row to a client and a planner gives two events `gm:<id>:1`, `gm:<id>:2` sharing `readRef`; `outbound resolves by the inbound it answers before recipients` (Review Focus 1); Bcc counts; a Sent row marked `failed` carries `meta.failed`; `auto_reply` and `bounce` map to `direction: 'system'`; a `zola_message` row maps to `z-<lead>` or `c-` when linked; `zola join works in both storage orders` (Review Focus 2: insert the reply first, then the notice, and the reverse; both yield the `out` Zola event on the lead); a `zola_unparsed` row maps to `kind: 'zola_unread'`; a `zola_closed` row maps to `kind: 'zola_closed'`, `direction: 'system'`.
  In `engine.test.js`: `resolveKey` on an `e-` key with events returns `{}`; on an `e-` key whose hash now names a client returns `{ movedTo: 'c-…' }`; on a `z-` key with a linked lead returns `movedTo`; `directoryFor.nameOf` for `e-` gives the From display name, else the marketing lead's name, else the address; for `z-` the couple label.

- [ ] **Step 2: fail. Step 3: Implement**, wiring `GM_HEADERS_SQL` and `ZOLA_HEADERS_SQL` into `computeSnapshot`'s `Promise.all`, the mappers into the `normalizeEvents` input, the counts into `warnHeaderRows`, and the gm loader into `loadDetails` (source `gm`, keyed by `Number(e.meta.id)`). **Step 4: green** (`readers.test.js`, then `engine.test.js`). **Step 5: Commit** `feat(inbox): email and Zola readers, engine wiring, e- and z- in the directory`.

### Task 10: Rules, reasons, thread, reply, context, feeds, payload, the personal filter, the route

**Files:**
- Modify: `classify.js`, `rules.js` (step 1 anchor; `personal` on the state), `reasons.js`, `thread.js`, `replyRules.js`, `reply.js`, `context.js`, `contextFormat.js`, `feeds.js`, `payload.js`, `engine.js` (getInbox, getItem, getWaitingCount), `server/routes/admin/inbox.js`, and their tests (`rules.*.test.js`, `rules.testkit.js`, `thread.test.js`, `replyRules.test.js`, `payload.test.js`, `server/routes/admin/inbox.test.js`).

**Interfaces:**
- `classify`: `countsAsReply` gets `case 'gm': return !e.meta.failed;`; `isCountedInbound` and `aiCannotClose` accept `zola_unread`; `eventNeedText` returns "Sent an attachment" for a `media` gm row without words and `ZOLA_UNREAD_TEXT` for `zola_unread`; `sliceText` prefixes `Subject: <subject>. ` on gm rows with a subject and appends ` [attachment]` per attachment; `readOf(reads, kind, ref, readRef)` prefers `readRef`; new `isPersonal(events, index) -> boolean` (every counted inbound is a gm row whose `to_addresses` hold `PERSONAL_ALIAS` and no other own address, and whose From resolves to an `e-` key not in `email_leads`).
- `rules`: `zola_closed` rows join the anchor (`Math.max(..., latest zola_closed at)`); each person state carries `personal: boolean`; `computeInbox` takes `viewerId` already; the list filter happens in `runRules`' caller.
- `reasons`: `case 'gm'`: Zola (`e.channel === 'zola'`) gives `{ reasonCode: 'zola', reasonText: 'Replied to Zola by email', by: null }`, else `{ reasonCode: 'email', reasonText: 'Replied by email', by: null }`; `describeCloser` type `zola_closed` gives `reasonText: 'Closed their inquiry on Zola'`, `by: null`.
- `thread`: gm rows carry `subject` and `attachments`; system lines "Auto-reply received", "Email bounced", "Closed their inquiry on Zola." (+ reason), `ZOLA_UNREAD_TEXT`; outbound gm rows `author_name: null`, `failed`/`failure_reason: 'Email bounced'` when failed.
- `replyRules.latestConversationChannel` includes `email` and `zola`.
- `reply.appLinkFor(personKey, index, events)` returns `{ name, url, caption }` for the latest channel: Thumbtack (existing url, caption "Closes here on its own once you reply in Thumbtack."), Gmail (`gmailThreadUrl(latest email event's threadId)`, caption "Closes here on its own once you reply from Gmail."), Zola (`zolaLeadUrl(uuid)` or `ZOLA_DASHBOARD_URL`, caption "Reply to Zola's email from Gmail and it closes here on its own. A reply typed inside Zola needs Done."); `buildReplyBlock` mode is `open` when the latest channel is `thumbtack`, `email` or `zola` and an app exists.
- `context`: `z-` keys give `{ kind: 'zola_lead', couple_label, wedding_date, client_id }`; the unknown card adds `address` (from `meta.address` of the latest gm inbound) beside `phone_display`.
- `feeds.loadFeeds` adds `{ source: 'gmail', last_at, quiet, status }` (status from `gmail_sync_state` and `isConfigured()`: `off` | `catching_up` | `failing` | `on`) and `{ source: 'zola', last_at, quiet }` (max `at` of `zola_%` rows).
- `payload`: waiting rows carry `personal`; thread rows `attachments`; `reply.app.caption`.
- `engine.getInbox({ viewerId })` drops personal persons from `waiting`, `snoozed`, `handled` unless `viewerId === PERSONAL_MAILBOX_OWNER_USER_ID`; `getWaitingCount({ viewerId })` does the same; `getItem` throws `NotFoundError` for a personal person to any other viewer. The route passes `req.user.id` to the badge count.

- [ ] **Step 1: Tests**, the ones that pin behavior: a gm reply closes a waiting email item; a bounced gm reply (`meta.failed`) does not; a gm reply holds when its outbound read says holding; two staff recipients answer no staffer; `zola_unread` waits and `aiCannotClose`; `zola_closed` anchors and the handled row reads "Closed their inquiry on Zola"; `isPersonal false when another alias is in copy` (Review Focus 5) plus true for dallas@-only unknown, false for a client sender, false when one business mail exists; the list for viewer 2 omits a personal person and the badge differs by viewer, the item 404s for viewer 2 and loads for viewer 1; captions for the three apps; `latestConversationChannel` returns `email` and `zola`; feed rows and the four statuses; the unknown card's `address`.

- [ ] **Step 2: fail. Step 3: Implement. Step 4: green, one suite at a time. Step 5: Commit** `feat(inbox): email and Zola in the rules, replies, thread, reply area, feeds, and the personal filter`.

### Task 11: The scheduler

**Files:**
- Modify: `server/index.js` (after the `inbox_ai_read` block at 834-848)

- [ ] **Step 1: Register it**

```js
      // Inbox email feed (spec 2026-10-14 section 5.5): every 60 s, reads the
      // business mailbox through the Gmail API and stores what counts. Leases
      // its state row so two instances never overlap. With
      // GMAIL_SERVICE_ACCOUNT_KEY unset every tick does nothing.
      if (enabled('RUN_GMAIL_SYNC_SCHEDULER')) {
        const { makeGmailSyncTick } = require('./utils/inbox/gmailSync');
        const wrapped = wrapScheduler('gmail_sync', 60, makeGmailSyncTick());
        setTimeout(wrapped, 20000); // 20s is off every sibling's boot slot
        setInterval(wrapped, 60000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('gmail_sync');
      }
```

- [ ] **Step 2: Boot the dev server with schedulers off (the default) and confirm the log shows the feed off and no Google call** (`npm run dev:server` or the project's server start; look for `[gmail_sync]` lines: none expected). **Step 3: Commit** `feat(inbox): gmail_sync scheduler`.

### Task 12: The page

**Files:**
- Modify: `client/src/components/inbox/ReplyBar.js:55-76` (use `app.caption`), `WaitingRows.js` (the "dallas@" chip), `Thread.js` and `inboxThread.js` (subject already drawn for email rows; add the attachment count line and the three new system lines), `ContextViews.js` (the Zola lead shape, `address`), `FeedsLine.js` (statuses `off`, `failing`, `catching_up` read "Gmail off", "Gmail failing", "Gmail catching up"); tests `inboxListViews.test.js`, `inboxItemViews.test.js`, `inboxThread.test.js`, `ReplyBar.test.js`.

- [ ] **Step 1: Make the edits.** The chips use `StatusChip` with the muted kind. Extend the four component tests with one case each: the chip renders for a `personal` row, the attachment line renders "2 attachments", the system lines render their copy, the caption comes from `app.caption`. **Step 2:** `cd client && CI=true npx react-scripts build` passes with no warnings. **Step 3:** Open the page on the dev server against the shared DB (the dev-signin recipe) and take the phone (390) and desktop (1440) screenshots of one email item and the feed line for the lane's `ui-ux-review`. **Step 4: Commit** `feat(inbox-page): email and Zola captions, chips, lines, feed statuses`.

### Task 13: Docs and the privacy line

**Files:**
- Modify: `README.md` (folder tree: the new inbox files, `zola_leads` in key features), `ARCHITECTURE.md` (the four tables, the scheduler row, the readers), `client/src/pages/website/legal/PrivacyPage.js:122` (Google: "for venue address lookup and to read our business mailbox so client email reaches our inbox") and its `lastUpdated`.

- [ ] **Step 1: Edit. Step 2: `node scripts/check-docs-drift.sh` is quiet. Step 3: Commit** `docs(inbox): email feed tables, readers, scheduler; privacy page names mailbox reading`.

Lane gate: full fleet, `npm run check:filesize`, every inbox suite green one at a time, the client build, `ui-ux-review` against the parent artifact. Then merge from `os`.

---

## Lane zola-leads

### Task 14: The Zola parser

**Files:**
- Create: `server/utils/inbox/zolaMail.js`, `server/utils/inbox/zolaMail.test.js` (with a fixture builder `buildZolaNotice({ template, label, firstName, date, text, uuid, wrapped, auth })` that renders invented notices by the spec's shapes)

**Interfaces:**
- Produces: `zolaAuthPasses(headers) -> boolean` (`authentication-results` from `mx.google.com` contains `dkim=pass` with `header.i=@zola.com` and `dmarc=pass`), `zolaTemplateOf(subject) -> 'inquiry'|'message'|'closed'|'booked'|null` with the label capture, `parseZola(template, plainText) -> { label, firstName, text, date, leadUuid, reason } | null` (null when the body yields no words), `UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, `decodeMandrillLink(url) -> string|null`.

- [ ] **Step 1: Tests:** each template parses from the builder; `gate refuses dkim fail` (Review Focus 4) and a DMARC fail; a wrapped link decodes to the direct URL; a malformed UUID yields `leadUuid: null`; the label is cut at 120; marketing subject gives null; booked gives `'booked'`; an inquiry with an empty note parses to null; odd spacing in the label still yields the same `labelKey`.
- [ ] **Step 2: fail. Step 3: Implement** by the spec's 5.6 rules (plain-text only; regexes anchored on the template phrases; the message text is the content between the first `"` after `'s message` and the last `"` before the dashed line). **Step 4: green. Step 5: Commit** `feat(inbox): Zola notice parser with the authentication gate`.

### Task 15: Lead capture, client creation, the cap, the backfill rule

**Files:**
- Modify: `server/utils/inbox/zolaLeads.js`, `zolaLeads.test.js`, `gmailSync.js`, `gmailSync.test.js`, `constants.js`

**Interfaces:**
- `zolaLeads.applyNotice(db, { parsed, template, gmailRow, duringBackfill, now }) -> { leadId, clientCreated }`: find-or-create the lead (Task 8), fill uuid/date, `markClosed` on closed; when `template === 'inquiry'` and `!duringBackfill` and the lead was just created and `countClientsCreatedSince(now - 24h) < ZOLA_CLIENT_DAILY_CAP`: `findOrCreateClient(db, { name: label, email: null, phone: null, source: 'zola', notes: 'Zola inquiry, no contact details yet' })` and `UPDATE zola_leads SET client_id = $1`. Past the cap: Sentry warning once an hour, no client. The sync's Zola branch now stores `kind` by template (`zola_inquiry` | `zola_message` | `zola_closed`), `text` from the parser, and `zola_unparsed` only when `parseZola` returns null; a gate failure drops and counts, three in a day warn once.

- [ ] **Step 1: Tests:** client created only after switch-on (`duringBackfill: false`) and only for a created lead; not for a message notice; not past the cap; closed stamps; an unparsed inquiry gets a "Zola notice <date>" row; the gate drop counts.
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox): Zola lead capture creates the client, capped, never during the backfill`.

### Task 16: The lead card and Open in Zola

Already produced by Task 10 for `z-` keys and the Zola app link; this task verifies them against stored parsed rows (a lead with a uuid opens the lead page, one without opens the dashboard) and adds `zola_leads` to ARCHITECTURE.md's schema section. Commit `docs(inbox): zola_leads`.

Lane gate as above. Merge together with lane email-feed's successor state before any push (spec 16).

---

## Lane email-ai

### Task 17: The read on email

**Files:**
- Modify: `server/utils/inbox/aiRead.js` (schema, prompt, caps), `aiRead.test.js`, `server/db/schema.sql` (nothing new; the column landed in Task 4), `.claude/CLAUDE.md` (the `ANTHROPIC_API_KEY` row mentions email lines and the solicitation flag)

**Interfaces:**
- `InboundRead` gains `solicitation: z.boolean()`; `INBOUND_SYSTEM_PROMPT` gains the solicitation paragraph (spec section 6, verbatim) before the "No reply is needed" list and a fourth "Fill in" line: `- solicitation: true when the person is selling to us or asking us for something that is not a booking; otherwise false.`; per-channel caps: `preclipFor(channel) = channel in (email, zola) ? EMAIL_PRECLIP_MAX : PRECLIP_CHARS`, `entryMaxFor(channel)` likewise with `EMAIL_LINE_MAX`.

- [ ] **Step 1: Tests:** the schema accepts and requires `solicitation`; an email entry of 5,000 characters keeps 4,000, a text entry keeps 1,500; a Zola entry is treated as email; `[attachment]` and the subject prefix render in the line through `sliceText`. **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox-ai): email-sized lines, the solicitation field`.

### Task 18: The read job

**Files:**
- Modify: `server/utils/inbox/readJob.js` (`store`, `HELD_KEYS_SQL`, the subject loop), `readJob.test.js`, `subjects.js`, `subjects.test.js`, `classify.js`, `rules.js`, `payload.js`, `payload.test.js`, `rules.states.test.js`, the list row component (the "Pitch" chip)

**Interfaces:**
- `store`: writes `solicitation`; when true forces `needs_reply = true`.
- `HELD_KEYS_SQL` adds the held client's `e-` key (`'e-' || left(encode(sha256(lower(trim(c.email))::bytea), 'hex'), 16)`) and `'z-' || zl.id` for linked Zola leads.
- `subjects.inSlice` adds `zola_unread`; `buildSubjects` skips a personal person entirely and keys an outbound subject by `meta.readRef || ref`; a Sent mail that reached a held key marks every sibling `legalHold` (the engine sets `meta.legalHold` on siblings when any recipient key is in the held set; the job's `isReadable` already refuses `legalHold`).
- `rules`: `pitch: boolean` on the waiting state (newest counted inbound's read has `solicitation === true`); `payload` carries `pitch`; the row shows the "Pitch" chip.

- [ ] **Step 1: Tests:** forced `needs_reply`; the held keys include `e-` and `z-`; a personal person yields no subject; two suffixed siblings yield one subject and one `inbox_reads` row; a pitch read leaves the item waiting with `pitch: true`. **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox-ai): pitch stays waiting, one read per mail, held email keys`.

Lane gate as above (full fleet; the read job is the paid path).

---

## Lane zola-draft

### Task 19: The source CHECK and the draft

**Files:**
- Modify: `server/db/schema.sql` (a NEW DO block right after the add-if-missing one at 958-966), `server/routes/proposals/crud.test.js`
- Create: `server/utils/zolaProposalDraft.js`, `server/utils/zolaProposalDraft.test.js`
- Modify: `server/utils/inbox/zolaLeads.js` (call the draft after commit), `scripts/sensitive-paths.txt`

- [ ] **Step 1: The schema block**

```sql
-- Widening (spec 2026-10-14 section 5.6): the block above adds the CHECK only
-- when it is missing, so a value added there never reaches dev or prod. This
-- block is the live definition, the inbox_reads pattern.
DO $$ BEGIN
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_source_check;
  ALTER TABLE proposals ADD CONSTRAINT proposals_source_check
    CHECK (source IS NULL OR source IN ('thumbtack','zola'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Tests** (`zolaProposalDraft.test.js`, against the dev DB, cleaning its rows): `createDraftProposalFromZolaLead({ leadId })` creates a draft with package `the-core-reaction`, `num_bars` 0, `guest_count` 50, `duration_hours` 4, `event_type` `wedding-reception`, `event_date` the lead's date, `event_start_time` `17:00`, `source` `zola`, `status` `draft`, admin notes carrying the note and the lead link, an activity log row `created` by `system`; idempotent (a second call returns the same id); no date means no draft; a `crud.test.js` case inserts `source = 'zola'` and reads it back.

- [ ] **Step 3: Implement** by copying `createDraftProposalFromLead`'s transaction shape (`FOR UPDATE` on the `zola_leads` row, `calculateProposal`, `insertProposalRecord`, `proposal_activity_log`, `UPDATE zola_leads SET proposal_id`), called from `zolaLeads.applyNotice` after its commit inside a try with `Sentry.captureException(err, { tags: { feed: 'zola', step: 'draft' } })`. Add `server/utils/zolaProposalDraft.js` to the sensitive list.

- [ ] **Step 4: green. Step 5: Commit** `feat(inbox): Zola draft proposal, the source CHECK widened by a live block`.

### Task 20: The no-contact Send guard

**Files:**
- Modify: `server/routes/proposals/lifecycle.js` (the `status === 'sent'` branch at about 145), `client/src/pages/admin/ProposalDetail.js:281-284`
- Create: `server/routes/proposals/lifecycle.sendGuard.test.js` (the `crud.test.js` harness: boot the router with the test db, create a client and a draft, PATCH the status)

- [ ] **Step 1: Test:** PATCH status `sent` on a proposal whose client has neither email nor phone answers 400 `VALIDATION_ERROR` with "Add an email or phone for this client before sending." and leaves the status unchanged; with an email it proceeds as today. **Step 2: fail. Step 3: Implement** (`throw new ValidationError({ client: 'Add an email or phone for this client before sending.' })` after the client row is read, before the status write); the page disables Send with the same copy when the loaded client has neither. **Step 4: green. Step 5: Commit** `fix(proposals): Send refuses a client with no email and no phone`.

### Task 21: The source consumers

**Files:**
- Modify: `server/routes/proposals/list.js:103-106` (`else if (source === 'zola') whereClause += " AND p.source = 'zola'"`), `server/routes/proposals/metadata.js:313-316` (accept `zola`; its clause `source = 'zola'`), `client/src/pages/admin/ProposalsDashboard.js:20` (`['thumbtack', 'zola', 'manual']`) and `:348-350` (`<option value="zola">Zola</option>`), `client/src/components/admin/SourceBadge.js:7` (render for `zola` with label "Zola"), `client/src/pages/admin/overview/FunnelCard.js:39-56` (`if (key === 'zola') return 'Zola';` and the href `/proposals?cohort=quoted&source=zola${rq}`), `ARCHITECTURE.md`.

- [ ] **Step 1: Edit. Step 2:** `node --test server/routes/proposals/list.sort.test.js` (regression, the only list suite) and the client build; then open the proposals dashboard on the dev server and pick Zola in the source filter. **Step 3: Commit** `feat(proposals): Zola as a proposal source in the list, counts, badge and funnel`.

Lane gate as above.

---

## Self-review (done at writing, 2026-10-14)

- **Spec coverage:** 3.1 to 3.4 (Tasks 1, 2, 8, 11); 3.5 to 3.8 (Tasks 7, 8, 10); 3.9 (Task 10); 3.10 (Tasks 9, 10); 3.11 (Tasks 15, 19); 3.12 (Tasks 17, 18); 3.13 (Task 17); 3.14 (Tasks 8, 14, 15); 3.15 (Tasks 8, 15); 3.16 (Tasks 5, 8); 3.17 (Task 10); 3.18 (Tasks 2, 3); 3.19 (Task 10); 3.20 (Task 8); 4.x (Tasks 10, 12); 5.1 to 5.4 (Tasks 7, 9, 10); 5.5 (Tasks 8, 11); 5.6 (Tasks 8, 14, 15, 19, 20, 21); 5.7 (Task 5); 6 (Tasks 17, 18); 7 (Tasks 4, 19); 8 (Task 10); 9 (every task); 10 (Tasks 1, 2); 11 (Task 12); 12 (Tasks 8, 10); 13 (Tasks 3, 13); 14 (every task's tests; the prod acceptance list is the switch-on walk, not a task); 16 (the lane map).
- **Placeholders:** none; where a task says "by the spec's rules" the rule set is enumerated in the task or the spec section it cites.
- **Type consistency:** `createGmailClient`, `makeGmailSyncTick`, `findOrCreateLead`, `applyNotice`, `parseZola`, `extractText`, `resolveEmail`, `keyByEmailHash`, `zolaKey`, `appLinkFor(personKey, index, events)`, `readRef`, `isPersonal` are named once and reused.
- **Review Focus:** the five lines each name their task and test.

## Execution

Dallas's standing method: Claude cuts each lane, builds it (one pass for a coherent lane, parallel subagents for independent pieces, stated at the time), runs the per-lane fleet, merges by squash from `os`. Lanes 3 and 4 run in parallel after lane 2; lane 5 after lane 3. No push without his own imperative cue.
