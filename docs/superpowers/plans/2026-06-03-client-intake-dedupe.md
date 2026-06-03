# Client-Intake Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One person becomes exactly one `clients` row no matter which intake path (Thumbtack lead, admin proposal-create, public quote wizard, BEO/shift) first sees them, and clean up the duplicates that already exist.

**Architecture:** Extract a single `findOrCreateClient(db, {...})` helper that de-dupes on **email OR normalized phone** (with a name guard on phone-only matches, mirroring `calcom.js`) and only ever **backfills NULL fields** — never overwrites identity, so it's safe for the unauthenticated wizard. Wire it into all four intake sites. Add a `mergeClients(db, loser, winner)` helper that repoints FK references discovered from the catalog and deletes the loser, then run it once for Jim (1384→1385) and surface any other dupes for manual triage.

**Tech Stack:** Node/Express, raw SQL via `pg`, `node:test`. Existing patterns to mirror: `server/routes/calcom.js:123-218` (email-then-phone find-or-create + 23505 savepoint recovery), `server/utils/phone.js#validatePhone` (10-digit normalizer), the functional index `idx_clients_phone_normalized` (`RIGHT(REGEXP_REPLACE(phone,'\D','','g'),10)`).

**Root cause being fixed:** `server/routes/thumbtack.js:233-265` matches on **phone only**; `server/routes/proposals/crud.js:142-162` and `proposals/public.js:274-281` match on **email only**; `server/routes/shifts.js:351-365` matches on email only (case-sensitive). A phone-only Thumbtack lead (no email) followed by an email-bearing proposal-create therefore produced two rows (Jim = clients 1384 + 1385).

---

### Task 1: `findOrCreateClient` helper

**Files:**
- Create: `server/utils/clientDedup.js`
- Test: `server/utils/clientDedup.test.js`

- [ ] **Step 1: Write the helper**

```js
// server/utils/clientDedup.js
const { validatePhone } = require('./phone');

/**
 * Find-or-create a client, de-duplicating on BOTH email and phone.
 *
 * Matching order: email (lower, via idx_clients_email_lower) first, then
 * normalized phone (last 10 digits, via idx_clients_phone_normalized) — but the
 * phone match only fires against a row whose email is still NULL AND whose name
 * matches (anti-takeover guard, mirrors calcom.js), so a shared phone can't
 * merge two different people. On a match we BACKFILL NULL fields only (e.g.
 * stamp the email onto a phone-only Thumbtack row); we NEVER overwrite an
 * existing non-null name/email/phone, which keeps this safe for the
 * UNAUTHENTICATED public wizard.
 *
 * Runs inside the caller's transaction — pass the caller's pg client.
 *
 * @param {import('pg').PoolClient} db
 * @param {{name:string,email?:string|null,phone?:string|null,source?:string,notes?:string|null}} args
 * @returns {Promise<number>} clients.id
 */
async function findOrCreateClient(db, { name, email, phone, source = 'direct', notes = null }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('findOrCreateClient: name is required');
  const cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
  const { value: phone10 } = validatePhone(phone); // 10-digit string or null

  let winnerId = null;

  if (cleanEmail) {
    const r = await db.query('SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
    if (r.rows[0]) winnerId = r.rows[0].id;
  }

  if (!winnerId && phone10) {
    const r = await db.query(
      `SELECT id FROM clients
         WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
           AND email IS NULL
           AND LOWER(name) = LOWER($2)
         ORDER BY created_at DESC
         LIMIT 1`,
      [phone10, cleanName]
    );
    if (r.rows[0]) winnerId = r.rows[0].id;
  }

  if (winnerId) {
    // Backfill NULLs only — never overwrite. This is the Jim fix: a phone-only
    // Thumbtack row gets the email stamped on, so the later proposal-create
    // resolves to it instead of inserting a second row.
    await db.query(
      `UPDATE clients SET email = COALESCE(email, $2), phone = COALESCE(phone, $3) WHERE id = $1`,
      [winnerId, cleanEmail, phone || null]
    );
    return winnerId;
  }

  // No match -> insert with 23505 race recovery (mirrors calcom.js).
  await db.query('SAVEPOINT foc_insert');
  try {
    const created = await db.query(
      `INSERT INTO clients (name, email, phone, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cleanName, cleanEmail, phone || null, source, notes]
    );
    await db.query('RELEASE SAVEPOINT foc_insert');
    return created.rows[0].id;
  } catch (err) {
    if (err.code === '23505' && cleanEmail) {
      await db.query('ROLLBACK TO SAVEPOINT foc_insert');
      const re = await db.query('SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      if (re.rows[0]) return re.rows[0].id;
    }
    try { await db.query('ROLLBACK TO SAVEPOINT foc_insert'); } catch (_) { /* already rolled back */ }
    throw err;
  }
}

module.exports = { findOrCreateClient };
```

- [ ] **Step 2: Write the test** (mirror the `node:test` + `pool` style already used in `server/utils/*.test.js`; runs against the dev DB, cleans up its own rows in `finally`)

```js
// server/utils/clientDedup.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { findOrCreateClient } = require('./clientDedup');

test('phone-only row then email proposal-create resolves to ONE client (the Jim case)', async () => {
  const db = await pool.connect();
  const ids = [];
  try {
    await db.query('BEGIN');
    // Simulate the Thumbtack phone-only lead.
    const a = await findOrCreateClient(db, { name: 'Dupe Test', phone: '(555) 010-2929', source: 'thumbtack' });
    ids.push(a);
    // Simulate the later admin proposal-create with name+email+same phone.
    const b = await findOrCreateClient(db, { name: 'Dupe Test', email: 'DupeTest@example.com', phone: '555-010-2929', source: 'direct' });
    assert.strictEqual(b, a, 'should reuse the phone-only row, not create a second');
    const row = await db.query('SELECT email FROM clients WHERE id = $1', [a]);
    assert.strictEqual(row.rows[0].email, 'dupetest@example.com', 'email backfilled onto the phone-only row');
  } finally {
    if (ids.length) await db.query('DELETE FROM clients WHERE id = ANY($1)', [ids]);
    await db.query('ROLLBACK');
    db.release();
  }
});

test('different name on a shared phone does NOT merge', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const a = await findOrCreateClient(db, { name: 'Person One', phone: '555-010-3030', source: 'thumbtack' });
    const b = await findOrCreateClient(db, { name: 'Person Two', phone: '555-010-3030', source: 'thumbtack' });
    assert.notStrictEqual(b, a, 'name guard prevents merging two people on one phone');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});
```

- [ ] **Step 3: Run the test, expect FAIL** (helper not wired / asserts) then PASS once Step 1 lands.

Run: `node --test server/utils/clientDedup.test.js`

- [ ] **Step 4: Commit** — `git add server/utils/clientDedup.js server/utils/clientDedup.test.js && git commit -m "feat(clients): findOrCreateClient dedupe helper (email or phone)"`

---

### Task 2: Wire `findOrCreateClient` into the four intake sites

**Files:**
- Modify: `server/routes/thumbtack.js:233-265`
- Modify: `server/routes/proposals/crud.js:142-162`
- Modify: `server/routes/proposals/public.js:274-281`
- Modify: `server/routes/shifts.js:351-365`

- [ ] **Step 1: Thumbtack** — replace the phone-only find-or-create block (lines 233-265) with:

```js
    // Find or create the client (dedupes on email OR phone — see clientDedup.js)
    let clientId = null;
    if (lead.customerName || normalizePhone(lead.customerPhone)) {
      clientId = await findOrCreateClient(dbClient, {
        name: lead.customerName || 'Thumbtack Lead',
        phone: lead.customerPhone,
        source: 'thumbtack',
        notes: `Thumbtack lead — email needed. Category: ${lead.category || 'N/A'}`,
      });
    }
```

Add at top of file: `const { findOrCreateClient } = require('../utils/clientDedup');`. The local `normalizePhone` (lines 88-92) stays (still used for the guard above and elsewhere).

- [ ] **Step 2: Admin proposal-create** — replace `crud.js:144-162` body with:

```js
    let finalClientId = client_id;
    if (!finalClientId && client_name) {
      finalClientId = await findOrCreateClient(dbClient, {
        name: client_name, email: client_email, phone: client_phone, source: client_source || 'direct',
      });
    }
```

Add `const { findOrCreateClient } = require('../../utils/clientDedup');` to the imports.

- [ ] **Step 3: Public wizard** — replace `public.js:274-281` upsert with:

```js
    const finalClientId = await findOrCreateClient(dbClient, {
      name: client_name, email: client_email, phone: client_phone, source: 'website',
    });
```

Add the require. NOTE: behavior is preserved — the helper backfills NULLs only, so an unauthenticated submit still cannot overwrite an existing client's name/phone (the takeover guard the old `DO UPDATE SET name = clients.name` comment protected). The downstream code that read `communication_preferences, email_status, phone_status` off the upsert RETURNING must now `SELECT` those by `finalClientId` — add immediately after:

```js
    const prefRow = await dbClient.query(
      'SELECT communication_preferences, email_status, phone_status FROM clients WHERE id = $1',
      [finalClientId]
    );
    // ...use prefRow.rows[0] where the old clientResult.rows[0] fields were read.
```

(The only consumers are the `finalClientId` assignment at `public.js:281` and the reads of `communication_preferences, email_status, phone_status` at `public.js:468-470` — repoint those three reads to `prefRow.rows[0]`. Confirm with `grep -n "clientResult.rows\[0\]" server/routes/proposals/public.js` that none remain.) Because this is the **unauthenticated** path, give it its own commit and a manual checklist before push: submit the public quote wizard with (a) a brand-new email+phone, (b) an email that already exists, (c) a phone that exists under a *different* name — assert one client row, no identity overwrite in cases b/c.

- [ ] **Step 4: BEO/shifts** — replace `shifts.js:352-365` with:

```js
    let clientId = null;
    if (client_name) {
      clientId = await findOrCreateClient(pgClient, {
        name: client_name, email: client_email, phone: client_phone, source: 'direct',
      });
    }
```

Add `const { findOrCreateClient } = require('../utils/clientDedup');`.

- [ ] **Step 5: Verify** — `node --test server/utils/clientDedup.test.js` still passes; run the existing route suites that touch these files in isolation (per the shared-dev-DB constraint): `node --test server/routes/proposals/crud.test.js` and any thumbtack/calcom/shifts test. Then `cd client; $env:CI='true'; npx react-scripts build` is **not** needed (server-only change).

- [ ] **Step 6: Commit** — `git add server/routes/thumbtack.js server/routes/proposals/crud.js server/routes/proposals/public.js server/routes/shifts.js && git commit -m "refactor(clients): route all intake through findOrCreateClient"`

---

### Task 3: `mergeClients` helper (clean up existing duplicates)

**Files:**
- Create: `server/utils/clientMerge.js`
- Test: `server/utils/clientMerge.test.js`

- [ ] **Step 1: Write the helper** — repoints all FK references (discovered from the catalog; every `client_id` FK is `ON DELETE SET NULL`) then deletes the loser:

```js
// server/utils/clientMerge.js
function quoteIdent(id) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
}

/**
 * Merge a duplicate client (loser) into the canonical one (winner): backfill the
 * winner's NULL contact fields from the loser, repoint every FK reference, then
 * delete the loser. Caller wraps in a transaction.
 * @returns {Promise<{repointed: Array<{table:string,column:string,rows:number}>}>}
 */
async function mergeClients(db, loserId, winnerId) {
  if (Number(loserId) === Number(winnerId)) throw new Error('mergeClients: loser === winner');

  await db.query(
    `UPDATE clients w SET email = COALESCE(w.email, l.email),
                          phone = COALESCE(w.phone, l.phone),
                          notes = COALESCE(w.notes, l.notes)
       FROM clients l WHERE w.id = $1 AND l.id = $2`,
    [winnerId, loserId]
  );

  const refs = await db.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      AND ccu.table_name = 'clients' AND ccu.column_name = 'id'`);

  const repointed = [];
  for (const { table_name, column_name } of refs.rows) {
    const r = await db.query(
      `UPDATE ${quoteIdent(table_name)} SET ${quoteIdent(column_name)} = $1 WHERE ${quoteIdent(column_name)} = $2`,
      [winnerId, loserId]
    );
    if (r.rowCount > 0) repointed.push({ table: table_name, column: column_name, rows: r.rowCount });
  }

  await db.query('DELETE FROM clients WHERE id = $1', [loserId]);
  return { repointed };
}

module.exports = { mergeClients };
```

- [ ] **Step 2: Test** — seed two clients + a referencing row, merge, assert the reference moved and the loser is gone (node:test, dev DB, cleanup in finally). Mirror Task 1's test shape.

- [ ] **Step 3: Run + Commit** — `node --test server/utils/clientMerge.test.js`; `git add server/utils/clientMerge.js server/utils/clientMerge.test.js && git commit -m "feat(clients): mergeClients helper for de-duplicating existing rows"`

---

### Task 4: Detect existing dupes + merge Jim (operational, against production)

**Files:** none — a read-only report plus one guarded merge, run via the Neon MCP against branch `br-noisy-frog-ad99sa6l` (production), like the proposal-443 archive.

**GATE:** Task 4 ships DATA, not code, and is **not git-revertable** — recovery is from the Step 3 snapshot. Run it only after Tasks 1-3 are merged and stable, and only after Steps 1-2 are reviewed. Every `client_id` FK is `ON DELETE SET NULL`, so a missed reference would be **silently NULLed** by the DELETE rather than erroring — that is why the FK list is derived from the catalog (Step 2), never assumed.

- [ ] **Step 1: Detection report** (read-only) — surface phone duplicates for triage (email dupes can't exist; `idx_clients_email_unique`):

```sql
SELECT RIGHT(REGEXP_REPLACE(phone,'\D','','g'),10) AS phone10,
       array_agg(id ORDER BY created_at) AS client_ids,
       array_agg(DISTINCT lower(name)) AS names, count(*) AS n
FROM clients WHERE phone IS NOT NULL AND length(REGEXP_REPLACE(phone,'\D','','g')) >= 10
GROUP BY 1 HAVING count(*) > 1 ORDER BY n DESC;
```

Present the list to Dan; only merge pairs he confirms are the same person (never blind-merge money records).

- [ ] **Step 2: Confirm the FK universe against production** (read-only) — do NOT assume the table list. Run the same catalog query `mergeClients` uses:

```sql
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND ccu.table_name = 'clients' AND ccu.column_name = 'id';
```

Expected (verified against `schema.sql` at authoring time): `proposals`, `email_leads`, `thumbtack_leads`, `consults`, `sms_messages`, `legacy_cc_proposals`. If the live list differs, reconcile the Step 4 SQL before running it.

- [ ] **Step 3: Snapshot for rollback** (read-only) — capture both client rows and every row currently pointing at the loser, save the output locally:

```sql
SELECT * FROM clients WHERE id IN (1384, 1385);
SELECT 'proposals' AS t, id FROM proposals WHERE client_id = 1384
UNION ALL SELECT 'email_leads', id FROM email_leads WHERE client_id = 1384
UNION ALL SELECT 'thumbtack_leads', id FROM thumbtack_leads WHERE client_id = 1384
UNION ALL SELECT 'consults', id FROM consults WHERE client_id = 1384
UNION ALL SELECT 'sms_messages', id FROM sms_messages WHERE client_id = 1384
UNION ALL SELECT 'legacy_cc_proposals', id FROM legacy_cc_proposals WHERE client_id = 1384;
```

(Rollback = restore these `client_id`s to 1384 and re-INSERT the deleted client row from the first SELECT.)

- [ ] **Step 4: Merge Jim 1384 → 1385** (winner 1385 holds the email + both proposals + SMS) as one transaction repointing ALL FK tables confirmed in Step 2. This is the MCP-runnable equivalent of calling `mergeClients(db, 1384, 1385)`; prefer running the Task 3 helper from a one-off Node script if a prod DB connection is available (it derives the table list dynamically).

```sql
BEGIN;
UPDATE clients w SET email = COALESCE(w.email, l.email), phone = COALESCE(w.phone, l.phone), notes = COALESCE(w.notes, l.notes)
  FROM clients l WHERE w.id = 1385 AND l.id = 1384;
UPDATE proposals           SET client_id = 1385 WHERE client_id = 1384;
UPDATE email_leads         SET client_id = 1385 WHERE client_id = 1384;
UPDATE thumbtack_leads     SET client_id = 1385 WHERE client_id = 1384;
UPDATE consults            SET client_id = 1385 WHERE client_id = 1384;
UPDATE sms_messages        SET client_id = 1385 WHERE client_id = 1384;
UPDATE legacy_cc_proposals SET client_id = 1385 WHERE client_id = 1384;
DELETE FROM clients WHERE id = 1384;
COMMIT;
```

- [ ] **Step 5: Verify** — `SELECT id, name, email, phone FROM clients WHERE id IN (1384,1385);` → 1384 gone, 1385 intact with phone+email; and for each FK table from Step 2, `SELECT count(*) FROM <table> WHERE client_id = 1384;` → 0.

---

## Verification (whole plan)
- `node --test server/utils/clientDedup.test.js server/utils/clientMerge.test.js` (run separately if the shared dev DB collides).
- Re-run the detection report after merges → Jim's pair no longer appears.
- Manual: create a Thumbtack-style phone-only client, then an admin proposal with the same phone + an email → one client row, email backfilled.

## Self-review notes
- **Behavior change (intentional):** admin proposal-create no longer overwrites an existing client's phone from new input (helper backfills NULLs only). Admins edit contact info via the client edit UI, not by re-submitting a proposal. Safer default; documented here.
- **No placeholders:** every code block is complete; the only runtime-discovered values are the catalog FK list (Task 3 query) and the confirmed dupe pairs (Task 4 Step 1).
- **Scope:** `server/routes/clients.js` direct admin create is intentionally left as-is (explicit single-client creation, not an intake path).
