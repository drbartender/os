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
    footprint:   # widened 2026-10-15 to every file the lane touched (spec 17 items 48 and 49)
      - .claude/CLAUDE.md
      - ARCHITECTURE.md
      - README.md
      - client/src/components/inbox/ContextViews.js
      - client/src/components/inbox/FeedsLine.js
      - client/src/components/inbox/ReplyBar.js
      - client/src/components/inbox/ReplyBar.test.js
      - client/src/components/inbox/Thread.js
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/inboxContext.js
      - client/src/components/inbox/inboxContext.test.js
      - client/src/components/inbox/inboxFormat.js
      - client/src/components/inbox/inboxFormat.test.js
      - client/src/components/inbox/inboxItemViews.test.js
      - client/src/components/inbox/inboxListViews.test.js
      - client/src/components/inbox/inboxThread.js
      - client/src/components/inbox/inboxThread.test.js
      - client/src/index.css
      - client/src/pages/website/legal/PrivacyPage.js
      - client/src/pages/website/legal/PrivacyPage.test.js
      - server/db/index.js
      - server/db/schema.sql
      - server/index.js
      - docs/walkthroughs-owed.md
      - scripts/sensitive-paths.txt
      - server/routes/admin/inbox.js
      - server/routes/admin/inbox.test.js
      - server/routes/admin/settings.js
      - server/routes/admin/settings.badgeCounts.test.js
      - server/routes/admin/settings.inboxBadge.test.js
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
      - server/utils/inbox/gmailRules.js
      - server/utils/inbox/gmailRules.test.js
      - server/utils/inbox/gmailSync.db.test.js
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
      - server/utils/inbox/personalMail.js
      - server/utils/inbox/personalMail.test.js
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
      - server/utils/inbox/zolaMail.js
      - server/utils/inbox/zolaMail.test.js
    blockedBy: [gmail-client]
    review: full-fleet   # server/utils/inbox/** and schema.sql are sensitive; stores message text; viewer filter
  - id: zola-leads
    footprint:
      - ARCHITECTURE.md
      - client/src/pages/admin/ProposalDetail.js
      - server/routes/proposals/lifecycle.js
      - server/routes/proposals/lifecycle.sendGuard.test.js
      - server/utils/inbox/constants.js
      - server/utils/inbox/gmailSync.js
      - server/utils/inbox/gmailSync.test.js
      - server/utils/inbox/zolaLeads.js
      - server/utils/inbox/zolaLeads.test.js
      - server/utils/inbox/zolaMail.js
      - server/utils/inbox/zolaMail.test.js
    blockedBy: [email-feed, zola-pipeline-spec]   # Dallas 2026-10-14: the Zola lead pipeline (box agent scrape, client with contacts, real draft, automated first reply) is its OWN spec, brainstormed first; this lane shrinks to consuming its lead rows
    review: full-fleet   # creates client rows from parsed third-party mail; the Send guard touches the proposal lifecycle
  - id: email-ai
    footprint:
      - .claude/CLAUDE.md
      - client/src/components/inbox/WaitingRows.js
      - client/src/components/inbox/inboxListViews.test.js
      - server/utils/inbox/aiRead.js
      - server/utils/inbox/aiRead.test.js
      - server/utils/inbox/aiRedact.test.js
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
      - server/db/index.js
      - server/db/schema.sql
      - server/routes/proposals/crud.filters.test.js
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/list.js
      - server/routes/proposals/metadata.js
      - server/utils/inbox/zolaLeads.js
      - server/utils/zolaProposalDraft.js
      - server/utils/zolaProposalDraft.test.js
    blockedBy: [zola-leads, zola-pipeline-spec]   # the draft takes the pipeline's real fields, not the notice's
    review: full-fleet   # proposal rows
pushGate: lanes email-feed, zola-leads and email-ai merge before any push that carries email-feed, and the key is not set in Render before that push (spec 16; plan review 2026-10-14)
---

# Inbox piece 3: email and Zola, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email in the business mailbox and Zola's notices become Inbox items on the same person as their texts, a reply from Gmail closes them, and the AI read judges email with a pitch flag and a personal-mail check.

**Architecture:** A 60-second `gmail_sync` scheduler reads the mailbox through a raw-fetch Gmail client under a service account, applies the counting rules at sync time, and writes `gmail_messages`; two readers (`readGmail.js`, `readZola.js`) map those rows into the engine's event shape, where identity resolves at read time (`people.js`), replies close by `classify.countsAsReply`, and the page gets captions, chips and a viewer filter. Zola notices create lead rows, clients and draft proposals through the Thumbtack precedents.

**Tech Stack:** Node (the box runs 24.16 under nvm, `.node-version` pins 26; `fetch`, `crypto.sign`, `AbortSignal.timeout` and `base64url` work on both), Express, raw SQL on Neon Postgres, `node --test`, React 18 (CRA), the existing Anthropic read job. No new npm dependency.

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
const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => { restore('GMAIL_SERVICE_ACCOUNT_KEY', saved.key); restore('NODE_ENV', saved.env); gc.__resetGmailClient(); });

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
    listHistory: ({ startHistoryId, historyTypes = ['messageAdded', 'labelAdded'], pageToken } = {}) => call('/history', { startHistoryId, historyTypes, pageToken }),
    getMessage: (id) => call(`/messages/${encodeURIComponent(id)}`, { format: 'full' }),
  };
}

module.exports = { GMAIL_MAILBOX, GMAIL_SCOPE, isConfigured, configurationError, createGmailClient, GmailError, __setGmailClientForTests, __resetGmailClient };
```

Note: `call` appends an array value once per element (`url.searchParams.append(k, v)` for each), because Gmail takes `historyTypes` as a repeated query parameter, never a comma list.

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

Run (the project's apply path is `initDb()`, `server/db/index.js:370`, exported at `:473`; it splits statements and tolerates the re-run codes, where a single `pool.query` of the whole file aborts on the first bare `ADD CONSTRAINT`):

```bash
node -e "require('dotenv').config(); const db=require('./server/db'); db.initDb().then(()=>db.pool.query(\"SELECT (SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_name IN ('gmail_messages','zola_leads','gmail_sync_state','gmail_sync_skips')) AS tables, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='inbox_reads' AND column_name='solicitation') AS col, (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conname IN ('gmail_messages_kind_check','gmail_messages_direction_check')) AS checks\")).then(r=>{console.log(JSON.stringify(r.rows[0]));process.exit(0)})"
```
Expected: `{"tables":"gmail_messages,gmail_sync_skips,gmail_sync_state,zola_leads","col":"1","checks":"gmail_messages_direction_check,gmail_messages_kind_check"}`.

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

- [ ] **Step 2: Run, see failures. Step 3: Implement** (`emailHash = (a) => crypto.createHash('sha256').update(norm(a)).digest('hex').slice(0, 16)`, `norm = (a) => String(a || '').trim().toLowerCase()`; own set built from `GMAIL_MAILBOX`, `PERSONAL_ALIAS`, the bare address inside `FROM_EMAIL` (exported by `server/utils/email.js:149` in display form `Name <address>`, hardcoded at `:10`; extract the angle-bracket part with `/<([^>]+)>/`, else the whole string), `env.ADMIN_EMAIL`, `env.INBOX_OWN_EMAILS` split on commas, operators' emails, `ZOLA_VENDOR_ADDRESS`). **Step 4: green. Step 5: Commit** `feat(inbox): email identity in the people index, e- and z- alias folding`.

### Task 8a: The Zola gate and subject match (pure)

**Files:**
- Create: `server/utils/inbox/zolaMail.js`, `server/utils/inbox/zolaMail.test.js`

**Interfaces:**
- Produces: `zolaAuthPasses(headers: Map) -> boolean` (the `authentication-results` value written by `mx.google.com` contains `dkim=pass` with `header.i=@zola.com` and `dmarc=pass`), `zolaTemplateOf(subject) -> { template: 'inquiry'|'message'|'closed'|'booked'|null, label: string|null }` (label cut at 120), `labelKey(label) -> string` (trim, collapse inner whitespace, case-fold), `fallbackLabel(atChicagoYmd) -> 'Zola notice <ymd>'`, `UUID_RE`. This module is the ONE home of the gate and the subject match; lane 3 extends it with `parseZola`, never redefines these.

- [ ] **Step 1: Tests** with a header fixture built from a `Map`: gate passes on a pass line; `gate refuses dkim fail` (Review Focus 4); refuses a dmarc fail; refuses a pass line for a different domain; the four subjects map to their templates with the label captured where the subject carries one; marketing subject maps to null; a 200-character label is cut to 120; `labelKey('  Alex  B &  Sam C ')` equals `labelKey('alex b & sam c')`; `fallbackLabel('2026-10-14')` is `'Zola notice 2026-10-14'`.
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green (9 pass). Step 5: Commit** `feat(inbox): Zola authentication gate and subject match`.

### Task 8b: Zola lead rows (the writer)

**Files:**
- Create: `server/utils/inbox/zolaLeads.js`, `server/utils/inbox/zolaLeads.test.js`
- Modify: `scripts/sensitive-paths.txt` (list `server/utils/inbox/zolaLeads.js` with the comment "writes lead and, in lane zola-leads, client rows from parsed third-party mail"; the folder glob already matches it, the line carries the reason)

**Interfaces:**
- Produces: `findOrCreateLead(db, { label, leadUuid, weddingDate }) -> { id, created }` (by uuid, then by open `couple_label_key`, else insert; fills a missing uuid on a label match; a label whose row holds a DIFFERENT uuid makes a new row), `markClosed(db, id)`. Lane 3 adds `applyNotice`, client creation and the cap here.

- [ ] **Step 1: Tests** (dev DB, rows with labels prefixed `zz-test-`, cleaned in `after`): find by uuid; find by open label; create; uuid filled on a label match; same label with a different uuid makes a second row; closed rows are not matched by label; a bad uuid is ignored (`UUID_RE` from Task 8a).
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox): zola_leads writer`.

### Task 8c: The sync tick

**Files:**
- Create: `server/utils/inbox/gmailSync.js`, `server/utils/inbox/gmailSync.test.js`

**Interfaces:**
- Produces: `makeGmailSyncTick({ client, db, now, sentry } = {}) -> async () => summary | null`, `summary = { stored, dropped, unparsed, skipped, failed, gateFailed }`; pure helpers exported for tests: `headersOf(payload) -> Map<lowercase name, value>`, `recipientsOf(headers) -> string[]` (To, Cc, Bcc, lowercased), `isBulk(headers, labelIds)`, `isAutoReply(headers, subject, hasCalendarOnly)`, `isBounce(headers, payload)`, `classifyMessage({ headers, labelIds, subject, text, hasCalendarOnly, fromAddress, recipients, index, storedSentIds }) -> { action: 'drop'|'store', kind, zola?: { template, label } }`; `ensureStateRow(db)` (`INSERT INTO gmail_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`), `claimLease(db, owner)`, `releaseLease(db, owner)`.
- Consumes: Task 1's client, Task 5's `extractText`, Task 7's index, Task 8a's gate and subject match, Task 8b's `findOrCreateLead`.

- [ ] **Step 1: Tests** (pure helpers over invented fixtures; the tick with an injected client stub and a recording db stub, the `readJob.test.js` style):
  - `ensureStateRow` then `claimLease`: the first tick on an empty table inserts the row and claims it; claimed when free; refused when another owner holds an unexpired lease; claimed when expired; `releaseLease` clears it.
  - first sync reads the profile's `historyId` BEFORE listing, stores `backfill_page`, processes a page's ids oldest first, sets `backfill_done` after the last page.
  - steady state: `history.list` ids processed; a `labelAdded` of `CATEGORY_PERSONAL` re-evaluates a message not stored before; `GmailHistoryGoneError` triggers the dated resync (`q=after:<last_ok_at minus one day, YYYY/MM/DD>`).
  - `classifyMessage` in the spec's order: DRAFT, SPAM, TRASH dropped; a Zola-address mail goes to the Zola branch BEFORE the own-address rule, and there a gate failure drops and counts `gateFailed`, a booked or marketing subject drops, an inquiry, message or closed subject stores `kind` by template (lane 2 stores every one as `zola_unparsed` with `text` null and the label, or the fallback label, for `findOrCreateLead`); Sent to only our own addresses dropped; Sent to a dropped domain dropped; inbound from own dropped; inbound from a dropped domain dropped; a bounce naming a stored Sent row stored as `bounce` and that row marked failed, a bounce naming nothing dropped; auto-reply by header, by subject, and a Sent calendar-only row; a known client counts whatever the category; a reply to our stored Sent row counts whatever the category; unknown in Primary without bulk headers counts; unknown in Updates dropped; `List-Unsubscribe` dropped; `Precedence: bulk`, `list` and `junk` each dropped; a no-reply local part dropped.
  - the insert gate: a re-processed id whose insert returned no row runs no side effect (no lead row, no bounce mark).
  - a failing message lands in `gmail_sync_skips` with attempts 1, then 2, then is skipped at 3 with one Sentry capture, and the window still advances; a message with one failure holds the window.
  - bounds: at most `GMAIL_SYNC_MAX_PER_TICK` messages and `GMAIL_SYNC_TICK_MS` per tick; `cache.invalidate` called once per tick.
  - three consecutive tick failures set `failing`; the Sentry warning is sent at most once an hour while failing (a module-level `lastFailWarnAt`, the daily-cap warning's pattern in `readJob.js`).
  - the summary line and `last_error` hold an error class, never a body or an address.

- [ ] **Step 2: fail. Step 3: Implement.** Tick skeleton:

```js
async function tick() {
  const client = deps.client || createGmailClient();
  if (!client) return null;                                   // feed off
  await ensureStateRow(db);
  const lease = await claimLease(db, owner);                  // one UPDATE ... WHERE lease free RETURNING
  if (!lease) return null;
  const started = Date.now(); let done = 0;
  const sum = { stored: 0, dropped: 0, unparsed: 0, skipped: 0, failed: 0, gateFailed: 0 };
  try {
    const index = await loadPeopleIndex(db);
    const ids = lease.backfill_done ? await historyIds(client, lease) : await backfillIds(client, lease, db);
    for (const id of ids.items) {
      if (done >= GMAIL_SYNC_MAX_PER_TICK || Date.now() - started > GMAIL_SYNC_TICK_MS) { ids.complete = false; break; }
      await processOne(client, db, index, id, sum);            // its own transaction; records skips
      done += 1;
    }
    if (ids.complete) await advanceCursor(db, ids);           // history id, or the next backfill page
    await db.query('UPDATE gmail_sync_state SET last_ok_at = NOW(), consecutive_errors = 0, updated_at = NOW() WHERE id = 1');
  } catch (err) {
    const n = await recordTickError(db, err);                 // class only; returns consecutive_errors
    if (n >= 3) warnFailingHourly(err);                       // Sentry at most once an hour
  } finally {
    await releaseLease(db, owner); cache.invalidate();
    console.log(`[gmail_sync] stored=${sum.stored} dropped=${sum.dropped} unparsed=${sum.unparsed} skipped=${sum.skipped} failed=${sum.failed} gateFailed=${sum.gateFailed}`);
  }
  return sum;
}
```

`processOne`: `BEGIN`; fetch (`getMessage`); on a client error throw (tick-level); `headersOf`, label ids, `extractText`; `classifyMessage`; if drop: `COMMIT`, `sum.dropped++`; else `INSERT ... ON CONFLICT (gmail_id) DO NOTHING RETURNING id`; if no row, `COMMIT`; else side effects in the same transaction (bounce: `UPDATE gmail_messages SET failed = true WHERE message_id_header = ANY($1)`; Zola: `findOrCreateLead` with the label or `fallbackLabel`, then `UPDATE gmail_messages SET zola_lead_id = $1 WHERE id = $2`); `COMMIT`. On any error after the fetch: `ROLLBACK`, upsert `gmail_sync_skips` (`attempts = gmail_sync_skips.attempts + 1`), `sum.failed++`; at `GMAIL_SKIP_ATTEMPTS` capture once (id and class) and count `skipped`. The history window advances when every id in it is stored, dropped, or has reached `GMAIL_SKIP_ATTEMPTS`.

- [ ] **Step 4: green, one suite at a time. Step 5: Commit** `feat(inbox): gmail_sync tick, counting rules at sync time`. **Checkpoint:** `security-review` and `code-review` on Tasks 8a to 8c (a credentialed fetch, message text at rest, the insert gate).

### Task 9: The two readers and the engine wiring

**Files:**
- Create: `server/utils/inbox/readGmail.js`, `server/utils/inbox/readZola.js`
- Modify: `server/utils/inbox/details.js`, `server/utils/inbox/engine.js` (computeSnapshot at 109-150; the held keys at 137-138; directoryFor at 162-197; resolveKey at 222-254), `server/utils/inbox/readers.test.js`, `server/utils/inbox/engine.test.js`

**Interfaces:**
- `readGmail.js`: `GM_HEADERS_SQL` (every column but subject and text, plus `(text IS NULL OR btrim(text) = '') AS empty_body`, `WHERE at >= $1 AND zola_lead_id IS NULL`), `mapGmailHeaders(rows, index) -> events[]` (takes the whole set: resolving "the inbound this answers" needs the stored inbound rows beside the Sent row), `GM_DETAILS_SQL`, `loadGmailDetails(ids, db) -> Map<'gm:<gmail_id>', { subject, text }>`; `details.js` looks a gm event up by `e.meta.readRef || e.ref`.
- `readZola.js`: `ZOLA_HEADERS_SQL` (`WHERE at >= $1 AND (kind LIKE 'zola_%' OR direction = 'out')`; the Sent rows are filtered in JS by the read-time join), `mapZolaHeaders(rows, index)`.
- Event meta exactly as spec 5.1 PLUS `toAddresses` (the stored recipient list, lowercased), which `isPersonal` (Task 10c) reads: `source: 'gm'`, `id`, `gmailId`, `threadId`, `address`, `fromName`, `toAddresses`, `attachments`, `textBearing`, `empty`, `failed`, `readRef`, `legalHold`; Zola adds `zolaLeadId`, `template`, `leadUuid`.
- `engine.computeSnapshot` sets `meta.legalHold = true` on every gm sibling (same `readRef`) of a Sent mail when any sibling's `personKey` is in the held set it already builds from `proposals.legal_hold` (engine.js:137-138); `rules.js` and lane 4 read the flag.

- [ ] **Step 1: Tests** in `readers.test.js` (rows with `gmail_id` prefixed `zz-test-`, cleaned after): inbound maps to `c-` for a client address, `s-` for staff, `e-` for unknown, nothing for own; a Sent row to a client gives one `out` event with `author: null`, `textBearing: true`; a Sent row to a client and a planner gives two events `gm:<id>:1`, `gm:<id>:2` sharing `readRef`; `outbound resolves by the inbound it answers before recipients` (Review Focus 1); Bcc counts; `toAddresses` is on meta; a Sent row marked `failed` carries `meta.failed`; `auto_reply` and `bounce` map to `direction: 'system'`; a `zola_message` row maps to `z-<lead>` or `c-` when linked; `zola join works in both storage orders` (Review Focus 2); a `zola_unparsed` row maps to `kind: 'zola_unread'`; a `zola_closed` row maps to `kind: 'zola_closed'`, `direction: 'system'`; a `zola_inquiry` row carries `template: 'inquiry'`.
  In `engine.test.js`: `resolveKey` on an `e-` key with events returns `{}`; on an `e-` key whose hash now names a client returns `{ movedTo: 'c-…' }`; on a `z-` key with a linked lead returns `movedTo`; `directoryFor.nameOf` for `e-` gives the From display name, else the marketing lead's name, else the address, and for `z-` the couple label; `the sibling hold flag`: a Sent mail to a held client and a third party flags both events `meta.legalHold`.

- [ ] **Step 2: fail. Step 3: Implement**, wiring both header queries into `computeSnapshot`'s `Promise.all`, the mappers into the `normalizeEvents` input, the counts into `warnHeaderRows`, the gm loader into `loadDetails` (source `gm`, keyed by `Number(e.meta.id)`), and the sibling flag after `normalizeEvents`. **Step 4: green** (`readers.test.js`, then `engine.test.js`). **Step 5: Commit** `feat(inbox): email and Zola readers, engine wiring, e- and z- in the directory, the sibling hold flag`.

### Task 10a: Counting rules and copy

**Files:**
- Modify: `classify.js`, `rules.js`, `reasons.js`, `thread.js`, `rules.testkit.js`, `rules.events.test.js`, `rules.replies.test.js`, `rules.states.test.js`, `thread.test.js`

**Interfaces:**
- `classify`: `countsAsReply` gets `case 'gm': return !e.meta.failed;`; `isCountedInbound` and `aiCannotClose` accept `zola_unread`; `eventNeedText` returns "Sent an attachment" for a `media` gm row without words and `ZOLA_UNREAD_TEXT` for `zola_unread`; `sliceText` prefixes `Subject: <subject>. ` on gm email rows with a subject (never on Zola rows) and appends ` [attachment]` per attachment; `readOf(reads, kind, ref, readRef)` prefers `readRef`; `isPersonal(events, index) -> boolean` (every counted inbound is a gm row whose `meta.toAddresses` hold `PERSONAL_ALIAS` and no other own address, and whose From resolves to an `e-` key not in `email_leads`).
- `rules`: a `zola_closed` row joins the anchor (`Math.max(..., latest zola_closed at)`); each person state carries `personal: boolean`; `pitch` is lane 4's.
- `reasons`: `case 'gm'`: Zola gives `{ reasonCode: 'zola', reasonText: 'Replied to Zola by email', by: null }`, else `{ reasonCode: 'email', reasonText: 'Replied by email', by: null }`; `describeCloser` type `zola_closed` gives `reasonText: 'Closed their inquiry on Zola'`, `by: null`.
- `thread`: gm rows carry `subject` (an inquiry row's subject reads "Zola inquiry"; a later Zola message's is null) and `attachments`; outbound gm rows `author_name: null`, caption `by_email: true` (the page renders "by email" where a text row says the line); system lines "Auto-reply received", "Email bounced", "Closed their inquiry on Zola." plus the reason, `ZOLA_UNREAD_TEXT`; a failed outbound reads `failed: true`, `failure_reason: 'Email bounced'`.

- [ ] **Step 1: Tests:** a gm reply closes a waiting email item and `ends a claim`; a bounced gm reply does not close; a gm reply holds when its outbound read says holding; two staff recipients answer no staffer, a client plus a planner both close; `zola_unread` waits and `aiCannotClose`; `an attachment-only mail waits`; `zola_closed` anchors and the handled row reads "Closed their inquiry on Zola"; `isPersonal` true for dallas@-only unknown, `isPersonal false when another alias is in copy` (Review Focus 5), false for a client sender, false for a staff sender, false for a marketing-lead sender, false when one business mail exists; `sliceText` adds the subject on email rows and none on Zola rows; the thread rows and system lines above.
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green, one suite at a time. Step 5: Commit** `feat(inbox): email and Zola in the counting rules, replies, reasons and thread`.

### Task 10b: Reply area, card, feeds, payload

**Files:**
- Modify: `replyRules.js`, `reply.js`, `context.js`, `contextFormat.js`, `feeds.js`, `payload.js`, `replyRules.test.js`, `payload.test.js`

**Interfaces:**
- `replyRules.latestConversationChannel` includes `email` and `zola`.
- `reply.appLinkFor(personKey, index, events) -> { name, url, caption } | null` for the latest channel: Thumbtack (existing url, caption "Closes here on its own once you reply in Thumbtack."), Gmail (`gmailThreadUrl(latest email event's threadId)`, "Closes here on its own once you reply from Gmail."), Zola (`zolaLeadUrl(uuid)` or `ZOLA_DASHBOARD_URL`, "Reply to Zola's email from Gmail and it closes here on its own. A reply typed inside Zola needs Done."); `buildReplyBlock` mode is `open` when the latest channel is `thumbtack`, `email` or `zola` and an app exists.
- `context`: `z-` keys give `{ kind: 'zola_lead', couple_label, wedding_date, client_id }`; the unknown card adds `address` beside `phone_display`.
- `feeds.loadFeeds` adds `{ source: 'gmail', last_at, quiet, status }` (`off` when `!isConfigured()`, `catching_up` while `backfill_done` is false, `failing` at `consecutive_errors >= 3`, else `on`) and `{ source: 'zola', last_at, quiet }`.
- `payload`: waiting rows carry `personal`; thread rows `attachments`, `by_email`; `reply.app.caption`.

- [ ] **Step 1: Tests:** `latestConversationChannel` returns `email` and `zola`; captions for the three apps; a Zola lead with a uuid opens the lead page, without one the dashboard; the Zola card and the unknown card's `address`; the four feed statuses; `personal` and `by_email` in the payload.
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox): reply area, card, feed rows and payload for email and Zola`.

### Task 10c: The personal-mail viewer filter

**Files:**
- Modify: `server/utils/inbox/engine.js` (getInbox, getItem, getWaitingCount, and a `personalKeys(snap)` helper), `server/utils/inbox/subjects.js` (`buildSubjects` skips a personal person), `server/utils/inbox/subjects.test.js`, `server/routes/admin/inbox.js:27-65` (seen, actions, text refuse a personal person to a non-owner with `NotFoundError`), `server/routes/admin/inbox.test.js`, `server/routes/admin/settings.js:137` (`getWaitingCount({ timeoutMs, viewerId: req.user.id })`), `server/routes/admin/settings.inboxBadge.test.js`, `server/routes/admin/settings.badgeCounts.test.js`, `engine.test.js`

**Interfaces:**
- `engine.getInbox({ viewerId })` drops personal persons from `waiting`, `snoozed` and `handled` unless `viewerId === PERSONAL_MAILBOX_OWNER_USER_ID`; `getWaitingCount({ timeoutMs, viewerId })` likewise; `getItem({ personKey, viewerId })` throws `NotFoundError` for a personal person to any other viewer; a new `isPersonalPerson(personKey, viewerId)` is what the seen, actions and text routes call before acting.
- `subjects.buildSubjects` yields nothing for a state with `personal: true`, so the existing read job never reads personal mail from the day lane 2 merges.

- [ ] **Step 1: Tests:** the list for viewer 2 omits a personal person and viewer 1 sees it; the badge differs by viewer; the item 404s for viewer 2 and loads for viewer 1; seen, actions and text answer 404 for viewer 2 on a personal key; `buildSubjects` yields no subject for a personal person.
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox): personal mail at the owner alias is owner-only and never read`. **Checkpoint:** `security-review` (the viewer seam) and `consistency-check` (every consumer of the new kinds and keys) on Tasks 9 to 10c.

### Task 11: The scheduler

**Files:**
- Modify: `server/index.js` (after the `inbox_ai_read` block at 836-850)

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

- [ ] **Step 2: Verify both paths** with the key unset (so no Google call is possible: `createGmailClient()` returns null). Start the server the way the dev-server recipe does (`RUN_SCHEDULERS=true RUN_GMAIL_SYNC_SCHEDULER=true node server/index.js` on a scratch port), wait 30 s, and read `SELECT name FROM scheduler_health WHERE name = 'gmail_sync'` on the dev DB: one row. Stop it; start again with `RUN_GMAIL_SYNC_SCHEDULER=false`: the row is gone (`clearHealthRow`). Stop it. **Step 3: Commit** `feat(inbox): gmail_sync scheduler`.

### Task 12: The page

**Files:**
- Modify: `client/src/components/inbox/ReplyBar.js:55-76` (use `app.caption`), `WaitingRows.js` (the "dallas@" chip), `Thread.js` and `inboxThread.js` (the attachment count line, the "by email" caption, the three new system lines), `ContextViews.js` (the Zola lead shape, `address`), `inboxFormat.js:197-212` (`feedItems`: display names "Gmail" and "Zola", and the status words "Gmail off", "Gmail failing", "Gmail catching up"; `FeedsLine.js` only renders items); tests `inboxListViews.test.js`, `inboxItemViews.test.js`, `inboxThread.test.js`, `ReplyBar.test.js`, `inboxFormat.test.js`.

**Declared input:** the parent artifact `docs/design-artifacts/2026-10-06-inbox/` (the vendored export): the email and Zola thread rows with their subject line, the "Open in Gmail" and "Open in Zola" reply modes, the Gmail and Zola feed rows. Match those drawings for layout, composition and component vocabulary; the three undrawn elements (the dallas@ chip, the attachment line, the feed status words) use the vocabulary the artifact uses (spec 11).

- [ ] **Step 1: Make the edits.** The chips use `StatusChip` with the muted kind. Extend the five tests with one case each: the chip renders for a `personal` row, the attachment line renders "2 attachments", the system lines render their copy, the caption comes from `app.caption`, `feedItems` names and statuses. **Step 2:** `cd client && CI=true npx react-scripts test --watchAll=false src/components/inbox` green, then `CI=true npx react-scripts build` with no warnings. **Step 3:** Open the page on the dev server (the dev-signin recipe) and take the phone (390) and desktop (1440) screenshots of one email item, one Zola item and the feed line, After Hours and House Lights, for the lane's `ui-ux-review`. **Step 4: Commit** `feat(inbox-page): email and Zola captions, chips, lines, feed statuses`. **Checkpoint:** `ui-ux-review` against the artifact.

### Task 13: Docs, the privacy line, the walkthrough

**Files:**
- Modify: `README.md` (folder tree: the new inbox files; `zola_leads` in key features), `ARCHITECTURE.md` (the four tables, the scheduler row, the readers), `client/src/pages/website/legal/PrivacyPage.js:122` (Google: "for venue address lookup and to read our business mailbox so client email reaches our inbox") and its `lastUpdated`, `docs/walkthroughs-owed.md` (an Inbox bullet: "email and Zola: a client email, a reply from Gmail, a Zola thread, a pitch, a personal mail at dallas@ seen only by Dallas", owed after switch-on).

- [ ] **Step 1: Edit. Step 2:** `git add` the files, then `bash scripts/check-docs-drift.sh` (it reads the staged diff) is quiet. **Step 3: Commit** `docs(inbox): email feed tables, readers, scheduler; privacy page names mailbox reading; the walk owed`.

**Lane gate (email-feed):** full fleet; `npm run check:filesize`; every inbox suite green one at a time; the two badge suites; the client build; `ui-ux-review` against the parent artifact. Merge from `os`. The push gate in the front-matter holds: this lane never ships alone.

---

## Lane zola-leads

### Task 14: The Zola body parser

**Files:**
- Modify: `server/utils/inbox/zolaMail.js`, `server/utils/inbox/zolaMail.test.js` (add a fixture builder `buildZolaNotice({ template, label, firstName, date, text, uuid, wrapped })` that renders invented notices by the spec's shapes, plain-text part only)

**Interfaces:**
- Adds: `parseZola(template, plainText) -> { label, firstName, text, date, leadUuid, reason } | null` (null when the body yields no words), `decodeMandrillLink(url) -> string|null` (the `url` field of the base64 JSON in the `p` parameter). The gate and the subject match stay as Task 8a wrote them; this task imports them.

- [ ] **Step 1: One-time shape check.** Through the Gmail connector in the session (never from the dev box's code), read ONE real inquiry notice's HTML part for its field labels only ("Getting married", "Guest count", "Wedding budget", "Location", whichever appear) and pin the labels, never the values, in the builder. Record what was found in a comment at the top of the builder.
- [ ] **Step 2: Tests:** each template parses from the builder; the message's UUID read direct and from a wrapped link; a malformed UUID yields `leadUuid: null`; a wedding date that does not parse yields `date: null`; the closed reason; an inquiry with an empty note parses to null; a message with an empty quote parses to null.
- [ ] **Step 3: fail. Step 4: Implement. Step 5: green. Step 6: Commit** `feat(inbox): Zola body parser`.

### Task 15: Lead capture, client creation, the cap, the backfill rule, Open in Zola

**Files:**
- Modify: `server/utils/inbox/zolaLeads.js`, `zolaLeads.test.js`, `gmailSync.js`, `gmailSync.test.js`, `constants.js`, `ARCHITECTURE.md` (the Zola lead flow in one paragraph; the tables are already documented)

**Interfaces:**
- `zolaLeads.applyNotice(db, { parsed, template, gmailRowId, duringBackfill, now }) -> { leadId, clientCreated, draftOwed }`: find-or-create the lead (Task 8b), fill uuid and date, `markClosed` on closed; when `template === 'inquiry'`, `!duringBackfill`, the lead was just created, and `countClientsCreatedSince(db, now - 24h) < ZOLA_CLIENT_DAILY_CAP`: `findOrCreateClient(db, { name: label, email: null, phone: null, source: 'zola', notes: 'Zola inquiry, no contact details yet' })` and `UPDATE zola_leads SET client_id = $1`; past the cap a Sentry warning at most once an hour and no client. The sync's Zola branch now stores `kind` by template, `text` from `parseZola`, `zola_unparsed` only when the parser returns null; a gate failure still drops and counts, and three in one day warn once.

- [ ] **Step 1: Tests:** client created only after switch-on and only for a created lead; not for a message notice; not past the cap (and the warning is hourly); closed stamps; an unparsed inquiry gets the fallback-label row and no client; the gate drop counts; `appLinkFor` for a lead with a uuid gives the lead URL and without one the dashboard URL (the folded Task 16).
- [ ] **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox): Zola lead capture creates the client, capped, never during the backfill`. **Checkpoint:** `security-review`.

### Task 16: The no-contact Send guard

**Files:**
- Modify: `server/routes/proposals/lifecycle.js` (the status transaction: add a `dbClient` read of the client's email and phone after the `SELECT status, group_id ... FOR UPDATE` at about 67 and before the UPDATE at about 98; the clients join at about 160 runs post-commit and is too late), `client/src/pages/admin/ProposalDetail.js:281-284` (971 lines, the ratchet blocks growth past 1000: the disable must add fewer than 29 net lines, else extract the Send confirm into a hook first)
- Create: `server/routes/proposals/lifecycle.sendGuard.test.js` (the `crud.test.js` harness)

This task protects exactly the state Task 15 creates (a client with neither email nor phone), so it ships in this lane.

- [ ] **Step 1: Test:** PATCH status `sent` on a proposal whose client has neither email nor phone answers 400 `VALIDATION_ERROR` with "Add an email or phone for this client before sending." and leaves the status unchanged; with an email it proceeds as today. **Step 2: fail. Step 3: Implement** (`throw new ValidationError({ client: 'Add an email or phone for this client before sending.' })` through the one `dbClient`, which rolls the transaction back as the handler's error path already does); the page disables Send with the same copy when the loaded client has neither. **Step 4: green; the client build. Step 5: Commit** `fix(proposals): Send refuses a client with no email and no phone`. **Checkpoint:** `security-review` on this task.

**Lane gate (zola-leads):** full fleet; the inbox suites plus `crud.test.js` and the new guard suite; the client build. Merge from `os` together with email-feed's state (spec 16).

---

## Lane email-ai

### Task 17: The read on email

**Files:**
- Modify: `server/utils/inbox/aiRead.js` (schema, prompt, caps), `aiRead.test.js`, `aiRedact.test.js` (two fixtures: a signature block with a phone and an address, and a quoted-address line, both fully redacted), `.claude/CLAUDE.md` (the `ANTHROPIC_API_KEY` row mentions email lines and the solicitation flag)

**Interfaces:**
- `InboundRead` gains `solicitation: z.boolean()`; `INBOUND_SYSTEM_PROMPT` gains the solicitation paragraph (spec section 6, verbatim) before the "No reply is needed" list and a fourth "Fill in" line: `- solicitation: true when the person is selling to us or asking us for something that is not a booking; otherwise false.`; per-channel caps: `preclipFor(channel)` is `EMAIL_PRECLIP_MAX` for `email` and `zola`, else `PRECLIP_CHARS`; `entryMaxFor(channel)` likewise with `EMAIL_LINE_MAX` and `MAX_ENTRY_CHARS`.

- [ ] **Step 1: Tests:** the schema accepts and requires `solicitation`; an email entry of 5,000 characters keeps 4,000, a text entry keeps 1,500; a Zola entry is treated as email; `[attachment]` and the subject prefix render in the line through `sliceText`; the two redaction fixtures. **Step 2: fail. Step 3: Implement. Step 4: green. Step 5: Commit** `feat(inbox-ai): email-sized lines, the solicitation field, redaction fixtures`.

### Task 18: The read job and the Pitch tag

**Files:**
- Modify: `server/utils/inbox/readJob.js` (`store`, `HELD_KEYS_SQL`, `isReadable`), `readJob.test.js`, `subjects.js`, `subjects.test.js`, `classify.js`, `rules.js`, `payload.js`, `payload.test.js`, `rules.states.test.js`, `client/src/components/inbox/WaitingRows.js` (the "Pitch" chip), `inboxListViews.test.js`

**Interfaces:**
- `store`: writes `solicitation`; when true forces `needs_reply = true`.
- `HELD_KEYS_SQL` adds the held client's `e-` key (`'e-' || left(encode(sha256(convert_to(lower(trim(c.email)), 'UTF8')), 'hex'), 16)`) and `'z-' || zl.id` for linked Zola leads.
- `subjects.inSlice` adds `zola_unread`; an outbound subject is keyed by `meta.readRef || ref` so suffixed siblings share one read; `isReadable` (aiRead.js) refuses a subject whose event carries `meta.legalHold` (the sibling flag Task 9 sets).
- `rules`: `pitch: boolean` on the waiting state (the newest counted inbound's read has `solicitation === true`); `payload` carries `pitch`; the row shows the "Pitch" chip (muted `StatusChip`).

- [ ] **Step 1: Tests:** forced `needs_reply`; the held keys include `e-` and `z-`; a sibling with `meta.legalHold` is not readable; two suffixed siblings yield one subject and one `inbox_reads` row; a pitch read leaves the item waiting with `pitch: true`; the chip renders for a `pitch` row. **Step 2: fail. Step 3: Implement. Step 4: green; the client build; a phone and desktop screenshot of a Pitch row for the lane's `ui-ux-review`. Step 5: Commit** `feat(inbox-ai): pitch stays waiting, one read per mail, held email keys`. **Checkpoint:** `security-review` and `code-review` (the paid path).

**Lane gate (email-ai):** full fleet; the inbox suites; the client build. Merge from `os`; the push gate holds until this lane is in.

---

## Lane zola-draft

### Task 19: The source CHECK and the draft

**Files:**
- Modify: `server/db/schema.sql` (a NEW DO block right after the add-if-missing one at 958-966), `server/db/index.js:198` (`CONSTRAINT_CONTRACT`: the entry for `proposals_source_check` with its widened values, the precedent for a twice-defined value-bearing CHECK), `server/routes/proposals/crud.test.js`, `server/utils/inbox/zolaLeads.js` (call the draft after `applyNotice` commits), `scripts/sensitive-paths.txt`
- Create: `server/utils/zolaProposalDraft.js`, `server/utils/zolaProposalDraft.test.js`

- [ ] **Step 1: The schema block**

```sql
-- Widening (spec 2026-10-14 section 5.6): the block above adds the CHECK only
-- when it is missing, so a value added there never reaches dev or prod. This
-- block is the live definition, the inbox_reads pattern. Rollback note: once a
-- row carries source = 'zola' the CHECK cannot be narrowed again; reverting the
-- lane leaves the widened CHECK in place, which is harmless.
DO $$ BEGIN
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_source_check;
  ALTER TABLE proposals ADD CONSTRAINT proposals_source_check
    CHECK (source IS NULL OR source IN ('thumbtack','zola'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply to the dev DB** with the Task 4 `initDb()` command, then `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'proposals_source_check'` shows `'zola'`.

- [ ] **Step 3: Tests** (`zolaProposalDraft.test.js`, dev DB, cleaning its rows): `createDraftProposalFromZolaLead({ leadId })` creates a draft with package `the-core-reaction`, `num_bars` 0, `guest_count` 50, `duration_hours` 4, `event_type` `wedding-reception`, `event_date` the lead's date, `event_start_time` `17:00`, `source` `zola`, `status` `draft`, admin notes carrying the note and the lead link, an activity log row `created` by `system`; idempotent (a second call returns the same id); no date means no draft; no client means no draft; a date that arrives with a later message notice draws the draft then; a failure is captured with the tag `{ feed: 'zola', step: 'draft' }`; a `crud.test.js` case inserts `source = 'zola'` and reads it back.

- [ ] **Step 4: Implement** by copying `createDraftProposalFromLead`'s transaction shape (`FOR UPDATE` on the `zola_leads` row, `calculateProposal`, `insertProposalRecord`, `proposal_activity_log`, `UPDATE zola_leads SET proposal_id`), called from `zolaLeads` after `applyNotice`'s commit inside a try with `Sentry.captureException(err, { tags: { feed: 'zola', step: 'draft' } })`. Add `server/utils/zolaProposalDraft.js` to the sensitive list.

- [ ] **Step 5: green. Step 6: Commit** `feat(inbox): Zola draft proposal, the source CHECK widened by a live block`. **Checkpoint:** `database-review` and `code-review`.

### Task 20: The source consumers

**Files:**
- Modify: `server/routes/proposals/list.js:103-106` (`else if (source === 'zola') whereClause += " AND p.source = 'zola'"`), `server/routes/proposals/metadata.js:313-316` (accept `zola`; its clause `source = 'zola'`), `client/src/pages/admin/ProposalsDashboard.js:20` (`['thumbtack', 'zola', 'manual']`) and `:348-350` (`<option value="zola">Zola</option>`), `client/src/components/admin/SourceBadge.js:7` (render for `zola` with the label "Zola"), `client/src/pages/admin/overview/FunnelCard.js:39-56` (`if (key === 'zola') return 'Zola';` and the href `/proposals?cohort=quoted&source=zola${rq}`), `ARCHITECTURE.md`

- [ ] **Step 1: Edit. Step 2:** `node --test server/routes/proposals/crud.filters.test.js` (seeds `source` rows and exercises the filter) and `node --test server/routes/proposals/list.sort.test.js`, then the client build; open the proposals dashboard on the dev server and pick Zola in the source filter: the list narrows and the badge shows. **Step 3: Commit** `feat(proposals): Zola as a proposal source in the list, counts, badge and funnel`.

**Lane gate (zola-draft):** full fleet; the proposal suites and the inbox suites that import `zolaLeads`; the client build.

---

## Self-review (2026-10-14, re-run after the plan fleet)

- **Spec coverage:** 3.1 to 3.4 (Tasks 1, 2, 8c, 11); 3.5 to 3.8 (Tasks 7, 8c, 10a); 3.9 (Task 10a); 3.10 (Tasks 9, 10a, 10b); 3.11 (Tasks 15, 19); 3.12 (Tasks 17, 18); 3.13 (Task 17); 3.14 (Tasks 8a, 8c, 14, 15); 3.15 (Tasks 8c, 15); 3.16 (Tasks 5, 8c); 3.17 (Task 10b); 3.18 (Tasks 2, 3); 3.19 (Task 10a); 3.20 (Task 8c); 4.x (Tasks 10a, 10b, 12, 18); 5.1 to 5.4 (Tasks 7, 9, 10a); 5.5 (Tasks 8c, 11); 5.6 (Tasks 8a, 8b, 14, 15, 16, 19, 20); 5.7 (Task 5); 6 (Tasks 9, 10c, 17, 18); 7 (Tasks 4, 19); 8 (Tasks 10b, 10c); 9 (every task); 10 (Tasks 1, 2); 11 (Tasks 12, 18); 12 (Tasks 8c, 10a); 13 (Tasks 3, 13); 14 (every task's tests; the prod acceptance list is the switch-on walk, Task 13 writes it into walkthroughs-owed); 16 (the lane map, the push gate); 17 items 31 to 36 (Tasks 8a to 8c, 1, 9, 12, 16).
- **Placeholders:** none.
- **Type consistency:** `createGmailClient`, `makeGmailSyncTick`, `ensureStateRow`, `claimLease`, `zolaAuthPasses`, `zolaTemplateOf`, `labelKey`, `fallbackLabel`, `findOrCreateLead`, `applyNotice`, `parseZola`, `extractText`, `resolveEmail`, `keyByEmailHash`, `zolaKey`, `appLinkFor(personKey, index, events)`, `readRef`, `toAddresses`, `isPersonal(events, index)`, `isPersonalPerson`, `preclipFor`, `entryMaxFor` are named once and reused.
- **Review Focus:** the five lines each name their task and test (Tasks 9, 9, 7, 8a, 10a).

## Zola restructure (Dallas, 2026-10-14, after the plan fleet)

Dallas: the Zola part must follow the Thumbtack path in full, and that path is "the first element of the Zola part". Zola has no webhook, so a box agent (the Thumbtack harvester's shape: a logged-in vendor profile under systemd on the box, a server surface behind a shared secret) opens each new lead's page, pulls the couple's contact and event data, and the existing path runs from there: client with real contacts, a draft with real fields, and an automated first reply sent through the Zola site by the agent ("automated the way thumbtack does"). That is a separate spec, brainstormed before lanes 3 and 5 here are cut; those two lanes then shrink to consuming the pipeline's lead rows and fields. Lanes 1, 2 and 4 proceed unchanged. First step of that spec: a throwaway spike on the box, one real lead page, read-only, to learn which fields Zola renders and whether the couple's email and phone show before booking.

## Carry-forward from lane gmail-client's fleet (2026-10-14)

The gmail-client fleet (security, code, consistency) found three things the Task 8c tick must handle; they are requirements for lane email-feed, each with a test.
1. **A message that vanished before it was fetched.** History can name a message id that is gone by the fetch (a draft autosave replaces its id; a deleted message). `getMessage` now returns `GmailNotFoundError` for a 404 on one message. `processOne` counts it `dropped` and moves on; it is never a tick-level throw, or every tick fails on the same window and the feed reads failing forever. Test: `a vanished message is dropped and the window advances`. Optionally skip `DRAFT` from the history record's `labelIds` before fetching.
2. **A partial page must not loop.** `listMessages` defaults to 100 ids and the tick stops at `GMAIL_SYNC_MAX_PER_TICK` (50) or `GMAIL_SYNC_TICK_MS`; the sketch then leaves the cursor where it was, so the next tick re-lists the same page, re-fetches the same oldest ids (a dropped mail leaves no row; a stored one still costs a fetch and counts toward the cap) and never gets past it. Required: ids already in `gmail_messages` are skipped before any fetch and do not count toward the cap, and progress inside a page survives the tick (persist the offset, or a seen-set for dropped ids), with `maxResults` no larger than the cap. Same rule for a history window and the dated resync. Test: `a backfill page larger than the per-tick cap finishes across ticks`.
3. **Suites always inject the client.** With no key, `createGmailClient()` returns null before its `NODE_ENV=test` refusal, so a tick test that forgets `deps.client` reads as "feed off" and an assertion like "nothing stored" passes vacuously. Every positive tick test asserts a non-zero `stored` count.
Noted, not changed: Gmail answers some per-user rate limits with 403, which the client classes as `GmailAuthError` (spec section 10). The sequential tick at 50 gets a minute is far under the per-user quota, so a "Gmail failing" auth streak with a working key would point here first. Errors also carry `stage` (`token` or `api`); `recordTickError` stores the class, and may store the stage, never more.

## Carry-forward from lane email-feed's checkpoint (2026-10-15), for lane email-ai

The Tasks 9 to 10c consistency check named four things Task 18 owns (inside the push gate, not regressions):
1. `subjects.inSlice` does not include `zola_unread` yet (spec 17 item 25).
2. `HELD_KEYS_SQL` carries no `e-` or `z-` keys; the engine's sibling flag (`meta.legalHold`, set in `computeSnapshot` by `markHeldSiblings`) is the email path's hold, and `aiRead.isReadable` must refuse an event that carries it.
3. **The readRef trap.** Outbound gm subjects still use the suffixed ref (`gm:<id>:n`, one event per recipient). When Task 18 moves `subjectRef` to `meta.readRef` (one read per mail), every lookup that compares a slice line's ref to the subject ref must compare on `readRef` too: `readJob.js` (the `slice.find(e.ref === subjectRef)` near line 81), `aiRead.subjectEntry` and `subjects.resolved`. Miss one and every multi-recipient mail becomes unreadable. Test: a Sent mail to a client and a planner is read once and both events carry the verdict.
4. The personal skip already ships in `subjects.buildSubjects` and `getReadSubjects` (lane email-feed); Task 18 keeps both.

## Execution

Dallas's standing method: Claude cuts each lane, builds it (one pass for a coherent lane, parallel subagents for independent pieces, stated at the time), runs the mid-lane checkpoints named above and the per-lane fleet, merges by squash from `os`. Order: gmail-client; email-feed; then zola-leads and email-ai in parallel; then zola-draft. **Push gate:** no push carries email-feed until zola-leads and email-ai are merged too, and the key is not set in Render before that push; the live probe run is Dallas's, after the push, with the key in that command's environment only. No push without his own imperative cue.

**Switch-on check (lane email-feed's fleet, 2026-10-15):** before the Gmail key goes into Render, confirm `INBOX_OWN_EMAILS` in Render holds the business's older Gmail address. A Zola notice addressed only to that address passes the replay gate (spec 17 item 48) only through that setting; without it such a notice is dropped as a gate failure.
