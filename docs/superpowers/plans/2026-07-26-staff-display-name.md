# Staff Display Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every staff member as their own preferred name plus a last initial ("Fareed S."), fix the onboarding copy that invited stage names, and give admin a no-gate notice when a preferred name is set or changed.

**Architecture:** One pure helper (`computeDisplayName`) feeds a maintained `contractor_profiles.display_name` column, refreshed explicitly at each write path. Roughly thirty read sites swap `COALESCE(cp.preferred_name, u.email)` for `COALESCE(cp.display_name, u.email)`; salutation sites keep reading `preferred_name` untouched, so the display-versus-salutation split becomes a column choice rather than a convention. A second column, `preferred_name_reviewed_at`, drives an informational Needs Attention item and is never consulted by any name read path.

**Tech Stack:** Node/Express, node-postgres, `node:test` + `node:assert/strict`, React 18 (CRA), no TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-26-staff-display-name-design.md`

## Global Constraints

- **The preferred name is authoritative.** The legal name contributes exactly one character (the last initial) and never substitutes for a name the person gave us. "Joey" renders "Joey K." forever, never "Joseph."
- **No approval gate.** A name is live the moment it is typed. `display_name` must never read `preferred_name_reviewed_at`.
- **No heuristic** relating a preferred name to a legal name. No prefix, substring, or nickname inference anywhere in this plan.
- **No script rewrites a stored `preferred_name`.** Shortening is a display concern and lives only in `display_name`. The one exception is whitespace trimming in Task 13.
- **No em dashes in any user-facing copy.** Use commas, periods, colons, or parentheticals.
- Schema DDL goes in `server/db/schema.sql`, which `initDb()` applies idempotently at boot (`server/db/index.js:197`). Use `ADD COLUMN IF NOT EXISTS`.
- Server tests are `node:test` and share the dev database. Run one suite at a time with `node -r dotenv/config --test <file>`.
- Client lint is verified only through `CI=true npx react-scripts build` from `client/`.
- Money paths: `paystubData.js` already resolves legal-name-first by design and must not change. Contracts and agreements already use `agreements.full_name` and must not change.

---

### Task 1: The display-name helper

**Files:**
- Create: `server/utils/staffDisplayName.js`
- Test: `server/utils/staffDisplayName.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeDisplayName({ preferredName, legalFullName }) -> string | null`, and the exported constant `TITLES` (a `Set` of lowercase title words) which Task 2 reuses.

- [ ] **Step 1: Write the failing test**

Create `server/utils/staffDisplayName.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDisplayName } = require('./staffDisplayName');

// Table-driven off REAL production pairs (spec §4.1). Every row here was read
// out of the production `contractor_profiles` / `agreements` join on 2026-07-26.
const CASES = [
  // [preferredName, legalFullName, expected, why]
  ['Fareed', 'Mohammad F Shafiuddin', 'Fareed S.', 'nickname unrelated to legal first name'],
  ['Teah', 'Teah Teriele', 'Teah T.', 'plain first name'],
  ['Dallas', 'Dallas Raby', 'Dallas R.', 'plain first name'],
  ['Joey', 'Joseph Key', 'Joey K.', 'NEVER renders as Joseph'],
  ['Nikki', 'Monique Lundy', 'Nikki L.', 'NEVER renders as Monique'],
  ['Tashea Coates', 'Tashea Coates', 'Tashea C.', 'typed full name, surname dropped'],
  ['Evan Williams', 'Evan Williams', 'Evan W.', 'typed full name, surname dropped'],
  ['Billie', 'Billie Jean Barrone', 'Billie B.', 'initial comes from surname, not middle name'],
  ['Billie Jean', 'Billie Jean Barrone', 'Billie Jean B.', 'two-word given name is kept whole'],
  ['Mark Holt', 'Mark', 'Mark H.', 'single-token agreement: initial off the preferred name'],
  ['Ariel  D. Smith', 'Ariel Smith', 'Ariel S.', 'surname and middle initial both dropped'],
  ['Adelle M. Reynolds', null, 'Adelle R.', 'no legal name: initial off preferred, middle initial dropped'],
  ['veronica martinez', 'veronica martinez', 'Veronica M.', 'all-lowercase token gets capitalized'],
  ['Jasmine Jeff', 'Jasmine jeff', 'Jasmine J.', 'surname match is case-insensitive'],
  ['Zul', 'Zul', 'Zul', 'single-token everything: no initial, no invention'],
  ['Dallas', null, 'Dallas', 'no legal name and one token: bare'],
];

for (const [preferredName, legalFullName, expected, why] of CASES) {
  test(`computeDisplayName: ${JSON.stringify(preferredName)} + ${JSON.stringify(legalFullName)} -> ${expected} (${why})`, () => {
    assert.equal(computeDisplayName({ preferredName, legalFullName }), expected);
  });
}

test('returns null when there is no preferred name at all (caller keeps its email fallback)', () => {
  assert.equal(computeDisplayName({ preferredName: null, legalFullName: 'Nevver Sayles' }), null);
  assert.equal(computeDisplayName({ preferredName: '   ', legalFullName: 'Nevver Sayles' }), null);
  assert.equal(computeDisplayName({}), null);
});

// GUARD (spec §2, §7). The legal name may contribute exactly one character.
// If this test ever fails, someone reintroduced legal-name fallback and Joey
// is about to be called Joseph on a roster.
test('the legal name never reaches the output except as one initial', () => {
  const out = computeDisplayName({ preferredName: 'Joey', legalFullName: 'Joseph Key' });
  assert.equal(out, 'Joey K.');
  assert.ok(!out.toLowerCase().includes('joseph'));
  assert.ok(!out.toLowerCase().includes('key'));
});

// Documented garbage-in behavior. These four rows are hand-fixed by a human
// (spec §6); the helper is not expected to rescue them.
test('malformed stored values render predictably rather than being rescued', () => {
  assert.equal(computeDisplayName({ preferredName: 'TwistidTreets', legalFullName: 'Nevver Sayles' }), 'TwistidTreets S.');
  assert.equal(computeDisplayName({ preferredName: 'Miss Taylor', legalFullName: null }), 'Miss T.');
  assert.equal(computeDisplayName({ preferredName: 'Nicholas or Nick', legalFullName: 'Nicholas George DiCristina' }), 'Nicholas or Nick D.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node --test server/utils/staffDisplayName.test.js`
Expected: FAIL with `Cannot find module './staffDisplayName'`

- [ ] **Step 3: Write the implementation**

Create `server/utils/staffDisplayName.js`:

```js
'use strict';

// Staff display name: the preferred name the person gave us, plus one initial
// taken from their legal surname. Spec:
//   docs/superpowers/specs/2026-07-26-staff-display-name-design.md
//
// THE RULE (spec §2): the preferred name is authoritative. The legal name is
// used for EXACTLY ONE character and is never a substitute for a name someone
// gave us. A person who says "Joey" is "Joey K." forever, never "Joseph".
// There is deliberately no heuristic relating the two names.

// Leading titles are a form of address, not a name ("Miss Taylor"). Shared with
// the validator in staffDisplayName.validate.js.
const TITLES = new Set([
  'miss', 'ms', 'ms.', 'mrs', 'mrs.', 'mr', 'mr.', 'dr', 'dr.', 'chef',
  'sir', 'madam', 'master', 'coach', 'captain', 'capt', 'capt.',
  'prof', 'prof.', 'rev', 'rev.',
]);

function tokens(s) {
  return String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
}

// A bare middle initial: "D" or "D." Never belongs in a display name.
function isMiddleInitial(tok) {
  return /^[A-Za-z]\.?$/.test(tok);
}

// Capitalize ONLY an all-lowercase token. Mixed case is left alone, because
// LaToya, McKenna and d'Angelo are correct as typed and a general title-casing
// pass would break them. Live data has `veronica martinez`.
function fixCase(tok) {
  if (tok !== tok.toLowerCase()) return tok;
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

function computeDisplayName({ preferredName, legalFullName } = {}) {
  const pref = tokens(preferredName);
  if (pref.length === 0) return null;
  const legal = tokens(legalFullName);

  // Where does the last initial come from? Prefer the legal surname; fall back
  // to the preferred name's own last token when the agreement is single-token
  // or missing; otherwise there is no initial and we do NOT invent one.
  let initialSource = null;
  let lastInitial = '';
  if (legal.length >= 2) {
    initialSource = 'legal';
    lastInitial = legal[legal.length - 1].charAt(0).toUpperCase();
  } else if (pref.length >= 2) {
    initialSource = 'preferred';
    lastInitial = pref[pref.length - 1].charAt(0).toUpperCase();
  }

  // Shorten the preferred name for the ~25 rows that hold a full name.
  let short;
  if (initialSource === 'legal') {
    // Drop a trailing token ONLY when it repeats the legal SURNAME. Matching
    // against every legal token would eat the "Jean" in "Billie Jean", whose
    // legal name is "Billie Jean Barrone".
    const surname = legal[legal.length - 1].toLowerCase();
    short = pref.slice();
    if (short.length > 1 && short[short.length - 1].toLowerCase() === surname) short.pop();
  } else if (initialSource === 'preferred') {
    short = pref.slice(0, -1);
  } else {
    short = pref.slice();
  }
  while (short.length > 1 && isMiddleInitial(short[short.length - 1])) short.pop();
  if (short.length === 0) short = [pref[0]];

  const shortStr = short.map(fixCase).join(' ');
  return lastInitial ? `${shortStr} ${lastInitial}.` : shortStr;
}

module.exports = { computeDisplayName, TITLES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node --test server/utils/staffDisplayName.test.js`
Expected: PASS, all cases

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/utils/staffDisplayName.js server/utils/staffDisplayName.test.js
git commit -m "feat(staff-name): computeDisplayName helper (preferred name + last initial)" -- server/utils/staffDisplayName.js server/utils/staffDisplayName.test.js
```

---

### Task 2: Preferred-name format validation

**Files:**
- Create: `server/utils/staffDisplayName.validate.js`
- Test: `server/utils/staffDisplayName.validate.test.js`

**Interfaces:**
- Consumes: `TITLES` from `server/utils/staffDisplayName.js` (Task 1).
- Produces: `validatePreferredName(raw) -> { valid: true, value: string } | { valid: false, error: string }`. Tasks 4, 5 and 9 call this.

- [ ] **Step 1: Write the failing test**

Create `server/utils/staffDisplayName.validate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePreferredName } = require('./staffDisplayName.validate');

// Real names MUST pass. Rejecting someone's actual name to catch a handle is a
// bad trade (spec §3.4), so this list is the higher-priority half of the suite.
const ACCEPTED = [
  'McKenna', 'DeShawn', 'LaToya', "O'Brien", 'Mary-Kate', 'D.J.', 'DJ',
  'Chip', 'Shea', 'Fareed', 'Alexis', 'Jo', 'Billie Jean', 'Tashea Coates',
  // Documented: a well-formed handle passes every mechanical check and always
  // will. The copy is what prevents it, not this function (spec §9).
  'LumpyIceCream',
];

for (const name of ACCEPTED) {
  test(`accepts ${JSON.stringify(name)}`, () => {
    const r = validatePreferredName(name);
    assert.equal(r.valid, true, r.error);
  });
}

const REJECTED = [
  ['', 'blank'],
  ['   ', 'whitespace only'],
  ['J', 'one character'],
  ['Miss Taylor', 'leading title'],
  ['Mrs. Smith', 'leading title with period'],
  ['Dr Bob', 'leading title'],
  ['Nicholas or Nick', 'three words'],
  ['Bar2Go', 'contains a digit'],
  ['Chip!', 'contains a symbol'],
  ['Bartender Extraordinaire Supreme', 'three words and too long'],
  ['Abcdefghijklmnopqrstuvwxyz', 'over 20 characters'],
];

for (const [name, why] of REJECTED) {
  test(`rejects ${JSON.stringify(name)} (${why})`, () => {
    const r = validatePreferredName(name);
    assert.equal(r.valid, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  });
}

test('normalizes surrounding and internal whitespace on the accepted value', () => {
  assert.equal(validatePreferredName('  Billie   Jean  ').value, 'Billie Jean');
  assert.equal(validatePreferredName('Elisa ').value, 'Elisa');
});

test('error copy contains no em dashes', () => {
  for (const [name] of REJECTED) {
    const r = validatePreferredName(name);
    assert.ok(!r.error.includes('—'), `em dash in: ${r.error}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node --test server/utils/staffDisplayName.validate.test.js`
Expected: FAIL with `Cannot find module './staffDisplayName.validate'`

- [ ] **Step 3: Write the implementation**

Create `server/utils/staffDisplayName.validate.js`:

```js
'use strict';

// Format validation for contractor_profiles.preferred_name. Spec §3.4.
//
// This is about SHAPE, not worth. It is deliberately narrow so that real names
// never trip: there is no camelCase detection, because McKenna, DeShawn and
// LaToya are real names and `LumpyIceCream` is not worth breaking them over.
// A well-formed handle passes this function and always will. The onboarding
// copy is what prevents that, and the §3.5 notice is how it gets noticed.

const { TITLES } = require('./staffDisplayName');

const MIN_LEN = 2;
const MAX_LEN = 20;
// Must start with a letter; may then contain letters, spaces, hyphens,
// apostrophes and periods. Allows "D.J.", "Mary-Kate", "O'Brien".
const NAME_CHARS = /^[A-Za-z][A-Za-z .'-]*$/;

function validatePreferredName(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!t) return { valid: false, error: 'Tell us what to call you.' };
  if (t.length < MIN_LEN) return { valid: false, error: 'That is a little short. Use at least 2 characters.' };
  if (t.length > MAX_LEN) return { valid: false, error: 'Keep it to 20 characters or fewer.' };
  if (!NAME_CHARS.test(t)) {
    return { valid: false, error: 'Letters only, plus hyphens, apostrophes and periods.' };
  }
  const parts = t.split(' ');
  if (parts.length > 2) {
    return { valid: false, error: 'One or two words. Pick the one you actually go by.' };
  }
  if (TITLES.has(parts[0].toLowerCase())) {
    return { valid: false, error: 'Skip the title, just the name you go by.' };
  }
  return { valid: true, value: t };
}

module.exports = { validatePreferredName, MIN_LEN, MAX_LEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node --test server/utils/staffDisplayName.validate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/utils/staffDisplayName.validate.js server/utils/staffDisplayName.validate.test.js
git commit -m "feat(staff-name): narrow format validation for preferred_name" -- server/utils/staffDisplayName.validate.js server/utils/staffDisplayName.validate.test.js
```

---

### Task 3: Schema columns and the refresh function

**Files:**
- Modify: `server/db/schema.sql` (append to the `contractor_profiles` migration block, near line 80)
- Create: `server/utils/refreshDisplayName.js`
- Test: `server/utils/refreshDisplayName.test.js`

**Interfaces:**
- Consumes: `computeDisplayName` from Task 1.
- Produces: `refreshDisplayName(userId, client, opts) -> Promise<string|null>`, where `client` defaults to the shared pool and `opts` may carry `previousPreferredName`. Tasks 4, 5, 12 and 13 call this.

- [ ] **Step 1: Add the columns to schema.sql**

In `server/db/schema.sql`, immediately after the `contractor_profiles` table definition that ends at line 80, add:

```sql
-- Staff display name: preferred name plus one initial from the legal surname
-- (spec docs/superpowers/specs/2026-07-26-staff-display-name-design.md).
-- MAINTAINED, not generated: a generated column cannot reach agreements /
-- applications for the surname. server/utils/refreshDisplayName.js owns every
-- write, and server/scripts/refreshDisplayNames.js --check proves no row drifted.
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

-- NULL means "admin has not looked at this preferred name yet". Drives the
-- informational Needs Attention notice ONLY. No name read path consults this
-- column: a name is live the moment it is typed, and this is never a gate.
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS preferred_name_reviewed_at TIMESTAMPTZ;
```

- [ ] **Step 2: Write the failing test**

Create `server/utils/refreshDisplayName.test.js`:

```js
require('dotenv').config();
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { refreshDisplayName } = require('./refreshDisplayName');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `refresh-dn-${NONCE}@example.com`;
let userId;

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id",
    [EMAIL]
  );
  userId = u.rows[0].id;
  await pool.query(
    'INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)',
    [userId, 'Joey']
  );
  await pool.query(
    'INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)',
    [userId, 'Joseph Key', EMAIL]
  );
});

after(async () => {
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('writes preferred name plus legal last initial', async () => {
  const out = await refreshDisplayName(userId);
  assert.equal(out, 'Joey K.');
  const { rows } = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].display_name, 'Joey K.');
});

test('is idempotent', async () => {
  await refreshDisplayName(userId);
  const a = await refreshDisplayName(userId);
  const b = await refreshDisplayName(userId);
  assert.equal(a, b);
});

test('clears the review stamp when the preferred name changed value', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Joe' WHERE user_id = $1", [userId]);
  await refreshDisplayName(userId, pool, { previousPreferredName: 'Joey' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name_reviewed_at, null);
});

test('leaves the review stamp alone when the preferred name did not change', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  // An admin editing a phone number, or an agreement landing and changing only
  // the initial, must not re-raise a notice about a name nobody touched.
  await refreshDisplayName(userId, pool, { previousPreferredName: 'Joe' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

test('omitting previousPreferredName never clears the stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await refreshDisplayName(userId);
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

// GUARD (spec §2): the notice must never become a gate.
test('display_name is identical whether the row is reviewed or not', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  const unreviewed = await refreshDisplayName(userId);
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  const reviewed = await refreshDisplayName(userId);
  assert.equal(unreviewed, reviewed);
});

test('returns null for a user with no contractor_profiles row', async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id",
    [`refresh-dn-noprofile-${NONCE}@example.com`]
  );
  try {
    assert.equal(await refreshDisplayName(u.rows[0].id), null);
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/refreshDisplayName.test.js`
Expected: FAIL with `Cannot find module './refreshDisplayName'`

- [ ] **Step 4: Write the implementation**

Create `server/utils/refreshDisplayName.js`:

```js
'use strict';

// Recompute and persist contractor_profiles.display_name for one user.
// Spec §4.2. Called explicitly from every write path that can change a
// preferred name or a legal name; there is deliberately no database trigger,
// because payroll reads this table and invisible behavior there is worse than
// a stale cosmetic string. `server/scripts/refreshDisplayNames.js --check` is
// the safety net for a write path someone forgets to wire up.

const { pool } = require('../db');
const { computeDisplayName } = require('./staffDisplayName');

// Legal-name precedence matches paystubData.js:40 and accountReads.js:78:
// the signed agreement wins, then the application.
const LEGAL_NAME_SQL = `
  SELECT cp.preferred_name,
         COALESCE(ag.full_name, ap.full_name) AS legal_full_name
    FROM contractor_profiles cp
    LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
    LEFT JOIN applications ap ON ap.user_id = cp.user_id
   WHERE cp.user_id = $1`;

function norm(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}

/**
 * @param {number} userId
 * @param {object} [client]  pg client or pool; pass the transaction client when inside one
 * @param {object} [opts]
 * @param {string|null} [opts.previousPreferredName]  when supplied AND different from the
 *   stored value, clears preferred_name_reviewed_at so the §3.5 notice re-raises. Omit it
 *   for writes that cannot have changed the name (phone edits, agreement signing).
 * @returns {Promise<string|null>} the stored display name, or null if the user has no profile
 */
async function refreshDisplayName(userId, client = pool, opts = {}) {
  const { rows } = await client.query(LEGAL_NAME_SQL, [userId]);
  if (rows.length === 0) return null;

  const next = computeDisplayName({
    preferredName: rows[0].preferred_name,
    legalFullName: rows[0].legal_full_name,
  });

  const preferredChanged =
    Object.prototype.hasOwnProperty.call(opts, 'previousPreferredName') &&
    norm(opts.previousPreferredName) !== norm(rows[0].preferred_name);

  await client.query(
    `UPDATE contractor_profiles
        SET display_name = $1,
            preferred_name_reviewed_at =
              CASE WHEN $2::boolean THEN NULL ELSE preferred_name_reviewed_at END,
            updated_at = NOW()
      WHERE user_id = $3`,
    [next, preferredChanged, userId]
  );
  return next;
}

module.exports = { refreshDisplayName };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/refreshDisplayName.test.js`
Expected: PASS. If it fails with `column "display_name" does not exist`, the schema has not been applied to the dev branch yet: restart the dev server so `initDb()` runs, then rerun.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/os
git add server/db/schema.sql server/utils/refreshDisplayName.js server/utils/refreshDisplayName.test.js
git commit -m "feat(staff-name): display_name + preferred_name_reviewed_at columns and refresh fn" -- server/db/schema.sql server/utils/refreshDisplayName.js server/utils/refreshDisplayName.test.js
```

---

### Task 4: Wire refresh and validation into the write paths

**Files:**
- Modify: `server/routes/contractor.js` (POST `/`, around `:77-195`)
- Modify: `server/routes/me.js` (PATCH `/tip-page`, `:147-173`)
- Modify: `server/routes/staffPortal.js` (PATCH `/profile`, `:261`)
- Modify: `server/routes/admin/users.js` (PUT `/users/:id/profile` at `:302`, and the seed-from-application path at `:172-186`)
- Modify: `server/routes/agreement.js` (POST `/`, after the agreement upsert commits)
- Modify: `server/utils/contractorSeed.js` (after the upsert)
- Test: `server/routes/staffPortal.displayName.test.js`

**Interfaces:**
- Consumes: `refreshDisplayName` (Task 3), `validatePreferredName` (Task 2).
- Produces: nothing new. Every path that writes a preferred name now leaves `display_name` correct.

- [ ] **Step 1: Write the failing test**

Create `server/routes/staffPortal.displayName.test.js`. Model the harness on the existing `server/routes/auth.preferredName.test.js` (hand-rolled `node:http`; this repo has no supertest):

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

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL = `sp-dn-${NONCE}@example.com`;
let server, baseUrl, token, userId;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  const u = await pool.query(
    "INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1, 'x', 'staff', 'approved') RETURNING id",
    [EMAIL]
  );
  userId = u.rows[0].id;
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Joey']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Joseph Key', EMAIL]);
  token = jwt.sign({ id: userId, email: EMAIL, role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/staff-portal', require('./staffPortal'));
  app.use((err, _rq, res, _nx) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message, fieldErrors: err.fieldErrors });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('saving a preferred name refreshes display_name', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Joe' });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].display_name, 'Joe K.');
});

test('a changed preferred name clears the review stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Joey' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name_reviewed_at, null);
});

test('a phone-only edit does NOT clear the review stamp', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  const res = await req('PATCH', '/api/staff-portal/profile', { phone: '3125550100' });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

test('rejects a titled name with a field error and leaves the stored name alone', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Miss Taylor' });
  assert.equal(res.status, 400);
  const { rows } = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name, 'Joey');
});

test('rejects a three-word name', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Nicholas or Nick' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/staffPortal.displayName.test.js`
Expected: FAIL. The refresh assertions fail because `display_name` stays NULL, and the rejection assertions fail with 200 instead of 400.

- [ ] **Step 3: Wire `staffPortal.js`**

At the top of `server/routes/staffPortal.js`, add:

```js
const { refreshDisplayName } = require('../utils/refreshDisplayName');
const { validatePreferredName } = require('../utils/staffDisplayName.validate');
```

Replace line 261, currently:

```js
  if ('preferred_name' in body) updates.preferred_name = trimOrNull(body.preferred_name);
```

with:

```js
  if ('preferred_name' in body) {
    const check = validatePreferredName(body.preferred_name);
    if (!check.valid) throw new ValidationError({ preferred_name: check.error });
    updates.preferred_name = check.value;
  }
```

Then, in the same handler, immediately before the response is sent, add the refresh. Read the previous value first so the notice only re-raises on a real change:

```js
  // Display name is derived, so it has to be recomputed on every profile write.
  // previousPreferredName is passed ONLY when the caller sent a preferred_name,
  // so a phone-only edit cannot re-raise the §3.5 notice.
  if ('preferred_name' in updates) {
    await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
  } else {
    await refreshDisplayName(req.user.id);
  }
```

`prevPreferredName` comes from a read taken before the UPDATE runs. Add this right after the allowlist loop, before `updates` is applied:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;
```

- [ ] **Step 4: Run the test to verify staffPortal passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/staffPortal.displayName.test.js`
Expected: PASS

- [ ] **Step 5: Wire the remaining five write paths the same way**

Each gets the same two imports and the same shape: validate on the way in, refresh after the write commits.

`server/routes/contractor.js`, in `POST /` around `:84`, add to the existing `fieldErrors` block before the `throw`:

```js
  const nameCheck = validatePreferredName(preferred_name);
  if (!nameCheck.valid) fieldErrors.preferred_name = nameCheck.error;
```

and use `nameCheck.value` in place of `preferred_name` in both the UPDATE parameter array (`:163`) and the INSERT parameter array (`:184`). After the transaction commits, add:

```js
  await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
```

reading `prevPreferredName` before the transaction opens, exactly as in Step 3.

`server/routes/me.js`, in the `preferred_name` block at `:147-150`, replace the bare trim with the validator:

```js
  if ('preferred_name' in updates) {
    const check = validatePreferredName(updates.preferred_name);
    if (!check.valid) throw new ValidationError(check.error);
    updates.preferred_name = check.value;
  }
```

and after the `UPDATE contractor_profiles` at `:169-172`, add:

```js
    await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
```

`server/routes/admin/users.js`, in `PUT /users/:id/profile` at `:302`, after the destructuring and before the upsert:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;

  const nameCheck = validatePreferredName(preferred_name);
  if (!nameCheck.valid) throw new ValidationError({ preferred_name: nameCheck.error });
```

use `nameCheck.value` in the upsert parameter array at `:333`, and after the upsert:

```js
  await refreshDisplayName(userId, pool, { previousPreferredName: prevPreferredName });
```

In the seed-from-application path at `:172-186`, add `await refreshDisplayName(req.params.id, client)` inside the transaction, after the seed INSERT, passing the transaction client rather than the pool. **No `previousPreferredName`** there: seeding fills a blank profile rather than changing a name someone chose, and the admin is already looking at the record.

`server/routes/agreement.js`, in `POST /` after the agreements upsert commits: add `await refreshDisplayName(req.user.id)`. **No `previousPreferredName`** here. Signing supplies the legal name and can change the initial, but it does not touch the preferred name, so it must not re-raise a notice.

`server/utils/contractorSeed.js`, after the upsert at `:19-46`: add `await refreshDisplayName(userId, client)`.

- [ ] **Step 6: Run every suite these files reach**

Run each separately (the suites share the dev database):

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/staffPortal.displayName.test.js
node -r dotenv/config --test server/routes/staffPortal.test.js
node -r dotenv/config --test server/routes/auth.preferredName.test.js
node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js
node -r dotenv/config --test server/routes/admin/users.managerScrub.test.js
node -r dotenv/config --test server/routes/staffPortal/accountReads.test.js
```

Expected: PASS. Any failure here is a real regression, not a fixture nit; read it before adjusting anything.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
git add server/routes/contractor.js server/routes/me.js server/routes/staffPortal.js server/routes/admin/users.js server/routes/agreement.js server/utils/contractorSeed.js server/routes/staffPortal.displayName.test.js
git commit -m "feat(staff-name): validate preferred_name and refresh display_name on every write path" -- server/routes/contractor.js server/routes/me.js server/routes/staffPortal.js server/routes/admin/users.js server/routes/agreement.js server/utils/contractorSeed.js server/routes/staffPortal.displayName.test.js
```

---

### Task 5: Stop step 5 from asking for a name

This is the highest-value change in the plan. It deletes the copy that produced `TwistidTreets` and stops Payday Protocols from silently overwriting the step 4 answer.

**Files:**
- Modify: `server/routes/payment.js:161-168` (delete the preferred_name write) and `:223` (source the tip link name from the profile)
- Modify: `client/src/pages/PaydayProtocols.js:76, 89, 102, 152, 183, 425-437`
- Test: `server/routes/payment.noNameWrite.test.js`

**Interfaces:**
- Consumes: `refreshDisplayName` (Task 3).
- Produces: nothing. `POST /api/payment` no longer reads or writes any name.

- [ ] **Step 1: Write the failing test**

Create `server/routes/payment.noNameWrite.test.js`. Reuse the `req` helper and `before`/`after` shape from Task 4's test file verbatim, mounting `app.use('/api/payment', require('./payment'))` and seeding a profile whose `preferred_name` is `'Fareed'`, plus an agreement `'Mohammad F Shafiuddin'`. Then:

```js
test('POST /api/payment ignores a preferred_name in the body', async () => {
  const res = await req('POST', '/api/payment', {
    preferred_name: 'LumpyIceCream',
    preferred_payment_method: 'venmo',
    venmo_handle: '@test-handle',
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query(
    'SELECT preferred_name, display_name FROM contractor_profiles WHERE user_id = $1',
    [userId]
  );
  // The step-4 answer survives. This is the regression that produced TwistidTreets.
  assert.equal(rows[0].preferred_name, 'Fareed');
  assert.equal(rows[0].display_name, 'Fareed S.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/payment.noNameWrite.test.js`
Expected: FAIL, `preferred_name` is now `'LumpyIceCream'`

- [ ] **Step 3: Remove the server-side write**

In `server/routes/payment.js`, delete lines 161-168 entirely:

```js
      // Persist preferred_name on contractor_profiles (existing column)
      const preferredNameForTip = String(preferred_name || '').trim() || null;
      if (preferredNameForTip) {
        await client.query(
          'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
          [preferredNameForTip, req.user.id]
        );
      }
```

Replace with a comment recording why it is gone, so nobody re-adds it:

```js
      // NO name write here. Payday Protocols used to ask for the preferred name
      // a second time, with copy inviting a stage name, and overwrote step 4's
      // answer. The field is gone from the client and the write is gone from
      // here. Step 4 (routes/contractor.js) is the only name entry point.
      // Spec §3.3.
```

Remove `preferred_name` from the destructuring of `req.body` at the top of the handler.

At `:223`, replace `displayName: req.body.preferred_name` with a read from the profile:

```js
      const { rows: dnRows } = await pool.query(
        'SELECT display_name FROM contractor_profiles WHERE user_id = $1',
        [req.user.id]
      );
      const { url, id: linkId } = await createTipPaymentLink({
        userId: req.user.id,
        displayName: dnRows[0]?.display_name || null,
        token,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/payment.noNameWrite.test.js`
Expected: PASS

- [ ] **Step 5: Replace the client field with a read-only line**

In `client/src/pages/PaydayProtocols.js`:

Remove `preferred_name: ''` from the form state at `:76`, the hydration at `:102`, the validation rule at `:152`, and the `data.append('preferred_name', ...)` at `:183`.

Replace the whole `form-group` block at `:425-437` with:

```jsx
<div className="form-group">
  <div className="meta-k" style={{ marginBottom: 4 }}>Your tip page</div>
  <p className="form-helper" style={{ marginTop: 0 }}>
    Your tip page will read <strong>{displayName || 'your name'}</strong>.{' '}
    <Link to="/contractor-profile">Change this</Link>
  </p>
</div>
```

Add the state and hydrate it from the same profile fetch that already runs at `:102`:

```js
  const [displayName, setDisplayName] = useState('');
  // ... inside the existing .then(prof => { ... }) that hydrates the form:
  setDisplayName(prof.display_name || prof.preferred_name || '');
```

`GET /api/contractor` returns `display_name` once Task 9 Step 5 widens that projection; until then it falls back to `preferred_name`. Import `Link` from `react-router-dom` if it is not already imported.

Update the intro paragraph at `:418-423` to drop "Your name is required":

```jsx
<p className="text-small text-muted" style={{ marginBottom: '1.25rem' }}>
  Your tip page lives at <strong>drbartender.com/tip/your-name</strong> with a
  QR you can print. The tip handles below are <strong>optional</strong>. Add
  them now, later from My Tip Page, or never. None of this is shared outside DRB.
</p>
```

- [ ] **Step 6: Verify the client builds**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds with no lint errors. `CI=true` makes warnings fatal, which is what the pre-push hook gates on.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
git add server/routes/payment.js client/src/pages/PaydayProtocols.js server/routes/payment.noNameWrite.test.js
git commit -m "fix(staff-name): step 5 stops asking for a name (this is where TwistidTreets came from)" -- server/routes/payment.js client/src/pages/PaydayProtocols.js server/routes/payment.noNameWrite.test.js
```

---

### Task 6: Server read-site swaps, non-money

**Files:**
- Modify: `server/routes/shifts.js:200,243,245,297` · `server/routes/calendar.js:179` · `server/routes/staffShiftActions.js:840` · `server/routes/proposals/cancel.js:170` · `server/routes/publicTip.js:83,227` · `server/routes/admin/contractorTipPage.js:110,160,268,294` · `server/routes/messages.js:20,37` · `server/routes/adminCoverSwaps.js:81` · `server/routes/staffPortal.js:99` · `server/routes/admin/applications.js:164` · `server/utils/presenceStore.js:8` · `server/utils/beoHandlers.js:223` · `server/utils/staffShiftHandlers.js:306,544` · `server/utils/marketingHandlers.js:390`
- Modify: `server/routes/beo.js:182-201` (delete the local `computeName`)

**Interfaces:**
- Consumes: `computeDisplayName` (Task 1) in `beo.js` only. Everything else is a SQL column swap.
- Produces: nothing.

- [ ] **Step 1: Swap the SQL**

In each file above, change `cp.preferred_name` to `cp.display_name` **only where the value is a person's name shown in a list or on a document**. The mechanical form is:

```sql
-- before
COALESCE(cp.preferred_name, u.email) AS staff_name
-- after
COALESCE(cp.display_name, u.email) AS staff_name
```

`presenceStore.js:8` is the same swap inside a constant:

```js
const NAME_SQL = "COALESCE(cp.display_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";
```

`messages.js:37` also sorts on it; change the ORDER BY to `cp.display_name` so the recipient picker stays alphabetized on what the admin actually sees.

**Do not touch** `server/routes/shifts.queries.js:42`. It already extracts a single initial from `preferred_name` for a cover marker and is correct as-is.

- [ ] **Step 2: Replace beo.js computeName with the shared helper**

In `server/routes/beo.js`, delete the local `computeName` function at `:182-201` and add the import at the top:

```js
const { computeDisplayName } = require('../utils/staffDisplayName');
```

Replace the call site (`const display_name = computeName(r);`) with:

```js
    // Shared helper (spec §5). This is the one behavior-preserving swap in the
    // batch: beo.js already implemented this exact rule locally.
    const display_name =
      computeDisplayName({
        preferredName: r.preferred_name,
        legalFullName: r.agreements_name || r.applications_name,
      }) || (r.email && r.email.includes('@') ? r.email.split('@')[0] : 'Staff');
```

Note the precedence flip: the old local function read `applications_name || agreements_name`, while `refreshDisplayName` and `paystubData.js` both prefer the signed agreement. Agreement-first is correct, since it is the document the person actually signed.

- [ ] **Step 3: Run the affected suites**

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/beo.test.js
node -r dotenv/config --test server/routes/publicTip.test.js
node -r dotenv/config --test server/routes/adminCoverSwaps.test.js
node -r dotenv/config --test server/routes/admin/presence.test.js
node -r dotenv/config --test server/routes/calendar.description.test.js
node -r dotenv/config --test server/routes/shifts.approval.test.js
node -r dotenv/config --test server/routes/staffShiftActions.test.js
```

Expected: PASS. `beo.test.js` asserts roster names; if a fixture seeds only a `preferred_name` with no agreement, the expected string changes from bare name to name-plus-initial. Update the fixture's expectation, not the helper.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/os
git add server/routes/shifts.js server/routes/calendar.js server/routes/staffShiftActions.js server/routes/proposals/cancel.js server/routes/publicTip.js server/routes/admin/contractorTipPage.js server/routes/messages.js server/routes/adminCoverSwaps.js server/routes/staffPortal.js server/routes/admin/applications.js server/routes/beo.js server/utils/presenceStore.js server/utils/beoHandlers.js server/utils/staffShiftHandlers.js server/utils/marketingHandlers.js
git commit -m "refactor(staff-name): read display_name on roster and document surfaces" -- server/routes/shifts.js server/routes/calendar.js server/routes/staffShiftActions.js server/routes/proposals/cancel.js server/routes/publicTip.js server/routes/admin/contractorTipPage.js server/routes/messages.js server/routes/adminCoverSwaps.js server/routes/staffPortal.js server/routes/admin/applications.js server/routes/beo.js server/utils/presenceStore.js server/utils/beoHandlers.js server/utils/staffShiftHandlers.js server/utils/marketingHandlers.js
```

---

### Task 7: Money-screen read swaps

Separated from Task 6 because two of these queries **sort and aggregate on the name string**, so the swap changes ordering. That is exactly where count and sorted-list assertions bite.

**Files:**
- Modify: `server/routes/admin/payroll.js:34,42,558,655`
- Modify: `server/routes/admin/users.js:33,442,455`
- Modify: `server/routes/stripePayouts.js:20`

- [ ] **Step 1: Swap the SQL**

Same mechanical change as Task 6: `cp.preferred_name` becomes `cp.display_name` in each cited line, including inside the `ORDER BY COALESCE(...)` at `admin/payroll.js:42` and `admin/users.js:455`, and inside the `ARRAY(SELECT COALESCE(...))` at `admin/payroll.js:655`.

**Exception, `admin/users.js:33` and `:442`.** Those two projections select the bare column, so the JSON key the client reads changes with it. Select **both** instead, so the client keeps a fallback while a brand-new row waits for its first refresh:

```sql
        cp.preferred_name, cp.display_name,
```

`admin/users.js:442` feeds `GET /admin/active-staff`, which is the StaffDashboard list, and `:33` feeds the admin users list. Task 11 updates both consumers to read `display_name` first.

`stripePayouts.js:20` also needs its comment at `:11` updated, since it currently documents the old resolution:

```js
// staff_name resolves the tip line's staffer from contractor_profiles.display_name
// (preferred name plus last initial, see utils/staffDisplayName.js), then the
// users.email fallback. Read-side display only: matching keys on
// tips.target_user_id, never on this string.
```

- [ ] **Step 2: Run the payroll suites and read the output**

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/admin/payroll.test.js
node -r dotenv/config --test server/routes/admin/payroll.redesign.test.js
node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js
node -r dotenv/config --test server/routes/admin/users.tipsGate.test.js
node -r dotenv/config --test server/routes/staffPortal/payouts.test.js
```

Expected: PASS. If a sorted-list or array-order assertion fails, the cause is that a fixture's display name now sorts differently from its preferred name (a fixture named `Zed` with legal surname `Adams` now renders `Zed A.` and still sorts under Z, but one seeded with a full name may move). Fix the fixture's expected ordering. **Do not** revert the column or add a sort on `preferred_name` to paper over it.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/os
git add server/routes/admin/payroll.js server/routes/admin/users.js server/routes/stripePayouts.js
git commit -m "refactor(staff-name): money SCREENS read display_name (records stay legal)" -- server/routes/admin/payroll.js server/routes/admin/users.js server/routes/stripePayouts.js
```

---

### Task 8: 1099 workbench reads the legal name

The one genuine money defect in scope. The year-end contractor list currently labels rows with the nickname, so Nevver's 1099 row reads `TwistidTreets`.

**Files:**
- Modify: `server/routes/admin/payrollTax.js:137`
- Test: `server/routes/admin/payrollTax.legalName.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/payrollTax.legalName.test.js`, using the Task 4 harness shape with an admin token, mounting `app.use('/api/admin', require('./payrollTax'))`. Seed a user whose `preferred_name` is `'TwistidTreets'` and whose agreement `full_name` is `'Nevver Sayles'`, give them one paid ledger row in the target year, then:

```js
test('the 1099 list labels rows with the LEGAL name, never the nickname', async () => {
  const res = await req('GET', `/api/admin/payroll-tax?year=${YEAR}`);
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'seeded contractor missing from the 1099 list');
  assert.equal(row.name, 'Nevver Sayles');
  assert.ok(!row.name.includes('Twistid'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/payrollTax.legalName.test.js`
Expected: FAIL, `'TwistidTreets' !== 'Nevver Sayles'`

- [ ] **Step 3: Fix the query**

In `server/routes/admin/payrollTax.js`, replace line 137:

```sql
            COALESCE(cp.preferred_name, u.email) AS name,
```

with the same legal-first precedence `paystubData.js:40` already uses:

```sql
            -- A 1099 is a government document, so this is the LEGAL name, not
            -- the display name. Same precedence as paystubData.js:40.
            COALESCE(ag.full_name, ap.full_name, u.email) AS name,
```

and add the joins the new columns need, alongside the existing `LEFT JOIN contractor_profiles`:

```sql
  LEFT JOIN agreements   ag ON ag.user_id = c.user_id
  LEFT JOIN applications ap ON ap.user_id = c.user_id
```

The `LEFT JOIN contractor_profiles cp` becomes unused in this query; remove it if nothing else in the statement references `cp`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/payrollTax.legalName.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/routes/admin/payrollTax.js server/routes/admin/payrollTax.legalName.test.js
git commit -m "fix(payroll-tax): 1099 contractor list reads the legal name, not the nickname" -- server/routes/admin/payrollTax.js server/routes/admin/payrollTax.legalName.test.js
```

---

### Task 9: Onboarding copy and the live preview

**Files:**
- Create: `client/src/utils/preferredName.js`
- Test: `client/src/utils/preferredName.test.js`
- Modify: `client/src/pages/ContractorProfile.js:83, 162-166`
- Modify: `server/routes/contractor.js` (GET `/` response gains `legal_name`)

**Interfaces:**
- Consumes: nothing at runtime. This is a deliberate port of the Task 1 and Task 2 logic to the browser.
- Produces: `computeDisplayName({ preferredName, legalFullName })` and `validatePreferredName(raw)` from `client/src/utils/preferredName.js`, used by Tasks 9 and 10.

**Known duplication:** the browser needs the preview without a round trip per keystroke, and CRA cannot import from outside `client/src`. `client/src/utils/preferredName.js` is therefore a hand-kept port of `server/utils/staffDisplayName.js` plus `server/utils/staffDisplayName.validate.js`. Both sides carry the **same table of cases**, so a drift in either shows up as a red test.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/preferredName.test.js` with the identical case table from Task 1 Step 1 and Task 2 Step 1, in Jest form:

```js
import { computeDisplayName, validatePreferredName } from './preferredName';

// PARITY TABLE. Must stay identical to server/utils/staffDisplayName.test.js.
// If you change one, change both.
const CASES = [
  ['Fareed', 'Mohammad F Shafiuddin', 'Fareed S.'],
  ['Teah', 'Teah Teriele', 'Teah T.'],
  ['Dallas', 'Dallas Raby', 'Dallas R.'],
  ['Joey', 'Joseph Key', 'Joey K.'],
  ['Nikki', 'Monique Lundy', 'Nikki L.'],
  ['Tashea Coates', 'Tashea Coates', 'Tashea C.'],
  ['Evan Williams', 'Evan Williams', 'Evan W.'],
  ['Billie', 'Billie Jean Barrone', 'Billie B.'],
  ['Billie Jean', 'Billie Jean Barrone', 'Billie Jean B.'],
  ['Mark Holt', 'Mark', 'Mark H.'],
  ['Ariel  D. Smith', 'Ariel Smith', 'Ariel S.'],
  ['Adelle M. Reynolds', null, 'Adelle R.'],
  ['veronica martinez', 'veronica martinez', 'Veronica M.'],
  ['Jasmine Jeff', 'Jasmine jeff', 'Jasmine J.'],
  ['Zul', 'Zul', 'Zul'],
  ['Dallas', null, 'Dallas'],
];

test.each(CASES)('computeDisplayName(%s, %s) === %s', (preferredName, legalFullName, expected) => {
  expect(computeDisplayName({ preferredName, legalFullName })).toBe(expected);
});

test('returns null with no preferred name', () => {
  expect(computeDisplayName({ preferredName: '', legalFullName: 'Nevver Sayles' })).toBeNull();
});

test.each([
  'McKenna', 'DeShawn', 'LaToya', "O'Brien", 'Mary-Kate', 'D.J.', 'DJ', 'LumpyIceCream',
])('accepts %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(true);
});

test.each([
  'Miss Taylor', 'Nicholas or Nick', 'Bar2Go', 'J', '', 'Abcdefghijklmnopqrstuvwxyz',
])('rejects %s', (name) => {
  expect(validatePreferredName(name).valid).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os/client && CI=true npx react-scripts test --watchAll=false src/utils/preferredName.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Port the logic**

Create `client/src/utils/preferredName.js` as an ES-module port. Copy the bodies of `computeDisplayName` (Task 1 Step 3) and `validatePreferredName` (Task 2 Step 3) verbatim, including the `TITLES` set, `tokens`, `isMiddleInitial` and `fixCase` helpers, changing only `module.exports` to named `export` statements. Add this header:

```js
// PORT of server/utils/staffDisplayName.js + staffDisplayName.validate.js.
// The browser needs the live preview without a round trip per keystroke, and
// CRA cannot import from outside client/src. The server is the source of truth
// and validates every write regardless of what happens here.
//
// If you change the rule, change BOTH files and BOTH case tables:
//   server/utils/staffDisplayName.test.js
//   client/src/utils/preferredName.test.js
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os/client && CI=true npx react-scripts test --watchAll=false src/utils/preferredName.test.js`
Expected: PASS

- [ ] **Step 5: Return the legal name from GET /api/contractor**

In `server/routes/contractor.js`, add the legal name to the profile projection so the preview has a surname to work with:

```js
  // Legal name (read-only) so the preferred-name field can preview the display
  // name live. Same precedence as refreshDisplayName / paystubData.
  const legal = await pool.query(
    `SELECT COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM users u
       LEFT JOIN agreements   ag ON ag.user_id = u.id
       LEFT JOIN applications ap ON ap.user_id = u.id
      WHERE u.id = $1`,
    [req.user.id]
  );
  res.json({
    ...(sanitizeProfile(profile) || {}),
    legal_name: legal.rows[0]?.legal_name || null,
  });
```

Confirm `sanitizeProfile` does not strip `display_name`; if it uses an allowlist, add `display_name` to it. Task 5's read-only Payday Protocols line and Task 11's fallbacks both depend on this endpoint returning it.

- [ ] **Step 6: Replace the field copy**

In `client/src/pages/ContractorProfile.js`, import the helpers:

```js
import { computeDisplayName, validatePreferredName } from '../utils/preferredName';
```

Store `legal_name` in state from the profile fetch at `:43-46`, then replace the block at `:162-166` with:

```jsx
<div className={"form-group" + fieldClass('preferred_name')}>
  <label htmlFor="cp-preferred_name" className="form-label">What do I call you? *</label>
  <p className="form-helper" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
    Fill in the blank: "Hi, I'm ______, I'll be taking care of you tonight."
    Whatever you actually go by. A short form, a chosen name, the name your
    people use. Chip for Vernon, Alexis for Alexander, Shea for Tashea,
    Fareed for Mohammad.
  </p>
  <input
    id="cp-preferred_name"
    name="preferred_name"
    className={"form-input" + inputClass('preferred_name')}
    value={form.preferred_name}
    onChange={handle}
    maxLength={20}
    aria-invalid={!!fieldErrors?.preferred_name}
    aria-describedby="cp-preferred_name-preview"
  />
  <FieldError error={fieldErrors?.preferred_name} />
  <p className="form-helper" id="cp-preferred_name-preview" style={{ marginTop: '0.4rem' }}>
    {namePreview
      ? <>Your team and clients will see <strong>{namePreview}</strong></>
      : 'Your team and clients will see your name plus your last initial.'}
  </p>
</div>
```

with the preview derived above the `return`:

```jsx
  // Live preview. Seeing "LumpyIceCream S." appear under a sentence about
  // introducing yourself to a guest is most of the enforcement (spec §3.1).
  const namePreview = computeDisplayName({
    preferredName: form.preferred_name,
    legalFullName: legalName,
  });
```

Replace the validation rule at `:83` so the client rejects the same shapes the server does. `useFormValidation` rules take a `test` callback returning a **boolean** (`client/src/hooks/useFormValidation.js:20-25`), and its `message` is only ever "Please fill in: ...", so the specific reason is surfaced through `fieldErrors` instead. Do not modify the hook.

```js
  const rules = [
    { field: 'preferred_name', label: 'Preferred Name', test: (v) => validatePreferredName(v).valid },
    { field: 'phone', label: 'Phone' },
    { field: 'city', label: 'City' },
    { field: 'state', label: 'State' },
  ];
```

Then in `submit`, immediately after the existing `const result = validate(rules, form);` guard, add the specific message so the user is told *why* rather than just "please fill in":

```js
    const nameCheck = validatePreferredName(form.preferred_name);
    if (!nameCheck.valid) {
      setFieldErrors({ preferred_name: nameCheck.error });
      setError(nameCheck.error);
      scrollToFirstError();
      return;
    }
```

- [ ] **Step 7: Verify the build**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds

- [ ] **Step 8: Commit**

```bash
cd ~/projects/os
git add client/src/utils/preferredName.js client/src/utils/preferredName.test.js client/src/pages/ContractorProfile.js server/routes/contractor.js
git commit -m "feat(staff-name): 'What do I call you?' copy with live display-name preview" -- client/src/utils/preferredName.js client/src/utils/preferredName.test.js client/src/pages/ContractorProfile.js server/routes/contractor.js
```

---

### Task 10: Staff portal copy

**Files:**
- Modify: `client/src/pages/staff/account/ProfileSection.js:44, 330-337`

**Interfaces:**
- Consumes: `computeDisplayName` from `client/src/utils/preferredName.js` (Task 9). `legal_name` already arrives from `accountReads.js:78`.

- [ ] **Step 1: Replace the helper constant and label**

Replace line 44:

```js
const PREFERRED_NAME_HELPER = 'Shown on the staff roster and to clients.';
```

with:

```js
const PREFERRED_NAME_HELPER =
  'Whatever you actually go by. A short form, a chosen name, the name your people use. '
  + 'Chip for Vernon, Alexis for Alexander, Shea for Tashea, Fareed for Mohammad.';
```

Add the import:

```js
import { computeDisplayName } from '../../../utils/preferredName';
```

- [ ] **Step 2: Add the preview under the field**

Replace the `TextField` block at `:330-337` with:

```jsx
<TextField
  label="What do I call you?"
  value={form.preferred_name}
  onChange={(v) => setField('preferred_name', v)}
  sub={PREFERRED_NAME_HELPER}
  error={fieldErrors.preferred_name}
  autoComplete="given-name"
/>
```

and immediately after the enclosing `sp-tf-row`, add the preview line:

```jsx
<div className="sp-tf-sub" style={{ marginTop: '-0.4rem', marginBottom: '0.75rem' }}>
  {namePreview
    ? <>Your team and clients will see <strong>{namePreview}</strong></>
    : 'Your team and clients will see your name plus your last initial.'}
</div>
```

with, above the `return`:

```jsx
  const namePreview = computeDisplayName({
    preferredName: form.preferred_name,
    legalFullName: profile?.legal_name,
  });
```

- [ ] **Step 3: Verify the build**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
cd ~/projects/os
git add client/src/pages/staff/account/ProfileSection.js
git commit -m "feat(staff-name): staff portal preferred-name copy and preview" -- client/src/pages/staff/account/ProfileSection.js
```

---

### Task 11: Client read-site swaps and the admin legal-name line

**Files:**
- Modify: `client/src/components/adminos/drawers/ShiftDrawer.js:371,650,653`
- Modify: `client/src/pages/AdminDashboard.js:256,269,486,605-639`
- Modify: `client/src/pages/admin/StaffDashboard.js:26,27,119,126,174`
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js:166,350`
- Modify: `client/src/pages/staff/TipCardPage.js:110,275`
- Modify: `client/src/pages/admin/userDetail/tabs/OverviewTab.js:186-189`

- [ ] **Step 1: Swap the rendered field**

In each cited line, change `s.preferred_name` / `r.preferred_name` / `req.preferred_name` / `data.preferred_name` to `display_name`, keeping `preferred_name` as a fallback wherever the server sends both:

```js
{s.display_name || s.preferred_name || displayEmail}
```

The search filters in `AdminDashboard.js:256,605-639` and `ShiftDrawer.js:371` should match on `display_name` too, so typing what you see finds the person.

`TipCardPage.js:110` reads from two endpoints and needs the same treatment on both:

```js
        display_name: tipPage.display_name || methods.display_name
          || tipPage.preferred_name || methods.preferred_name || null,
```

which means `server/routes/me.js` (the staff tip-page GET at `:75`) must select `cp.display_name` alongside `cp.preferred_name`, and return it at `:121`. Line `275` then renders `data.display_name || 'your bartender'`.

`AdminUserDetail.js:166` becomes:

```js
  const displayName = profile?.display_name || profile?.preferred_name || user.email;
```

The `preferred_name` fallback stays here on purpose: this page can load before a backfill has touched a brand-new row.

- [ ] **Step 2: Show the legal name on the admin record**

In `client/src/pages/admin/userDetail/tabs/OverviewTab.js`, in the non-editing branch of the profile card, add a read-only row beneath the preferred name:

```jsx
<div>
  <div className="meta-k" style={{ marginBottom: 4 }}>Legal name</div>
  <div className="meta-v">{profile?.legal_name || <span className="muted">not on file</span>}</div>
</div>
```

In the editing branch at `:186-189`, relabel the input and keep it editable:

```jsx
<div>
  <div className="meta-k" style={{ marginBottom: 4 }}>What we call them</div>
  <input className="input" value={editForm.preferred_name} onChange={e => updateField('preferred_name', e.target.value)} maxLength={20} />
  <FieldError error={profileFieldErrors?.preferred_name} />
</div>
```

`legal_name` needs to reach this component: add it to the admin user projection in `server/routes/admin/users.js:442` using the same `COALESCE(ag.full_name, ap.full_name)` join already added in Task 8.

- [ ] **Step 3: Verify the build**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
cd ~/projects/os
git add client/src/components/adminos/drawers/ShiftDrawer.js client/src/pages/AdminDashboard.js client/src/pages/admin/StaffDashboard.js client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/staff/TipCardPage.js client/src/pages/admin/userDetail/tabs/OverviewTab.js server/routes/admin/users.js
git commit -m "refactor(staff-name): admin and staff surfaces render display_name; legal name on the record" -- client/src/components/adminos/drawers/ShiftDrawer.js client/src/pages/AdminDashboard.js client/src/pages/admin/StaffDashboard.js client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/staff/TipCardPage.js client/src/pages/admin/userDetail/tabs/OverviewTab.js server/routes/admin/users.js
```

---

### Task 12: The admin visibility notice

Visibility, never a gate. The name is live the moment it is typed; this is how Dallas finds out about it.

**Files:**
- Create: `server/routes/admin/nameNotices.js`
- Modify: `server/routes/admin/index.js` (mount it)
- Test: `server/routes/admin/nameNotices.test.js`
- Modify: `client/src/pages/admin/overview/queueItems.js` (`buildStaffingItems`)
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js` (`queueItemHref`, `QUEUE_ICON`)
- Modify: `client/src/pages/admin/overview/OverviewPage.js` (fetch + wire)

**Interfaces:**
- Consumes: `refreshDisplayName` (Task 3).
- Produces: `GET /api/admin/name-notices -> { rows: [{ user_id, display_name, preferred_name, legal_name }] }` and `POST /api/admin/name-notices/:userId/ack -> { ok: true }`. `buildStaffingItems(unstaffed, newApplications, nameNotices)` gains a third parameter.

A separate router file rather than another route in `admin/users.js`, so a literal path can never be shadowed by the existing `/users/:id` patterns.

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/nameNotices.test.js` using the Task 4 harness shape with an admin token, mounting `app.use('/api/admin', require('./nameNotices'))`. Seed a staff user with `preferred_name = 'TwistidTreets'`, agreement `'Nevver Sayles'`, and `preferred_name_reviewed_at = NULL`. Then:

```js
test('lists unreviewed names with both the display and legal name', async () => {
  const res = await req('GET', '/api/admin/name-notices');
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'unreviewed row missing from the notice list');
  assert.equal(row.preferred_name, 'TwistidTreets');
  assert.equal(row.legal_name, 'Nevver Sayles');
});

test('ack stamps the row and drops it from the list', async () => {
  const ack = await req('POST', `/api/admin/name-notices/${userId}/ack`);
  assert.equal(ack.status, 200);
  const res = await req('GET', '/api/admin/name-notices');
  assert.ok(!res.body.rows.some((r) => r.user_id === userId));
});

// GUARD (spec §2, §8): the notice is not a gate.
test('acking does not change the rendered name', async () => {
  const before = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  await req('POST', `/api/admin/name-notices/${userId}/ack`);
  const after = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(after.rows[0].display_name, before.rows[0].display_name);
  assert.equal(after.rows[0].display_name, 'TwistidTreets S.');
});

test('rejects a non-admin caller', async () => {
  const saved = token;
  token = staffToken;
  try {
    const res = await req('GET', '/api/admin/name-notices');
    assert.ok(res.status === 401 || res.status === 403);
  } finally {
    token = saved;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/nameNotices.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Write the router**

Create `server/routes/admin/nameNotices.js`:

```js
'use strict';

// Informational notice when a staff preferred name is set or changed.
// Spec §3.5. THIS IS NOT A GATE: the name is live from the moment it is typed,
// and no name read path consults preferred_name_reviewed_at. The only action is
// "Got it", which stamps the timestamp. There is deliberately no reject action;
// the remedy for a bad name is a conversation, and if that conversation ends in
// a change, it gets made in the profile like any other edit.

const express = require('express');
const { pool } = require('../../db');
const auth = require('../../middleware/auth');
const { adminOnly } = require('../../middleware/roles');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

router.get('/name-notices', auth, adminOnly, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.user_id,
            cp.display_name,
            cp.preferred_name,
            COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM contractor_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
       LEFT JOIN applications ap ON ap.user_id = cp.user_id
      WHERE cp.preferred_name_reviewed_at IS NULL
        AND cp.preferred_name IS NOT NULL
        AND u.onboarding_status <> 'deactivated'
      ORDER BY cp.updated_at DESC`
  );
  res.json({ rows });
}));

router.post('/name-notices/:userId/ack', auth, adminOnly, asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1',
    [req.params.userId]
  );
  res.json({ ok: true });
}));

module.exports = router;
```

Verify the `auth`, `adminOnly` and `asyncHandler` import paths against a sibling such as `server/routes/admin/payrollTax.js`, and mount the router in `server/routes/admin/index.js` alongside the others.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/nameNotices.test.js`
Expected: PASS

- [ ] **Step 5: Add the queue item**

In `client/src/pages/admin/overview/queueItems.js`, extend `buildStaffingItems`:

```js
export function buildStaffingItems(unstaffed, newApplications, nameNotices) {
  const items = (unstaffed || []).map(e => {
    // ... unchanged ...
  });
  if (newApplications > 0) {
    // ... unchanged ...
  }
  // Informational: a staffer told us what to call them. Usually a pleasant
  // fact, occasionally a conversation. Never blocks the name (spec §3.5).
  for (const n of nameNotices || []) {
    items.push({
      id: 'name-' + n.user_id, type: 'name-notice', priority: 'info',
      title: `${n.legal_name || 'A staffer'} goes by ${n.preferred_name}`,
      sub: `shows as ${n.display_name || n.preferred_name}`,
      meta: 'Got it', target: 'user', ref: n.user_id,
    });
  }
  return items;
}
```

In `NeedsYouStrip.js`, add the target and an icon:

```js
  if (a.target === 'user') return `/staffing/users/${a.ref}`;
```

```js
const QUEUE_ICON = {
  unstaffed: 'userplus', proposal: 'eye', application: 'pen',
  payouts: 'dollar', prep: 'flask', 'change-request': 'pen', sms: 'chat',
  'lead-call': 'alert', 'name-notice': 'userplus',
};
```

In `OverviewPage.js`, fetch the notices alongside the other queue sources and pass them through:

```js
  const [nameNotices, setNameNotices] = useState([]);
  useEffect(() => {
    api.get('/admin/name-notices')
      .then(r => setNameNotices(r.data.rows || []))
      .catch(() => setNameNotices([]));
  }, []);

  const staffingItems = useMemo(
    () => buildStaffingItems(unstaffed, newApplications, nameNotices),
    [unstaffed, newApplications, nameNotices]
  );
```

Clicking the row navigates to the user record, which is where the legal name from Task 11 now sits. Acking from the row is a follow-up if Dallas wants it; navigating to the record is the primary action and the `.catch` keeps a failed fetch from breaking the whole strip.

- [ ] **Step 6: Verify the build**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
git add server/routes/admin/nameNotices.js server/routes/admin/nameNotices.test.js server/routes/admin/index.js client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/NeedsYouStrip.js client/src/pages/admin/overview/OverviewPage.js
git commit -m "feat(staff-name): informational Needs Attention notice for new/changed names" -- server/routes/admin/nameNotices.js server/routes/admin/nameNotices.test.js server/routes/admin/index.js client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/NeedsYouStrip.js client/src/pages/admin/overview/OverviewPage.js
```

---

### Task 13: Backfill script and the hand-fix list

**Files:**
- Create: `server/scripts/refreshDisplayNames.js`
- Test: manual run against dev, then production

**Interfaces:**
- Consumes: `computeDisplayName` (Task 1) and `validatePreferredName` (Task 2). The script writes both columns directly rather than going through `refreshDisplayName`, because the backfill needs the whitespace trim and the report in the same pass over the rows.

- [ ] **Step 1: Write the script**

Create `server/scripts/refreshDisplayNames.js`:

```js
'use strict';

// Backfill and audit for contractor_profiles.display_name. Spec §6, §7.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js          # backfill
//   node -r dotenv/config server/scripts/refreshDisplayNames.js --check  # audit only
//
// --check exits non-zero if any stored display_name differs from a fresh
// computation. That is the safety net for a write path someone adds later and
// forgets to wire to refreshDisplayName().
//
// This script NEVER rewrites a stored preferred_name beyond trimming
// whitespace. Shortening is a display concern and lives in display_name, so
// nobody's stored name is second-guessed by a script (spec §6).

require('dotenv').config();
const { pool } = require('../db');
const { computeDisplayName } = require('../utils/staffDisplayName');
const { validatePreferredName } = require('../utils/staffDisplayName.validate');

const CHECK_ONLY = process.argv.includes('--check');

async function main() {
  const { rows } = await pool.query(
    `SELECT cp.user_id, cp.preferred_name, cp.display_name,
            u.onboarding_status,
            COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM contractor_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN agreements   ag ON ag.user_id = cp.user_id
       LEFT JOIN applications ap ON ap.user_id = cp.user_id
      ORDER BY cp.user_id`
  );

  let drift = 0, updated = 0, trimmed = 0;
  const needsHuman = [];
  const needsLegalName = [];

  for (const r of rows) {
    const trimmedName = String(r.preferred_name || '').trim().replace(/\s+/g, ' ');
    const expected = computeDisplayName({ preferredName: trimmedName, legalFullName: r.legal_name });

    if (CHECK_ONLY) {
      if (expected !== r.display_name) {
        drift++;
        console.log(`DRIFT user ${r.user_id}: stored ${JSON.stringify(r.display_name)} != computed ${JSON.stringify(expected)}`);
      }
      continue;
    }

    if (trimmedName && trimmedName !== r.preferred_name) {
      await pool.query('UPDATE contractor_profiles SET preferred_name = $1 WHERE user_id = $2', [trimmedName, r.user_id]);
      trimmed++;
    }
    await pool.query(
      `UPDATE contractor_profiles
          SET display_name = $1,
              preferred_name_reviewed_at = COALESCE(preferred_name_reviewed_at, NOW()),
              updated_at = NOW()
        WHERE user_id = $2`,
      [expected, r.user_id]
    );
    updated++;

    // Report only. A script does not get to decide what someone is called.
    const check = validatePreferredName(trimmedName);
    if (trimmedName && !check.valid) {
      needsHuman.push(`  user ${r.user_id}: ${JSON.stringify(trimmedName)} (${check.error}) -> currently renders ${JSON.stringify(expected)}`);
    }
    if (!r.legal_name && r.onboarding_status !== 'deactivated') {
      needsLegalName.push(`  user ${r.user_id}: ${JSON.stringify(trimmedName)} has no agreement or application on file`);
    }
  }

  if (CHECK_ONLY) {
    console.log(drift === 0 ? `OK: ${rows.length} rows, no drift` : `FAIL: ${drift} row(s) drifted`);
    await pool.end();
    process.exit(drift === 0 ? 0 : 1);
  }

  console.log(`Backfilled ${updated} rows (${trimmed} whitespace fixes).`);
  if (needsHuman.length) console.log(`\nMalformed preferred names, fix by hand:\n${needsHuman.join('\n')}`);
  if (needsLegalName.length) console.log(`\nActive staff with no legal name on file:\n${needsLegalName.join('\n')}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note `preferred_name_reviewed_at = COALESCE(..., NOW())`: every existing row is stamped as seen, so the Needs Attention queue opens empty rather than with sixty notices about names that have been fine all year.

- [ ] **Step 2: Run the backfill against dev**

Run: `cd ~/projects/os && node -r dotenv/config server/scripts/refreshDisplayNames.js`
Expected: a row count, plus the two report sections.

- [ ] **Step 3: Prove the audit mode works**

Run: `cd ~/projects/os && node -r dotenv/config server/scripts/refreshDisplayNames.js --check`
Expected: `OK: <n> rows, no drift`, exit 0.

Then deliberately corrupt one row and confirm the audit catches it:

```bash
cd ~/projects/os
node -r dotenv/config -e "require('./server/db').pool.query(\"UPDATE contractor_profiles SET display_name='WRONG' WHERE user_id=(SELECT MIN(user_id) FROM contractor_profiles)\").then(()=>process.exit(0))"
node -r dotenv/config server/scripts/refreshDisplayNames.js --check   # expect FAIL, exit 1
node -r dotenv/config server/scripts/refreshDisplayNames.js           # repair
node -r dotenv/config server/scripts/refreshDisplayNames.js --check   # expect OK, exit 0
```

- [ ] **Step 4: Full server suite**

Run: `cd ~/projects/os && npm test`
Expected: PASS. Read any failure before touching it; several suites assert on staff names and a legitimately changed expectation is a fixture edit, not a helper edit.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/scripts/refreshDisplayNames.js
git commit -m "feat(staff-name): backfill + --check audit for display_name" -- server/scripts/refreshDisplayNames.js
```

- [ ] **Step 6: Hand off the manual list to Dallas**

These four rows are deliberately not touched by any script (spec §6). Report them with the script's actual output:

| user | value | what it needs |
|---|---|---|
| 205 | `TwistidTreets` | a conversation with Nevver Sayles, then a profile edit |
| 61 | `Miss Taylor` | a legal name on file (needed for money records too), then a real preferred name |
| 31 | `Nicholas or Nick ` | he picks one |
| 62 | `Adelle M. Reynolds` | duplicate of user 51, out of scope here |

---

## Post-implementation

Production deploy runs `initDb()` (schema) automatically. The backfill is a separate manual step:

```bash
# against production, after the deploy lands
node -r dotenv/config server/scripts/refreshDisplayNames.js
node -r dotenv/config server/scripts/refreshDisplayNames.js --check
```

Manual pass owed before this is called done: onboarding steps 4 and 5 on a fresh account watching the live preview, one staff-portal name edit, and a look at the Needs Attention strip after that edit.
