# Legal Pages and SMS Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public Privacy Policy and Terms of Use, wire the footer to them, and capture recorded SMS consent on the quote wizard and staff application so the Twilio A2P campaign can be submitted against real URLs.

**Architecture:** The exact consent sentence is defined once per side (client constant for display, server map for the audit record) and a node test asserts the two agree, so the string a reviewer reads on `/privacy` and the string a user clicks can never drift. Submitting a form writes the existing `communication_preferences.sms_enabled` boolean plus an `sms_opt_in_at` stamp using the same jsonb pattern `smsInbound.js` already uses for STOP/START, and appends a row to a new append-only `sms_consent_log` table which is what gets handed to a carrier.

**Tech Stack:** Node.js / Express 4, React 18 (CRA), Postgres (raw SQL via `pg`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-22-legal-pages-sms-consent-design.md` (commit `70c8127f`)

## Global Constraints

- **No em dashes in client-facing copy or spec prose.** Commas, periods, colons, parentheticals only. This plan contains a lot of copy; the rule applies to all of it.
- **The Privacy Policy sharing paragraph is not to be reworded or trimmed.** Carriers look for those exact sentences. Copy it verbatim from Task 1.
- **An audit row never stores browser-supplied text.** The wire carries `sms_consent` (boolean) and `sms_consent_version` (string) only. `copy_text` is always resolved server-side from `server/data/smsConsentCopy.js`.
- **Unchecked is not an error.** It writes `sms_enabled: false` and a `consented: false` log row. No submit is ever blocked by the checkbox.
- **Existing clients and staff are not touched.** No backfill, no migration of existing `communication_preferences`, no re-consent sweep.
- Wire keys are snake_case. Errors go through `AppError` subclasses (`ValidationError`). Client API calls follow the surrounding file's existing style.
- Server suites run one at a time against the shared dev DB: `node -r dotenv/config --test <file>`.
- Client gate before any push: `cd client && CI=true npx react-scripts build`.
- No new env var. The only schema change is the additive block in Task 2.
- Line cites were verified 2026-07-22. Where a cite and the code disagree by a line or two, trust the described content, not the number.

## Lane map

```yaml
lanes:
  - id: legal-consent-data
    footprint:
      - client/src/constants/smsConsent.js
      - server/data/smsConsentCopy.js
      - server/utils/smsConsent.js
      - server/utils/smsConsent.test.js
      - server/db/schema.sql
      - server/routes/proposals/public.js
      - server/routes/proposals/publicSmsConsent.test.js
      - server/routes/application.js
      - server/routes/application.smsConsent.test.js
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
  - id: legal-pages-ui
    footprint:
      - client/src/pages/website/legal/LegalLayout.js
      - client/src/pages/website/legal/PrivacyPage.js
      - client/src/pages/website/legal/TermsPage.js
      - client/src/App.js
      - client/src/components/PublicLayout.js
      - client/src/pages/website/quoteWizard/QuoteWizard.js
      - client/src/pages/website/quoteWizard/steps/YourInfoStep.js
      - client/src/pages/Application.js
      - README.md
    depends_on: [legal-consent-data]
    review_fleet: [code-review, consistency-check, ui-ux-review]
```

`server/db/schema.sql` is on `scripts/sensitive-paths.txt`, so lane `legal-consent-data` takes the full fleet regardless of size. Lane `legal-pages-ui` is copy and UI only and takes the light fleet.

---

## Lane: legal-consent-data

### Task 1: Consent copy modules and the drift test

Both halves of the copy plus the test that keeps them equal. This lands first because every later task imports one of these two modules.

**Files:**
- Create: `client/src/constants/smsConsent.js`
- Create: `server/data/smsConsentCopy.js`
- Create: `server/utils/smsConsent.test.js`

**Interfaces:**
- Produces: `SMS_CONSENT_VERSION` (string `'v1'`), `SMS_CONSENT_CLIENT` (string), `SMS_CONSENT_STAFF` (string) from the client constant. `getConsentCopy(version, audience)` returning the canonical string or `null`, and `SMS_CONSENT_VERSION` from the server module, where `audience` is `'client'` or `'staff'`.

- [ ] **Step 1: Write the client constant**

Create `client/src/constants/smsConsent.js`:

```js
// Single source of truth for the SMS consent sentence shown to users.
//
// This exact text is rendered in three places: the quote wizard checkbox, the
// staff application checkbox, and the Text Messaging section of /privacy. A
// Twilio reviewer compares the public page against the form, so the strings
// must be one literal, not three copies.
//
// The server keeps a matching copy in server/data/smsConsentCopy.js for the
// audit record. server/utils/smsConsent.test.js fails if they diverge.
// Bump SMS_CONSENT_VERSION whenever either string changes, and add the new
// version to the server map rather than editing the old entry: existing
// sms_consent_log rows must keep resolving to the text those users agreed to.

export const SMS_CONSENT_VERSION = 'v1';

export const SMS_CONSENT_CLIENT =
  'Text me about my event. I agree to receive text messages from Dr. Bartender ' +
  'about my quote, booking, payments, and event details at the mobile number ' +
  'provided. Message frequency varies. Msg & data rates may apply. Reply STOP ' +
  'to opt out, HELP for help. Consent is not a condition of purchase. See our ' +
  'Privacy Policy and Terms.';

export const SMS_CONSENT_STAFF =
  'Text me about shifts. I agree to receive text messages from Dr. Bartender ' +
  'about shift offers, schedule changes, and event day logistics at the mobile ' +
  'number provided. Message frequency varies. Msg & data rates may apply. Reply ' +
  'STOP to opt out, HELP for help. Consent is not a condition of hiring or ' +
  'employment. See our Privacy Policy and Terms.';
```

- [ ] **Step 2: Write the server copy map**

Create `server/data/smsConsentCopy.js`:

```js
// Canonical SMS consent text, server side, keyed by version.
//
// An audit row must never store text the browser supplied, so recordSmsConsent
// resolves copy_text from this map using the version the client submitted.
// Entries are append-only: an old version stays forever so historical
// sms_consent_log rows keep resolving to what those users actually agreed to.
//
// Mirrors client/src/constants/smsConsent.js. server/utils/smsConsent.test.js
// fails if the two diverge.

const SMS_CONSENT_VERSION = 'v1';

const SMS_CONSENT_COPY = {
  v1: {
    client:
      'Text me about my event. I agree to receive text messages from Dr. Bartender ' +
      'about my quote, booking, payments, and event details at the mobile number ' +
      'provided. Message frequency varies. Msg & data rates may apply. Reply STOP ' +
      'to opt out, HELP for help. Consent is not a condition of purchase. See our ' +
      'Privacy Policy and Terms.',
    staff:
      'Text me about shifts. I agree to receive text messages from Dr. Bartender ' +
      'about shift offers, schedule changes, and event day logistics at the mobile ' +
      'number provided. Message frequency varies. Msg & data rates may apply. Reply ' +
      'STOP to opt out, HELP for help. Consent is not a condition of hiring or ' +
      'employment. See our Privacy Policy and Terms.',
  },
};

/**
 * Resolve the canonical consent text.
 * @param {string} version
 * @param {'client'|'staff'} audience
 * @returns {string|null} null for an unknown version or audience
 */
function getConsentCopy(version, audience) {
  const entry = SMS_CONSENT_COPY[version];
  if (!entry) return null;
  return entry[audience] || null;
}

module.exports = { SMS_CONSENT_VERSION, SMS_CONSENT_COPY, getConsentCopy };
```

- [ ] **Step 3: Write the failing drift test**

Create `server/utils/smsConsent.test.js`. The client file is ESM inside CRA and cannot be `require`d from node, so the test reads it as text and extracts the literals. That is deliberate: it is the only cross-package assertion available without a build step.

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SMS_CONSENT_VERSION, getConsentCopy } = require('../data/smsConsentCopy');

/**
 * Pull an exported string literal out of the client constants file and
 * concatenate its adjacent-literal pieces, so the test compares the resolved
 * sentence rather than the source formatting.
 */
function readClientConstant(source, name) {
  const start = source.indexOf(`export const ${name} =`);
  assert.ok(start !== -1, `${name} not found in client constant file`);
  const end = source.indexOf(';', start);
  assert.ok(end !== -1, `${name} declaration is unterminated`);
  const body = source.slice(start, end);
  const pieces = body.match(/'((?:[^'\\]|\\.)*)'/g) || [];
  return pieces
    .map(p => p.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

const CLIENT_CONSTANT_PATH = path.join(
  __dirname, '..', '..', 'client', 'src', 'constants', 'smsConsent.js'
);

test('sms consent copy > client and server agree on the client sentence', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  assert.strictEqual(
    readClientConstant(source, 'SMS_CONSENT_CLIENT'),
    getConsentCopy(SMS_CONSENT_VERSION, 'client')
  );
});

test('sms consent copy > client and server agree on the staff sentence', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  assert.strictEqual(
    readClientConstant(source, 'SMS_CONSENT_STAFF'),
    getConsentCopy(SMS_CONSENT_VERSION, 'staff')
  );
});

test('sms consent copy > client and server agree on the version', () => {
  const source = fs.readFileSync(CLIENT_CONSTANT_PATH, 'utf8');
  const match = source.match(/export const SMS_CONSENT_VERSION = '([^']+)'/);
  assert.ok(match, 'SMS_CONSENT_VERSION not found in client constant file');
  assert.strictEqual(match[1], SMS_CONSENT_VERSION);
});

test('sms consent copy > carries the required disclosures', () => {
  for (const audience of ['client', 'staff']) {
    const copy = getConsentCopy(SMS_CONSENT_VERSION, audience);
    assert.match(copy, /Dr\. Bartender/);
    assert.match(copy, /Message frequency varies/);
    assert.match(copy, /Msg & data rates may apply/);
    assert.match(copy, /Reply STOP to opt out, HELP for help/);
    assert.match(copy, /not a condition of/);
    assert.doesNotMatch(copy, /—/, 'no em dashes in client-facing copy');
  }
});

test('sms consent copy > unknown version or audience resolves to null', () => {
  assert.strictEqual(getConsentCopy('v99', 'client'), null);
  assert.strictEqual(getConsentCopy(SMS_CONSENT_VERSION, 'nobody'), null);
});
```

- [ ] **Step 4: Run the test**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/smsConsent.test.js`
Expected: all 5 tests PASS. If a copy assertion fails, fix the copy to match Step 1, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add client/src/constants/smsConsent.js server/data/smsConsentCopy.js server/utils/smsConsent.test.js
git commit -m "feat(sms-consent): versioned consent copy with a client/server drift test"
```

---

### Task 2: The sms_consent_log table

**Files:**
- Modify: `server/db/schema.sql` (append at end of file)

**Interfaces:**
- Produces: table `sms_consent_log` with columns `id, client_id, user_id, phone, consented, copy_version, copy_text, source_form, ip, user_agent, created_at`.

- [ ] **Step 1: Append the DDL**

Append to the end of `server/db/schema.sql`, following the existing idempotent style:

```sql
-- ─── SMS consent audit (A2P 10DLC, 2026-07-22) ───────────────────
-- Append-only proof of opt-in. communication_preferences.sms_enabled is what
-- the comms system reads; THIS is what gets handed to a carrier or a claimant.
-- Both FKs are ON DELETE SET NULL and phone is retained, so deleting the
-- subject never destroys the compliance record. copy_text is resolved
-- server-side from server/data/smsConsentCopy.js, never from the request body.
-- See docs/superpowers/specs/2026-07-22-legal-pages-sms-consent-design.md
CREATE TABLE IF NOT EXISTS sms_consent_log (
  id BIGSERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  consented BOOLEAN NOT NULL,
  copy_version TEXT NOT NULL,
  copy_text TEXT NOT NULL,
  source_form TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A carrier dispute arrives as a phone number, so that is the lookup that matters.
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_phone_created_at
  ON sms_consent_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_client
  ON sms_consent_log(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_log_user
  ON sms_consent_log(user_id, created_at DESC);
```

- [ ] **Step 2: Apply to the dev database**

Run: `cd ~/projects/os && node -r dotenv/config server/db/index.js` if that is the schema runner in use; otherwise apply `schema.sql` with the project's existing bootstrap command (check `package.json` scripts for `db:*` before inventing one).

- [ ] **Step 3: Verify the table exists**

Run:
```bash
cd ~/projects/os && node -r dotenv/config -e "
const { pool } = require('./server/db');
pool.query(\"SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='sms_consent_log' ORDER BY ordinal_position\")
  .then(r => { console.table(r.rows); return pool.end(); });
"
```
Expected: 11 rows, `phone`/`consented`/`copy_version`/`copy_text`/`source_form`/`created_at` all `NO` for is_nullable, `client_id`/`user_id`/`ip`/`user_agent` all `YES`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(sms-consent): append-only sms_consent_log audit table"
```

---

### Task 3: The recordSmsConsent helper

**Files:**
- Create: `server/utils/smsConsent.js`
- Modify: `server/utils/smsConsent.test.js` (append tests)

**Interfaces:**
- Consumes: `getConsentCopy` from `server/data/smsConsentCopy.js` (Task 1), table from Task 2.
- Produces: `recordSmsConsent(db, opts)` where `opts` is `{ clientId?, userId?, phone, consented, version, sourceForm, ip?, userAgent? }`, returning `{ applied: boolean, logged: boolean }`. `db` is a `pg` pool or an in-transaction client, so callers inside `BEGIN` pass their `dbClient`.
- Produces: `consentFieldsFromBody(body)` returning `{ consented, version }` or `null` when the body carries no consent fields.
- Produces: `requestMeta(req)` returning `{ ip, userAgent }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/smsConsent.test.js`:

```js
const { pool } = require('../db');
const {
  recordSmsConsent, consentFieldsFromBody, requestMeta,
} = require('./smsConsent');

async function makeClient(phone) {
  const r = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
    ['Consent Fixture', `consent-${Date.now()}-${Math.round(process.hrtime()[1])}@example.invalid`, phone]
  );
  return r.rows[0].id;
}

async function cleanupClient(clientId) {
  await pool.query('DELETE FROM sms_consent_log WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
}

test('recordSmsConsent > consent true sets sms_enabled and stamps sms_opt_in_at', async (t) => {
  const clientId = await makeClient('3125550101');
  t.after(() => cleanupClient(clientId));

  const result = await recordSmsConsent(pool, {
    clientId, phone: '3125550101', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
    ip: '203.0.113.9', userAgent: 'test-agent',
  });
  assert.deepStrictEqual(result, { applied: true, logged: true });

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, true);
  assert.ok(row.rows[0].p.sms_opt_in_at, 'sms_opt_in_at stamped');

  const log = await pool.query('SELECT * FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].consented, true);
  assert.strictEqual(log.rows[0].source_form, 'quote_wizard');
  assert.strictEqual(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION, 'client'));
  assert.strictEqual(log.rows[0].ip, '203.0.113.9');
});

test('recordSmsConsent > consent false disables sms and stamps sms_opt_out_at', async (t) => {
  const clientId = await makeClient('3125550102');
  t.after(() => cleanupClient(clientId));

  await recordSmsConsent(pool, {
    clientId, phone: '3125550102', consented: false,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  });

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, false);
  assert.ok(row.rows[0].p.sms_opt_out_at, 'sms_opt_out_at stamped');

  const log = await pool.query('SELECT consented FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows[0].consented, false);
});

test('recordSmsConsent > an unchanged repeat submit does not append a duplicate row', async (t) => {
  const clientId = await makeClient('3125550103');
  t.after(() => cleanupClient(clientId));

  const args = {
    clientId, phone: '3125550103', consented: true,
    version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard',
  };
  const first = await recordSmsConsent(pool, args);
  const second = await recordSmsConsent(pool, args);

  assert.strictEqual(first.logged, true);
  assert.strictEqual(second.logged, false, 'same value + same version appends nothing');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 1);
});

test('recordSmsConsent > a changed answer appends a second row', async (t) => {
  const clientId = await makeClient('3125550104');
  t.after(() => cleanupClient(clientId));

  const base = { clientId, phone: '3125550104', version: SMS_CONSENT_VERSION, sourceForm: 'quote_wizard' };
  await recordSmsConsent(pool, { ...base, consented: true });
  await recordSmsConsent(pool, { ...base, consented: false });

  const log = await pool.query(
    'SELECT consented FROM sms_consent_log WHERE client_id = $1 ORDER BY id ASC', [clientId]
  );
  assert.deepStrictEqual(log.rows.map(r => r.consented), [true, false]);
});

test('recordSmsConsent > an unknown version is refused, nothing is written', async (t) => {
  const clientId = await makeClient('3125550105');
  t.after(() => cleanupClient(clientId));

  const result = await recordSmsConsent(pool, {
    clientId, phone: '3125550105', consented: true,
    version: 'v99', sourceForm: 'quote_wizard',
  });
  assert.deepStrictEqual(result, { applied: false, logged: false });

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [clientId]);
  assert.strictEqual(log.rows.length, 0);

  const row = await pool.query('SELECT communication_preferences AS p FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(row.rows[0].p.sms_enabled, true, 'default untouched');
});

test('consentFieldsFromBody > absent consent fields return null', () => {
  assert.strictEqual(consentFieldsFromBody({}), null);
  assert.strictEqual(consentFieldsFromBody({ sms_consent: undefined }), null);
});

test('consentFieldsFromBody > coerces to a strict boolean and keeps the version', () => {
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: true, sms_consent_version: 'v1' }),
    { consented: true, version: 'v1' }
  );
  assert.deepStrictEqual(
    consentFieldsFromBody({ sms_consent: 'yes', sms_consent_version: 'v1' }),
    { consented: false, version: 'v1' },
    'only a real boolean true counts as consent'
  );
});

test('consentFieldsFromBody > ignores a forged copy_text', () => {
  const parsed = consentFieldsFromBody({
    sms_consent: true, sms_consent_version: 'v1', copy_text: 'I agree to anything',
  });
  assert.deepStrictEqual(parsed, { consented: true, version: 'v1' });
  assert.ok(!('copy_text' in parsed));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/smsConsent.test.js`
Expected: FAIL with `Cannot find module './smsConsent'`.

- [ ] **Step 3: Write the implementation**

Create `server/utils/smsConsent.js`:

```js
const { getConsentCopy } = require('../data/smsConsentCopy');

/**
 * Pull the consent fields off a request body.
 *
 * Only a strict boolean true counts as consent: a truthy string from a
 * hand-rolled client must not silently opt someone in. Returns null when the
 * body carries no consent fields at all, which is how an older cached client
 * bundle stays harmless.
 *
 * copy_text is deliberately NOT read. The audit record resolves its own text.
 *
 * @param {Object} body
 * @returns {{consented: boolean, version: string}|null}
 */
function consentFieldsFromBody(body) {
  if (!body || body.sms_consent === undefined || body.sms_consent === null) return null;
  return {
    consented: body.sms_consent === true,
    version: typeof body.sms_consent_version === 'string' ? body.sms_consent_version : '',
  };
}

/**
 * Best-effort request metadata for the audit row.
 * @param {Object} req
 * @returns {{ip: string|null, userAgent: string|null}}
 */
function requestMeta(req) {
  if (!req) return { ip: null, userAgent: null };
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;
  const ua = (req.get && req.get('user-agent')) || null;
  return {
    ip: ip ? String(ip).slice(0, 100) : null,
    userAgent: ua ? String(ua).slice(0, 500) : null,
  };
}

/**
 * Persist an SMS consent answer: flip the preference, stamp the audit
 * timestamp, and append a proof row.
 *
 * The preference write mirrors setSmsEnabled in server/utils/smsInbound.js so
 * a form answer and an inbound STOP land in the same shape. The audit path is
 * a static literal because jsonb_set needs a text[] path; it is a controlled
 * internal constant, never user input.
 *
 * The log is a record of consent CHANGES, not of page submits: an unchanged
 * repeat (same value, same version) appends nothing, so a client who edits and
 * resubmits a quote does not accumulate identical rows.
 *
 * @param {Object} db pg pool or an in-transaction client
 * @param {Object} opts
 * @param {number} [opts.clientId]
 * @param {number} [opts.userId]
 * @param {string} opts.phone
 * @param {boolean} opts.consented
 * @param {string} opts.version
 * @param {string} opts.sourceForm 'quote_wizard' | 'staff_application'
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @returns {Promise<{applied: boolean, logged: boolean}>}
 */
async function recordSmsConsent(db, {
  clientId = null, userId = null, phone, consented,
  version, sourceForm, ip = null, userAgent = null,
}) {
  if (!clientId && !userId) return { applied: false, logged: false };

  const audience = clientId ? 'client' : 'staff';
  const copyText = getConsentCopy(version, audience);
  // An unknown version means we cannot say what they agreed to, so we record
  // nothing rather than record a lie. Nothing is thrown: a stale client bundle
  // must never break a submit.
  if (!copyText) return { applied: false, logged: false };

  const DEFAULT_PREFS = `'{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb`;
  const auditPath = consented ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";
  const table = clientId ? 'clients' : 'users';
  const subjectId = clientId || userId;

  await db.query(
    `UPDATE ${table}
     SET communication_preferences = jsonb_set(
           jsonb_set(COALESCE(communication_preferences, ${DEFAULT_PREFS}), '{sms_enabled}', $2::jsonb),
           ${auditPath}, to_jsonb(NOW()::text))
     WHERE id = $1`,
    [subjectId, JSON.stringify(consented)]
  );

  const subjectColumn = clientId ? 'client_id' : 'user_id';
  const prior = await db.query(
    `SELECT consented, copy_version FROM sms_consent_log
      WHERE ${subjectColumn} = $1
      ORDER BY id DESC LIMIT 1`,
    [subjectId]
  );
  const last = prior.rows[0];
  if (last && last.consented === consented && last.copy_version === version) {
    return { applied: true, logged: false };
  }

  await db.query(
    `INSERT INTO sms_consent_log
       (client_id, user_id, phone, consented, copy_version, copy_text, source_form, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [clientId, userId, String(phone || ''), consented, version, copyText, sourceForm, ip, userAgent]
  );

  return { applied: true, logged: true };
}

module.exports = { recordSmsConsent, consentFieldsFromBody, requestMeta };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/smsConsent.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsConsent.js server/utils/smsConsent.test.js
git commit -m "feat(sms-consent): recordSmsConsent helper with change-only audit rows"
```

---

### Task 4: Capture consent on the public quote submit

`POST /api/proposals/public/capture-lead` is deliberately left alone: it writes `email_leads` and `quote_drafts` only and never creates a `clients` row, so there is no SMS-reachable subject to consent for. The `clients` row is born at submit via `findOrCreateClient`.

**Files:**
- Modify: `server/routes/proposals/public.js` (destructure near line 235, call after `findOrCreateClient` near line 279)
- Create: `server/routes/proposals/publicSmsConsent.test.js`

**Interfaces:**
- Consumes: `recordSmsConsent`, `consentFieldsFromBody`, `requestMeta` (Task 3).
- Produces: `POST /api/proposals/public/submit` accepting `sms_consent` (boolean) and `sms_consent_version` (string).

- [ ] **Step 1: Write the failing test**

Create `server/routes/proposals/publicSmsConsent.test.js`. Follow the surrounding suites' harness style; if they boot the app via a shared helper, use that helper rather than the inline `require('../../app')` below.

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../../app');
const { pool } = require('../../db');
const { SMS_CONSENT_VERSION, getConsentCopy } = require('../../data/smsConsentCopy');

const PHONE = '3125550911';
const EMAIL = 'consent-submit@example.invalid';

async function activePackageId() {
  const r = await pool.query('SELECT id FROM service_packages WHERE is_active = true ORDER BY id LIMIT 1');
  assert.ok(r.rows[0], 'dev DB needs at least one active service package');
  return r.rows[0].id;
}

async function cleanup() {
  const c = await pool.query('SELECT id FROM clients WHERE email = $1', [EMAIL]);
  for (const row of c.rows) {
    await pool.query('DELETE FROM sms_consent_log WHERE client_id = $1', [row.id]);
    await pool.query('DELETE FROM proposals WHERE client_id = $1', [row.id]);
    await pool.query('DELETE FROM clients WHERE id = $1', [row.id]);
  }
  await pool.query('DELETE FROM quote_drafts WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM email_leads WHERE email = $1', [EMAIL]);
}

function body(extra) {
  return {
    client_name: 'Consent Tester',
    client_email: EMAIL,
    client_phone: PHONE,
    event_date: '2026-12-31',
    event_duration_hours: 4,
    venue_city: 'Chicago',
    venue_state: 'IL',
    guest_count: 50,
    ...extra,
  };
}

test('public submit > sms_consent true records the opt-in', async (t) => {
  t.after(cleanup);
  await cleanup();
  const package_id = await activePackageId();

  const res = await request(app).post('/api/proposals/public/submit').send(
    body({ package_id, sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION })
  );
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const c = await pool.query('SELECT id, communication_preferences AS p FROM clients WHERE email = $1', [EMAIL]);
  assert.strictEqual(c.rows[0].p.sms_enabled, true);
  assert.ok(c.rows[0].p.sms_opt_in_at);

  const log = await pool.query('SELECT * FROM sms_consent_log WHERE client_id = $1', [c.rows[0].id]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].source_form, 'quote_wizard');
  assert.strictEqual(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION, 'client'));
});

test('public submit > sms_consent false opts out and still succeeds', async (t) => {
  t.after(cleanup);
  await cleanup();
  const package_id = await activePackageId();

  const res = await request(app).post('/api/proposals/public/submit').send(
    body({ package_id, sms_consent: false, sms_consent_version: SMS_CONSENT_VERSION })
  );
  assert.strictEqual(res.status, 200, 'an unchecked box never blocks a submit');

  const c = await pool.query('SELECT id, communication_preferences AS p FROM clients WHERE email = $1', [EMAIL]);
  assert.strictEqual(c.rows[0].p.sms_enabled, false);

  const log = await pool.query('SELECT consented FROM sms_consent_log WHERE client_id = $1', [c.rows[0].id]);
  assert.strictEqual(log.rows[0].consented, false);
});

test('public submit > a forged copy_text is ignored, canonical text is stored', async (t) => {
  t.after(cleanup);
  await cleanup();
  const package_id = await activePackageId();

  await request(app).post('/api/proposals/public/submit').send(
    body({
      package_id, sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION,
      copy_text: 'I agree to unlimited marketing forever',
    })
  );

  const c = await pool.query('SELECT id FROM clients WHERE email = $1', [EMAIL]);
  const log = await pool.query('SELECT copy_text FROM sms_consent_log WHERE client_id = $1', [c.rows[0].id]);
  assert.strictEqual(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION, 'client'));
});

test('public submit > omitting consent fields leaves the client default untouched', async (t) => {
  t.after(cleanup);
  await cleanup();
  const package_id = await activePackageId();

  const res = await request(app).post('/api/proposals/public/submit').send(body({ package_id }));
  assert.strictEqual(res.status, 200);

  const c = await pool.query('SELECT id, communication_preferences AS p FROM clients WHERE email = $1', [EMAIL]);
  assert.strictEqual(c.rows[0].p.sms_enabled, true, 'grandfathered default');
  assert.strictEqual(c.rows[0].p.sms_opt_in_at, undefined, 'no stamp without an answer');

  const log = await pool.query('SELECT id FROM sms_consent_log WHERE client_id = $1', [c.rows[0].id]);
  assert.strictEqual(log.rows.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/proposals/publicSmsConsent.test.js`
Expected: FAIL. The consent assertions fail because nothing writes `sms_consent_log`.

- [ ] **Step 3: Wire the route**

In `server/routes/proposals/public.js`, add to the requires at the top of the file:

```js
const { recordSmsConsent, consentFieldsFromBody, requestMeta } = require('../../utils/smsConsent');
```

Add `sms_consent` and `sms_consent_version` to the `req.body` destructure in the `/public/submit` handler (near line 235), at the end of the existing list:

```js
    client_provides_glassware,
    class_options,
    sms_consent, sms_consent_version
  } = req.body;
```

Immediately after the `prefRow` query that follows `findOrCreateClient` (near line 279), insert:

```js
    // Recorded SMS consent from the quote wizard checkbox (A2P 10DLC).
    // Inside the transaction on purpose: a consent record that outlives a
    // rolled-back proposal would claim an opt-in that never happened. Absent
    // fields mean an older cached bundle, which leaves the client's existing
    // preference alone.
    const consent = consentFieldsFromBody({ sms_consent, sms_consent_version });
    if (consent) {
      const meta = requestMeta(req);
      await recordSmsConsent(dbClient, {
        clientId: finalClientId,
        phone: client_phone || '',
        consented: consent.consented,
        version: consent.version,
        sourceForm: 'quote_wizard',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
```

Note the shadowing risk: the handler already binds `dbClient`. Use that name, do not introduce a second connection.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/proposals/publicSmsConsent.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 5: Run the neighbouring suite for regressions**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/proposals/crud.test.js`
Expected: same result as before this task. Case 8 in `crud.test.js` is a known pre-existing failure (see the TT budget-warning project note); it is not caused by this change. Record whether it was already failing before claiming a regression.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/public.js server/routes/proposals/publicSmsConsent.test.js
git commit -m "feat(sms-consent): record quote-wizard consent on public proposal submit"
```

---

### Task 5: Capture consent on the staff application submit

**Files:**
- Modify: `server/routes/application.js` (destructure near line 44, call inside the transaction near the `applications` insert at line 165)
- Create: `server/routes/application.smsConsent.test.js`

**Interfaces:**
- Consumes: `recordSmsConsent`, `consentFieldsFromBody`, `requestMeta` (Task 3).
- Produces: `POST /api/application` accepting `sms_consent` and `sms_consent_version`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/application.smsConsent.test.js`. Reuse whatever authenticated-request helper the existing application or staff-portal suites use to mint a JWT for a user with `onboarding_status = 'in_progress'`; do not hand-roll token signing if a helper exists.

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../app');
const { pool } = require('../db');
const { SMS_CONSENT_VERSION, getConsentCopy } = require('../data/smsConsentCopy');
// Match the helper used by the existing staff suites (see staffPortal tests).
const { makeAuthedUser, authHeader } = require('./__helpers__/auth');

const PHONE = '3125550922';

function applicationBody(extra) {
  return {
    full_name: 'Consent Applicant',
    phone: PHONE,
    city: 'Chicago',
    state: 'IL',
    travel_distance: '25',
    reliable_transportation: 'yes',
    positions_interested: 'bartender',
    why_dr_bartender: 'Testing consent capture.',
    birth_month: 1, birth_day: 1, birth_year: 1990,
    ...extra,
  };
}

test('application submit > sms_consent true records the opt-in against the user', async (t) => {
  const user = await makeAuthedUser({ onboarding_status: 'in_progress' });
  t.after(async () => {
    await pool.query('DELETE FROM sms_consent_log WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM applications WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  const res = await request(app)
    .post('/api/application')
    .set(authHeader(user))
    .send(applicationBody({ sms_consent: true, sms_consent_version: SMS_CONSENT_VERSION }));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const u = await pool.query('SELECT communication_preferences AS p FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(u.rows[0].p.sms_enabled, true);
  assert.ok(u.rows[0].p.sms_opt_in_at);

  const log = await pool.query('SELECT * FROM sms_consent_log WHERE user_id = $1', [user.id]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].source_form, 'staff_application');
  assert.strictEqual(log.rows[0].copy_text, getConsentCopy(SMS_CONSENT_VERSION, 'staff'));
  assert.strictEqual(log.rows[0].client_id, null);
});

test('application submit > sms_consent false opts out and still submits', async (t) => {
  const user = await makeAuthedUser({ onboarding_status: 'in_progress' });
  t.after(async () => {
    await pool.query('DELETE FROM sms_consent_log WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM applications WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  const res = await request(app)
    .post('/api/application')
    .set(authHeader(user))
    .send(applicationBody({ sms_consent: false, sms_consent_version: SMS_CONSENT_VERSION }));
  assert.strictEqual(res.status, 200);

  const u = await pool.query('SELECT communication_preferences AS p FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(u.rows[0].p.sms_enabled, false);

  const log = await pool.query('SELECT consented FROM sms_consent_log WHERE user_id = $1', [user.id]);
  assert.strictEqual(log.rows[0].consented, false);
});

test('application submit > omitting consent leaves the staff default untouched', async (t) => {
  const user = await makeAuthedUser({ onboarding_status: 'in_progress' });
  t.after(async () => {
    await pool.query('DELETE FROM sms_consent_log WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM applications WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  await request(app).post('/api/application').set(authHeader(user)).send(applicationBody());

  const u = await pool.query('SELECT communication_preferences AS p FROM users WHERE id = $1', [user.id]);
  assert.strictEqual(u.rows[0].p.sms_enabled, true);
  const log = await pool.query('SELECT id FROM sms_consent_log WHERE user_id = $1', [user.id]);
  assert.strictEqual(log.rows.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/application.smsConsent.test.js`
Expected: FAIL on the `sms_consent_log` assertions.

- [ ] **Step 3: Wire the route**

In `server/routes/application.js`, add to the requires:

```js
const { recordSmsConsent, consentFieldsFromBody, requestMeta } = require('../utils/smsConsent');
```

Add to the `req.body` destructure (ending near line 44):

```js
    referral_source,
    sms_consent, sms_consent_version,
  } = req.body;
```

Inside the same transaction, immediately after the `INSERT INTO applications` query completes, insert:

```js
    // Recorded SMS consent from the application checkbox (A2P 10DLC). Inside
    // the transaction so a rolled-back application cannot leave a consent
    // record behind. phoneCheck.value is the normalized number.
    const consent = consentFieldsFromBody({ sms_consent, sms_consent_version });
    if (consent) {
      const meta = requestMeta(req);
      await recordSmsConsent(client, {
        userId: req.user.id,
        phone: phoneCheck.value,
        consented: consent.consented,
        version: consent.version,
        sourceForm: 'staff_application',
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
```

The transaction handle in this file is named `client`. Use it; do not open a second connection.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/application.smsConsent.test.js`
Expected: all 3 tests PASS.

- [ ] **Step 5: Document the surface**

In `ARCHITECTURE.md`, add `sms_consent_log` to whichever section enumerates tables or comms surfaces, one line: the append-only A2P consent record written by the quote wizard and the staff application, read by nothing at runtime.

- [ ] **Step 6: Commit**

```bash
git add server/routes/application.js server/routes/application.smsConsent.test.js ARCHITECTURE.md
git commit -m "feat(sms-consent): record staff-application consent on submit"
```

---

## Lane: legal-pages-ui

Depends on `legal-consent-data` being merged: this lane imports `client/src/constants/smsConsent.js` and posts the fields the server now accepts.

### Task 6: The legal page shell and the two pages

**Files:**
- Create: `client/src/pages/website/legal/LegalLayout.js`
- Create: `client/src/pages/website/legal/PrivacyPage.js`
- Create: `client/src/pages/website/legal/TermsPage.js`
- Modify: `client/src/App.js` (lazy imports near line 64, routes near line 331 and near line 508)

**Interfaces:**
- Consumes: `SMS_CONSENT_CLIENT`, `SMS_CONSENT_STAFF` from `client/src/constants/smsConsent.js` (Task 1).
- Produces: routes `/privacy` and `/terms`.

- [ ] **Step 1: Write the shared shell**

Create `client/src/pages/website/legal/LegalLayout.js`:

```jsx
import React from 'react';

// Shared shell for /privacy and /terms so the two pages cannot drift apart
// visually. Prose-width column, one heading, one last-updated line.
export default function LegalLayout({ title, lastUpdated, children }) {
  return (
    <div className="ws-section">
      <div className="ws-container" style={{ maxWidth: 760 }}>
        <h1 className="ws-h1">{title}</h1>
        <p className="text-muted text-small" style={{ marginBottom: '2rem' }}>
          Last updated: {lastUpdated}
        </p>
        <div className="ws-legal-prose">{children}</div>
      </div>
    </div>
  );
}
```

If `ws-section`, `ws-container`, or `ws-h1` are not the class names the other website pages use, match whatever `AboutPage.js` uses instead. Read that file first rather than guessing.

- [ ] **Step 2: Write the Privacy Policy page**

Create `client/src/pages/website/legal/PrivacyPage.js`. The `SMS_CONSENT_CLIENT` and `SMS_CONSENT_STAFF` renders are what make this page evidence for the A2P submission, since `/apply` is behind auth and the wizard checkbox is several steps deep.

```jsx
import React from 'react';
import LegalLayout from './LegalLayout';
import { SMS_CONSENT_CLIENT, SMS_CONSENT_STAFF } from '../../../constants/smsConsent';

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="July 22, 2026">
      <p>
        Dr. Bartender LLC ("Dr. Bartender," "we," "us") provides bartending services
        for private events in Illinois, Indiana, and Michigan. This policy explains
        what we collect, why, and what we do with it. It covers drbartender.com and
        the client and staff portals we operate.
      </p>

      <h2>Information we collect</h2>
      <p>
        <strong>From clients.</strong> Your name, email address, phone number, event
        date, venue name and address, guest count, and the drink and service
        preferences you give us so we can plan and staff your event.
      </p>
      <p>
        <strong>From applicants and staff.</strong> Your name, email address, phone
        number, address, work experience and availability, emergency contact, and the
        payment handle we use to pay you. We do not collect Social Security numbers or
        government ID numbers through this website.
      </p>
      <p>
        <strong>Automatically.</strong> Standard server logs and error diagnostics,
        which include IP address and browser information. We use these to keep the site
        working and to investigate problems.
      </p>
      <p>
        <strong>From other sources.</strong> If you contact us through a lead service
        such as Thumbtack, we receive the contact and event details you provided there.
      </p>
      <p>
        <strong>Payments.</strong> Card payments are processed by Stripe. Card numbers
        are entered on Stripe's systems and never reach our servers. We keep a record
        that a payment happened, its amount, and its status.
      </p>
      <p>
        <strong>What we do not collect.</strong> This site runs no advertising
        networks, no third-party analytics, and no tracking pixels.
      </p>

      <h2>How we use it</h2>
      <p>
        To prepare quotes, book and staff events, take payment, pay our staff, respond
        to you, and keep the tax and business records we are required to keep. We do
        not sell your personal information.
      </p>

      <h2>Text messaging (SMS)</h2>
      <p>
        If you provide your mobile number and check the SMS consent box on our quote
        form or staff application, Dr. Bartender may send you text messages. Clients
        receive messages about quotes, bookings, payments, and event details. Staff
        receive messages about shift offers, schedule changes, and event day logistics.
        Message frequency varies. Message and data rates may apply. Reply STOP to any
        message to opt out, or reply HELP for help.
      </p>
      <p>
        We do not sell your personal information. No mobile information will be shared
        with third parties or affiliates for marketing or promotional purposes. Text
        messaging originator opt-in data and consent are never shared with any third
        party. We disclose phone numbers only to the service providers that transmit
        our messages on our behalf, such as Twilio, and only for that purpose.
      </p>
      <p>
        You may opt out at any time by replying STOP to any text message or emailing
        contact@drbartender.com. Opting out of text messages does not affect your
        booking or your employment.
      </p>
      <p>These are the exact consent statements we present:</p>
      <blockquote>{SMS_CONSENT_CLIENT}</blockquote>
      <p>On our staff application:</p>
      <blockquote>{SMS_CONSENT_STAFF}</blockquote>

      <h2>Email</h2>
      <p>
        We email you about your quote, booking, payments, and event. We may also send
        occasional updates about our services. Every non-transactional email has an
        unsubscribe link, and unsubscribing does not affect messages about a booking
        you already have.
      </p>

      <h2>Cookies</h2>
      <p>
        We use cookies and similar browser storage only to keep you signed in and to
        remember progress in our quote form. We do not use advertising or
        cross-site tracking cookies.
      </p>

      <h2>Who we share information with</h2>
      <p>
        We share only what a provider needs to do its job for us. We do not sell
        personal information, and we do not share it for anyone else's marketing.
      </p>
      <ul>
        <li>Stripe, to process payments</li>
        <li>Twilio, to send and receive text messages and calls</li>
        <li>Resend, to send email</li>
        <li>Google, for venue address lookup</li>
        <li>Sentry, for error diagnostics</li>
        <li>Cloudflare and Neon, for file storage and our database</li>
        <li>Our hosting provider, to run the site</li>
      </ul>
      <p>
        We may also disclose information when the law requires it, or to establish or
        defend legal claims.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Event, payment, and staffing records are kept as long as we need them for
        business, accounting, and legal purposes. Records of your text message consent
        and of any opt-out are kept for as long as we operate the messaging program, so
        we can show what you agreed to and when.
      </p>

      <h2>Your choices</h2>
      <p>
        Reply STOP to any text to stop texts. Use the unsubscribe link in any marketing
        email to stop those emails. To ask what we hold about you, to correct it, or to
        request deletion, email contact@drbartender.com. We will respond within a
        reasonable time. Some records we are required to keep cannot be deleted on
        request.
      </p>

      <h2>Security</h2>
      <p>
        Traffic to this site is encrypted, passwords are stored hashed, and access to
        client and staff records is limited to people who need it. No system is
        perfectly secure, and we cannot guarantee absolute security.
      </p>

      <h2>Children</h2>
      <p>
        This site is not directed to children, and we do not knowingly collect
        information from anyone under 18. Our events serve alcohol and our staff
        positions require applicants to be 21 or older.
      </p>

      <h2>Changes</h2>
      <p>
        If we change this policy we will update the date at the top of this page.
      </p>

      <h2>Contact</h2>
      <p>
        Dr. Bartender LLC, Chicago, Illinois.
        <br />
        <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
      </p>
    </LegalLayout>
  );
}
```

- [ ] **Step 3: Write the Terms of Use page**

Create `client/src/pages/website/legal/TermsPage.js`. Nothing in this file may describe booking, cancellation, or refund terms: that is the whole point of the conflict clause.

```jsx
import React from 'react';
import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Use" lastUpdated="July 22, 2026">
      <p>
        These terms govern your use of drbartender.com and the client and staff portals
        operated by Dr. Bartender LLC. By using the site you agree to them. If you do
        not agree, please do not use the site.
      </p>

      <h2>What this site does</h2>
      <p>
        The site describes our services, lets you request a quote, and lets clients and
        staff manage bookings and shifts. A quote, a proposal, or a saved draft is an
        estimate, not a booking. Neither you nor Dr. Bartender is bound to an event
        until the Event Services Agreement for that event is signed and the required
        payment is made.
      </p>

      <h2>Your event agreement controls</h2>
      <p>
        Booking, cancellation, refunds, rescheduling, staffing, and all other terms of
        the services we provide are governed solely by the Event Services Agreement you
        sign for your event. If anything on this page conflicts with that agreement,
        the agreement controls.
      </p>

      <h2>Accounts</h2>
      <p>
        Some parts of the site require an account. Keep your login credentials
        confidential, and tell us promptly at contact@drbartender.com if you believe
        someone else has used your account. You are responsible for activity under your
        account. We may suspend or close an account that is being misused.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use this site to break the law, to interfere with its operation, to
        access accounts or data that are not yours, to scrape or harvest it by
        automated means, or to submit false information or someone else's contact
        details. Do not attempt to probe or bypass our security.
      </p>

      <h2>Our content</h2>
      <p>
        The text, photography, recipes, menus, and design on this site belong to Dr.
        Bartender LLC or are used with permission. You may view and share them for
        personal, non-commercial purposes. You may not republish, sell, or use them
        commercially without our written permission.
      </p>

      <h2>Your content</h2>
      <p>
        When you send us event details, preferences, application materials, or
        feedback, you give us permission to use that material to provide our services
        to you. You confirm you have the right to share whatever you send us.
      </p>

      <h2>Communications</h2>
      <p>
        How we contact you, including text messages and how to opt out, is described in
        our <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Third-party links and services</h2>
      <p>
        The site links to and relies on services we do not control, such as our payment
        processor. We are not responsible for their content or their practices.
      </p>

      <h2>Disclaimer</h2>
      <p>
        The site is provided as is and as available. We do not warrant that it will be
        uninterrupted, error free, or that the information on it is complete or current.
        Prices, packages, and availability shown on the site are subject to change and
        are confirmed only in a signed agreement. To the fullest extent permitted by
        law, we disclaim all implied warranties, including merchantability and fitness
        for a particular purpose.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Dr. Bartender LLC is not liable for
        indirect, incidental, special, consequential, or punitive damages arising from
        your use of this site. Nothing in this section limits liability that cannot be
        limited under applicable law, and nothing here changes the liability terms of a
        signed Event Services Agreement.
      </p>

      <h2>Indemnity</h2>
      <p>
        You agree to indemnify Dr. Bartender LLC against claims and costs arising from
        your misuse of the site or your breach of these terms.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the State of Illinois, without regard
        to its conflict of laws rules. Any dispute about this site will be brought in
        the state or federal courts located in Cook County, Illinois.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date at the top of this page shows when they
        last changed, and continuing to use the site means you accept the update.
      </p>

      <h2>Contact</h2>
      <p>
        Dr. Bartender LLC, Chicago, Illinois.
        <br />
        <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
      </p>
    </LegalLayout>
  );
}
```

- [ ] **Step 4: Register both routes in both route trees**

In `client/src/App.js`, add lazy imports beside the other website pages (near line 64):

```js
const PrivacyPage = lazy(() => import('./pages/website/legal/PrivacyPage'));
const TermsPage = lazy(() => import('./pages/website/legal/TermsPage'));
```

Add to the public-site route tree, after the `/faq` route near line 332:

```jsx
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
```

Add to the second route tree, after the `/faq` route near line 509:

```jsx
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
```

Both are required. `/quote` appears in both trees for the same reason: the site renders a different tree depending on host.

- [ ] **Step 5: Verify both pages render**

Run the dev server and load `http://localhost:3000/privacy` and `http://localhost:3000/terms`.
Expected: both render with the site header and footer, the heading, and the last-updated line. On `/privacy`, confirm the two blockquotes show the full consent sentences.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/website/legal client/src/App.js
git commit -m "feat(legal): public Privacy Policy and Terms of Use pages"
```

---

### Task 7: Footer links

**Files:**
- Modify: `client/src/components/PublicLayout.js:203`

- [ ] **Step 1: Replace the dead labels**

`Link` is already imported at `PublicLayout.js:2`. Replace line 203:

```jsx
              Privacy &middot; Terms &middot; Accessibility &middot;{' '}
```

with:

```jsx
              <Link to="/privacy">Privacy</Link> &middot;{' '}
              <Link to="/terms">Terms</Link> &middot;{' '}
```

"Accessibility" is removed deliberately: it advertised a page that does not exist. Do not add it back in this lane.

- [ ] **Step 2: Verify**

Load any public page, scroll to the footer, click Privacy and then Terms.
Expected: both navigate, both render, the trailing italic line still reads correctly with no stray separator.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/PublicLayout.js
git commit -m "feat(legal): wire footer Privacy and Terms links, drop dead Accessibility label"
```

---

### Task 8: Quote wizard consent checkbox

**Files:**
- Modify: `client/src/pages/website/quoteWizard/steps/YourInfoStep.js`
- Modify: `client/src/pages/website/quoteWizard/QuoteWizard.js` (form state near line 73, submit payload near line 535)

**Interfaces:**
- Consumes: `SMS_CONSENT_CLIENT`, `SMS_CONSENT_VERSION` (Task 1); the submit endpoint from Task 4.

- [ ] **Step 1: Add the checkbox to the contact step**

In `client/src/pages/website/quoteWizard/steps/YourInfoStep.js`, add the imports:

```js
import { Link } from 'react-router-dom';
import { SMS_CONSENT_CLIENT } from '../../../../constants/smsConsent';
```

Add a full-width cell after the phone `form-group`, still inside `wz-grid`:

```jsx
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="wz-sms_consent" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              id="wz-sms_consent"
              type="checkbox"
              checked={!!form.sms_consent}
              onChange={e => update('sms_consent', e.target.checked)}
              style={{ marginTop: '0.25rem', flexShrink: 0 }}
            />
            <span className="text-small text-muted">
              {SMS_CONSENT_CLIENT.replace(' See our Privacy Policy and Terms.', ' See our ')}
              <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>
              {' and '}
              <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link>.
            </span>
          </label>
        </div>
```

The `replace` keeps the rendered sentence identical to the constant while turning the last clause into links, so the page and the audit record still describe the same agreement. Do not retype the sentence.

- [ ] **Step 2: Add it to form state**

In `client/src/pages/website/quoteWizard/QuoteWizard.js`, add to the initial form object near line 73, after `client_phone`:

```js
    sms_consent: false,
```

Unchecked by default is a compliance requirement, not a style choice. Never initialise this to `true`, and never add it to any validation rule set.

- [ ] **Step 3: Send it on submit**

In the `handleSubmit` payload near line 535, add the import at the top of the file:

```js
import { SMS_CONSENT_VERSION } from '../../../constants/smsConsent';
```

and add to the JSON body, after `client_phone`:

```js
          sms_consent: !!form.sms_consent,
          sms_consent_version: SMS_CONSENT_VERSION,
```

Do not add these to the `capture-lead` payload. That endpoint creates no client record and has nothing to consent for.

- [ ] **Step 4: Verify end to end**

With the server running, walk `/quote` to the contact step, tick the box, complete the wizard, and submit. Then check:

```bash
cd ~/projects/os && node -r dotenv/config -e "
const { pool } = require('./server/db');
pool.query('SELECT client_id, consented, copy_version, source_form, created_at FROM sms_consent_log ORDER BY id DESC LIMIT 3')
  .then(r => { console.table(r.rows); return pool.end(); });
"
```
Expected: one row, `consented` true, `source_form` `quote_wizard`. Repeat the walk with the box left unticked and confirm a second row with `consented` false and that the submit still succeeded.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/website/quoteWizard/steps/YourInfoStep.js client/src/pages/website/quoteWizard/QuoteWizard.js
git commit -m "feat(sms-consent): consent checkbox on the quote wizard contact step"
```

---

### Task 9: Staff application consent checkbox

**Files:**
- Modify: `client/src/pages/Application.js` (form state near line 100, phone field near line 272, submit payload)

**Interfaces:**
- Consumes: `SMS_CONSENT_STAFF`, `SMS_CONSENT_VERSION` (Task 1); the endpoint from Task 5.

- [ ] **Step 1: Add the checkbox under the phone field**

In `client/src/pages/Application.js`, add the imports:

```js
import { Link } from 'react-router-dom';
import { SMS_CONSENT_STAFF, SMS_CONSENT_VERSION } from '../constants/smsConsent';
```

After the phone `form-group` that ends near line 274, add:

```jsx
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="app-sms_consent" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    id="app-sms_consent"
                    name="sms_consent"
                    type="checkbox"
                    checked={!!form.sms_consent}
                    onChange={e => setForm(f => ({ ...f, sms_consent: e.target.checked }))}
                    style={{ marginTop: '0.25rem', flexShrink: 0 }}
                  />
                  <span className="text-small text-muted">
                    {SMS_CONSENT_STAFF.replace(' See our Privacy Policy and Terms.', ' See our ')}
                    <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>
                    {' and '}
                    <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link>.
                  </span>
                </label>
              </div>
```

If the surrounding markup is a `two-col` grid rather than a full-width container, place the block after the closing tag of that grid so the sentence gets full width.

- [ ] **Step 2: Add it to form state**

In the initial form object near line 100, after `phone: ''`:

```js
    sms_consent: false,
```

Do not add `sms_consent` to the required-field list near line 151. An unchecked box must never block an application.

- [ ] **Step 3: Send it on submit**

In the submit payload, add:

```js
        sms_consent: !!form.sms_consent,
        sms_consent_version: SMS_CONSENT_VERSION,
```

- [ ] **Step 4: Verify**

Sign in as a test applicant, load `/apply`, confirm the box renders unticked under the phone field and that both links open. Submit with it ticked, then:

```bash
cd ~/projects/os && node -r dotenv/config -e "
const { pool } = require('./server/db');
pool.query(\"SELECT user_id, consented, source_form FROM sms_consent_log WHERE source_form='staff_application' ORDER BY id DESC LIMIT 3\")
  .then(r => { console.table(r.rows); return pool.end(); });
"
```
Expected: one row with `consented` true.

- [ ] **Step 5: Run the client build gate**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds with no warnings. CI treats warnings as errors, so an unused import here fails the push.

- [ ] **Step 6: Document and commit**

Add one line to `README.md` wherever public routes or compliance surfaces are listed: `/privacy` and `/terms` are the public legal pages, and `/privacy` is the URL submitted to Twilio for A2P campaign review.

```bash
git add client/src/pages/Application.js README.md
git commit -m "feat(sms-consent): consent checkbox on the staff application"
```

---

## Post-merge, before the campaign is submitted

Not code, and not part of either lane. These are operator steps that gate the actual Twilio submission:

1. Confirm Twilio Advanced Opt-Out is enabled on the Messaging Service, so HELP gets an automatic reply. The app recognises STOP and START (`server/utils/smsInbound.js:10`) but has no HELP keyword, and both consent sentences promise one.
2. The pages must be deployed and publicly reachable before submitting. `/privacy` is the policy URL and the opt-in evidence URL.
3. Screenshots of both checkboxes for the campaign form, since `/apply` is behind auth.

## Self-review notes

- Spec coverage: pages and routes (Task 6), footer (Task 7), single-source copy (Task 1), consent record and table (Tasks 2 and 3), both capture points (Tasks 4, 5, 8, 9), grandfathering (enforced by the absent-fields path tested in Tasks 4 and 5), Accessibility removal (Task 7), HELP and deployment (post-merge list).
- Naming is consistent across tasks: `recordSmsConsent`, `consentFieldsFromBody`, `requestMeta`, `getConsentCopy`, `SMS_CONSENT_VERSION`, `SMS_CONSENT_CLIENT`, `SMS_CONSENT_STAFF`, `sms_consent`, `sms_consent_version`, `sms_consent_log`.
- Two known environment couplings the implementer must confirm rather than assume: the schema-apply command in Task 2 Step 2, and the authenticated-request helper in Task 5 Step 1. Both say to read the existing project setup first.
