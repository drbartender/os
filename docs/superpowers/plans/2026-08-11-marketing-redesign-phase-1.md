# Marketing Redesign Phase 1: Tags, Suppression, Resolver, Contacts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Marketing section a real contact base: human-set tags on `clients`, a Do-not-contact gate that carries a reason, one shared audience resolver that every path goes through, and an Audiences tab where Dallas can classify 184 never-tagged contacts by hand.

**Architecture:** One server-side resolver module owns mailability and audience membership; nothing else may re-derive either, and the client never reimplements a filter. Tags live in their own table so each carries who set it and when. Do-not-contact displays as a tag but is backed by dedicated columns, because it is the only one whose accidental removal emails someone who asked not to be emailed. Contact message history is a union across three tables because no single one can hold it.

**Tech Stack:** Node.js 26 / Express 4, raw SQL via `pg` (no ORM), React 18 (CRA) / React Router 6, vanilla CSS in `index.css`, `node:test` for server, `react-scripts test` for client.

**Spec:** `docs/superpowers/specs/2026-08-11-marketing-campaigns-design.md` (approved 2026-08-11, third revision)

**Design:** `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`

**Revision:** rewritten 2026-08-11 after the design-stage fleet returned 14 blockers against the first draft. The first draft's test harness was fabricated: it invented a `users` table shape, a JWT payload shape, and an error-middleware field, none of which matched the codebase, and every route test would have hung or 401'd before an assertion ran. **The harness in this revision was executed against the real stack before this plan was written** (see Proven Harness below). Where this plan shows server code, the pattern was verified. Where it describes UI, it describes rather than inventing large speculative JSX; that is deliberate, not laziness.

**Scope:** Phase 1 only. Phases 2 and 3 are declared in the lane map with scope and dependencies, and get their own plans.

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string. Commas, colons, parentheses only.
- **Corporate is never inferred.** No code path may set a Corporate tag from an email domain or event history. Suggestions are surfaced for a human to accept; accepting is the only write.
- **One mailability predicate.** `isMailable` lives in `server/utils/marketingAudience.js` and is the only place the **seven** suppression conditions are expressed. No route, no query, no client component may restate them.
- **`communication_preferences` is tri-state.** Every existing check is `prefs.x === false`; an absent key means enabled. SQL tests `IS DISTINCT FROM 'false'`, never `= 'true'`.
- **Money units differ by source.** `proposals.total_price` and `proposals.amount_paid` are `NUMERIC(10,2)` **dollars**. `legacy_cc_proposals.total_cost_cents` is **cents**. Divide the cents column by 100.0. CLAUDE.md's integer-cents invariant does not hold for `proposals`.
- **Check Cherry joins on email, not id.** `lower(clients.email) = legacy_cc_proposals.client_email_normalized`. `client_id` is populated on only 197 of 1,230 rows.
- **Check Cherry clients are past clients.** Any audience meaning "has paid us" must accept a ledger-booked client, not only a `proposals` one. Gating on `proposals`-derived counts alone silently excludes the single largest cohort in the business, 184 people.
- **Event-type casing is doubled.** Normalize with `lower(replace(event_type, ' ', '-'))`.
- **Postgres has no `ADD CONSTRAINT IF NOT EXISTS`,** and `schema.sql` replays on every boot. Use the guarded `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...) THEN ... END IF; END $$;` form, verified at `schema.sql:931-938`. That exemplar raises loudly and has no EXCEPTION clause; what swallows failures is `server/db/index.js:173-215`, which eats `42710`/`42P16`, so a post-apply assertion is still required.
- All SQL parameterized (`$1`). Client-visible errors throw `AppError` subclasses, never `res.status(400).json(...)`.
- **One pooled connection per request.** A handler holding a `pool.connect()` client must route every query through it until `release()`. This applies to verification scripts too.
- Frontend API calls go through `client/src/utils/api.js` (baseURL already includes `/api`, so call `/marketing/...`). Never raw `fetch`/`axios`.
- **Server suites run ONE AT A TIME from the repo root:** `node -r dotenv/config --test <file>`. They share the dev DB.
- Client: `cd client && CI=true npx react-scripts test --watchAll=false <path>`. **Before any commit touching `client/`**, run `cd client && CI=true npx react-scripts build`. It is the only local gate that catches CI-fatal warnings.
- **File-size discipline:** `server/routes/emailMarketing.js` is at **987 lines** against the 1000-line hard cap. **No task may add a line to it.** Every new route goes in a new file. `npm run check:filesize` reports it under YELLOW (>700), which is expected; RED is >1000.
- **Do not touch `scheduled_messages`.** Phase 1 reads it and never writes it.
- **Test fixture emails must NOT use `.invalid`.** That is the house fixture domain, and `MAILABLE_SQL` suppresses it, so a `.invalid` fixture can never be mailable and would make a passing test meaningless. Use `@mkt-test.example`.

## Proven Harness

This exact shape was run against the real stack on 2026-08-11 and passed 4/4. Copy it verbatim into every route test. The three things it gets right are the three the first draft got wrong.

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const router = require('./marketingContacts');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, base, adminToken, managerToken, adminUserId, clientId;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  // `users` has NO `name` and NO `password`. Real columns: id, email,
  // password_hash, role, onboarding_status, created_at, updated_at
  // (schema.sql:12-20). role CHECK widened to ('staff','admin','manager')
  // at schema.sql:294-296.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`mkt-admin-${NONCE}@mkt-test.example`]
  );
  adminUserId = a.rows[0].id;
  const m = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'manager', 'approved') RETURNING id`,
    [`mkt-mgr-${NONCE}@mkt-test.example`]
  );

  // `auth` verifies decoded.userId and compares decoded.tokenVersion against
  // the row's token_version (auth.js:38,45). NOT decoded.id. Role comes from
  // the DB row, never from the token.
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ userId: m.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET);

  // Fixture email is NOT .invalid: MAILABLE_SQL suppresses that domain.
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`MKT ${NONCE}`, `mkt-${NONCE}@mkt-test.example`]
  );
  clientId = c.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  // AppError carries `statusCode`, NOT `status` (errors.js:6, and the real
  // handler at index.js:424 uses err.statusCode). Reading err.status yields
  // res.status(undefined), which THROWS and hangs the request forever.
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    const body = { error: err.message, code: err.code };
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    res.status(status).json(body);
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Order matters: children before parents, and pool.end() LAST.
  await pool.query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  await pool.query("DELETE FROM admin_audit_log WHERE metadata->>'client_id' = $1", [String(clientId)]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`mkt-%-${NONCE}@mkt-test.example`]);
  server.close();
  await pool.end();
});
```

Verified guard behavior: an admin token reaches an `adminOnly` route (200), a manager is refused (403), no token is 401, and a thrown `ValidationError` returns 400 with `fieldErrors` and does not hang.

## Verified fixture shapes

Also executed on 2026-08-11, inside a transaction that was rolled back.

- **`message_log`** requires `proposal_id` (NOT NULL, FK) and `recipient` (NOT NULL). `channel` CHECK is `('email','sms')`, `status` CHECK is `('sent','failed','bounced','complained')`.
  ```sql
  INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status, created_at)
  VALUES ($1, $2, 'email', 'proposal_sent', $3, 'sent', NOW() - INTERVAL '3 days')
  ```
- **`scheduled_messages`** `sent_at` is nullable with no default. A fixture with `status='sent'` must set it explicitly or every query filtering `sent_at IS NOT NULL` will not see the row.
  ```sql
  INSERT INTO scheduled_messages
    (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
     scheduled_for, sent_at, status)
  VALUES ('proposal', $1, 'retention_nudge', 'client', $2, 'email',
          NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 'sent')
  ```
- **`legacy_cc_proposals`** accepts `(cc_id, status, client_email_normalized, event_date, total_cost_cents)`; `raw_import_id`'s NOT NULL was dropped.
- **`GREATEST(NULL::date, '-infinity'::date)`** returns a JS **number** (`-Infinity`), not a string. Comparing it to `'-infinity'` is dead code. Guard with `Number.isFinite()` or let `JSON.stringify` serialize it to `null`, which it does.

## Lane map

```yaml
lanes:
  - id: mkt-a-tags
    phase: 1
    scope: >
      client_tags schema and the marketing_excluded columns, the tag vocabulary
      mirrored server and client, the tag write API, the Do-not-contact
      endpoint with its required reason and audit entry, and the GET
      /api/clients column allowlist that spec section 7 names.
    footprint:
      - server/db/schema.sql
      - server/utils/marketingTags.js
      - server/utils/marketingTags.test.js
      - server/routes/marketingContacts.js
      - server/routes/marketingContacts.tags.test.js
      - server/routes/clients.js
      - server/index.js
      - client/src/utils/marketingTags.js
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, database-review]

  - id: mkt-b-history
    phase: 1
    scope: >
      The contact message-history union across message_log,
      scheduled_messages, and email_sends, so automated sends are visible on
      the contact record. Independent of tags; runs in parallel with mkt-a.
    footprint:
      - server/utils/contactMessageHistory.js
      - server/utils/contactMessageHistory.test.js
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [code-review, consistency-check, database-review]

  - id: mkt-c-resolver
    phase: 1
    scope: >
      The shared mailability predicate and held-back classifier, tag
      suggestions, the seven audience definitions, the paginated contact-list
      endpoint with derived states and a held-back aggregate, and the contact
      detail endpoint.
    footprint:
      - server/utils/marketingAudience.js
      - server/utils/marketingAudience.test.js
      - server/utils/marketingSuggestions.js
      - server/utils/marketingSuggestions.test.js
      - server/routes/marketingContacts.js
      - server/routes/marketingContacts.list.test.js
      - server/routes/marketingContacts.detail.test.js
      - ARCHITECTURE.md
    # DEPENDS ON BOTH: Task 13 imports getContactMessageHistory from mkt-b, and
    # the router is already mounted in server/index.js by mkt-a, so merging
    # mkt-c without mkt-b is MODULE_NOT_FOUND at boot, not a 500.
    depends_on: [mkt-a-tags, mkt-b-history]
    review_fleet: [code-review, consistency-check, security-review, database-review]

  - id: mkt-d-contacts-ui
    phase: 1
    scope: >
      The Audiences tab: audience list, contact table with inline tag editing
      and quick filters, the Do-not-contact control with its reason prompt and
      remove confirmation, the held-back panel, and the contact drawer with
      event history and message history.
    footprint:
      - client/src/pages/admin/marketing/**
      - client/src/pages/admin/MarketingLayout.js
      - client/src/App.js
      - client/src/index.css
      - README.md
    depends_on: [mkt-a-tags, mkt-b-history, mkt-c-resolver]
    review_fleet: [code-review, consistency-check, ui-ux-review]

  # ─── Phase 2, its own plan. Declared so the graph is visible. ───
  - id: mkt-e-extract
    phase: 2
    scope: >
      Behavior-inert conversion of server/routes/emailMarketing.js (987 lines)
      into server/routes/emailMarketing/ behind a composition router, following
      server/routes/proposals/. Moves lead CRUD (:30-258), sequence handlers
      (:743-821), sequence steps (:658-742), and lead conversations (:856-939)
      with exact path preservation. Must land before any phase 2 feature code.
    depends_on: [mkt-d-contacts-ui]
    review_fleet: [code-review, consistency-check]

  - id: mkt-f-compliance
    phase: 2
    scope: >
      Unsubscribe GET-renders / POST-flips confirmation page (plain form; Helmet
      CSP at index.js:144-153 blocks inline JS); advisory `typ` claim on new
      tokens; retire the legacy all-leads send path and hide /schedule; real
      token on test sends; bounce-webhook split so a marketing complaint sets
      marketing_excluded instead of flipping email_status='bad'; admin control
      to clear a bad email_status. Dallas approved the webhook change
      2026-08-11. NOTE: the CAN-SPAM postal address is NOT in this lane; it
      already shipped as eb82e092 (footer) and 8240dd89 (legal pages).
    depends_on: [mkt-e-extract]
    review_fleet: [code-review, consistency-check, security-review]

  - id: mkt-g-send
    phase: 2
    scope: >
      Compose (Design / Recipients / Send) with the Look panel, the send route
      taking client_ids, paced serial sending, the send-once guard under FOR
      UPDATE, transient-429 versus daily-quota handling, dedupe by lowercased
      email on the send path (spec 4.3), email_sends.client_id plus the
      recipient CHECK, and the consumer sweep: the send-history INNER JOIN at
      emailMarketing.js:337-346, the webhook's lead_id UPDATE at
      emailMarketingWebhook.js:157-171, and the analytics aggregate at
      emailMarketing.js:826-835. Must also add a test exercising
      contactMessageHistory's campaign leg, which phase 1 cannot reach.
    depends_on: [mkt-f-compliance]
    review_fleet: [code-review, consistency-check, security-review, database-review]

  # ─── Phase 3, its own plan. ───
  - id: mkt-h-overview
    phase: 3
    scope: >
      Overview with moments (built-in rules, authored copy, per-field
      overrides, per-occurrence dismissal), the year-honestly numbers, the
      Needs You queue, and Sent with 30-day booked attribution.
    depends_on: [mkt-g-send]
    review_fleet: [code-review, consistency-check]
```

**Run order:** `mkt-a-tags` and `mkt-b-history` in parallel, then `mkt-c-resolver`, then `mkt-d-contacts-ui`.

---

# Lane mkt-a-tags

## Task 1: Schema for tags and Do-not-contact

**Files:** Modify `server/db/schema.sql` (append a new section at the end)

**Interfaces produced:** table `client_tags(client_id, tag, set_by, set_at)`; columns `clients.marketing_excluded`, `_reason`, `_at`, `_by`.

A table rather than an array column: each tag carries who set it and when, which an array cannot hold, and that audit trail is the entire reason Corporate is human-set.

- [ ] **Step 1: Append the schema block**

```sql
-- ─── Marketing tags and Do-not-contact (spec 2026-08-11) ───────────
-- Human-set marketing classification. Corporate is NEVER inferred: the email
-- domain measures as a coin flip in both directions (of 30 clients who booked
-- corporate work, 14 used a personal address; of 26 on company domains, 10
-- booked their own weddings). Suggestions are surfaced for a human to accept.
--
-- One row per (client, tag). set_by/set_at are the audit trail an array column
-- could not carry. Derived states (Paid client, Quoted only, Untagged) are
-- computed at read time and NEVER stored.
CREATE TABLE IF NOT EXISTS client_tags (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, tag)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_tags_tag_check'
  ) THEN
    ALTER TABLE client_tags ADD CONSTRAINT client_tags_tag_check
      CHECK (tag IN ('corporate','wedding','birthday','graduation','thumbtack'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_tags_tag ON client_tags(tag);

-- Do-not-contact. Displayed as a tag in the UI but deliberately NOT stored in
-- client_tags: it is the only classification whose accidental removal emails
-- someone who explicitly asked not to be emailed, so it carries a required
-- reason and an actor, and removal is a confirmed action rather than a click.
-- MARKETING ONLY. An excluded client who books still receives proposals,
-- invoices, and every operational message.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_excluded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_excluded_reason TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_excluded_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_excluded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_marketing_excluded_reason_check'
  ) THEN
    ALTER TABLE clients ADD CONSTRAINT clients_marketing_excluded_reason_check
      CHECK (
        marketing_excluded = false
        OR (marketing_excluded_reason IS NOT NULL AND length(btrim(marketing_excluded_reason)) > 0)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clients_marketing_excluded
  ON clients(marketing_excluded) WHERE marketing_excluded = true;
```

- [ ] **Step 2: Assert the objects installed**

`initDb` swallows `42710`/`42P16` (`server/db/index.js:173-215`), so a failed install boots clean and silently absent. Assert.

Create `server/scripts/verify-marketing-schema.js`:

```js
require('dotenv').config();
const { pool, initDb } = require('../db');

const WANT_CONSTRAINTS = ['client_tags_tag_check', 'clients_marketing_excluded_reason_check'];
const WANT_COLUMNS = [
  'marketing_excluded', 'marketing_excluded_at',
  'marketing_excluded_by', 'marketing_excluded_reason',
];

(async () => {
  await initDb();
  let ok = true;
  const table = (await pool.query("SELECT to_regclass('public.client_tags') AS t")).rows[0].t;
  if (!table) { console.error('MISSING TABLE: client_tags'); ok = false; }

  const cons = (await pool.query(
    'SELECT conname FROM pg_constraint WHERE conname = ANY($1)', [WANT_CONSTRAINTS]
  )).rows.map(r => r.conname);
  for (const c of WANT_CONSTRAINTS) {
    if (!cons.includes(c)) { console.error(`MISSING CONSTRAINT: ${c}`); ok = false; }
  }

  const cols = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'clients' AND column_name = ANY($1)`, [WANT_COLUMNS]
  )).rows.map(r => r.column_name);
  for (const c of WANT_COLUMNS) {
    if (!cols.includes(c)) { console.error(`MISSING COLUMN: clients.${c}`); ok = false; }
  }

  console.log(ok ? 'marketing schema OK' : 'marketing schema INCOMPLETE');
  await pool.end();
  process.exit(ok ? 0 : 1);
})();
```

Run from the repo root: `node server/scripts/verify-marketing-schema.js`
Expected: `marketing schema OK`, exit 0. A non-zero exit is a hard stop.

Keep the script. It is the post-apply assertion to run after the prod deploy replays `schema.sql`, which is where a swallowed failure actually matters.

- [ ] **Step 3: Prove the reason CHECK bites**

One pooled client for the whole transaction, per CLAUDE.md. Three separate `pool.query()` calls can land on three connections, in which case the UPDATE auto-commits and permanently flags a real dev client.

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT id FROM clients ORDER BY id LIMIT 1');
    await c.query('BEGIN');
    await c.query('UPDATE clients SET marketing_excluded = true WHERE id = \$1', [rows[0].id]);
    console.log('FAIL: excluded without a reason was accepted');
  } catch (e) {
    console.log('PASS: rejected ->', e.code);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
  }
})();
"
```

Expected: `PASS: rejected -> 23514`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql server/scripts/verify-marketing-schema.js
git commit -m "feat(marketing): schema for client tags and do-not-contact"
```

---

## Task 2: The tag vocabulary, server and client

**Files:** Create `server/utils/marketingTags.js`, `server/utils/marketingTags.test.js`, `client/src/utils/marketingTags.js`

**Interfaces produced:** `MARKETING_TAGS` (`[{id, label}]`), `TAG_IDS` (Set), `isValidTag(id)`, `DO_NOT_CONTACT_ID` (`'do-not-contact'`, never a `client_tags` value).

Two mirrored files because the client and server bundles are separate, following `eventTypes.js` and `gratuityLabels.js`. Say so in both.

- [ ] **Step 1: Write the failing test**

`server/utils/marketingTags.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MARKETING_TAGS, isValidTag, DO_NOT_CONTACT_ID } = require('./marketingTags');

test('MARKETING_TAGS matches the approved vocabulary in order', () => {
  assert.deepEqual(MARKETING_TAGS.map(t => t.id), [
    'corporate', 'wedding', 'birthday', 'graduation', 'thumbtack',
  ]);
});

test('every tag has a human label', () => {
  for (const t of MARKETING_TAGS) {
    assert.equal(typeof t.label, 'string');
    assert.ok(t.label.length > 0, `${t.id} has no label`);
  }
});

test('isValidTag accepts the vocabulary and rejects everything else', () => {
  assert.equal(isValidTag('corporate'), true);
  assert.equal(isValidTag('Corporate'), false, 'ids are lowercase, no case folding');
  assert.equal(isValidTag('vip'), false);
  assert.equal(isValidTag(''), false);
  assert.equal(isValidTag(null), false);
  assert.equal(isValidTag(undefined), false);
  assert.equal(isValidTag(123), false);
});

test('do-not-contact is NOT a client_tags value', () => {
  assert.equal(DO_NOT_CONTACT_ID, 'do-not-contact');
  assert.equal(isValidTag(DO_NOT_CONTACT_ID), false,
    'backed by clients columns; must never be insertable into client_tags');
});

test('the vocabulary matches the DB CHECK constraint exactly', () => {
  // schema.sql client_tags_tag_check. Drift here means a valid-looking tag
  // 23514s at insert time instead of 400ing at validation time.
  const fs = require('node:fs');
  const sql = fs.readFileSync(require('node:path').join(__dirname, '../db/schema.sql'), 'utf8');
  const m = sql.match(/client_tags_tag_check[\s\S]*?CHECK \(tag IN \(([^)]*)\)\)/);
  assert.ok(m, 'client_tags_tag_check not found in schema.sql');
  const inCheck = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(inCheck.sort(), MARKETING_TAGS.map(t => t.id).sort());
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/utils/marketingTags.test.js`
Expected: FAIL, `Cannot find module './marketingTags'`.

- [ ] **Step 3: Write the module**

`server/utils/marketingTags.js`:

```js
/**
 * Marketing tag vocabulary. Fixed enum, mirrored by the CHECK constraint
 * `client_tags_tag_check` in schema.sql and by client/src/utils/marketingTags.js.
 * Change all three together; a test pins this file against the constraint.
 *
 * Corporate is HUMAN-SET ONLY. Nothing may infer it from an email domain:
 * measured across every client with a proposal, 14 of the 30 who booked
 * corporate work used a personal address, and 10 of the 26 on company domains
 * were booking their own weddings and birthdays.
 */
const MARKETING_TAGS = [
  { id: 'corporate', label: 'Corporate' },
  { id: 'wedding', label: 'Wedding' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'graduation', label: 'Graduation' },
  { id: 'thumbtack', label: 'Thumbtack' },
];

const TAG_IDS = new Set(MARKETING_TAGS.map(t => t.id));

/**
 * Do-not-contact is shown alongside the tags in the UI but is backed by
 * clients.marketing_excluded and friends, never by a client_tags row, because
 * it needs a required reason and an actor. isValidTag deliberately rejects it
 * so a tag-write path can never smuggle it into client_tags.
 */
const DO_NOT_CONTACT_ID = 'do-not-contact';

function isValidTag(id) {
  return typeof id === 'string' && TAG_IDS.has(id);
}

module.exports = { MARKETING_TAGS, TAG_IDS, isValidTag, DO_NOT_CONTACT_ID };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/marketingTags.test.js`
Expected: PASS, 5/5.

- [ ] **Step 5: Mirror it for the client**

`client/src/utils/marketingTags.js`:

```js
/**
 * Marketing tag vocabulary, ESM mirror of server/utils/marketingTags.js.
 * Client and server bundles are separate, so these are hand-synced, the same
 * arrangement as eventTypes.js and gratuityLabels.js. The CHECK constraint
 * `client_tags_tag_check` in schema.sql is the third copy.
 * Change all three together.
 */
export const MARKETING_TAGS = [
  { id: 'corporate', label: 'Corporate' },
  { id: 'wedding', label: 'Wedding' },
  { id: 'birthday', label: 'Birthday' },
  { id: 'graduation', label: 'Graduation' },
  { id: 'thumbtack', label: 'Thumbtack' },
];

export const DO_NOT_CONTACT_ID = 'do-not-contact';

/** Derived states the server computes at read time. Never stored, never set. */
export const DERIVED_STATES = {
  paid: 'Paid client',
  quoted: 'Quoted only',
  untagged: 'Untagged',
};

export function tagLabel(id) {
  const t = MARKETING_TAGS.find(x => x.id === id);
  return t ? t.label : id;
}
```

- [ ] **Step 6: Run the client build before committing a client file**

Run: `cd client && CI=true npx react-scripts build && cd ..`
Expected: "Compiled successfully" or a clean build with no CI-fatal warnings. This is the plan's global constraint; do not skip it because the file is small.

- [ ] **Step 7: Commit**

```bash
git add server/utils/marketingTags.js server/utils/marketingTags.test.js client/src/utils/marketingTags.js
git commit -m "feat(marketing): tag vocabulary, server and client mirrors"
```

---

## Task 3: Tag write API

**Files:** Create `server/routes/marketingContacts.js`, `server/routes/marketingContacts.tags.test.js`; modify `server/index.js`

**Interfaces consumed:** `isValidTag`, `MARKETING_TAGS` (Task 2).
**Interfaces produced:** `PUT /api/marketing/contacts/:id/tags` taking `{ tags: string[] }`, returning `{ tags: string[] }`.

A new route file, not an addition to `emailMarketing.js` (987/1000).

**Auth is `adminOnly`, not `requireAdminOrManager`.** All 31 authenticated routes in `emailMarketing.js` use the looser guard; following that convention here would let a manager clear house-rule exclusions and read a full-client-base PII export.

- [ ] **Step 1: Write the failing test**

Create `server/routes/marketingContacts.tags.test.js` using the **Proven Harness** block verbatim, then append:

```js
test('sets tags and returns them in vocabulary order', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken,
    { tags: ['birthday', 'corporate'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['corporate', 'birthday']);
});

test('replaces the whole set, so removal works', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, []);
  const { rows } = await pool.query('SELECT 1 FROM client_tags WHERE client_id = $1', [clientId]);
  assert.equal(rows.length, 0, 'an empty array must clear every tag');
});

test('records who set each tag', async () => {
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['wedding'] });
  const { rows } = await pool.query(
    'SELECT set_by, set_at FROM client_tags WHERE client_id = $1 AND tag = $2', [clientId, 'wedding']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].set_by, adminUserId);
  assert.ok(rows[0].set_at instanceof Date);
});

test('rejects an unknown tag', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['vip'] });
  assert.equal(r.status, 400);
});

test('rejects do-not-contact, which is not a client_tags value', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken,
    { tags: ['do-not-contact'] });
  assert.equal(r.status, 400);
  const { rows } = await pool.query(
    "SELECT 1 FROM client_tags WHERE client_id = $1 AND tag = 'do-not-contact'", [clientId]);
  assert.equal(rows.length, 0);
});

test('rejects a non-array body', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: 'corporate' });
  assert.equal(r.status, 400);
});

test('404s an unknown client', async () => {
  const r = await req('PUT', '/api/marketing/contacts/99999999/tags', adminToken, { tags: [] });
  assert.equal(r.status, 404);
});

test('a manager cannot write tags', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, managerToken, { tags: ['corporate'] });
  assert.equal(r.status, 403);
});

test('an unauthenticated caller cannot write tags', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/tags`, null, { tags: ['corporate'] });
  assert.equal(r.status, 401);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: FAIL, `Cannot find module './marketingContacts'`.

- [ ] **Step 3: Write the route**

`server/routes/marketingContacts.js`:

```js
const express = require('express');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { MARKETING_TAGS, isValidTag } = require('../utils/marketingTags');

const router = express.Router();

// adminOnly, deliberately tighter than emailMarketing.js's requireAdminOrManager.
// These routes write the marketing classification and read names, emails, and
// lifetime spend across the whole client base.

const TAG_ORDER = MARKETING_TAGS.map(t => t.id);
const sortTags = (tags) => [...tags].sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b));

/** PUT /api/marketing/contacts/:id/tags — replace a contact's whole tag set. */
router.put('/contacts/:id/tags', auth, adminOnly, asyncHandler(async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) throw new ValidationError({ id: 'Invalid contact id.' });

  const { tags } = req.body || {};
  if (!Array.isArray(tags)) throw new ValidationError({ tags: 'tags must be an array of tag ids.' });

  const unique = [...new Set(tags)];
  const bad = unique.filter(t => !isValidTag(t));
  if (bad.length > 0) {
    // do-not-contact lands here on purpose: it is backed by clients columns and
    // has its own endpoint, so it must never reach client_tags.
    throw new ValidationError({ tags: `Unknown tag(s): ${bad.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('Contact not found.');
    }
    // Replace-the-set semantics: the UI sends the full desired set, so removal
    // is expressed by omission. `tag <> ALL('{}')` is TRUE for every row, so an
    // empty array correctly clears everything (verified 2026-08-11).
    await client.query('DELETE FROM client_tags WHERE client_id = $1 AND tag <> ALL($2::text[])',
      [clientId, unique]);
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO client_tags (client_id, tag, set_by)
         SELECT $1, t, $3 FROM unnest($2::text[]) AS t
         ON CONFLICT (client_id, tag) DO NOTHING`,
        [clientId, unique, req.user.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  res.json({ tags: sortTags(unique) });
}));

module.exports = router;
```

- [ ] **Step 4: Mount it in the same commit**

In `server/index.js`, next to the existing `/api/email-marketing` mount:

```js
app.use('/api/marketing', require('./routes/marketingContacts'));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: PASS, 9/9.

- [ ] **Step 6: Confirm emailMarketing.js did not grow**

Run: `npm run check:filesize`
Expected: `server/routes/emailMarketing.js` at 987, listed under YELLOW (>700), no RED (>1000).

- [ ] **Step 7: Commit**

```bash
git add server/routes/marketingContacts.js server/routes/marketingContacts.tags.test.js server/index.js
git commit -m "feat(marketing): tag write API, admin only"
```

---

## Task 4: Do-not-contact endpoint

**Files:** Modify `server/routes/marketingContacts.js`, `server/routes/marketingContacts.tags.test.js`

**Interfaces consumed:** `logAdminAction({actorUserId, targetUserId, action, metadata})` from `server/utils/adminAuditLog.js` (signature verified).
**Interfaces produced:** `PUT /api/marketing/contacts/:id/do-not-contact` taking `{ excluded: boolean, reason?: string }`.

`admin_audit_log.target_user_id` FKs to `users(id)` (`schema.sql:2532`) and a client is not a user, so the client id rides in `metadata` with `targetUserId: null`. Precedent: `server/routes/admin/ccImport/proposalActions.js:74-81`.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/marketingContacts.tags.test.js`. The `after()` hook in the Proven Harness already deletes the audit rows, in the correct order, before `pool.end()`.

```js
test('setting do-not-contact requires a reason', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true });
  assert.equal(r.status, 400);
  const { rows } = await pool.query('SELECT marketing_excluded FROM clients WHERE id = $1', [clientId]);
  assert.equal(rows[0].marketing_excluded, false);
});

test('setting do-not-contact rejects a blank reason', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: '   ' });
  assert.equal(r.status, 400);
});

test('sets do-not-contact with a reason, actor, and timestamp', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: true, reason: 'Asked not to be emailed on the review reply' });
  assert.equal(r.status, 200);
  assert.equal(r.body.excluded, true);
  const { rows } = await pool.query(
    `SELECT marketing_excluded, marketing_excluded_reason, marketing_excluded_at, marketing_excluded_by
     FROM clients WHERE id = $1`, [clientId]);
  assert.equal(rows[0].marketing_excluded, true);
  assert.equal(rows[0].marketing_excluded_reason, 'Asked not to be emailed on the review reply');
  assert.ok(rows[0].marketing_excluded_at instanceof Date);
  assert.equal(rows[0].marketing_excluded_by, adminUserId);
});

test('writes an audit row with the client id in metadata, not target_user_id', async () => {
  const { rows } = await pool.query(
    `SELECT target_user_id, metadata FROM admin_audit_log
      WHERE action = 'marketing.do_not_contact.set' AND metadata->>'client_id' = $1
      ORDER BY created_at DESC LIMIT 1`, [String(clientId)]);
  assert.equal(rows.length, 1, 'audit row missing');
  assert.equal(rows[0].target_user_id, null, 'target_user_id FKs to users; a client is not a user');
  assert.equal(rows[0].metadata.reason, 'Asked not to be emailed on the review reply');
});

test('clearing nulls the reason, actor, and timestamp', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.excluded, false);
  const { rows } = await pool.query(
    `SELECT marketing_excluded, marketing_excluded_reason, marketing_excluded_at, marketing_excluded_by
     FROM clients WHERE id = $1`, [clientId]);
  assert.equal(rows[0].marketing_excluded, false);
  assert.equal(rows[0].marketing_excluded_reason, null);
  assert.equal(rows[0].marketing_excluded_at, null);
  assert.equal(rows[0].marketing_excluded_by, null);
});

test('a manager cannot set do-not-contact', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, managerToken,
    { excluded: true, reason: 'nope' });
  assert.equal(r.status, 403);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: the six new tests FAIL with 404 (route not mounted); the nine from Task 3 still PASS.

- [ ] **Step 3: Add the route**

Add to `server/routes/marketingContacts.js`:

```js
const { logAdminAction } = require('../utils/adminAuditLog');
```

```js
/**
 * PUT /api/marketing/contacts/:id/do-not-contact
 *
 * The house rule, distinct from the client's own unsubscribe. Gates MARKETING
 * ONLY: an excluded client who books still gets proposals, invoices, and every
 * operational message.
 *
 * Its own endpoint rather than a field on PUT /api/clients/:id, which
 * destructures a fixed 5-field body and updates via COALESCE($n, col) where
 * null means "leave unchanged", so that route structurally cannot clear this
 * flag or null the reason (clients.js:121-150).
 */
router.put('/contacts/:id/do-not-contact', auth, adminOnly, asyncHandler(async (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  if (!Number.isInteger(clientId)) throw new ValidationError({ id: 'Invalid contact id.' });

  const { excluded, reason } = req.body || {};
  if (typeof excluded !== 'boolean') {
    throw new ValidationError({ excluded: 'excluded must be true or false.' });
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (excluded && !trimmed) {
    throw new ValidationError({ reason: 'A reason is required to stop marketing to someone.' });
  }

  const { rows, rowCount } = await pool.query(
    `UPDATE clients SET
       marketing_excluded = $2,
       marketing_excluded_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
       marketing_excluded_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
       marketing_excluded_by = CASE WHEN $2 THEN $4 ELSE NULL END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING marketing_excluded, marketing_excluded_reason`,
    [clientId, excluded, trimmed || null, req.user.id]);
  if (rowCount === 0) throw new NotFoundError('Contact not found.');

  // target_user_id FKs to users(id) and a client is not a user, so the client
  // id rides in metadata (precedent: admin/ccImport/proposalActions.js:74-81).
  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: excluded ? 'marketing.do_not_contact.set' : 'marketing.do_not_contact.cleared',
    metadata: { client_id: clientId, reason: trimmed || null },
  });

  res.json({ excluded: rows[0].marketing_excluded, reason: rows[0].marketing_excluded_reason });
}));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: PASS, 15/15.

- [ ] **Step 5: Commit**

```bash
git add server/routes/marketingContacts.js server/routes/marketingContacts.tags.test.js
git commit -m "feat(marketing): do-not-contact endpoint with required reason and audit"
```

---

## Task 5: Surface the new columns on GET /api/clients

**Files:** Modify `server/routes/clients.js`

Spec section 7 names this explicitly. `GET /api/clients` (`clients.js:30-33`) uses an explicit column allowlist that will never return the new columns, so the existing ClientsDashboard can neither show nor manage the exclusion. `GET /api/clients/:id` is `SELECT *` and picks them up for free.

`marketing_excluded_reason` is admin-visible free text about a client relationship. The list route is `requireAdminOrManager`, so return the boolean only; the reason stays on the detail route and the marketing endpoints, both of which are tighter.

- [ ] **Step 1: Add the column to the SELECT**

In `clients.js`, in the `GET /` allowlist, add `c.marketing_excluded` after `c.cc_id`.

- [ ] **Step 2: Verify the list route returns it**

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  const { rows } = await pool.query(
    'SELECT c.id, c.marketing_excluded FROM clients c ORDER BY c.id LIMIT 3');
  console.log(rows);
  await pool.end();
})();
"
```

Expected: three rows, each with `marketing_excluded: false`. Then confirm the route file compiles: `node -e "require('./server/routes/clients')"` exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/routes/clients.js
git commit -m "feat(marketing): expose marketing_excluded on the clients list"
```

---

## Task 6: Documentation for lane mkt-a-tags

**Files:** Modify `ARCHITECTURE.md`, `README.md`

Each lane carries its own doc step. The squash commit is the unit that reaches `main`, so batching docs into a later lane lands this lane undocumented.

`ARCHITECTURE.md`'s route tables are **per-router sections using relative paths** with a Yes/No-style Auth column (e.g. `| GET | \`/me\` | Yes | … |` under `### Authentication — /api/auth`). Match that; do not add absolute `/api/marketing/...` rows to some other section.

- [ ] **Step 1: Add a new route section to ARCHITECTURE.md**

```
### Marketing Contacts — /api/marketing

| Method | Path | Auth | Description |
|---|---|---|---|
| PUT | `/contacts/:id/tags` | Admin | Replace a contact's marketing tag set |
| PUT | `/contacts/:id/do-not-contact` | Admin | Set or clear the house do-not-contact rule (reason required) |
```

- [ ] **Step 2: Add the schema to ARCHITECTURE.md's Database Schema section**

```
**client_tags** — human-set marketing classification, one row per (client, tag),
with set_by/set_at. Fixed enum mirrored in server/utils/marketingTags.js,
client/src/utils/marketingTags.js, and the client_tags_tag_check constraint;
a test pins the module against the constraint. Corporate is never inferred.

**clients.marketing_excluded / _reason / _at / _by** — the house do-not-contact
rule, distinct from the client's own communication_preferences.marketing_enabled
unsubscribe. Marketing only; operational mail is unaffected. Setting requires a
reason; the only writer is PUT /api/marketing/contacts/:id/do-not-contact.
```

- [ ] **Step 3: Add to README.md's folder tree**

`server/routes/marketingContacts.js`, `server/utils/marketingTags.js`, `server/scripts/verify-marketing-schema.js`, `client/src/utils/marketingTags.js`.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs(marketing): tag routes, schema, and folder tree"
```

---

# Lane mkt-b-history

## Task 7: Contact message history

**Files:** Create `server/utils/contactMessageHistory.js`, `server/utils/contactMessageHistory.test.js`

**Interfaces produced:** `getContactMessageHistory(clientId, { limit = 50 }) -> Promise<Array<{at, channel, kind, label, automated, source}>>`, newest first.

This cannot be built on `message_log` alone: `message_log.proposal_id` is `INTEGER NOT NULL` (`schema.sql:3542`) and `logClientMessage` returns early without one (`messageLog.js:88`), so the 254 proposal-less clients and the Check Cherry cohort log nothing there.

`email_sends.client_id` does not exist until phase 2, so its leg sits behind a column probe and returns nothing today. That is correct, not a bug. Lane `mkt-g-send` owns the test that exercises it.

- [ ] **Step 1: Write the failing test**

`server/utils/contactMessageHistory.test.js`. Fixture shapes below were executed on 2026-08-11: `message_log` needs `proposal_id` and `recipient`; `scheduled_messages` needs an explicit `sent_at`.

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { getContactMessageHistory } = require('./contactMessageHistory');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `cmh-${NONCE}@mkt-test.example`;
let clientId, proposalId, emptyClientId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [`CMH ${NONCE}`, EMAIL]);
  clientId = c.rows[0].id;
  const e = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [`CMH empty ${NONCE}`, `cmh-e-${NONCE}@mkt-test.example`]);
  emptyClientId = e.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price)
     VALUES ($1, CURRENT_DATE - 30, 'completed', 500) RETURNING id`, [clientId]);
  proposalId = p.rows[0].id;

  // message_log: proposal_id NOT NULL, recipient NOT NULL,
  // channel CHECK ('email','sms'), status CHECK ('sent','failed','bounced','complained')
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status, created_at)
     VALUES ($1, $2, 'email', 'proposal_sent', $3, 'sent', NOW() - INTERVAL '3 days')`,
    [proposalId, clientId, EMAIL]);

  // scheduled_messages.sent_at is nullable with NO default. status='sent'
  // without it makes the row invisible to any `sent_at IS NOT NULL` filter.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, sent_at, status)
     VALUES ('proposal', $1, 'retention_nudge', 'client', $2, 'email',
             NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 'sent')`,
    [proposalId, clientId]);
});

after(async () => {
  await pool.query(
    'DELETE FROM scheduled_messages WHERE recipient_type = $1 AND recipient_id = $2', ['client', clientId]);
  await pool.query('DELETE FROM message_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[clientId, emptyClientId]]);
  await pool.end();
});

test('returns entries newest first across both sources', async () => {
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.length, 2);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(new Date(rows[i - 1].at) >= new Date(rows[i].at), 'not sorted newest first');
  }
});

test('marks dispatcher touches automated and message_log ones not', async () => {
  const rows = await getContactMessageHistory(clientId);
  const nudge = rows.find(r => r.kind === 'retention_nudge');
  const proposal = rows.find(r => r.kind === 'proposal_sent');
  assert.ok(nudge, 'retention_nudge missing');
  assert.equal(nudge.automated, true);
  assert.equal(nudge.source, 'scheduled_messages');
  assert.ok(proposal, 'proposal_sent missing');
  assert.equal(proposal.automated, false);
  assert.equal(proposal.source, 'message_log');
});

test('a pending future touch is a plan, not history', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel,
        scheduled_for, status)
     VALUES ('proposal', $1, 'new_year_hello', 'client', $2, 'email',
             NOW() + INTERVAL '90 days', 'pending')`,
    [proposalId, clientId]);
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.find(r => r.kind === 'new_year_hello'), undefined);
});

test('a client with no messages returns an empty array, not null', async () => {
  assert.deepEqual(await getContactMessageHistory(emptyClientId), []);
});

test('respects the limit', async () => {
  assert.equal((await getContactMessageHistory(clientId, { limit: 1 })).length, 1);
});

test('a non-numeric id returns empty rather than throwing', async () => {
  assert.deepEqual(await getContactMessageHistory('nope'), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/contactMessageHistory.test.js`
Expected: FAIL, `Cannot find module './contactMessageHistory'`.

- [ ] **Step 3: Write the module**

```js
const { pool } = require('../db');

/**
 * Every message a contact has actually received, newest first, across the
 * three tables that hold them.
 *
 * WHY A UNION
 * -----------
 * message_log cannot hold this alone: message_log.proposal_id is INTEGER NOT
 * NULL (schema.sql:3542) and logClientMessage returns early without one
 * (messageLog.js:88), so the 254 proposal-less clients and the whole Check
 * Cherry cohort have nothing there. The automated lifecycle and marketing
 * touches live in scheduled_messages; campaign sends will live in email_sends
 * once phase 2 adds its client_id column.
 *
 * This view is what makes the design's promise true, that automations "show up
 * on the contact's record so you never double-tap someone".
 *
 * Only rows that actually went out are history. A pending future touch is a
 * plan, not a record.
 */
async function getContactMessageHistory(clientId, { limit = 50 } = {}) {
  const id = parseInt(clientId, 10);
  if (!Number.isInteger(id)) return [];
  const cap = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // email_sends.client_id arrives in phase 2 (lane mkt-g-send). Probe rather
  // than depend on it, so this module works before and after that column exists.
  const { rows: colRows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'email_sends' AND column_name = 'client_id' LIMIT 1`);
  const campaignLeg = colRows.length > 0 ? `
    UNION ALL
    SELECT es.sent_at AS at, 'email' AS channel, 'campaign' AS kind,
           COALESCE(ec.name, es.subject) AS label, false AS automated,
           'email_sends' AS source
      FROM email_sends es
      LEFT JOIN email_campaigns ec ON ec.id = es.campaign_id
     WHERE es.client_id = $1 AND es.status = 'sent' AND es.sent_at IS NOT NULL
  ` : '';

  const { rows } = await pool.query(`
    SELECT * FROM (
      SELECT ml.created_at AS at, ml.channel, ml.message_type AS kind,
             ml.message_type AS label, false AS automated, 'message_log' AS source
        FROM message_log ml
       WHERE ml.client_id = $1 AND ml.status = 'sent'

      UNION ALL

      SELECT sm.sent_at AS at, sm.channel, sm.message_type AS kind,
             sm.message_type AS label, true AS automated, 'scheduled_messages' AS source
        FROM scheduled_messages sm
       WHERE sm.recipient_type = 'client' AND sm.recipient_id = $1
         AND sm.status = 'sent' AND sm.sent_at IS NOT NULL
      ${campaignLeg}
    ) h
    ORDER BY h.at DESC
    LIMIT $2
  `, [id, cap]);

  return rows;
}

module.exports = { getContactMessageHistory };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/contactMessageHistory.test.js`
Expected: PASS, 6/6.

- [ ] **Step 5: Document and commit**

Add to `ARCHITECTURE.md`, in the relevant section: `contactMessageHistory.js` unions `message_log`, `scheduled_messages`, and (from phase 2) `email_sends`, because `message_log.proposal_id` is NOT NULL and cannot hold a send to a proposal-less client.

```bash
git add server/utils/contactMessageHistory.js server/utils/contactMessageHistory.test.js ARCHITECTURE.md
git commit -m "feat(marketing): contact message history across log, dispatcher, and campaigns"
```

---

# Lane mkt-c-resolver

## Task 8: The mailability predicate and held-back classifier

**Files:** Create `server/utils/marketingAudience.js`, `server/utils/marketingAudience.test.js`

**Interfaces produced:** `MAILABLE_SQL` (parameter-free fragment, alias `c` = clients, `lu` = the lead-unsub lateral), `LEAD_UNSUB_LATERAL`, `HELD_BACK_REASONS`, `isMailable(row)`, `heldBackReason(row)`.

**Seven conditions**, all of which must hold. `isMailable` and `heldBackReason` must be exact complements: every row `isMailable` rejects gets a non-null reason, and every row it accepts gets null. The first draft covered 5 of 7 in the classifier, which left the Check Cherry cohort showing `mailable:false` with no reason.

1. `communication_preferences.marketing_enabled` is not `false`
2. `communication_preferences.email_enabled` is not `false`
3. `marketing_excluded` is `false`
4. `email` is present and non-blank
5. `email_status` is not `'bad'`
6. the address is not an `.invalid` placeholder
7. no `email_leads` row for the same address is `unsubscribed`

Condition 7 matters because 9 of the 15 `email_leads` rows are also clients.

`isPlaceholderEmail` is confirmed to exist at `server/utils/emailValidation.js:82` and is exactly `endsWith('.invalid')`, so the JS and SQL legs genuinely agree.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMailable, heldBackReason, MAILABLE_SQL, HELD_BACK_REASONS,
} = require('./marketingAudience');

const ok = {
  email: 'a@b.com', email_status: 'ok', marketing_excluded: false,
  communication_preferences: {}, lead_unsubscribed: false,
};

test('a clean contact is mailable with no held-back reason', () => {
  assert.equal(isMailable(ok), true);
  assert.equal(heldBackReason(ok), null);
});

test('absent preference keys mean enabled (tri-state)', () => {
  assert.equal(isMailable({ ...ok, communication_preferences: null }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: {} }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: { marketing_enabled: true } }), true);
});

const CASES = [
  ['marketing opt-out', { communication_preferences: { marketing_enabled: false } }, 'unsubscribed'],
  ['email opt-out',     { communication_preferences: { email_enabled: false } },     'unsubscribed'],
  ['house rule',        { marketing_excluded: true },                                'do_not_contact'],
  ['null address',      { email: null },                                             'no_address'],
  ['blank address',     { email: '   ' },                                            'no_address'],
  ['bad status',        { email_status: 'bad' },                                     'bounced'],
  ['placeholder',       { email: 'x@arthrex-chicago.invalid' },                      'no_address'],
  ['lead unsubscribe',  { lead_unsubscribed: true },                                 'unsubscribed'],
];

for (const [name, patch, reason] of CASES) {
  test(`${name} holds the contact back with reason ${reason}`, () => {
    const row = { ...ok, ...patch };
    assert.equal(isMailable(row), false);
    assert.equal(heldBackReason(row), reason);
  });
}

test('isMailable and heldBackReason are exact complements', () => {
  for (const [name, patch] of CASES) {
    const row = { ...ok, ...patch };
    assert.equal(isMailable(row), heldBackReason(row) === null, `${name} disagrees`);
  }
  assert.equal(isMailable(ok), heldBackReason(ok) === null);
});

test('every reason isMailable can produce is declared in HELD_BACK_REASONS', () => {
  for (const [, patch, reason] of CASES) {
    assert.ok(HELD_BACK_REASONS.includes(reason), `${reason} not in HELD_BACK_REASONS`);
  }
});

test('MAILABLE_SQL is parameter-free and tri-state', () => {
  assert.equal(typeof MAILABLE_SQL, 'string');
  assert.ok(!/\$\d/.test(MAILABLE_SQL), 'must not contain bind parameters');
  assert.ok(MAILABLE_SQL.includes("IS DISTINCT FROM 'false'"), 'must be tri-state, never = true');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: FAIL, `Cannot find module './marketingAudience'`.

- [ ] **Step 3: Write the module**

```js
const { isPlaceholderEmail } = require('./emailValidation');

/**
 * THE single definition of who may receive marketing. Nothing else may restate
 * these conditions: the contact list filters with MAILABLE_SQL, the send path
 * re-checks with isMailable, and the tests hold the JS legs as exact
 * complements. Three hand-written copies is how a suppression rule drifts and
 * someone who asked not to be emailed gets emailed.
 *
 * communication_preferences is TRI-STATE. Every existing check is
 * `prefs.x === false`, and an absent key means enabled, so the SQL tests
 * IS DISTINCT FROM 'false' rather than = 'true'. A row whose JSONB simply
 * lacks the key would otherwise be silently excluded.
 */

// Alias `c` = clients. Alias `lu` = LEAD_UNSUB_LATERAL, which must be joined.
const MAILABLE_SQL = `
  (c.communication_preferences->>'marketing_enabled') IS DISTINCT FROM 'false'
  AND (c.communication_preferences->>'email_enabled') IS DISTINCT FROM 'false'
  AND c.marketing_excluded = false
  AND c.email IS NOT NULL
  AND btrim(c.email) <> ''
  AND lower(c.email) NOT LIKE '%.invalid'
  AND COALESCE(c.email_status, '') <> 'bad'
  AND NOT COALESCE(lu.unsubscribed, false)
`;

/**
 * Supplies `lu.unsubscribed`. Kept beside MAILABLE_SQL so the two cannot be
 * used apart. 9 of the 15 email_leads rows are also clients, so someone who
 * unsubscribed from the one historical blast must not be re-mailable here.
 */
const LEAD_UNSUB_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT true AS unsubscribed
      FROM email_leads el
     WHERE lower(el.email) = lower(c.email) AND el.status = 'unsubscribed'
     LIMIT 1
  ) lu ON true
`;

const HELD_BACK_REASONS = ['do_not_contact', 'unsubscribed', 'bounced', 'no_address'];

function isMailable(row) {
  return heldBackReason(row) === null;
}

/**
 * Why a contact is held back, or null when they are mailable. Covers all seven
 * conditions; isMailable is defined in terms of this so the two can never
 * disagree. Order is deliberate: the house rule outranks an unsubscribe in the
 * UI, and a missing address outranks a bad status because it is more actionable.
 */
function heldBackReason(row) {
  if (!row) return 'no_address';
  if (row.marketing_excluded === true) return 'do_not_contact';
  const prefs = row.communication_preferences || {};
  if (prefs.marketing_enabled === false) return 'unsubscribed';
  if (prefs.email_enabled === false) return 'unsubscribed';
  if (row.lead_unsubscribed === true) return 'unsubscribed';
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  if (!email) return 'no_address';
  if (isPlaceholderEmail(email)) return 'no_address';
  if (row.email_status === 'bad') return 'bounced';
  return null;
}

module.exports = {
  MAILABLE_SQL, LEAD_UNSUB_LATERAL, HELD_BACK_REASONS, isMailable, heldBackReason,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: PASS, 14/14.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingAudience.js server/utils/marketingAudience.test.js
git commit -m "feat(marketing): single mailability predicate and held-back classifier"
```

---

## Task 9: Tag suggestions

**Files:** Create `server/utils/marketingSuggestions.js`, `server/utils/marketingSuggestions.test.js`

**Interfaces produced:** `suggestTag(facts) -> { tag, reason } | null`, where `facts` is `{ email, corporateEventCount, personalEventCount, largestGuestCount, venueName }`.

A suggestion is never applied. It renders with its reasoning and a one-click accept, and the accept goes through the Task 3 endpoint like any other human write. Event history outranks the domain in both directions.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestTag } = require('./marketingSuggestions');

test('corporate history on a personal address still suggests corporate', () => {
  // 14 of the 30 clients who booked corporate work used a personal address.
  const s = suggestTag({ email: 'someone@gmail.com', corporateEventCount: 1, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /corporate/i);
});

test('a company domain with only personal events does NOT suggest corporate', () => {
  // 10 of the 26 clients on company domains were booking their own weddings.
  const s = suggestTag({ email: 'bride@acmecorp.com', corporateEventCount: 0, personalEventCount: 1 });
  assert.equal(s, null);
});

test('a company domain with no history suggests corporate and admits it is a guess', () => {
  const s = suggestTag({ email: 'ops@acmecorp.com', corporateEventCount: 0, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /guess/i);
});

test('free mail with no history suggests nothing', () => {
  assert.equal(suggestTag({ email: 'nobody@gmail.com', corporateEventCount: 0, personalEventCount: 0 }), null);
});

test('guest count and venue strengthen the reason', () => {
  const s = suggestTag({
    email: 'faculty@calderwood.edu', corporateEventCount: 1, personalEventCount: 0,
    largestGuestCount: 180, venueName: 'Calderwood faculty reception',
  });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /180/);
  assert.match(s.reason, /Calderwood/);
});

test('handles a missing or malformed email without throwing', () => {
  assert.equal(suggestTag({ email: null, corporateEventCount: 0, personalEventCount: 0 }), null);
  assert.equal(suggestTag({ email: 'not-an-email', corporateEventCount: 0, personalEventCount: 0 }), null);
  assert.equal(suggestTag({}), null);
  assert.equal(suggestTag(), null);
});

test('no reason contains an em dash', () => {
  const s = suggestTag({ email: 'ops@acmecorp.com', corporateEventCount: 2, personalEventCount: 0,
    largestGuestCount: 90, venueName: 'HQ' });
  assert.ok(!s.reason.includes('—'), 'copy rule: no em dashes');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/marketingSuggestions.test.js`
Expected: FAIL, `Cannot find module './marketingSuggestions'`.

- [ ] **Step 3: Write the module**

```js
/**
 * Tag suggestions. A suggestion is NEVER applied: it is rendered next to the
 * contact with its reasoning and a one-click accept, and accepting goes
 * through the ordinary tag endpoint as a human write.
 *
 * The email domain is one weak input, never the decision. Measured across
 * every client with a proposal:
 *
 *                        corporate events only   personal events only
 *   company domain                  16                    10
 *   free mail                       14                   119
 *
 * Event history outranks the domain in both directions, and a domain-only
 * guess has to say out loud that it is a guess.
 */

const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com', 'icloud.com', 'outlook.com',
  'comcast.net', 'me.com', 'msn.com', 'sbcglobal.net', 'att.net', 'live.com',
  'ymail.com', 'hmail.com', 'protonmail.com', 'proton.me',
]);

function domainOf(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const dom = email.slice(at + 1).trim().toLowerCase();
  return dom.includes('.') ? dom : null;
}

function suggestTag(facts) {
  const f = facts || {};
  const { email, corporateEventCount = 0, personalEventCount = 0,
          largestGuestCount = null, venueName = null } = f;
  const dom = domainOf(email);
  if (!dom) return null;
  const isCompanyDomain = !FREE_MAIL.has(dom);

  if (corporateEventCount > 0) {
    const bits = [corporateEventCount === 1
      ? 'Booked a corporate event before'
      : `Booked ${corporateEventCount} corporate events before`];
    if (largestGuestCount) bits.push(`largest was ${largestGuestCount} guests`);
    if (venueName) bits.push(`at ${venueName}`);
    if (!isCompanyDomain) bits.push('on a personal address, which is common');
    return { tag: 'corporate', reason: `${bits.join(', ')}.` };
  }

  // A company domain with only personal events is the false positive the
  // numbers warn about. Say nothing rather than guess wrong.
  if (personalEventCount > 0) return null;

  if (isCompanyDomain) {
    return {
      tag: 'corporate',
      reason: `Uses a company address (${dom}), but nothing booked yet, so this is a guess.`,
    };
  }
  return null;
}

module.exports = { suggestTag, domainOf, FREE_MAIL };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/marketingSuggestions.test.js`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingSuggestions.js server/utils/marketingSuggestions.test.js
git commit -m "feat(marketing): tag suggestions that never auto-apply"
```

---

## Task 10: Audience definitions

**Files:** Modify `server/utils/marketingAudience.js`, `server/utils/marketingAudience.test.js`

**Interfaces produced:** `AUDIENCES` (`[{id, name, rule, includes, where}]`), `AUDIENCE_BY_ID`, `CONTACT_AGGREGATES` (the SQL joins every audience's `where` depends on).

Split from the endpoints so the definitions can be reviewed and reverted on their own.

Two corrections over the first draft, both fleet findings:

- **`agg.last_inbound` did not exist.** The real join is `clients` → `thumbtack_leads.client_id` → `thumbtack_messages.negotiation_id` filtered to `from_type = 'Customer'`. Verified against the schema.
- **Check Cherry clients were excluded from every "past client" audience.** `agg.paid_count` is proposals-only, so gating on it silently dropped 184 people, the largest cohort in the business. "Has paid us" now means `agg.paid_count > 0 OR cc.booked_count > 0`.

- [ ] **Step 1: Append the aggregates and definitions**

```js
/**
 * Per-client aggregates every audience `where` depends on. Aliases: c =
 * clients, agg = native proposals, cc = the Check Cherry ledger, tt = inbound
 * Thumbtack activity, tg = tags.
 *
 * MONEY UNITS DIFFER. proposals.amount_paid is NUMERIC(10,2) DOLLARS (units
 * legend schema.sql:575); legacy_cc_proposals.total_cost_cents is CENTS.
 * Summed naively a $760 Check Cherry booking reads as $76,000 and the whole
 * 184-person cohort floats to the top of any spend sort. Divide by 100.0.
 *
 * The Check Cherry join is on EMAIL, not client_id: client_id is populated on
 * only 197 of that table's 1,230 rows.
 */
const CONTACT_AGGREGATES = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                                                     AS proposal_count,
      COUNT(*) FILTER (WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')) AS paid_count,
      COALESCE(SUM(p.amount_paid) FILTER (
        WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')), 0)            AS paid_dollars,
      MIN(p.created_at)                                                            AS first_quoted,
      MAX(p.event_date) FILTER (WHERE p.event_date < CURRENT_DATE
        AND p.status IN ('deposit_paid','balance_paid','confirmed','completed'))                  AS last_finished,
      COUNT(*) FILTER (WHERE lower(replace(p.event_type, ' ', '-')) IN
        ('corporate-event','holiday-party','corporate-happy-hour','fundraiser-gala'))             AS corporate_events,
      COUNT(*) FILTER (WHERE lower(replace(p.event_type, ' ', '-')) IN
        ('wedding-reception','birthday-party','milestone-birthday','baby-shower',
         'bridal-shower','graduation','anniversary'))                                             AS personal_events,
      MAX(p.guest_count)                                                           AS largest_guests,
      MAX(p.venue_name)                                                            AS a_venue
    FROM proposals p
    WHERE p.client_id = c.id AND p.status <> 'archived'
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                     AS booked_count,
      COALESCE(SUM(l.total_cost_cents), 0) / 100.0 AS paid_dollars,
      MAX(l.event_date)                            AS last_event
    FROM legacy_cc_proposals l
    WHERE l.client_email_normalized = lower(c.email) AND l.status = 'booked'
  ) cc ON true
  LEFT JOIN LATERAL (
    -- Inbound Thumbtack activity. thumbtack_messages has no client_id, so the
    -- path is thumbtack_leads.client_id -> negotiation_id -> messages, filtered
    -- to from_type='Customer' (the CHECK values are 'Customer' | 'Business').
    SELECT MAX(tm.sent_at) AS last_inbound
      FROM thumbtack_leads tl
      JOIN thumbtack_messages tm ON tm.negotiation_id = tl.negotiation_id
     WHERE tl.client_id = c.id AND tm.from_type = 'Customer'
  ) tt ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(ct.tag ORDER BY ct.tag), '{}') AS tags
    FROM client_tags ct WHERE ct.client_id = c.id
  ) tg ON true
`;

/**
 * The seven audiences from the approved design. Each is a saved RULE,
 * re-resolved every time, never a frozen list of people.
 *
 * "Has paid us" accepts a Check Cherry ledger booking as well as a native
 * proposal. Gating on agg.paid_count alone silently excludes 184 people, the
 * largest cohort in the business.
 *
 * Event type is deliberately absent from every rule: legacy_cc_proposals
 * .event_type is NULL on all 1,230 rows and package_name describes the bar
 * package, not the occasion, so an event-type rule would drop that same cohort.
 */
const HAS_PAID = `(agg.paid_count > 0 OR cc.booked_count > 0)`;
const LAST_EVENT = `GREATEST(COALESCE(agg.last_finished, '-infinity'::date),
                             COALESCE(cc.last_event, '-infinity'::date))`;

const AUDIENCES = [
  {
    id: 'past-corporate',
    name: 'Past clients · corporate',
    rule: 'Paid us · tagged Corporate',
    includes: ['Has paid us', 'Tagged Corporate', 'Event finished'],
    where: `${HAS_PAID} AND ${LAST_EVENT} > '-infinity'::date AND 'corporate' = ANY(tg.tags)`,
  },
  {
    id: 'past-all',
    name: 'Past clients · everyone',
    rule: 'Paid us · event finished',
    includes: ['Has paid us', 'Event finished'],
    where: `${HAS_PAID} AND ${LAST_EVENT} > '-infinity'::date`,
  },
  {
    id: 'one-year-on',
    name: 'One year on',
    rule: 'Last event 11 to 13 months ago',
    includes: ['Event finished 11 to 13 months ago'],
    where: `${LAST_EVENT} BETWEEN (CURRENT_DATE - INTERVAL '13 months')
                              AND (CURRENT_DATE - INTERVAL '11 months')`,
  },
  {
    id: 'cold-quotes-spring',
    name: 'Cold quotes · spring',
    rule: 'Quoted March to June, never booked',
    includes: ['Has a proposal', 'Never paid', 'Quoted March to June'],
    where: `agg.proposal_count > 0 AND NOT ${HAS_PAID}
            AND EXTRACT(MONTH FROM agg.first_quoted) BETWEEN 3 AND 6`,
  },
  {
    id: 'quoted-never-booked',
    name: 'Quoted, never booked',
    rule: 'Has a proposal · never paid',
    includes: ['Has a proposal', 'Never paid'],
    where: `agg.proposal_count > 0 AND NOT ${HAS_PAID}`,
  },
  {
    id: 'thumbtack-live',
    name: 'Thumbtack · in conversation',
    rule: 'Thumbtack lead · replied in the last 14 days',
    includes: ['Thumbtack lead', 'Replied in 14 days'],
    where: `tt.last_inbound >= (NOW() - INTERVAL '14 days')`,
  },
  {
    id: 'never-classified',
    name: 'Never classified',
    rule: 'No marketing tag set by a human',
    includes: ['No human-set tag'],
    where: `COALESCE(array_length(tg.tags, 1), 0) = 0`,
  },
];

const AUDIENCE_BY_ID = new Map(AUDIENCES.map(a => [a.id, a]));
```

Add `CONTACT_AGGREGATES`, `AUDIENCES`, `AUDIENCE_BY_ID`, and `LAST_EVENT` to the exports.

- [ ] **Step 2: Write the tests, including one that executes every audience**

The highest-value test here is the one that runs each `where` against the real DB. A typo in a fragment is otherwise invisible until the UI loads, which is exactly how `agg.last_inbound` survived the first draft.

```js
const {
  AUDIENCES, AUDIENCE_BY_ID, CONTACT_AGGREGATES, MAILABLE_SQL, LEAD_UNSUB_LATERAL,
} = require('./marketingAudience');
const { pool } = require('../db');

test('ships the seven audiences from the design, in order', () => {
  assert.deepEqual(AUDIENCES.map(a => a.id), [
    'past-corporate', 'past-all', 'one-year-on', 'cold-quotes-spring',
    'quoted-never-booked', 'thumbtack-live', 'never-classified',
  ]);
});

test('every audience carries display strings and a parameter-free where', () => {
  for (const a of AUDIENCES) {
    assert.ok(a.name && a.rule, `${a.id} missing name or rule`);
    assert.ok(Array.isArray(a.includes) && a.includes.length > 0, `${a.id} missing includes`);
    assert.ok(typeof a.where === 'string' && a.where.trim(), `${a.id} missing where`);
    assert.ok(!/\$\d/.test(a.where), `${a.id} where contains a bind parameter`);
  }
});

test('no audience filters on event type', () => {
  for (const a of AUDIENCES) {
    assert.ok(!/event_type/i.test(a.where), `${a.id} filters on event_type`);
  }
});

test('past-client audiences accept a Check Cherry booking', () => {
  for (const id of ['past-corporate', 'past-all']) {
    assert.match(AUDIENCE_BY_ID.get(id).where, /cc\.booked_count/,
      `${id} gates on proposals only and would drop the 184-person CC cohort`);
  }
});

test('EVERY audience actually executes against the database', async () => {
  for (const a of AUDIENCES) {
    const sql = `
      SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS emailable, COUNT(*)::int AS total
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
       WHERE ${a.where}`;
    const { rows } = await pool.query(sql);   // throws 42703 on an undefined column
    assert.equal(typeof rows[0].emailable, 'number', `${a.id} returned no count`);
  }
});

test('lookup by id works', () => {
  assert.equal(AUDIENCE_BY_ID.get('past-corporate').name, 'Past clients · corporate');
  assert.equal(AUDIENCE_BY_ID.get('nope'), undefined);
});
```

Add `after(async () => { await pool.end(); });` to this file, since it now opens a pool.

- [ ] **Step 3: Run and verify**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: PASS, 20/20. A `42703` from the execute-every-audience test names the undefined column directly.

- [ ] **Step 4: Commit**

```bash
git add server/utils/marketingAudience.js server/utils/marketingAudience.test.js
git commit -m "feat(marketing): seven audience definitions, each executed by test"
```

---

## Task 11: Contact list endpoint with the held-back aggregate

**Files:** Modify `server/routes/marketingContacts.js`; create `server/routes/marketingContacts.list.test.js`

**Interfaces consumed:** `MAILABLE_SQL`, `LEAD_UNSUB_LATERAL`, `CONTACT_AGGREGATES`, `AUDIENCES`, `AUDIENCE_BY_ID`, `heldBackReason`, `LAST_EVENT` (Task 10); `suggestTag` (Task 9).
**Interfaces produced:** `GET /api/marketing/contacts`, `GET /api/marketing/audiences`.

The response carries a `held_back` **aggregate over the whole filtered base**, not just the current page. The first draft returned per-row reasons only, so the panel would have reported one 50-row page as if it were the base.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/marketingContacts.list.test.js` from the **Proven Harness**, then:

```js
test('a clean contact is mailable with no held-back reason', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r.status, 200);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.ok(row, 'fixture contact missing from the list');
  assert.equal(row.mailable, true);
  assert.equal(row.held_back_reason, null);
});

test('a client with NO preference keys is mailable (tri-state)', async () => {
  await pool.query('UPDATE clients SET communication_preferences = NULL WHERE id = $1', [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r.body.contacts.find(c => c.id === clientId).mailable, true);
});

test('marketing_enabled false reports unsubscribed', async () => {
  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(COALESCE(communication_preferences, '{}'::jsonb), '{marketing_enabled}', 'false')
     WHERE id = $1`, [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.equal(row.mailable, false);
  assert.equal(row.held_back_reason, 'unsubscribed');
  await pool.query('UPDATE clients SET communication_preferences = NULL WHERE id = $1', [clientId]);
});

test('do-not-contact reports its own reason, outranking unsubscribed', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'test' WHERE id = $1`,
    [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.equal(row.mailable, false);
  assert.equal(row.held_back_reason, 'do_not_contact');
  assert.equal(row.do_not_contact, true);
});

test('the held_back aggregate counts the whole base, not the page', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}&limit=1`, adminToken);
  assert.ok(r.body.held_back, 'response carries no held_back aggregate');
  assert.equal(typeof r.body.held_back.do_not_contact, 'number');
  assert.ok(r.body.held_back.do_not_contact >= 1);
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL WHERE id = $1`,
    [clientId]);
});

test('lifetime_dollars converts Check Cherry cents, so $760 is not $76,000', async () => {
  await pool.query(
    `INSERT INTO legacy_cc_proposals (cc_id, status, client_email_normalized, event_date, total_cost_cents)
     VALUES ($1, 'booked', $2, CURRENT_DATE - 400, 76000)`,
    [`cc-${NONCE}`, `mkt-${NONCE}@mkt-test.example`]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.ok(row.lifetime_dollars >= 760 && row.lifetime_dollars < 761,
    `expected ~760, got ${row.lifetime_dollars}`);
});

test('a Check Cherry booking alone makes someone a past client', async () => {
  // The fixture client has NO proposals, only the ledger row above.
  const r = await req('GET',
    `/api/marketing/contacts?search=${NONCE}&audience=past-all`, adminToken);
  assert.ok(r.body.contacts.find(c => c.id === clientId),
    'CC-only client excluded from past-all; that is the 184-person drop');
  await pool.query('DELETE FROM legacy_cc_proposals WHERE cc_id = $1', [`cc-${NONCE}`]);
});

test('an untagged contact carries a suggestion, a tagged one does not', async () => {
  const r1 = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r1.body.contacts.find(c => c.id === clientId).untagged, true);
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  const r2 = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r2.body.contacts.find(c => c.id === clientId).suggestion, null);
});

test('filter=corporate narrows to corporate-tagged contacts', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}&filter=corporate`, adminToken);
  assert.ok(r.body.contacts.find(c => c.id === clientId));
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: [] });
  const r2 = await req('GET', `/api/marketing/contacts?search=${NONCE}&filter=corporate`, adminToken);
  assert.equal(r2.body.contacts.find(c => c.id === clientId), undefined);
});

test('mailable_only=true drops held-back contacts entirely', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'x' WHERE id = $1`,
    [clientId]);
  const r = await req('GET',
    `/api/marketing/contacts?search=${NONCE}&mailable_only=true`, adminToken);
  assert.equal(r.body.contacts.find(c => c.id === clientId), undefined);
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL WHERE id = $1`,
    [clientId]);
});

test('last_event is null rather than -Infinity for a contact with no events', async () => {
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r.body.contacts.find(c => c.id === clientId).last_event, null);
});

test('every audience resolves through the endpoint', async () => {
  const r = await req('GET', '/api/marketing/audiences', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 7);
  for (const a of r.body) assert.equal(typeof a.emailable, 'number', `${a.id} returned no count`);
});

test('an unknown audience is a 400, not a 500', async () => {
  const r = await req('GET', '/api/marketing/contacts?audience=nope', adminToken);
  assert.equal(r.status, 400);
});

test('a manager cannot read the contact list', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts', managerToken)).status, 403);
});
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `node -r dotenv/config --test server/routes/marketingContacts.list.test.js`
Expected: FAIL, 404 on every request (routes not written).

- [ ] **Step 3: Write the endpoints**

Add imports, then:

```js
const {
  MAILABLE_SQL, LEAD_UNSUB_LATERAL, CONTACT_AGGREGATES, LAST_EVENT,
  AUDIENCES, AUDIENCE_BY_ID, heldBackReason,
} = require('../utils/marketingAudience');
const { suggestTag } = require('../utils/marketingSuggestions');
```

```js
/**
 * Builds the WHERE fragments shared by the list and the held-back aggregate,
 * so the counts describe the same base the rows come from.
 */
function buildContactFilters(query) {
  const params = [];
  const conds = [];
  if (query.audience) {
    const aud = AUDIENCE_BY_ID.get(query.audience);
    if (!aud) throw new ValidationError({ audience: 'Unknown audience.' });
    conds.push(`(${aud.where})`);
  }
  if (query.filter === 'untagged') {
    conds.push(`COALESCE(array_length(tg.tags, 1), 0) = 0`);
  } else if (query.filter === 'do-not-contact') {
    conds.push(`c.marketing_excluded = true`);
  } else if (query.filter && query.filter !== 'all') {
    // Any other filter value is a tag id. Validated against the vocabulary so
    // a typo is a 400 rather than a silently empty list.
    if (!isValidTag(query.filter)) throw new ValidationError({ filter: 'Unknown filter.' });
    params.push(query.filter);
    conds.push(`$${params.length} = ANY(tg.tags)`);
  }
  if (query.search) {
    params.push(`%${String(query.search).trim().toLowerCase()}%`);
    conds.push(`(lower(c.name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length})`);
  }
  // The recipient picker passes mailable_only. The default view shows everyone
  // so held-back contacts stay visible and correctable.
  if (query.mailable_only === 'true') conds.push(`(${MAILABLE_SQL})`);
  return { params, where: conds.length ? `WHERE ${conds.join(' AND ')}` : '' };
}

/** GET /api/marketing/contacts */
router.get('/contacts', auth, adminOnly, asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const { params, where } = buildContactFilters(req.query);
  const rowParams = [...params, limit, (page - 1) * limit];

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.email, c.source, c.email_status,
           c.marketing_excluded, c.marketing_excluded_reason, c.communication_preferences,
           COALESCE(lu.unsubscribed, false)  AS lead_unsubscribed,
           tg.tags,
           agg.proposal_count::int, agg.paid_count::int, cc.booked_count::int,
           agg.corporate_events::int, agg.personal_events::int,
           agg.largest_guests::int, agg.a_venue,
           ${LAST_EVENT}                     AS last_event,
           (COALESCE(agg.paid_dollars, 0) + COALESCE(cc.paid_dollars, 0))::float8 AS lifetime_dollars,
           (${MAILABLE_SQL})                 AS mailable,
           COUNT(*) OVER ()                  AS total_count
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} ${where}
     ORDER BY ${LAST_EVENT} DESC, c.id DESC
     LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}
  `, rowParams);

  // Aggregate over the WHOLE filtered base, not the page, so the panel is honest.
  const agg = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE c.marketing_excluded)::int AS do_not_contact,
      COUNT(*) FILTER (WHERE NOT c.marketing_excluded AND (
        (c.communication_preferences->>'marketing_enabled') = 'false'
        OR (c.communication_preferences->>'email_enabled') = 'false'
        OR COALESCE(lu.unsubscribed, false)))::int      AS unsubscribed,
      COUNT(*) FILTER (WHERE COALESCE(c.email_status,'') = 'bad')::int AS bounced,
      COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int      AS mailable
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES} ${where}
  `, params);

  res.json({
    total: rows.length ? parseInt(rows[0].total_count, 10) : 0,
    page, limit,
    held_back: agg.rows[0],
    contacts: rows.map(r => ({
      id: r.id, name: r.name, email: r.email, source: r.source,
      tags: r.tags || [],
      // Derived states are computed here and NEVER stored.
      derived: (r.paid_count > 0 || r.booked_count > 0) ? 'paid'
             : (r.proposal_count > 0 ? 'quoted' : null),
      untagged: (r.tags || []).length === 0,
      // GREATEST(-infinity) comes back as the JS number -Infinity, not a
      // string (verified). Number.isFinite is the correct guard.
      last_event: Number.isFinite(Date.parse(r.last_event)) ? r.last_event : null,
      lifetime_dollars: r.lifetime_dollars,
      mailable: r.mailable,
      held_back_reason: r.mailable ? null : heldBackReason(r),
      do_not_contact: r.marketing_excluded,
      do_not_contact_reason: r.marketing_excluded_reason,
      suggestion: (r.tags || []).length === 0 ? suggestTag({
        email: r.email,
        corporateEventCount: r.corporate_events,
        personalEventCount: r.personal_events,
        largestGuestCount: r.largest_guests,
        venueName: r.a_venue,
      }) : null,
    })),
  });
}));

/** GET /api/marketing/audiences — the seven definitions with live counts. */
router.get('/audiences', auth, adminOnly, asyncHandler(async (_req, res) => {
  const out = [];
  for (const a of AUDIENCES) {
    const { rows } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS emailable, COUNT(*)::int AS total
        FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
       WHERE ${a.where}`);
    out.push({ id: a.id, name: a.name, rule: a.rule, includes: a.includes, ...rows[0] });
  }
  res.json(out);
}));
```

- [ ] **Step 4: Run and verify**

Run: `node -r dotenv/config --test server/routes/marketingContacts.list.test.js`
Expected: PASS, 14/14.

- [ ] **Step 5: Commit**

```bash
git add server/routes/marketingContacts.js server/routes/marketingContacts.list.test.js
git commit -m "feat(marketing): contact list with held-back aggregate and audience counts"
```

---

## Task 12: Contact detail endpoint

**Files:** Modify `server/routes/marketingContacts.js`; create `server/routes/marketingContacts.detail.test.js`

**Interfaces consumed:** `getContactMessageHistory` (Task 7, lane mkt-b).
**Interfaces produced:** `GET /api/marketing/contacts/:id`.

Split from Task 11 because it is separately revertible and is the only place lane `mkt-c` couples to lane `mkt-b`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/marketingContacts.detail.test.js` from the **Proven Harness**, adding a proposal and a `message_log` row to the fixtures (shapes in Verified Fixture Shapes above), then:

```js
test('returns tags, lifetime, events, and message history', async () => {
  const r = await req('GET', `/api/marketing/contacts/${clientId}`, adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, clientId);
  assert.ok(Array.isArray(r.body.tags));
  assert.ok(Array.isArray(r.body.events));
  assert.ok(Array.isArray(r.body.messages));
  assert.equal(typeof r.body.lifetime_dollars, 'number');
});

test('message history includes the automated flag', async () => {
  const r = await req('GET', `/api/marketing/contacts/${clientId}`, adminToken);
  const m = r.body.messages.find(x => x.kind === 'proposal_sent');
  assert.ok(m, 'proposal_sent missing from the drawer history');
  assert.equal(m.automated, false);
});

test('404s an unknown contact', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts/99999999', adminToken)).status, 404);
});

test('400s a non-numeric id rather than 500ing', async () => {
  assert.equal((await req('GET', '/api/marketing/contacts/abc', adminToken)).status, 400);
});

test('a manager cannot read a contact record', async () => {
  assert.equal((await req('GET', `/api/marketing/contacts/${clientId}`, managerToken)).status, 403);
});
```

- [ ] **Step 2: Run to verify it fails**, then write the handler:

```js
const { getContactMessageHistory } = require('../utils/contactMessageHistory');
```

```js
/** GET /api/marketing/contacts/:id — drawer detail. */
router.get('/contacts/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new ValidationError({ id: 'Invalid contact id.' });

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.email, c.phone, c.source, c.email_status,
           c.marketing_excluded, c.marketing_excluded_reason, c.communication_preferences,
           COALESCE(lu.unsubscribed, false) AS lead_unsubscribed,
           tg.tags,
           (COALESCE(agg.paid_dollars, 0) + COALESCE(cc.paid_dollars, 0))::float8 AS lifetime_dollars,
           (${MAILABLE_SQL}) AS mailable
      FROM clients c ${LEAD_UNSUB_LATERAL} ${CONTACT_AGGREGATES}
     WHERE c.id = $1`, [id]);
  if (rows.length === 0) throw new NotFoundError('Contact not found.');

  const events = await pool.query(`
    SELECT p.id, p.event_date, p.event_type, p.venue_name, p.amount_paid::float8 AS amount
      FROM proposals p WHERE p.client_id = $1 AND p.status <> 'archived'
     ORDER BY p.event_date DESC LIMIT 20`, [id]);

  const messages = await getContactMessageHistory(id, { limit: 50 });

  res.json({
    ...rows[0],
    tags: rows[0].tags || [],
    held_back_reason: rows[0].mailable ? null : heldBackReason(rows[0]),
    events: events.rows,
    messages,
  });
}));
```

- [ ] **Step 3: Run and verify**

Run: `node -r dotenv/config --test server/routes/marketingContacts.detail.test.js`
Expected: PASS, 5/5.

- [ ] **Step 4: Commit**

```bash
git add server/routes/marketingContacts.js server/routes/marketingContacts.detail.test.js
git commit -m "feat(marketing): contact detail with event and message history"
```

---

## Task 13: Documentation for lane mkt-c-resolver

**Files:** Modify `ARCHITECTURE.md`

- [ ] **Step 1: Extend the Marketing Contacts route section**

```
| GET | `/contacts` | Admin | Paginated contacts with tags, derived states, mailability, held-back aggregate, suggestions |
| GET | `/contacts/:id` | Admin | Contact drawer: event history and message history |
| GET | `/audiences` | Admin | The seven audience definitions with live counts |
```

- [ ] **Step 2: Note the resolver**

One paragraph: `server/utils/marketingAudience.js` is the single definition of who may receive marketing, exporting a SQL fragment and a JS classifier that a test holds as exact complements across all seven suppression conditions. Audience `where` fragments are executed against the live DB by test, because a typo in one is otherwise invisible until the UI loads.

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(marketing): resolver, audiences, and contact read routes"
```

---

# Lane mkt-d-contacts-ui

**Note on this lane.** The server tasks above carry full code because their patterns were executed and verified. The UI tasks below specify behavior, states, and endpoints precisely but do not ship large speculative JSX. That is deliberate: the first draft of this plan invented server code that did not run, and writing 400 lines of unverifiable React would repeat the mistake in a place where no test can catch it. Build against the design artifact at `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`, which shows the real layout.

## Task 14: Marketing nav shell and routes

**Files:** Create `client/src/pages/admin/MarketingLayout.js`; modify `client/src/App.js`

The existing `EmailMarketingDashboard.js` is the layout element for the `/email-marketing` mount (`App.js:592`), and its `TABS` array is the **only** navigation to Leads, Campaigns, Analytics, and Conversations. Replacing that array in place breaks the lead surface the phase 2 extraction still needs. Add a **new** layout component instead and leave the old one untouched.

- [ ] **Step 1: Create `MarketingLayout.js`** with tabs Overview, Audiences, Compose, Sent, matching `EmailMarketingDashboard.js`'s structure and class names. Audiences is the only one implemented in phase 1; Overview, Compose, and Sent render a short "Coming in phase 2" panel rather than 404ing, so the nav matches the approved design from day one.

- [ ] **Step 2: Mount `/marketing` in `App.js`** beside the existing `/email-marketing` route at line 592, with the same admin guard, `AudiencesTab` as the `audiences` child and placeholders for the rest. Do not remove or edit the `/email-marketing` route.

- [ ] **Step 3: Verify** both `/marketing/audiences` and `/email-marketing/leads` load, and the old tab bar still highlights Leads correctly at `/email-marketing`.

- [ ] **Step 4:** `cd client && CI=true npx react-scripts build`, then commit.

## Task 15: Contact table and inline tag editing

**Files:** Create `client/src/pages/admin/marketing/ContactTable.js`, `TagCell.js`; modify `client/src/index.css`

- [ ] **Step 1: `TagCell`** renders the contact's tags, plus an `Untagged` chip when empty and a `Do not contact` chip when excluded. Opening it shows a checkbox per `MARKETING_TAGS` entry. `DO_NOT_CONTACT_ID` is **not** in the menu; it has its own control in Task 16. Toggling is optimistic against `PUT /marketing/contacts/:id/tags`, with rollback to the previous set and a toast on failure, because classifying 184 contacts is a long grind and a round trip per click makes it unusable, while a silent failed save is worse than a slow one.

- [ ] **Step 2: `ContactTable`** columns: Contact (name over email), Marketing tags, Last event, Lifetime, **Last contacted**, with a row click that opens the drawer. Held-back rows get a muted class and their `held_back_reason` as a chip. A row with a `suggestion` shows the reason text and an Accept button calling the same tag endpoint.

  `last_contacted` comes from the newest entry in the drawer's message history. Phase 1 renders it from the detail call when the drawer opens and leaves the column showing a dash in the list; adding it to the list response is a phase 2 refinement, recorded here so it is not silently dropped.

- [ ] **Step 3: All four states, no exceptions.** Loading (spinner), error (message plus a working retry button), empty (distinct copy for "no contacts match that filter" versus "no contacts yet"), and in-flight disabling on the tag control. Pagination is required; the base is ~700 rows and `AudienceSelector.js:29` shows the local precedent hard-codes `limit: 500` with no pagination and would silently truncate.

- [ ] **Step 4: Verify in the browser**, then `cd client && CI=true npx react-scripts build`, then commit.

## Task 16: Do-not-contact control

**Files:** Create `client/src/pages/admin/marketing/DoNotContactControl.js`

- [ ] **Step 1:** Setting it opens a small prompt requiring a non-blank reason and calls `PUT /marketing/contacts/:id/do-not-contact` with `{excluded: true, reason}`. The Save button stays disabled while the reason is blank, matching the server rule so the client never sends a request it knows will 400.

- [ ] **Step 2:** Clearing it requires an explicit confirmation, not a single click, and shows the stored reason and when it was set so the person clearing it knows what they are undoing.

- [ ] **Step 3:** Available from both the contact row and the drawer. On success the row updates in place without a full refetch.

- [ ] **Step 4: Verify** that a blank reason is refused client-side and server-side, that clearing takes two actions, and that the excluded contact disappears from a `mailable_only=true` list. Then build and commit.

## Task 17: Contact drawer

**Files:** Create `client/src/pages/admin/marketing/ContactDrawer.js`

This is the view spec section 4.4 calls load-bearing: it is what makes "every automated send shows up on the contact's record so you never double-tap someone" true. Without it, Tasks 7 and 12 ship with no consumer.

- [ ] **Step 1:** Opens from a row click, fetches `GET /marketing/contacts/:id`, and shows name, email, source, tags (editable via `TagCell`), lifetime value, and the `DoNotContactControl`.

- [ ] **Step 2:** Two lists. **Event history** from `events`: date, event type via `getEventTypeLabel`, venue, amount. **Message history** from `messages`: date, channel, what it was, and an explicit marker on automated ones, since distinguishing "the system emailed them" from "I emailed them" is the entire point.

- [ ] **Step 3:** Loading, error with retry, and empty states for both lists separately. A contact with no events and no messages is normal, not an error.

- [ ] **Step 4:** Verify against a client with only automated touches, one with only a proposal, and one with neither. Then build and commit.

## Task 18: Audiences list and held-back panel

**Files:** Create `client/src/pages/admin/marketing/AudiencesTab.js`, `HeldBackPanel.js`

- [ ] **Step 1: `AudiencesTab`** composes the screen: audience list from `GET /marketing/audiences` showing name, rule, and emailable count; quick filters (All, Untagged, Corporate, Do not contact); search; `ContactTable`; `HeldBackPanel`. Selecting an audience passes `audience=<id>` to the contact list. Selecting an audience shows its `includes` criteria, as the design does.

- [ ] **Step 2: `HeldBackPanel`** renders `held_back` from the list response: Do not contact, Unsubscribed, Bounced, and the mailable count. These are aggregates over the whole filtered base, not the page.

- [ ] **Step 3: Full manual walk.** The tab loads; an audience filters the table and its count matches; a tag toggles and survives a refresh; a suggestion accepts and disappears; a held-back contact shows its reason and cannot be tagged into a mailable state; search finds someone outside the current filter; the drawer opens and shows both histories; do-not-contact sets with a reason and clears with a confirm; every empty and error state renders. The dev server is a Claude-managed background process and does **not** auto-reload server edits, so restart it after any server change.

- [ ] **Step 4:** `cd client && CI=true npx react-scripts build`, `npm run check:filesize`, then commit.

## Task 19: Documentation for lane mkt-d-contacts-ui

**Files:** Modify `README.md`

- [ ] **Step 1:** Add the new pages and components to the folder tree: `client/src/pages/admin/MarketingLayout.js` and `client/src/pages/admin/marketing/` (AudiencesTab, ContactTable, TagCell, DoNotContactControl, ContactDrawer, HeldBackPanel).
- [ ] **Step 2:** Add the feature to README's Key Features section.
- [ ] **Step 3:** Commit.

---

## Self-review notes

Checked against the spec and against the fleet findings on the first draft.

**Spec coverage.** §4.1 tags → Tasks 1, 2, 3; suggestions → Task 9, wired in Task 11. §4.2 Do-not-contact → Tasks 1, 4, 16. §4.3 resolver → Tasks 8, 10, 11, with all seven conditions tested as complements. §4.3 money units, CC email join, casing → Task 10, pinned by test. §4.4 contacts surface → Tasks 11, 15, 18; drawer → Tasks 7, 12, 17. §7 schema → Task 1 plus a reusable post-apply assertion script; the `GET /api/clients` allowlist → Task 5.

**Fleet findings from draft 1, all addressed.** The harness was executed before this plan was written. Fixture shapes were executed. `agg.last_inbound` now has a real join path. The Check Cherry cohort is no longer excluded from past-client audiences, and a test pins that. `heldBackReason` covers all seven conditions. Held-back counts are a real aggregate. `mkt-c-resolver` declares its dependency on `mkt-b-history`. Task 9 of draft 1 is split into Tasks 10, 11, and 12. Each lane carries its own doc task. The `TABS` replacement is replaced by a new layout component. Fixture emails avoid `.invalid`. The `-infinity` guard uses `Number.isFinite`. Task 1's verification uses one pooled client. `filter=corporate` is implemented and tested.

**Two findings deliberately handled rather than fixed.** Dedupe by lowercased email is a send-path concern and is declared in lane `mkt-g-send`; phase 1 has no send. The `contactMessageHistory` campaign leg cannot be exercised until `email_sends.client_id` exists, and `mkt-g-send` now explicitly owns that test rather than leaving it unowned.

**One finding rejected.** The CAN-SPAM postal address was flagged as dropped from every lane. It already shipped: `eb82e092` (footer) and `8240dd89` (legal pages). The lane map says so rather than re-scheduling done work.
