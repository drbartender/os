# Marketing Redesign Phase 1: Tags, Suppression, Resolver, Contacts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Marketing section a real contact base: human-set tags on `clients`, a Do-not-contact gate that carries a reason, one shared audience resolver that every path goes through, and an Audiences tab where Dallas can classify 184 never-tagged contacts by hand.

**Architecture:** One server-side resolver module owns mailability and audience membership; nothing else may re-derive either, and the client never reimplements a filter. Tags live in their own table so each one carries who set it and when. Do-not-contact displays as a tag but is backed by dedicated columns, because it is the only one whose accidental removal emails someone who asked not to be emailed. Contact message history is a union across three tables because no single one can hold it.

**Tech Stack:** Node.js 26 / Express 4, raw SQL via `pg` (no ORM), React 18 (CRA) / React Router 6, vanilla CSS in `index.css`, `node:test` for server, `react-scripts test` for client.

**Spec:** `docs/superpowers/specs/2026-08-11-marketing-campaigns-design.md` (approved 2026-08-11, third revision)

**Design:** `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`

**Scope:** Phase 1 only. Phases 2 and 3 are declared in the lane map with scope summaries and get their own plans.

## Global Constraints

- **No em dashes** in any copy, comment prose, or UI string. Commas, colons, parentheses only.
- **Corporate is never inferred.** No code path may set a Corporate tag from an email domain or event history. Suggestions are surfaced for a human to accept; accepting is the only write.
- **One mailability predicate.** `isMailable` lives in `server/utils/marketingAudience.js` and is the only place the six suppression conditions are expressed. No route, no query, and no client component may restate them.
- **`communication_preferences` is tri-state.** Every existing check in the codebase is `prefs.x === false`; an absent key means enabled. SQL must test `IS DISTINCT FROM 'false'`, never `= 'true'`.
- **Money units differ by source.** `proposals.total_price` and `proposals.amount_paid` are `NUMERIC(10,2)` **dollars**. `legacy_cc_proposals.total_cost_cents` is **cents**. Every lifetime-value expression must divide the cents column by 100. CLAUDE.md's "money as integer cents" invariant does not hold for `proposals`.
- **Check Cherry joins on email, not id.** `lower(clients.email) = legacy_cc_proposals.client_email_normalized`. `client_id` is populated on only 197 of 1,230 rows.
- **Event-type casing is doubled.** The import left both `corporate-event` and `Corporate Event`. Any read of `proposals.event_type` normalizes with `lower(replace(event_type, ' ', '-'))`.
- **Postgres has no `ADD CONSTRAINT IF NOT EXISTS`,** and `schema.sql` replays on every boot. Every constraint uses the guarded `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...) THEN ... END IF; END $$;` pattern (`schema.sql:931-938`).
- All SQL parameterized (`$1`). Client-visible errors throw `AppError` subclasses, never `res.status(400).json(...)`.
- Frontend API calls go through `client/src/utils/api.js`. Never raw `fetch`/`axios`.
- **Server suites run ONE AT A TIME against the shared dev DB, from the repo root:** `node -r dotenv/config --test <file>`.
- Client suites: `cd client && CI=true npx react-scripts test --watchAll=false <path>`. Before any commit touching `client/`, run `cd client && CI=true npx react-scripts build`; it is the only local gate that catches CI-fatal warnings.
- **File-size discipline:** `server/routes/emailMarketing.js` is at **987 lines** against the 1000-line hard cap. **No task in this plan may add a line to it.** Every new server route in phase 1 goes in a new file. Run `npm run check:filesize` in any task touching it.
- **Do not touch `scheduled_messages`.** The dispatcher path from spec draft 1 is abandoned; `lookupEntity` has no campaign branch and `messageScheduling.js:4` holds a second allowlist. Phase 1 reads that table and never writes it.

## Lane map

```yaml
lanes:
  - id: mkt-a-tags
    phase: 1
    scope: >
      Schema for client_tags and the marketing_excluded columns, the tag
      vocabulary constant, the tag read/write API, and the Do-not-contact
      endpoint with its required reason and audit entry.
    footprint:
      - server/db/schema.sql
      - server/utils/marketingTags.js
      - server/utils/marketingTags.test.js
      - server/routes/marketingContacts.js
      - server/routes/marketingContacts.tags.test.js
      - server/index.js
      - client/src/utils/marketingTags.js
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, database-review]

  - id: mkt-b-history
    phase: 1
    scope: >
      The contact message-history endpoint: a union across message_log,
      scheduled_messages, and email_sends, so automated sends are visible on
      the contact record. Independent of tags; runs in parallel with mkt-a.
    footprint:
      - server/utils/contactMessageHistory.js
      - server/utils/contactMessageHistory.test.js
      - server/routes/marketingContacts.history.test.js
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [code-review, consistency-check]

  - id: mkt-c-resolver
    phase: 1
    scope: >
      The shared mailability predicate, the audience definitions and their
      resolver, tag suggestions with reasoning, and the paginated contact-list
      endpoint with derived states and held-back counts.
    footprint:
      - server/utils/marketingAudience.js
      - server/utils/marketingAudience.test.js
      - server/utils/marketingSuggestions.js
      - server/utils/marketingSuggestions.test.js
      - server/routes/marketingContacts.js
      - server/routes/marketingContacts.list.test.js
      - ARCHITECTURE.md
    depends_on: [mkt-a-tags]
    review_fleet: [code-review, consistency-check, security-review, database-review]

  - id: mkt-d-contacts-ui
    phase: 1
    scope: >
      The Audiences tab: audience list and detail, the contact table with
      inline tag editing and quick filters, the held-back panel, and the
      contact drawer with event history and message history.
    footprint:
      - client/src/pages/admin/marketing/**
      - client/src/pages/admin/EmailMarketingDashboard.js
      - client/src/App.js
      - client/src/index.css
      - README.md
    depends_on: [mkt-a-tags, mkt-b-history, mkt-c-resolver]
    review_fleet: [code-review, consistency-check, ui-ux-review]

  # ─── Phase 2, its own plan. Declared here so the graph is visible. ───
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
      Unsubscribe GET-renders/POST-flips confirmation page (plain form, Helmet
      CSP blocks inline JS); advisory `typ` claim on new tokens; retire the
      legacy all-leads send path and hide /schedule; real token on test sends;
      bounce-webhook split so a marketing complaint sets marketing_excluded
      instead of flipping email_status='bad'; admin control to clear a bad
      email_status. Dallas approved the webhook change 2026-08-11.
    depends_on: [mkt-e-extract]
    review_fleet: [code-review, consistency-check, security-review]

  - id: mkt-g-send
    phase: 2
    scope: >
      Compose (Design / Recipients / Send) with the Look panel, the send route
      taking client_ids, paced serial sending, the send-once guard under FOR
      UPDATE, transient-429 versus daily-quota handling, email_sends.client_id
      plus the recipient CHECK and its consumer sweep.
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

**Run order:** `mkt-a-tags` and `mkt-b-history` in parallel, then `mkt-c-resolver`, then `mkt-d-contacts-ui`. Phase 2 and 3 lanes are sequential and get their own plans.

---

## Task 1: Schema for tags and Do-not-contact

**Lane:** mkt-a-tags

**Files:**
- Modify: `server/db/schema.sql` (append a new section at the end)

**Interfaces:**
- Produces: table `client_tags(client_id, tag, set_by, set_at)`; columns `clients.marketing_excluded`, `clients.marketing_excluded_reason`, `clients.marketing_excluded_at`, `clients.marketing_excluded_by`.

A table rather than an array column: each tag carries who set it and when, which an array cannot hold, and the audit trail is the whole reason Corporate is human-set.

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

- [ ] **Step 2: Verify the constraints actually installed**

Existing constraint blocks in this file end `EXCEPTION WHEN OTHERS THEN NULL`, and `server/db/index.js:173-225` swallows `42710`/`42P16`, so a failed install boots clean and silently absent. Assert rather than assume.

Run from the repo root:

```bash
node -r dotenv/config -e "
const { pool, initDb } = require('./server/db');
(async () => {
  await initDb();
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  console.log('client_tags exists:', (await q(\"SELECT to_regclass('public.client_tags') AS t\"))[0].t);
  console.log('constraints:', (await q(
    \"SELECT conname FROM pg_constraint WHERE conname IN ('client_tags_tag_check','clients_marketing_excluded_reason_check') ORDER BY 1\"
  )).map(r => r.conname));
  console.log('columns:', (await q(
    \"SELECT column_name FROM information_schema.columns WHERE table_name='clients' AND column_name LIKE 'marketing_excluded%' ORDER BY 1\"
  )).map(r => r.column_name));
  await pool.end();
})();
"
```

Expected: `client_tags exists: client_tags`, both constraint names listed, all four columns listed. Anything missing is a hard stop, not a warning.

- [ ] **Step 3: Verify the reason CHECK actually bites**

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  const { rows } = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1');
  try {
    await pool.query('BEGIN');
    await pool.query('UPDATE clients SET marketing_excluded = true WHERE id = \$1', [rows[0].id]);
    console.log('FAIL: excluded without a reason was accepted');
  } catch (e) {
    console.log('PASS: rejected without reason ->', e.code);
  } finally {
    await pool.query('ROLLBACK');
    await pool.end();
  }
})();
"
```

Expected: `PASS: rejected without reason -> 23514`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(marketing): schema for client tags and do-not-contact"
```

---

## Task 2: The tag vocabulary, shared server and client

**Lane:** mkt-a-tags

**Files:**
- Create: `server/utils/marketingTags.js`
- Create: `server/utils/marketingTags.test.js`
- Create: `client/src/utils/marketingTags.js`

**Interfaces:**
- Produces: `MARKETING_TAGS` (array of `{id, label}`), `isValidTag(id) -> boolean`, `DO_NOT_CONTACT_ID` (the string `'do-not-contact'`, which is NOT a `client_tags` value and never reaches that table).

Two mirrored files because the client and server bundles are separate. This follows `eventTypes.js` and `gratuityLabels.js`, both of which are hand-synced with a note. Say so in both files.

- [ ] **Step 1: Write the failing test**

Create `server/utils/marketingTags.test.js`:

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
    'do-not-contact is backed by clients columns, never inserted into client_tags');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/utils/marketingTags.test.js`
Expected: FAIL, `Cannot find module './marketingTags'`.

- [ ] **Step 3: Write the module**

Create `server/utils/marketingTags.js`:

```js
/**
 * Marketing tag vocabulary. Fixed enum, mirrored by the CHECK constraint
 * `client_tags_tag_check` in schema.sql and by client/src/utils/marketingTags.js.
 * Change all three together.
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
Expected: PASS, 4/4.

- [ ] **Step 5: Mirror it for the client**

Create `client/src/utils/marketingTags.js`:

```js
/**
 * Marketing tag vocabulary, ESM mirror of server/utils/marketingTags.js.
 * Client and server bundles are separate, so these are kept in sync by hand,
 * the same arrangement as eventTypes.js and gratuityLabels.js. The CHECK
 * constraint `client_tags_tag_check` in schema.sql is the third copy.
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

- [ ] **Step 6: Commit**

```bash
git add server/utils/marketingTags.js server/utils/marketingTags.test.js client/src/utils/marketingTags.js
git commit -m "feat(marketing): tag vocabulary, server and client mirrors"
```

---

## Task 3: Tag write API

**Lane:** mkt-a-tags

**Files:**
- Create: `server/routes/marketingContacts.js`
- Create: `server/routes/marketingContacts.tags.test.js`
- Modify: `server/index.js` (mount the router)

**Interfaces:**
- Consumes: `isValidTag`, `MARKETING_TAGS` from Task 2.
- Produces: `PUT /api/marketing/contacts/:id/tags` accepting `{ tags: string[] }` and returning `{ tags: string[] }`.

A new route file, not an addition to `emailMarketing.js`, which is at 987 of 1000 lines.

**Auth is `adminOnly`, not `requireAdminOrManager`.** Every route in `emailMarketing.js` uses the looser guard, and following that convention here would let a manager clear house-rule exclusions and reach a full-client-base PII export. Import `adminOnly` from `server/middleware/auth.js`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/marketingContacts.tags.test.js`:

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
let server, base, adminToken, managerToken, clientId, adminUserId;

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
  const admin = await pool.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ('MC Admin ${NONCE}', 'mc-admin-${NONCE}@test.invalid', 'x', 'admin') RETURNING id`
  );
  adminUserId = admin.rows[0].id;
  const mgr = await pool.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ('MC Mgr ${NONCE}', 'mc-mgr-${NONCE}@test.invalid', 'x', 'manager') RETURNING id`
  );
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('MC Client ${NONCE}', 'mc-${NONCE}@test.invalid') RETURNING id`
  );
  clientId = c.rows[0].id;
  adminToken = jwt.sign({ id: adminUserId, role: 'admin' }, process.env.JWT_SECRET);
  managerToken = jwt.sign({ id: mgr.rows[0].id, role: 'manager' }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((err, _req, res, _next) => {
    const status = err instanceof AppError ? err.status : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'mc-%${NONCE}@test.invalid'`);
  server.close();
  await pool.end();
});

test('sets tags and returns them sorted by the vocabulary order', async () => {
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
    "SELECT 1 FROM client_tags WHERE client_id = $1 AND tag = 'do-not-contact'", [clientId]
  );
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

Create `server/routes/marketingContacts.js`:

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
  if (!Array.isArray(tags)) {
    throw new ValidationError({ tags: 'tags must be an array of tag ids.' });
  }
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
    // is expressed by omission. Deleting only the difference would leave a
    // concurrent edit's tag behind.
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

- [ ] **Step 4: Mount it**

In `server/index.js`, next to the existing `emailMarketing` mount (search for `/api/email-marketing`), add:

```js
app.use('/api/marketing', require('./routes/marketingContacts'));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: PASS, 9/9.

- [ ] **Step 6: Confirm emailMarketing.js did not grow**

Run: `npm run check:filesize`
Expected: `server/routes/emailMarketing.js` still reported at 987 lines, no RED.

- [ ] **Step 7: Commit**

```bash
git add server/routes/marketingContacts.js server/routes/marketingContacts.tags.test.js server/index.js
git commit -m "feat(marketing): tag write API, admin only"
```

---

## Task 4: Do-not-contact endpoint

**Lane:** mkt-a-tags

**Files:**
- Modify: `server/routes/marketingContacts.js`
- Modify: `server/routes/marketingContacts.tags.test.js` (append the new describe block's tests)

**Interfaces:**
- Consumes: `logAdminAction` from `server/utils/adminAuditLog.js`.
- Produces: `PUT /api/marketing/contacts/:id/do-not-contact` accepting `{ excluded: boolean, reason?: string }`.

`admin_audit_log.target_user_id` FKs to `users(id)` (`schema.sql:2532`) and a client is not a user, so the client id rides in `metadata` with `targetUserId: null`. This follows `server/routes/admin/ccImport/proposalActions.js:74-81`.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/marketingContacts.tags.test.js`:

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
     FROM clients WHERE id = $1`, [clientId]
  );
  assert.equal(rows[0].marketing_excluded, true);
  assert.equal(rows[0].marketing_excluded_reason, 'Asked not to be emailed on the review reply');
  assert.ok(rows[0].marketing_excluded_at instanceof Date);
  assert.equal(rows[0].marketing_excluded_by, adminUserId);
});

test('writes an audit row with the client id in metadata, not target_user_id', async () => {
  const { rows } = await pool.query(
    `SELECT target_user_id, action, metadata FROM admin_audit_log
     WHERE action = 'marketing.do_not_contact.set'
       AND metadata->>'client_id' = $1
     ORDER BY created_at DESC LIMIT 1`, [String(clientId)]
  );
  assert.equal(rows.length, 1, 'audit row missing');
  assert.equal(rows[0].target_user_id, null, 'target_user_id FKs to users; a client is not a user');
  assert.equal(rows[0].metadata.reason, 'Asked not to be emailed on the review reply');
});

test('clearing do-not-contact nulls the reason, actor, and timestamp', async () => {
  const r = await req('PUT', `/api/marketing/contacts/${clientId}/do-not-contact`, adminToken,
    { excluded: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.excluded, false);
  const { rows } = await pool.query(
    `SELECT marketing_excluded, marketing_excluded_reason, marketing_excluded_at, marketing_excluded_by
     FROM clients WHERE id = $1`, [clientId]
  );
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

Add `client_tags` cleanup for the audit rows in `after()`:

```js
  await pool.query("DELETE FROM admin_audit_log WHERE metadata->>'client_id' = $1", [String(clientId)]);
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node -r dotenv/config --test server/routes/marketingContacts.tags.test.js`
Expected: the six new tests FAIL with 404 (route not mounted); the nine from Task 3 still PASS.

- [ ] **Step 3: Add the route**

In `server/routes/marketingContacts.js`, add the import and the handler:

```js
const { logAdminAction } = require('../utils/adminAuditLog');
```

```js
/**
 * PUT /api/marketing/contacts/:id/do-not-contact
 *
 * The house rule, distinct from the client's own unsubscribe. It gates
 * MARKETING ONLY: an excluded client who books still gets proposals,
 * invoices, and every operational message.
 *
 * Deliberately its own endpoint rather than a field on PUT /api/clients/:id,
 * which destructures a fixed 5-field body and updates via COALESCE($n, col),
 * where null means "leave unchanged" — so that route structurally cannot
 * clear this flag or null the reason (clients.js:121-150).
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
    [clientId, excluded, trimmed || null, req.user.id]
  );
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

## Task 5: Documentation for lane mkt-a-tags

**Lane:** mkt-a-tags

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

CLAUDE.md's Mandatory Documentation Updates table is triggered three ways by this lane: a new route file, new util files, and schema changes.

- [ ] **Step 1: Add the route to ARCHITECTURE.md's route table**

Find the API route table and add, in the style of its neighbors:

```
| PUT | `/api/marketing/contacts/:id/tags` | admin | Replace a contact's marketing tag set |
| PUT | `/api/marketing/contacts/:id/do-not-contact` | admin | Set or clear the house do-not-contact rule (requires a reason) |
```

- [ ] **Step 2: Add the schema to ARCHITECTURE.md's Database Schema section**

```
**client_tags** — human-set marketing classification, one row per (client, tag),
with set_by/set_at. Vocabulary is a fixed enum mirrored in
server/utils/marketingTags.js, client/src/utils/marketingTags.js, and the
client_tags_tag_check constraint. Corporate is never inferred.

**clients.marketing_excluded / _reason / _at / _by** — the house do-not-contact
rule, distinct from the client's own communication_preferences.marketing_enabled
unsubscribe. Marketing only; operational mail is unaffected.
```

- [ ] **Step 3: Add the new files to README.md's folder tree**

Under `server/routes/`: `marketingContacts.js`. Under `server/utils/`: `marketingTags.js`. Under `client/src/utils/`: `marketingTags.js`.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs(marketing): route table, schema, and folder tree for tags"
```

---

## Task 6: Contact message history

**Lane:** mkt-b-history

**Files:**
- Create: `server/utils/contactMessageHistory.js`
- Create: `server/utils/contactMessageHistory.test.js`

**Interfaces:**
- Produces: `getContactMessageHistory(clientId, { limit = 50 }) -> Promise<Array<{ at, channel, kind, label, automated, source }>>`, newest first.

This cannot be built on `message_log` alone. `message_log.proposal_id` is `INTEGER NOT NULL` (`schema.sql:3542`) and `logClientMessage` returns early without one (`messageLog.js:88`), so the 254 proposal-less clients and the whole Check Cherry cohort log nothing there. The history is a union of three tables: `message_log` (proposal-bound sends), `scheduled_messages` (the automated lifecycle and marketing touches), and `email_sends` (campaigns, once phase 2 adds `client_id`).

`email_sends` has no `client_id` until phase 2 (Task list in lane `mkt-g-send`). Its leg is written now and returns nothing until that column exists, guarded by a `to_regclass`-style column probe so this lane does not depend on phase 2.

- [ ] **Step 1: Write the failing test**

Create `server/utils/contactMessageHistory.test.js`:

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { getContactMessageHistory } = require('./contactMessageHistory');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId, proposalId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('CMH ${NONCE}', 'cmh-${NONCE}@test.invalid') RETURNING id`
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, total_price)
     VALUES ($1, CURRENT_DATE + 30, 'sent', 500) RETURNING id`, [clientId]
  );
  proposalId = p.rows[0].id;

  await pool.query(
    `INSERT INTO message_log (client_id, proposal_id, channel, message_type, status, created_at)
     VALUES ($1, $2, 'email', 'proposal_sent', 'sent', NOW() - INTERVAL '3 days')`,
    [clientId, proposalId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'retention_nudge', 'client', $2, 'email', NOW() - INTERVAL '1 day', 'sent')`,
    [proposalId, clientId]
  );
});

after(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE recipient_id = $1 AND recipient_type = $2',
    [clientId, 'client']);
  await pool.query('DELETE FROM message_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('returns entries newest first across both sources', async () => {
  const rows = await getContactMessageHistory(clientId);
  assert.ok(rows.length >= 2, `expected at least 2, got ${rows.length}`);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(new Date(rows[i - 1].at) >= new Date(rows[i].at), 'not sorted newest first');
  }
});

test('marks dispatcher touches as automated and message_log ones as not', async () => {
  const rows = await getContactMessageHistory(clientId);
  const nudge = rows.find(r => r.kind === 'retention_nudge');
  const proposal = rows.find(r => r.kind === 'proposal_sent');
  assert.ok(nudge, 'retention_nudge missing from history');
  assert.equal(nudge.automated, true);
  assert.equal(nudge.source, 'scheduled_messages');
  assert.ok(proposal, 'proposal_sent missing from history');
  assert.equal(proposal.automated, false);
  assert.equal(proposal.source, 'message_log');
});

test('only returns sent rows, never pending ones', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'new_year_hello', 'client', $2, 'email', NOW() + INTERVAL '90 days', 'pending')`,
    [proposalId, clientId]
  );
  const rows = await getContactMessageHistory(clientId);
  assert.equal(rows.find(r => r.kind === 'new_year_hello'), undefined,
    'a pending future touch is not history');
});

test('a client with no messages returns an empty array, not null', async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('CMH empty ${NONCE}', 'cmh-e-${NONCE}@test.invalid') RETURNING id`
  );
  const rows = await getContactMessageHistory(c.rows[0].id);
  assert.deepEqual(rows, []);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});

test('respects the limit', async () => {
  const rows = await getContactMessageHistory(clientId, { limit: 1 });
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/contactMessageHistory.test.js`
Expected: FAIL, `Cannot find module './contactMessageHistory'`.

- [ ] **Step 3: Write the module**

Create `server/utils/contactMessageHistory.js`:

```js
const { pool } = require('../db');

/**
 * Every message a contact has actually received, newest first, across the
 * three tables that hold them.
 *
 * WHY A UNION
 * -----------
 * message_log cannot hold this on its own: message_log.proposal_id is
 * INTEGER NOT NULL (schema.sql:3542) and logClientMessage returns early
 * without one (messageLog.js:88), so the 254 proposal-less clients and the
 * whole Check Cherry cohort have nothing there. The automated lifecycle and
 * marketing touches live in scheduled_messages, and campaign sends will live
 * in email_sends once phase 2 adds its client_id column.
 *
 * This view is what makes the design's promise true — that automations "show
 * up on the contact's record so you never double-tap someone."
 *
 * Only rows that actually went out are history. A pending future touch is a
 * plan, not a record.
 */
async function getContactMessageHistory(clientId, { limit = 50 } = {}) {
  const id = parseInt(clientId, 10);
  if (!Number.isInteger(id)) return [];
  const cap = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // email_sends.client_id arrives in phase 2. Probe rather than depend on it,
  // so this module works before and after that column exists.
  const { rows: colRows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'email_sends' AND column_name = 'client_id' LIMIT 1`
  );
  const hasCampaignLeg = colRows.length > 0;

  const campaignLeg = hasCampaignLeg ? `
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
             ml.message_type AS label, false AS automated,
             'message_log' AS source
        FROM message_log ml
       WHERE ml.client_id = $1 AND ml.status = 'sent'

      UNION ALL

      SELECT sm.sent_at AS at, sm.channel, sm.message_type AS kind,
             sm.message_type AS label, true AS automated,
             'scheduled_messages' AS source
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
Expected: PASS, 5/5.

If the `message_log` insert in the test fails on a missing column, read the live table shape first with `\d message_log` equivalent (`SELECT column_name FROM information_schema.columns WHERE table_name='message_log'`) and fix the fixture, not the module. The dev DB lacks some prod CHECK constraints, so a green local run is not proof against `ci-smoke`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/contactMessageHistory.js server/utils/contactMessageHistory.test.js
git commit -m "feat(marketing): contact message history across log, dispatcher, and campaigns"
```

---

## Task 7: The mailability predicate

**Lane:** mkt-c-resolver

**Files:**
- Create: `server/utils/marketingAudience.js`
- Create: `server/utils/marketingAudience.test.js`

**Interfaces:**
- Produces: `MAILABLE_SQL` (a SQL fragment string, parameter-free, referencing alias `c` for clients), `HELD_BACK_REASONS` (array of ids), `isMailable(contactRow) -> boolean`.

This is the single place the suppression conditions are expressed. Both a SQL fragment and a JS predicate are exported because the list query filters in SQL and the send path re-checks in JS; they must be the same rules, so the test asserts they agree on the same fixture rows.

The six conditions, all of which must hold for a contact to be mailable:

1. `communication_preferences.marketing_enabled` is not `false` (the client's own unsubscribe)
2. `communication_preferences.email_enabled` is not `false`
3. `marketing_excluded` is `false` (the house rule)
4. `email` is present and non-blank
5. `email_status` is not `'bad'`
6. the address is not an `.invalid` placeholder
7. no `email_leads` row for the same address is `unsubscribed`

Condition 7 matters because 9 of the 15 `email_leads` rows are also clients, so someone who unsubscribed from the one historical blast is otherwise re-mailable through the client-keyed picker.

- [ ] **Step 1: Write the failing test**

Create `server/utils/marketingAudience.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMailable, MAILABLE_SQL, HELD_BACK_REASONS } = require('./marketingAudience');

const ok = {
  email: 'a@b.com', email_status: 'ok', marketing_excluded: false,
  communication_preferences: {}, lead_unsubscribed: false,
};

test('a clean contact is mailable', () => {
  assert.equal(isMailable(ok), true);
});

test('absent preference keys mean enabled (tri-state)', () => {
  assert.equal(isMailable({ ...ok, communication_preferences: null }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: {} }), true);
  assert.equal(isMailable({ ...ok, communication_preferences: { marketing_enabled: true } }), true);
});

test('an explicit false on either preference holds the contact back', () => {
  assert.equal(isMailable({ ...ok, communication_preferences: { marketing_enabled: false } }), false);
  assert.equal(isMailable({ ...ok, communication_preferences: { email_enabled: false } }), false);
});

test('the house rule holds the contact back', () => {
  assert.equal(isMailable({ ...ok, marketing_excluded: true }), false);
});

test('a missing or blank address holds the contact back', () => {
  assert.equal(isMailable({ ...ok, email: null }), false);
  assert.equal(isMailable({ ...ok, email: '' }), false);
  assert.equal(isMailable({ ...ok, email: '   ' }), false);
});

test('a bad email_status holds the contact back', () => {
  assert.equal(isMailable({ ...ok, email_status: 'bad' }), false);
});

test('an .invalid placeholder address holds the contact back', () => {
  assert.equal(isMailable({ ...ok, email: 'cmurphy@arthrex-chicago.invalid' }), false);
});

test('a lead-side unsubscribe holds the contact back', () => {
  // 9 of the 15 email_leads rows are also clients; someone who unsubscribed
  // from the one historical blast must not be re-mailable through this path.
  assert.equal(isMailable({ ...ok, lead_unsubscribed: true }), false);
});

test('MAILABLE_SQL is parameter-free so callers can compose it', () => {
  assert.equal(typeof MAILABLE_SQL, 'string');
  assert.ok(!/\$\d/.test(MAILABLE_SQL), 'MAILABLE_SQL must not contain bind parameters');
  assert.ok(MAILABLE_SQL.includes("IS DISTINCT FROM 'false'"),
    'preference checks must be tri-state, never = true');
});

test('every held-back reason has an id', () => {
  assert.deepEqual(HELD_BACK_REASONS, ['do_not_contact', 'unsubscribed', 'bounced']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: FAIL, `Cannot find module './marketingAudience'`.

- [ ] **Step 3: Write the module**

Create `server/utils/marketingAudience.js`:

```js
const { isPlaceholderEmail } = require('./emailValidation');

/**
 * THE single definition of who may receive marketing. Nothing else in the
 * codebase may restate these conditions: the contact list filters with
 * MAILABLE_SQL, the send path re-checks with isMailable, and the test asserts
 * the two agree. Three hand-written copies is how a suppression rule drifts
 * and someone who asked not to be emailed gets emailed.
 *
 * communication_preferences is TRI-STATE. Every existing check in the
 * codebase is `prefs.x === false`, and an absent key means enabled, so the
 * SQL tests IS DISTINCT FROM 'false' rather than = 'true'. A row whose JSONB
 * simply lacks the key would otherwise be silently excluded.
 */

// Alias `c` = clients. Alias `lu` = the lead-unsubscribe LATERAL the caller joins.
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
 * The LATERAL a caller joins to supply `lu.unsubscribed`. Kept beside
 * MAILABLE_SQL so the two cannot be used apart.
 */
const LEAD_UNSUB_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT true AS unsubscribed
      FROM email_leads el
     WHERE lower(el.email) = lower(c.email)
       AND el.status = 'unsubscribed'
     LIMIT 1
  ) lu ON true
`;

const HELD_BACK_REASONS = ['do_not_contact', 'unsubscribed', 'bounced'];

function isMailable(row) {
  if (!row) return false;
  const prefs = row.communication_preferences || {};
  if (prefs.marketing_enabled === false) return false;
  if (prefs.email_enabled === false) return false;
  if (row.marketing_excluded === true) return false;
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  if (!email) return false;
  if (isPlaceholderEmail(email)) return false;
  if (row.email_status === 'bad') return false;
  if (row.lead_unsubscribed === true) return false;
  return true;
}

/** Why a contact is held back, for the "Always held back" panel. Null = mailable. */
function heldBackReason(row) {
  if (!row) return null;
  if (row.marketing_excluded === true) return 'do_not_contact';
  const prefs = row.communication_preferences || {};
  if (prefs.marketing_enabled === false || prefs.email_enabled === false || row.lead_unsubscribed === true) {
    return 'unsubscribed';
  }
  if (row.email_status === 'bad') return 'bounced';
  return null;
}

module.exports = {
  MAILABLE_SQL, LEAD_UNSUB_LATERAL, HELD_BACK_REASONS, isMailable, heldBackReason,
};
```

Confirm `server/utils/emailValidation.js` exports `isPlaceholderEmail` before relying on it:

```bash
grep -n "isPlaceholderEmail" server/utils/emailValidation.js
```

If it does not exist under that name, find the real one (`grep -rn "\.invalid" server/utils/ | head`) and use it; do not write a seventh copy of the predicate.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingAudience.js server/utils/marketingAudience.test.js
git commit -m "feat(marketing): single mailability predicate, SQL and JS"
```

---

## Task 8: Tag suggestions

**Lane:** mkt-c-resolver

**Files:**
- Create: `server/utils/marketingSuggestions.js`
- Create: `server/utils/marketingSuggestions.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `suggestTag(contactFacts) -> { tag, reason } | null`, where `contactFacts` is `{ email, corporateEventCount, personalEventCount, largestGuestCount, venueName }`.

A suggestion is never applied. It renders next to the contact with its reasoning and a one-click accept, and the accept goes through the Task 3 tag endpoint like any other human write.

The domain is one weak input among several, never the decision. Event history outranks it: someone with corporate events on a gmail address is a corporate suggestion, and someone with only weddings on a company domain is not.

- [ ] **Step 1: Write the failing test**

Create `server/utils/marketingSuggestions.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestTag } = require('./marketingSuggestions');

test('corporate event history on a personal address still suggests corporate', () => {
  // 14 of the 30 clients who booked corporate work used a personal address.
  const s = suggestTag({ email: 'someone@gmail.com', corporateEventCount: 1, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /corporate/i);
});

test('a company domain with only personal events does NOT suggest corporate', () => {
  // 10 of the 26 clients on company domains were booking their own weddings.
  const s = suggestTag({ email: 'bride@acmecorp.com', corporateEventCount: 0, personalEventCount: 1 });
  assert.notEqual(s && s.tag, 'corporate');
});

test('a company domain with no event history suggests corporate, weakly, and says so', () => {
  const s = suggestTag({ email: 'ops@acmecorp.com', corporateEventCount: 0, personalEventCount: 0 });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /no event history|nothing booked/i,
    'a domain-only guess must admit it is a guess');
});

test('a free-mail address with no history suggests nothing', () => {
  assert.equal(suggestTag({ email: 'nobody@gmail.com', corporateEventCount: 0, personalEventCount: 0 }), null);
});

test('a large guest count at a named venue strengthens the reason', () => {
  const s = suggestTag({
    email: 'faculty@calderwood.edu', corporateEventCount: 1, personalEventCount: 0,
    largestGuestCount: 180, venueName: 'Calderwood faculty reception',
  });
  assert.equal(s.tag, 'corporate');
  assert.match(s.reason, /180/);
});

test('handles a missing or malformed email without throwing', () => {
  assert.equal(suggestTag({ email: null, corporateEventCount: 0, personalEventCount: 0 }), null);
  assert.equal(suggestTag({ email: 'not-an-email', corporateEventCount: 0, personalEventCount: 0 }), null);
  assert.equal(suggestTag({}), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/marketingSuggestions.test.js`
Expected: FAIL, `Cannot find module './marketingSuggestions'`.

- [ ] **Step 3: Write the module**

Create `server/utils/marketingSuggestions.js`:

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
 * So event history outranks the domain in both directions, and a domain-only
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

function suggestTag(facts = {}) {
  const { email, corporateEventCount = 0, personalEventCount = 0,
          largestGuestCount = null, venueName = null } = facts;
  const dom = domainOf(email);
  if (!dom) return null;
  const isCompanyDomain = !FREE_MAIL.has(dom);

  if (corporateEventCount > 0) {
    const bits = [];
    bits.push(corporateEventCount === 1
      ? 'Booked a corporate event before'
      : `Booked ${corporateEventCount} corporate events before`);
    if (largestGuestCount) bits.push(`largest was ${largestGuestCount} guests`);
    if (venueName) bits.push(`at ${venueName}`);
    if (!isCompanyDomain) bits.push('on a personal address, which is common');
    return { tag: 'corporate', reason: `${bits.join(', ')}.` };
  }

  if (personalEventCount > 0) {
    // A company domain with only personal events is the false positive the
    // numbers warn about. Say nothing rather than guess wrong.
    return null;
  }

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
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingSuggestions.js server/utils/marketingSuggestions.test.js
git commit -m "feat(marketing): tag suggestions that never auto-apply"
```

---

## Task 9: Audience definitions and the contact list endpoint

**Lane:** mkt-c-resolver

**Files:**
- Modify: `server/utils/marketingAudience.js`
- Modify: `server/utils/marketingAudience.test.js`
- Modify: `server/routes/marketingContacts.js`
- Create: `server/routes/marketingContacts.list.test.js`

**Interfaces:**
- Consumes: `MAILABLE_SQL`, `LEAD_UNSUB_LATERAL`, `heldBackReason` (Task 7); `suggestTag` (Task 8); `getContactMessageHistory` (Task 6).
- Produces: `AUDIENCES` (array of `{id, name, rule, includes, where}`); `GET /api/marketing/contacts` (paginated, filtered); `GET /api/marketing/contacts/:id` (drawer detail); `GET /api/marketing/audiences` (list with live counts).

The seven audiences from the design, each carrying the human-readable `rule` and `includes` strings the UI shows.

- [ ] **Step 1: Append the audience definitions to `marketingAudience.js`**

```js
/**
 * The seven audiences from the approved design. Each is a saved RULE,
 * re-resolved every time, never a frozen list of people.
 *
 * `where` composes with MAILABLE_SQL and LEAD_UNSUB_LATERAL. Aliases in
 * scope: c = clients, agg = the per-client proposal aggregate LATERAL,
 * cc = the Check Cherry ledger aggregate LATERAL, tg = the tag aggregate.
 *
 * Event type is deliberately absent from every rule. legacy_cc_proposals
 * .event_type is NULL on all 1,230 rows and package_name describes the bar
 * package, not the occasion, so an event-type rule would silently drop the
 * entire 184-person Check Cherry cohort.
 */
const AUDIENCES = [
  {
    id: 'past-corporate',
    name: 'Past clients · corporate',
    rule: 'Paid us · tagged Corporate',
    includes: ['Has paid us', 'Tagged Corporate', 'Event finished'],
    where: `agg.paid_count > 0 AND agg.last_finished IS NOT NULL AND 'corporate' = ANY(tg.tags)`,
  },
  {
    id: 'past-all',
    name: 'Past clients · everyone',
    rule: 'Paid us · event finished',
    includes: ['Has paid us', 'Event finished'],
    where: `agg.paid_count > 0 AND agg.last_finished IS NOT NULL`,
  },
  {
    id: 'one-year-on',
    name: 'One year on',
    rule: 'Last event 11 to 13 months ago',
    includes: ['Event finished 11 to 13 months ago'],
    where: `agg.last_finished BETWEEN (CURRENT_DATE - INTERVAL '13 months')
                                  AND (CURRENT_DATE - INTERVAL '11 months')`,
  },
  {
    id: 'cold-quotes-spring',
    name: 'Cold quotes · spring',
    rule: 'Quoted March to June, never booked',
    includes: ['Has a proposal', 'Never paid', 'Quoted March to June'],
    where: `agg.proposal_count > 0 AND agg.paid_count = 0
            AND EXTRACT(MONTH FROM agg.first_quoted) BETWEEN 3 AND 6`,
  },
  {
    id: 'quoted-never-booked',
    name: 'Quoted, never booked',
    rule: 'Has a proposal · never paid',
    includes: ['Has a proposal', 'Never paid'],
    where: `agg.proposal_count > 0 AND agg.paid_count = 0`,
  },
  {
    id: 'thumbtack-live',
    name: 'Thumbtack · in conversation',
    rule: 'Thumbtack lead · replied in the last 14 days',
    includes: ['Thumbtack lead', 'Replied in 14 days'],
    where: `c.source = 'thumbtack' AND agg.last_inbound >= (NOW() - INTERVAL '14 days')`,
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

Add `AUDIENCES` and `AUDIENCE_BY_ID` to the module exports.

- [ ] **Step 2: Write the failing tests**

Append to `server/utils/marketingAudience.test.js`:

```js
const { AUDIENCES, AUDIENCE_BY_ID } = require('./marketingAudience');

test('ships the seven audiences from the design, in order', () => {
  assert.deepEqual(AUDIENCES.map(a => a.id), [
    'past-corporate', 'past-all', 'one-year-on', 'cold-quotes-spring',
    'quoted-never-booked', 'thumbtack-live', 'never-classified',
  ]);
});

test('every audience carries display strings and a where clause', () => {
  for (const a of AUDIENCES) {
    assert.ok(a.name && a.rule, `${a.id} missing name or rule`);
    assert.ok(Array.isArray(a.includes) && a.includes.length > 0, `${a.id} missing includes`);
    assert.ok(typeof a.where === 'string' && a.where.trim(), `${a.id} missing where`);
    assert.ok(!/\$\d/.test(a.where), `${a.id} where must not contain bind parameters`);
  }
});

test('no audience filters on event type', () => {
  // legacy_cc_proposals.event_type is NULL on all 1,230 rows, so an
  // event-type rule silently drops the entire Check Cherry cohort.
  for (const a of AUDIENCES) {
    assert.ok(!/event_type/i.test(a.where), `${a.id} filters on event_type`);
  }
});

test('lookup by id works', () => {
  assert.equal(AUDIENCE_BY_ID.get('past-corporate').name, 'Past clients · corporate');
  assert.equal(AUDIENCE_BY_ID.get('nope'), undefined);
});
```

- [ ] **Step 3: Run to verify the new tests fail, then pass after Step 1**

Run: `node -r dotenv/config --test server/utils/marketingAudience.test.js`
Expected: PASS, 14/14 (Step 1 already added the definitions; if you wrote the tests first, they fail with `AUDIENCES is not defined` before Step 1).

- [ ] **Step 4: Add the list endpoint**

In `server/routes/marketingContacts.js`, add the imports and the handler. The aggregate LATERALs are the load-bearing part; read the comments before changing any of them.

```js
const {
  MAILABLE_SQL, LEAD_UNSUB_LATERAL, AUDIENCES, AUDIENCE_BY_ID, heldBackReason,
} = require('../utils/marketingAudience');
const { suggestTag } = require('../utils/marketingSuggestions');
```

```js
// Per-client aggregates. Two LATERALs because the two eras live in different
// tables with different money units:
//   proposals.amount_paid is NUMERIC(10,2) DOLLARS (units legend schema.sql:575)
//   legacy_cc_proposals.total_cost_cents is CENTS
// Summed naively, a $760 Check Cherry booking reads as $76,000 and the whole
// 184-person cohort floats to the top of any spend sort. Divide by 100.0.
//
// The Check Cherry join is on EMAIL, not client_id: client_id is populated on
// only 197 of that table's 1,230 rows.
const CONTACT_AGGREGATES = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                                              AS proposal_count,
      COUNT(*) FILTER (WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')) AS paid_count,
      COALESCE(SUM(p.amount_paid) FILTER (
        WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')), 0)            AS paid_dollars,
      MIN(p.created_at)                                                     AS first_quoted,
      MAX(p.event_date) FILTER (WHERE p.event_date < CURRENT_DATE
        AND p.status IN ('deposit_paid','balance_paid','confirmed','completed'))                  AS last_finished,
      COUNT(*) FILTER (WHERE lower(replace(p.event_type, ' ', '-')) IN
        ('corporate-event','holiday-party','corporate-happy-hour','fundraiser-gala'))             AS corporate_events,
      COUNT(*) FILTER (WHERE lower(replace(p.event_type, ' ', '-')) IN
        ('wedding-reception','birthday-party','milestone-birthday','baby-shower','bridal-shower',
         'graduation','anniversary'))                                                             AS personal_events,
      MAX(p.guest_count)                                                    AS largest_guests,
      MAX(p.venue_name)                                                     AS a_venue
    FROM proposals p
    WHERE p.client_id = c.id AND p.status <> 'archived'
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(l.total_cost_cents), 0) / 100.0 AS paid_dollars,
      MAX(l.event_date)                            AS last_event
    FROM legacy_cc_proposals l
    WHERE l.client_email_normalized = lower(c.email) AND l.status = 'booked'
  ) cc ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(ct.tag ORDER BY ct.tag), '{}') AS tags
    FROM client_tags ct WHERE ct.client_id = c.id
  ) tg ON true
`;
```

```js
/**
 * GET /api/marketing/contacts
 *
 * Query: audience, tag, filter (all|untagged|corporate|do-not-contact),
 *        search, page, limit.
 *
 * Held-back contacts are returned with `mailable: false` and a
 * `held_back_reason` so the UI can show the "Always held back" panel, but the
 * recipient picker only ever offers `mailable: true` rows.
 */
router.get('/contacts', auth, adminOnly, asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const params = [];
  const conds = [];

  if (req.query.audience) {
    const aud = AUDIENCE_BY_ID.get(req.query.audience);
    if (!aud) throw new ValidationError({ audience: 'Unknown audience.' });
    conds.push(`(${aud.where})`);
  }
  if (req.query.tag) {
    params.push(req.query.tag);
    conds.push(`$${params.length} = ANY(tg.tags)`);
  }
  if (req.query.filter === 'untagged') {
    conds.push(`COALESCE(array_length(tg.tags, 1), 0) = 0`);
  } else if (req.query.filter === 'do-not-contact') {
    conds.push(`c.marketing_excluded = true`);
  }
  if (req.query.search) {
    params.push(`%${req.query.search.trim().toLowerCase()}%`);
    conds.push(`(lower(c.name) LIKE $${params.length} OR lower(c.email) LIKE $${params.length})`);
  }
  // `mailable_only` is what the recipient picker passes. The default view
  // shows everyone so held-back contacts stay visible and correctable.
  if (req.query.mailable_only === 'true') {
    conds.push(`(${MAILABLE_SQL})`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(limit, (page - 1) * limit);

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.email, c.source, c.email_status,
           c.marketing_excluded, c.marketing_excluded_reason,
           c.communication_preferences,
           COALESCE(lu.unsubscribed, false)                       AS lead_unsubscribed,
           tg.tags,
           agg.proposal_count::int, agg.paid_count::int,
           agg.corporate_events::int, agg.personal_events::int,
           agg.largest_guests::int, agg.a_venue,
           GREATEST(COALESCE(agg.last_finished, '-infinity'::date),
                    COALESCE(cc.last_event, '-infinity'::date))   AS last_event,
           (COALESCE(agg.paid_dollars, 0) + COALESCE(cc.paid_dollars, 0))::float8 AS lifetime_dollars,
           (${MAILABLE_SQL})                                      AS mailable,
           COUNT(*) OVER ()                                       AS total_count
      FROM clients c
      ${LEAD_UNSUB_LATERAL}
      ${CONTACT_AGGREGATES}
      ${where}
     ORDER BY last_event DESC NULLS LAST, c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
  res.json({
    total, page, limit,
    contacts: rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      source: r.source,
      tags: r.tags || [],
      // Derived states are computed here and NEVER stored.
      derived: r.paid_count > 0 ? 'paid' : (r.proposal_count > 0 ? 'quoted' : null),
      untagged: (r.tags || []).length === 0,
      last_event: r.last_event && r.last_event !== '-infinity' ? r.last_event : null,
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
      SELECT COUNT(*) FILTER (WHERE ${MAILABLE_SQL})::int AS emailable,
             COUNT(*)::int AS total
        FROM clients c
        ${LEAD_UNSUB_LATERAL}
        ${CONTACT_AGGREGATES}
       WHERE ${a.where}
    `);
    out.push({ id: a.id, name: a.name, rule: a.rule, includes: a.includes, ...rows[0] });
  }
  res.json(out);
}));

/** GET /api/marketing/contacts/:id — drawer detail, including message history. */
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
      FROM clients c
      ${LEAD_UNSUB_LATERAL}
      ${CONTACT_AGGREGATES}
     WHERE c.id = $1
  `, [id]);
  if (rows.length === 0) throw new NotFoundError('Contact not found.');

  const events = await pool.query(`
    SELECT p.id, p.event_date, p.event_type, p.venue_name, p.amount_paid::float8 AS amount
      FROM proposals p WHERE p.client_id = $1 AND p.status <> 'archived'
     ORDER BY p.event_date DESC LIMIT 20
  `, [id]);

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

Add the `getContactMessageHistory` import at the top of the file.

- [ ] **Step 5: Write the endpoint test**

Create `server/routes/marketingContacts.list.test.js`, reusing the harness shape from Task 3 (`req` helper, `before`/`after` fixtures). Cover, at minimum:

```js
test('a client with marketing_enabled false comes back mailable:false, reason unsubscribed', async () => {
  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(COALESCE(communication_preferences, '{}'::jsonb), '{marketing_enabled}', 'false')
     WHERE id = $1`, [clientId]
  );
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.equal(row.mailable, false);
  assert.equal(row.held_back_reason, 'unsubscribed');
});

test('a client with NO preference keys is mailable (tri-state)', async () => {
  await pool.query('UPDATE clients SET communication_preferences = NULL WHERE id = $1', [clientId]);
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r.body.contacts.find(c => c.id === clientId).mailable, true);
});

test('do-not-contact reports its own held-back reason, not unsubscribed', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'test'
     WHERE id = $1`, [clientId]
  );
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.equal(row.mailable, false);
  assert.equal(row.held_back_reason, 'do_not_contact');
  await pool.query(
    `UPDATE clients SET marketing_excluded = false, marketing_excluded_reason = NULL WHERE id = $1`,
    [clientId]
  );
});

test('lifetime_dollars converts Check Cherry cents, so a $760 booking is not $76,000', async () => {
  await pool.query(
    `INSERT INTO legacy_cc_proposals (cc_id, status, client_email_normalized, event_date, total_cost_cents)
     VALUES ($1, 'booked', $2, CURRENT_DATE - 400, 76000)`,
    [`cc-${NONCE}`, `mc-${NONCE}@test.invalid`]
  );
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const row = r.body.contacts.find(c => c.id === clientId);
  assert.ok(row.lifetime_dollars >= 760 && row.lifetime_dollars < 761,
    `expected ~760, got ${row.lifetime_dollars}`);
  await pool.query('DELETE FROM legacy_cc_proposals WHERE cc_id = $1', [`cc-${NONCE}`]);
});

test('an untagged contact carries a suggestion, a tagged one does not', async () => {
  const r1 = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  const before = r1.body.contacts.find(c => c.id === clientId);
  assert.equal(before.untagged, true);
  await req('PUT', `/api/marketing/contacts/${clientId}/tags`, adminToken, { tags: ['corporate'] });
  const r2 = await req('GET', `/api/marketing/contacts?search=${NONCE}`, adminToken);
  assert.equal(r2.body.contacts.find(c => c.id === clientId).suggestion, null);
});

test('mailable_only=true drops held-back contacts entirely', async () => {
  await pool.query(
    `UPDATE clients SET marketing_excluded = true, marketing_excluded_reason = 'x' WHERE id = $1`,
    [clientId]
  );
  const r = await req('GET', `/api/marketing/contacts?search=${NONCE}&mailable_only=true`, adminToken);
  assert.equal(r.body.contacts.find(c => c.id === clientId), undefined);
});

test('every audience resolves without a SQL error', async () => {
  const r = await req('GET', '/api/marketing/audiences', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 7);
  for (const a of r.body) {
    assert.equal(typeof a.emailable, 'number', `${a.id} returned no count`);
  }
});

test('an unknown audience is a 400, not a 500', async () => {
  const r = await req('GET', '/api/marketing/contacts?audience=nope', adminToken);
  assert.equal(r.status, 400);
});

test('a manager cannot read the contact list', async () => {
  const r = await req('GET', '/api/marketing/contacts', managerToken);
  assert.equal(r.status, 403);
});
```

- [ ] **Step 6: Run both suites, one at a time**

```bash
node -r dotenv/config --test server/utils/marketingAudience.test.js
node -r dotenv/config --test server/routes/marketingContacts.list.test.js
```

Expected: PASS on both. The audience test that matters most is "every audience resolves without a SQL error"; a typo in a `where` clause is otherwise invisible until the UI loads.

- [ ] **Step 7: Commit**

```bash
git add server/utils/marketingAudience.js server/utils/marketingAudience.test.js \
        server/routes/marketingContacts.js server/routes/marketingContacts.list.test.js
git commit -m "feat(marketing): audience definitions, contact list, and drawer detail"
```

---

## Task 10: Audiences tab, contact table, and inline tag editing

**Lane:** mkt-d-contacts-ui

**Files:**
- Create: `client/src/pages/admin/marketing/AudiencesTab.js`
- Create: `client/src/pages/admin/marketing/ContactTable.js`
- Create: `client/src/pages/admin/marketing/TagCell.js`
- Create: `client/src/pages/admin/marketing/HeldBackPanel.js`
- Modify: `client/src/pages/admin/EmailMarketingDashboard.js`
- Modify: `client/src/App.js`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `GET /api/marketing/contacts`, `GET /api/marketing/audiences`, `PUT /api/marketing/contacts/:id/tags`, `PUT /api/marketing/contacts/:id/do-not-contact` (Tasks 3, 4, 9); `MARKETING_TAGS`, `tagLabel`, `DERIVED_STATES` from `client/src/utils/marketingTags.js` (Task 2).

Four small components rather than one page, because a single file holding the audience list, the table, the tag editor, and the held-back panel lands in the 600-line yellow zone immediately.

**Every async surface needs loading, empty, error, and retry states.** The contact list is ~700 rows, so it paginates; there is no select-all across pages in phase 1 because there is nothing to select into yet.

- [ ] **Step 1: Replace the tab list in `EmailMarketingDashboard.js`**

```js
const TABS = [
  { label: 'Overview', path: '/marketing/overview' },
  { label: 'Audiences', path: '/marketing/audiences' },
  { label: 'Compose', path: '/marketing/compose' },
  { label: 'Sent', path: '/marketing/sent' },
];
```

Phase 1 ships only Audiences. Overview, Compose, and Sent render a placeholder reading "Coming in phase 2" rather than 404ing, so the nav matches the approved design from day one.

Keep the existing `/email-marketing/*` routes mounted and working. They are the lead-side surface phase 2 extracts; breaking them now would strand the paused sequence engine.

- [ ] **Step 2: Write `TagCell.js`**

```js
import React, { useState } from 'react';
import { MARKETING_TAGS, tagLabel } from '../../../utils/marketingTags';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';

/**
 * Inline tag editor for one contact. Optimistic, with rollback on failure:
 * classifying 184 contacts is a long grind and a round trip per click would
 * make it unusable, but a silent failed save would be worse than a slow one.
 *
 * Do-not-contact is NOT in this menu. It is displayed as a tag but is set
 * through its own endpoint, needs a reason, and takes a confirm to remove,
 * because it is the only classification whose accidental removal emails
 * someone who asked not to be emailed.
 */
export default function TagCell({ contact, onChange }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const tags = contact.tags || [];

  const toggle = async (id) => {
    const next = tags.includes(id) ? tags.filter(t => t !== id) : [...tags, id];
    const prev = tags;
    onChange(contact.id, next);            // optimistic
    setSaving(true);
    try {
      const res = await api.put(`/marketing/contacts/${contact.id}/tags`, { tags: next });
      onChange(contact.id, res.data.tags); // server order wins
    } catch (err) {
      onChange(contact.id, prev);          // rollback
      toast.error('Could not save that tag. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mkt-tagcell">
      <button
        type="button"
        className="mkt-tagcell-trigger"
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        aria-expanded={open}
      >
        {tags.length === 0
          ? <span className="mkt-tag mkt-tag-untagged">Untagged</span>
          : tags.map(t => <span key={t} className="mkt-tag">{tagLabel(t)}</span>)}
        {contact.do_not_contact && <span className="mkt-tag mkt-tag-dnc">Do not contact</span>}
      </button>
      {open && (
        <div className="mkt-tagcell-menu" role="menu">
          {MARKETING_TAGS.map(t => (
            <label key={t.id} className="mkt-tagcell-option">
              <input
                type="checkbox"
                checked={tags.includes(t.id)}
                onChange={() => toggle(t.id)}
                disabled={saving}
              />
              {t.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write `ContactTable.js`**

Columns: Contact (name over email), Marketing tags (`TagCell`), Last event, Lifetime, and a row click that opens the drawer. Held-back rows get a `mkt-row-held` class and their reason as a chip. A row with a `suggestion` renders the reason text and an Accept button that calls the same tag endpoint.

Required states, all four, no exceptions:

```js
if (loading) return <div className="loading"><div className="spinner" />Loading contacts…</div>;
if (error) return (
  <div className="mkt-error">
    Could not load contacts. <button type="button" onClick={retry}>Try again</button>
  </div>
);
if (contacts.length === 0) return (
  <div className="mkt-empty">
    {search || filter !== 'all'
      ? 'No contacts match that filter.'
      : 'No contacts yet.'}
  </div>
);
```

- [ ] **Step 4: Write `HeldBackPanel.js` and `AudiencesTab.js`**

`HeldBackPanel` shows the three counts (Do not contact, Unsubscribed, Bounced) from the list response. `AudiencesTab` composes: audience list on the left with name, rule, and emailable count; quick filters (All, Untagged, Corporate, Do not contact); the search box; `ContactTable`; `HeldBackPanel`.

- [ ] **Step 5: Add the routes in `App.js`**

Mirror the existing `/email-marketing` mount at line 584, adding `/marketing` with the same admin guard, `AudiencesTab` as the `audiences` child, and placeholder elements for `overview`, `compose`, and `sent`.

- [ ] **Step 6: Add the CSS to `index.css`**

Vanilla CSS only, `mkt-` prefix, using the existing OS design-system custom properties. No new files, no CSS modules.

- [ ] **Step 7: Verify in the browser**

Start the dev server (it is a Claude-managed background process and does not auto-reload server edits; restart it after any server change). Then walk: the Audiences tab loads, an audience filters the table, a tag toggles and survives a refresh, a suggestion accepts, a held-back contact shows its reason and cannot be tagged into a mailable state, search finds someone outside the current filter, and every empty and error state renders.

- [ ] **Step 8: Run the CI build, then commit**

```bash
cd client && CI=true npx react-scripts build && cd ..
npm run check:filesize
git add client/src/pages/admin/marketing client/src/pages/admin/EmailMarketingDashboard.js \
        client/src/App.js client/src/index.css
git commit -m "feat(marketing): audiences tab with contact table and inline tagging"
```

---

## Task 11: Documentation for the remaining lanes

**Lane:** mkt-d-contacts-ui

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Add the read routes to ARCHITECTURE.md's route table**

```
| GET | `/api/marketing/contacts` | admin | Paginated contact list with tags, derived states, mailability, and suggestions |
| GET | `/api/marketing/contacts/:id` | admin | Contact drawer: event history and message history |
| GET | `/api/marketing/audiences` | admin | The seven audience definitions with live counts |
```

- [ ] **Step 2: Note the resolver in ARCHITECTURE.md**

One paragraph: `server/utils/marketingAudience.js` is the single definition of who may receive marketing, exporting both a SQL fragment and a JS predicate that a test holds in agreement. `contactMessageHistory.js` unions three tables because `message_log.proposal_id` is NOT NULL.

- [ ] **Step 3: Add the new files and pages to README.md's folder tree, and the feature to Key Features**

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs(marketing): phase 1 routes, resolver, and folder tree"
```

---

## Self-review notes

Checked against the spec, 2026-08-11:

- **Spec §4.1 tags** → Tasks 1, 2, 3. **§4.1 suggestions** → Task 8, wired in Task 9.
- **§4.2 Do-not-contact** → Tasks 1, 4; the display-as-a-tag half is Task 10's `TagCell`.
- **§4.3 resolver** → Tasks 7, 9. All seven mailability conditions have a test.
- **§4.3 money units, CC email join, casing** → Task 9's `CONTACT_AGGREGATES`, with a test pinning the cents conversion.
- **§4.4 contacts surface** → Tasks 9, 10. **§4.4 contact drawer + automated sends** → Tasks 6, 9, 10.
- **§7 schema** → Task 1, including the guarded-DO-block requirement and a post-apply assertion.
- **Deliberately deferred to phase 2 and 3** (declared in the lane map, not silently dropped): compose and send, all compliance fixes, the `emailMarketing.js` extraction, `email_sends.client_id`, moments, and Sent attribution.

Two things a phase 1 implementer will hit that are worth stating plainly rather than discovering:

- `email_sends.client_id` does not exist until phase 2, so Task 6's campaign leg is behind a column probe and returns nothing. That is correct, not a bug.
- The dev DB lacks some prod CHECK constraints, so a green local suite is not proof against `ci-smoke`. Never pipe `testdb-smoke` output to `tail`.
