---
plan: staff-display-name
spec: docs/superpowers/specs/2026-07-26-staff-display-name-design.md
# ONE lane, deliberately. The first draft declared core/server/client lanes and
# four of thirteen tasks edited outside their own footprint: contractor.js and
# me.js are BOTH write paths (Task 5) and read/GET surfaces (Tasks 10, 12);
# contractorTipPage.js is both a write path (Task 5) and a read site (Task 7);
# PaydayProtocols.js is client work inside the server-side step-5 removal.
# Those overlaps are inherent to the change, the lanes were strictly serial
# anyway (client depended on server depended on core), so splitting bought zero
# parallelism and only manufactured footprint aborts.
lanes:
  - id: staff-display-name
    tasks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    footprint:
      - server/utils/staffDisplayName.js
      - server/utils/staffDisplayName.validate.js
      - server/utils/refreshDisplayName.js
      - server/utils/staffDisplayName*.test.js
      - server/utils/refreshDisplayName.test.js
      - server/utils/presenceStore.js
      - server/utils/beoHandlers.js
      - server/utils/staffShiftHandlers.js
      - server/utils/marketingHandlers.js
      - server/utils/globalSearch.js
      - server/utils/eventDetailsPayload.js
      - server/utils/outstandingDocuments.js
      - server/utils/contractorSeed.js
      - server/db/schema.sql
      - server/db/seedTestData.js
      - server/scripts/refreshDisplayNames.js
      - server/scripts/staffPaymentImport/importFromSheet.js
      - server/routes/**
      - client/src/utils/preferredName.js
      - client/src/utils/preferredName.test.js
      - client/src/pages/**
      - client/src/components/adminos/drawers/ShiftDrawer.js
      - client/src/index.css
    depends_on: []
    # database-review for the schema add + the backfill that mutates prod rows;
    # security-review for the new admin router and the public tip-page reads;
    # consistency-check because a 30-site column swap IS the cross-cutting
    # consistency invariant.
    review: [code-review, database-review, consistency-check, security-review]
    review_checkpoints:
      - after_task: 4
        agents: [database-review]
      - after_task: 9
        agents: [code-review, consistency-check]
      - after_task: 13
        agents: [security-review]
---

# Staff Display Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every staff member as their own preferred name plus a last initial ("Fareed S."), fix the onboarding copy that invited stage names, and give admin a no-gate notice when a preferred name is set or changed.

**Architecture:** One pure helper (`computeDisplayName`) feeds a maintained `contractor_profiles.display_name` column, refreshed explicitly at each write path. Read sites resolve `COALESCE(cp.display_name, cp.preferred_name, u.email)`; salutation sites keep reading `preferred_name` untouched, so the display-versus-salutation split becomes a column choice rather than a convention. A second column, `preferred_name_reviewed_at`, drives an informational Needs Attention item and is never consulted by any name read path.

**Tech Stack:** Node/Express, node-postgres, `node:test` + `node:assert/strict`, React 18 (CRA), no TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-26-staff-display-name-design.md`

> **This is a rewrite.** The first draft of this plan was reviewed by the `plan-fidelity` / `plan-decomposition` / `plan-feasibility` fleet and came back with 11 blockers. Places where a fact was verified against the codebase rather than assumed are marked **[verified]**. Do not "correct" those back toward what looks conventional.

## Global Constraints

- **The preferred name is authoritative.** The legal name contributes the last initial, plus one narrow fallback when the person gave us no preferred name at all (spec §4.1 step 4). It never displaces a name someone did give us: "Joey" renders "Joey K.", never "Joseph K."
- **No approval gate.** A name is live the moment it is typed. `display_name` must never read `preferred_name_reviewed_at`.
- **No heuristic** relating a preferred name to a legal name. No prefix, substring, or nickname inference anywhere in this plan.
- **No script rewrites a stored `preferred_name`.** Shortening is a display concern and lives only in `display_name`. The one exception is whitespace trimming in Task 4.
- **Reads are three-deep:** `COALESCE(cp.display_name, cp.preferred_name, u.email)`. The middle term is permanent, not rollout scaffolding: it means a write path someone adds later and forgets to wire degrades to a name without an initial rather than to a raw email address on a client-facing BEO.
- **No em dashes in any user-facing copy.** Use commas, periods, colons, or parentheticals.
- **[verified]** `ValidationError`'s first parameter is a `fieldErrors` OBJECT, not a message string (`server/utils/errors.js:12`). Always `new ValidationError({ preferred_name: '...' })`.
- **[verified]** `auth` and `adminOnly` are both named exports of `server/middleware/auth.js:140` (the export line moved when `requireOnboarded` and `clientAuth` joined the module on 8/03; this plan needs neither). There is no `server/middleware/roles.js`. `asyncHandler` is a default export of `server/middleware/asyncHandler`.
- **[verified]** JWT test tokens must be signed `{ userId, tokenVersion }`. `server/middleware/auth.js:41` reads `decoded.userId` and `:46` compares `decoded.tokenVersion` against `users.token_version`. A token signed `{ id, ... }` 401s with `USER_NOT_FOUND`.
- Schema DDL goes in `server/db/schema.sql`, applied idempotently at boot by `initDb()` (**[verified]** `server/db/index.js:197`). Use `ADD COLUMN IF NOT EXISTS`.
- Server tests share the dev database and run **one file at a time**: `node -r dotenv/config --test <file>`. The bare `npm test` script runs files in parallel and will produce spurious cross-suite failures.
- Client lint is verified only through `CI=true npx react-scripts build` from `client/`.
- **[verified]** No file this plan touches is at or over the 1000-line hard cap. Largest are `staffShiftActions.js` (929) and `staffPortal.js` (919), both soft-cap warnings only.
- Money paths: `paystubData.js:40` already resolves legal-name-first by design and must not change. Contracts and agreements already use `agreements.full_name` and must not change.

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

// Table-driven off REAL production pairs (spec §4.1). Every row was read out of
// the production contractor_profiles / agreements join on 2026-07-26.
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
  ['Billie Jean', 'Billie Jean Barrone', 'Billie Jean B.', 'two-word given name kept whole: surname-only match'],
  ['Mark Holt', 'Mark', 'Mark H.', 'single-token agreement: initial off the preferred name'],
  ['Ariel  D. Smith', 'Ariel Smith', 'Ariel S.', 'surname and middle initial both dropped'],
  ['Adelle M. Reynolds', null, 'Adelle R.', 'no legal name: initial off preferred, middle initial dropped'],
  ['veronica martinez', 'veronica martinez', 'Veronica M.', 'all-lowercase token gets capitalized'],
  ['Jasmine Jeff', 'Jasmine jeff', 'Jasmine J.', 'surname match is case-insensitive'],
  ['Zul', 'Zul', 'Zul', 'single-token everything: no initial, no invention'],
  ['Dallas', null, 'Dallas', 'no legal name and one token: bare'],
  // Empty preferred name falls back to the legal FIRST name (spec §4.1 step 4).
  // This is what keeps the event-details roster (eventDetailsPayload.js)
  // behavior-preserving and keeps an email local-part off a client-facing BEO. It is NOT the rejected legal-name fallback: there
  // is no preferred name here to displace.
  [null, 'Nevver Sayles', 'Nevver S.', 'no preferred name: legal first name plus initial'],
  ['', 'Joseph Key', 'Joseph K.', 'blank preferred name behaves the same as null'],
  [null, 'Zul', 'Zul', 'no preferred name, single-token legal'],
  [null, null, null, 'nothing at all: caller keeps its email fallback'],
];

for (const [preferredName, legalFullName, expected, why] of CASES) {
  test(`computeDisplayName: ${JSON.stringify(preferredName)} + ${JSON.stringify(legalFullName)} -> ${expected} (${why})`, () => {
    assert.equal(computeDisplayName({ preferredName, legalFullName }), expected);
  });
}

test('no arguments at all returns null rather than throwing', () => {
  assert.equal(computeDisplayName(), null);
  assert.equal(computeDisplayName({}), null);
  assert.equal(computeDisplayName({ preferredName: '   ', legalFullName: '  ' }), null);
});

// GUARD (spec §2, §7). Scoped to the preferred-name-PRESENT case, because the
// empty case falls back to the legal first name on purpose. If this fails,
// someone reintroduced legal-name displacement and Joey is about to be called
// Joseph on a roster.
test('when a preferred name exists, the legal name reaches the output only as one initial', () => {
  const out = computeDisplayName({ preferredName: 'Joey', legalFullName: 'Joseph Key' });
  assert.equal(out, 'Joey K.');
  assert.ok(!out.includes('Joseph'));
  assert.ok(!out.includes('Key'));
});

// The first draft of this helper failed exactly this case: fixCase promoted the
// connector and produced "Nicholas Or Nick D."
test('connector words are not capitalized by the lowercase repair', () => {
  assert.equal(
    computeDisplayName({ preferredName: 'Nicholas or Nick', legalFullName: 'Nicholas George DiCristina' }),
    'Nicholas or Nick D.'
  );
});

// Documented garbage-in behavior. These rows are hand-fixed by a human
// (spec §6); the helper is not expected to rescue them.
test('malformed stored values render predictably rather than being rescued', () => {
  assert.equal(computeDisplayName({ preferredName: 'TwistidTreets', legalFullName: 'Nevver Sayles' }), 'TwistidTreets S.');
  assert.equal(computeDisplayName({ preferredName: 'Miss Taylor', legalFullName: null }), 'Miss T.');
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
// THE RULE (spec §2): the preferred name is authoritative. The legal name
// supplies the last initial, plus one narrow fallback when the person gave us
// NO preferred name at all (better "Nevver S." than "nsayles@gmail.com" on a
// client-facing BEO). It never displaces a name someone did give us: a person
// who says "Joey" is "Joey K." forever, never "Joseph". There is deliberately
// no heuristic relating the two names.

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

// Capitalize a token only when it is at least 3 characters AND entirely
// lowercase. The length floor exists so the connector in "Nicholas or Nick"
// does not become "Or". Mixed case is never touched, because LaToya, McKenna
// and d'Angelo are correct as typed. This is a two-line repair for the one
// all-lowercase row on production (`veronica martinez`), NOT a title-caser.
// Known imperfection: lowercase name particles (van, del, mac) are 3 chars and
// would be promoted. The escape hatch is that typing mixed case wins.
function fixCase(tok) {
  if (tok.length < 3) return tok;
  if (tok !== tok.toLowerCase()) return tok;
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

function computeDisplayName({ preferredName, legalFullName } = {}) {
  const pref = tokens(preferredName);
  const legal = tokens(legalFullName);
  if (pref.length === 0 && legal.length === 0) return null;

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

  let short;
  if (pref.length === 0) {
    // No preferred name at all: legal first name. Nothing is being displaced.
    short = [legal[0]];
  } else if (initialSource === 'legal') {
    // Drop a trailing token ONLY when it repeats the legal SURNAME. Matching
    // against every legal token would eat the "Jean" in "Billie Jean", whose
    // legal name is "Billie Jean Barrone", and a two-part given name is exactly
    // what she asked to be called.
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
Expected: PASS, all 24 assertions. This exact implementation was run against this exact table before the plan was written; a failure here means the code was transcribed wrong, not that the table is wrong.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/utils/staffDisplayName.js server/utils/staffDisplayName.test.js
git commit -m "feat(staff-name): computeDisplayName helper (preferred name + last initial)" -- server/utils/staffDisplayName.js server/utils/staffDisplayName.test.js
```

---

### Task 2: Preferred-name validation, with grandfathering

**Files:**
- Create: `server/utils/staffDisplayName.validate.js`
- Test: `server/utils/staffDisplayName.validate.test.js`

**Interfaces:**
- Consumes: `TITLES` from `server/utils/staffDisplayName.js` (Task 1).
- Produces: `validatePreferredName(raw) -> { valid: true, value: string } | { valid: false, error: string }` and `validatePreferredNameChange(submitted, stored) -> same shape`. Tasks 5, 6, 10 and 11 call these.

- [ ] **Step 1: Write the failing test**

Create `server/utils/staffDisplayName.validate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePreferredName, validatePreferredNameChange } = require('./staffDisplayName.validate');

// Real names MUST pass. Rejecting someone's actual name to catch a handle is a
// bad trade (spec §3.4), so this is the higher-priority half of the suite.
const ACCEPTED = [
  'McKenna', 'DeShawn', 'LaToya', "O'Brien", 'Mary-Kate', 'D.J.', 'DJ',
  'Chip', 'Shea', 'Fareed', 'Alexis', 'Jo', 'Billie Jean', 'Tashea Coates',
  // Documented: a well-formed handle passes every mechanical check and always
  // will. The copy prevents it, not this function (spec §9).
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
  ['Abcdefghijklmnopqrstuvwxyzabcd', 'thirty characters, over the 20 cap'],
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
    assert.ok(!validatePreferredName(name).error.includes('—'));
  }
});

// GRANDFATHERING (spec §3.4). Without this, the staffer stored as
// "Nicholas or Nick" opens his profile, the field pre-fills with the value we
// accepted years ago, and he is locked out of saving his own phone number.
test('an unchanged legacy value passes even though it would fail as a new entry', () => {
  assert.equal(validatePreferredName('Nicholas or Nick').valid, false);
  assert.equal(validatePreferredNameChange('Nicholas or Nick', 'Nicholas or Nick').valid, true);
  assert.equal(validatePreferredNameChange('Miss Taylor', 'Miss Taylor').valid, true);
});

test('grandfathering tolerates whitespace drift but not a real edit', () => {
  assert.equal(validatePreferredNameChange('  Nicholas or Nick ', 'Nicholas or Nick').valid, true);
  assert.equal(validatePreferredNameChange('Nicholas or Nicky', 'Nicholas or Nick').valid, false);
});

test('grandfathering does not let a blank stored value wave through new junk', () => {
  assert.equal(validatePreferredNameChange('Bar2Go', null).valid, false);
  assert.equal(validatePreferredNameChange('', '').valid, false);
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

function norm(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}

function validatePreferredName(raw) {
  const t = norm(raw);
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

/**
 * Validate a name that is CHANGING. An unchanged value always passes, however
 * malformed, so nobody is locked out of editing their own phone number by a
 * legacy name they cannot fix through the form (spec §3.4 grandfathering).
 * Every write path uses this, not validatePreferredName directly.
 */
function validatePreferredNameChange(submitted, stored) {
  const s = norm(submitted);
  const prev = norm(stored);
  if (prev !== '' && s === prev) return { valid: true, value: prev };
  return validatePreferredName(submitted);
}

module.exports = { validatePreferredName, validatePreferredNameChange, MIN_LEN, MAX_LEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node --test server/utils/staffDisplayName.validate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/utils/staffDisplayName.validate.js server/utils/staffDisplayName.validate.test.js
git commit -m "feat(staff-name): narrow format validation with grandfathering for legacy names" -- server/utils/staffDisplayName.validate.js server/utils/staffDisplayName.validate.test.js
```

---

### Task 3: Schema columns and the refresh function

**Files:**
- Modify: `server/db/schema.sql` (**[verified 2026-08-04]** the `contractor_profiles` CREATE TABLE now ends at line 95, and an existing `ALTER TABLE contractor_profiles` block follows it through the `hourly_rate` ALTER at :108 — the `onboarding_drafts` table landed above it on 8/03. Append after that ALTER block, alongside the other idempotent column adds)
- Create: `server/utils/refreshDisplayName.js`
- Test: `server/utils/refreshDisplayName.test.js`

**Interfaces:**
- Consumes: `computeDisplayName` from Task 1.
- Produces: `refreshDisplayName(userId, client, opts) -> Promise<string|null>`, where `client` defaults to the shared pool and `opts` may carry `previousPreferredName`. Tasks 4, 5, 6 and 13 call this.

- [ ] **Step 1: Add the columns to schema.sql**

In `server/db/schema.sql`, after the existing `ALTER TABLE contractor_profiles` block (the `hourly_rate` ALTER at :108 is its last line), add:

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

- [ ] **Step 2: Apply the schema to the dev database**

The dev server applies `schema.sql` at boot via `initDb()`. Restart it (it is a Claude-managed background process and does **not** auto-reload), or apply the two statements directly. Then confirm:

```bash
cd ~/projects/os
node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='contractor_profiles' AND column_name IN ('display_name','preferred_name_reviewed_at') ORDER BY 1\").then(r=>{console.log(r.rows);process.exit(r.rowCount===2?0:1)})"
```

Expected: both column names printed, exit 0.

- [ ] **Step 3: Write the failing test**

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
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Joey']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Joseph Key', EMAIL]);
});

after(async () => {
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('writes preferred name plus legal last initial', async () => {
  assert.equal(await refreshDisplayName(userId), 'Joey K.');
  const { rows } = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].display_name, 'Joey K.');
});

test('is idempotent', async () => {
  await refreshDisplayName(userId);
  assert.equal(await refreshDisplayName(userId), await refreshDisplayName(userId));
});

test('prefers the signed agreement over the application for the surname', async () => {
  // positions_interested is NOT NULL with no default (schema.sql); omitting it
  // is a 23502 before the assertion ever runs.
  await pool.query(
    `INSERT INTO applications (user_id, full_name, phone, city, state, travel_distance, reliable_transportation, positions_interested)
     VALUES ($1, 'Joseph Wrongsurname', '3125550100', 'Chicago', 'IL', '25', 'yes', '["Bartender"]')`,
    [userId]
  );
  assert.equal(await refreshDisplayName(userId), 'Joey K.');
});

test('clears the review stamp when the preferred name changed value', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Joe' WHERE user_id = $1", [userId]);
  await refreshDisplayName(userId, pool, { previousPreferredName: 'Joey' });
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name_reviewed_at, null);
});

test('leaves the review stamp alone when the preferred name did not change', async () => {
  // An admin editing a phone number, or an agreement landing and changing only
  // the initial, must not re-raise a notice about a name nobody touched.
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NOW() WHERE user_id = $1', [userId]);
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
  assert.equal(await refreshDisplayName(userId), unreviewed);
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

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/refreshDisplayName.test.js`
Expected: FAIL with `Cannot find module './refreshDisplayName'`

- [ ] **Step 5: Write the implementation**

Create `server/utils/refreshDisplayName.js`:

```js
'use strict';

// Recompute and persist contractor_profiles.display_name for one user.
// Spec §4.2. Called explicitly from every write path that can change a
// preferred name or a legal name; there is deliberately no database trigger,
// because payroll reads this table and invisible behavior there is worse than
// a stale cosmetic string. `server/scripts/refreshDisplayNames.js --check` is
// the safety net for a write path someone adds later and forgets to wire up.

const { pool } = require('../db');
const { computeDisplayName } = require('./staffDisplayName');

// Legal-name precedence matches paystubData.js:40 and accountReads.js:78:
// the signed agreement wins, then the application. Both tables have a UNIQUE
// user_id, so neither LEFT JOIN can fan out.
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
 * @param {object} [client] pg client or pool; pass the transaction client when inside one
 * @param {object} [opts]
 * @param {string|null} [opts.previousPreferredName] when supplied AND different from the
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

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/utils/refreshDisplayName.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
git add server/db/schema.sql server/utils/refreshDisplayName.js server/utils/refreshDisplayName.test.js
git commit -m "feat(staff-name): display_name + preferred_name_reviewed_at columns and refresh fn" -- server/db/schema.sql server/utils/refreshDisplayName.js server/utils/refreshDisplayName.test.js
```

---

### Task 4: Backfill script and audit mode

Moved ahead of every read swap. The three-deep COALESCE means an unpopulated column degrades to the preferred name rather than an email, but populating first means the read swaps are a true no-op on day one and any diff you see is a real bug.

**Files:**
- Create: `server/scripts/refreshDisplayNames.js`

**Interfaces:**
- Consumes: `computeDisplayName` (Task 1), `validatePreferredName` (Task 2). Writes both columns directly rather than going through `refreshDisplayName`, because the backfill needs the whitespace trim, the one-time review stamp, and the report in a single pass.
- Produces: a re-runnable `--check` audit that Task 14 and every future change relies on.

- [ ] **Step 1: Write the script**

Create `server/scripts/refreshDisplayNames.js`:

```js
'use strict';

// Backfill and audit for contractor_profiles.display_name. Spec §6, §7.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js --stamp-existing
//        first run only: populate display_name AND mark every existing row as
//        already reviewed, so the §3.5 notice queue opens empty instead of with
//        one notice per staffer who has been fine all year.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js
//        ordinary re-run: populate display_name, touch NO review stamps.
//
//   node -r dotenv/config server/scripts/refreshDisplayNames.js --check
//        audit only: exit non-zero if any stored display_name differs from a
//        fresh computation. The safety net for a write path someone adds later
//        and forgets to wire to refreshDisplayName().
//
// --stamp-existing is deliberately opt-in and NOT the default. If the default
// stamped, a routine post-go-live re-run would silently ack every pending
// notice, which is exactly the state the notice exists to prevent.
//
// This script NEVER rewrites a stored preferred_name beyond trimming
// whitespace. Shortening is a display concern and lives in display_name, so
// nobody's stored name is second-guessed by a script (spec §6).

require('dotenv').config();
const { pool } = require('../db');
const { computeDisplayName } = require('../utils/staffDisplayName');
const { validatePreferredName } = require('../utils/staffDisplayName.validate');

const CHECK_ONLY = process.argv.includes('--check');
const STAMP_EXISTING = process.argv.includes('--stamp-existing');

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

  let drift = 0, updated = 0, trimmed = 0, stamped = 0;
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

    if (STAMP_EXISTING) {
      await pool.query(
        `UPDATE contractor_profiles
            SET display_name = $1,
                preferred_name_reviewed_at = COALESCE(preferred_name_reviewed_at, NOW()),
                updated_at = NOW()
          WHERE user_id = $2`,
        [expected, r.user_id]
      );
      stamped++;
    } else {
      await pool.query(
        'UPDATE contractor_profiles SET display_name = $1, updated_at = NOW() WHERE user_id = $2',
        [expected, r.user_id]
      );
    }
    updated++;

    // Report only. A script does not get to decide what someone is called.
    const check = validatePreferredName(trimmedName);
    if (trimmedName && !check.valid) {
      needsHuman.push(`  user ${r.user_id}: ${JSON.stringify(trimmedName)} (${check.error}) -> renders ${JSON.stringify(expected)}`);
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

  console.log(`Backfilled ${updated} rows (${trimmed} whitespace fixes${STAMP_EXISTING ? `, ${stamped} marked reviewed` : ', review stamps untouched'}).`);
  if (needsHuman.length) console.log(`\nMalformed preferred names, fix by hand:\n${needsHuman.join('\n')}`);
  if (needsLegalName.length) console.log(`\nActive staff with no legal name on file:\n${needsLegalName.join('\n')}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the first-run backfill against dev**

Run: `cd ~/projects/os && node -r dotenv/config server/scripts/refreshDisplayNames.js --stamp-existing`
Expected: a row count with "marked reviewed", plus the two report sections. Read the malformed-names list; it is the §6 hand-fix list and should name the same four rows the spec does.

- [ ] **Step 3: Prove the audit catches drift**

```bash
cd ~/projects/os
node -r dotenv/config server/scripts/refreshDisplayNames.js --check          # expect OK, exit 0
node -r dotenv/config -e "require('./server/db').pool.query(\"UPDATE contractor_profiles SET display_name='WRONG' WHERE user_id=(SELECT MIN(user_id) FROM contractor_profiles)\").then(()=>process.exit(0))"
node -r dotenv/config server/scripts/refreshDisplayNames.js --check; echo "exit=$?"   # expect FAIL, exit=1
node -r dotenv/config server/scripts/refreshDisplayNames.js                  # repair
node -r dotenv/config server/scripts/refreshDisplayNames.js --check; echo "exit=$?"   # expect OK, exit=0
```

- [ ] **Step 4: Prove a plain re-run does not ack a pending notice**

```bash
cd ~/projects/os
node -r dotenv/config -e "require('./server/db').pool.query(\"UPDATE contractor_profiles SET preferred_name_reviewed_at=NULL WHERE user_id=(SELECT MIN(user_id) FROM contractor_profiles)\").then(()=>process.exit(0))"
node -r dotenv/config server/scripts/refreshDisplayNames.js
node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT COUNT(*)::int AS n FROM contractor_profiles WHERE preferred_name_reviewed_at IS NULL\").then(r=>{console.log(r.rows[0]);process.exit(r.rows[0].n>=1?0:1)})"
```

Expected: `{ n: 1 }` or more, exit 0. The pending row survives the re-run.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/scripts/refreshDisplayNames.js
git commit -m "feat(staff-name): backfill with opt-in review stamp and --check audit" -- server/scripts/refreshDisplayNames.js
```

---

### Task 5: Wire validation and refresh into all six write paths

**Files:**
- Modify: `server/routes/contractor.js` (POST `/`: `fieldErrors` block at **[verified 2026-08-04]** `:86-91`, UPDATE params at `:162`, INSERT params at `:183` — the onboarding-upload lanes grew the file by ~9 lines; the body/param shapes are unchanged and `equipment_will_pickup` is already threaded)
- Modify: `server/routes/me.js` (PATCH `/tip-page`, `:147-173`)
- Modify: `server/routes/staffPortal.js` (PATCH `/profile`, `:261`)
- Modify: `server/routes/admin/users.js` (PUT `/users/:id/profile` at `:302`, upsert at **[verified 2026-08-04]** `:334-359`, params from `:350`; hire path at `:158-199` — see Step 7, it needs NO edit here anymore)
- Modify: `server/routes/admin/contractorTipPage.js` (**[verified]** `:60-65`, the admin override the first draft of the spec missed entirely)
- Modify: `server/scripts/staffPaymentImport/importFromSheet.js:294` (spec §4.2; missing from the first draft of this plan)
- Modify: `server/routes/agreement.js` (POST `/`, after the agreements upsert commits)
- Modify: `server/utils/contractorSeed.js` (**[verified 2026-08-04]** the upsert spans `:17-94`; the 8/03 submit-gate-relax lane added per-column COALESCE arms that preserve documents, none of which touch `preferred_name`)
- Modify: `server/db/seedTestData.js` (`:59`, `:97`)
- Test: `server/routes/staffPortal.displayName.test.js`

**Interfaces:**
- Consumes: `refreshDisplayName` (Task 3), `validatePreferredNameChange` (Task 2).
- Produces: nothing new. Every path that writes a preferred name leaves `display_name` correct.

**Note on `contractorSeed.js`:** **[verified]** it seeds `preferred_name = a.full_name` (`:31`, still exact). That is *why* 25 production rows hold a full name. It stays as-is; the shortening rule renders `Tashea Coates` as `Tashea C.` and step 4 lets people change it. **[2026-08-04]** it now has THREE callers, all passing their own transaction client: the admin Hire path (`admin/users.js:183`), the pre-hired application submit (`application.js:245`), and the register-with-application path (`auth.js:229`). The single internal refresh added in Step 9 covers all three, which is exactly why the refresh lives inside this helper and nowhere else.

- [ ] **Step 1: Write the failing test**

Create `server/routes/staffPortal.displayName.test.js`. **This is the canonical harness for this plan; Tasks 6, 9 and 13 copy it.** Note the JWT shape.

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
  // token_version is RETURNed and signed into the JWT: middleware/auth.js:46
  // compares decoded.tokenVersion against users.token_version, and :41 looks the
  // user up by decoded.userId. A token signed { id, ... } 401s USER_NOT_FOUND.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, 'x', 'staff', 'approved', 0) RETURNING id, token_version`,
    [EMAIL]
  );
  userId = u.rows[0].id;
  token = jwt.sign(
    { userId, tokenVersion: u.rows[0].token_version },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  await pool.query('INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Joey']);
  await pool.query('INSERT INTO agreements (user_id, full_name, email) VALUES ($1, $2, $3)', [userId, 'Joseph Key', EMAIL]);

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

test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { phone: '3125550100' });
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
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
  const res = await req('PATCH', '/api/staff-portal/profile', { phone: '3125550101' });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('SELECT preferred_name_reviewed_at FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.notEqual(rows[0].preferred_name_reviewed_at, null);
});

test('rejects a titled name with a field error and leaves the stored name alone', async () => {
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Miss Taylor' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors?.preferred_name);
  const { rows } = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(rows[0].preferred_name, 'Joey');
});

test('rejects a three-word name', async () => {
  assert.equal((await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Nicholas or Nick' })).status, 400);
});

// GRANDFATHERING (spec §3.4): a legacy value must not lock its owner out.
test('re-submitting an unchanged legacy name is accepted', async () => {
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Nicholas or Nick' WHERE user_id = $1", [userId]);
  const res = await req('PATCH', '/api/staff-portal/profile', { preferred_name: 'Nicholas or Nick', phone: '3125550102' });
  assert.equal(res.status, 200, `legacy name locked its owner out: ${JSON.stringify(res.body)}`);
  await pool.query("UPDATE contractor_profiles SET preferred_name = 'Joey' WHERE user_id = $1", [userId]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/staffPortal.displayName.test.js`
Expected: the auth guard test PASSES (proving the harness is sound), the refresh and rejection tests FAIL.

If the auth guard test fails with 401, stop: the JWT shape is wrong and every later route test in this plan will fail the same way.

- [ ] **Step 3: Wire `staffPortal.js`**

Add the imports at the top of `server/routes/staffPortal.js`:

```js
const { refreshDisplayName } = require('../utils/refreshDisplayName');
const { validatePreferredNameChange } = require('../utils/staffDisplayName.validate');
```

Inside the PATCH `/profile` handler, after the allowlist loop and before `updates` is built, read the previous value:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;
```

Replace line 261:

```js
  if ('preferred_name' in body) updates.preferred_name = trimOrNull(body.preferred_name);
```

with:

```js
  if ('preferred_name' in body) {
    // validatePreferredNameChange, NOT validatePreferredName: an unchanged
    // legacy value always passes, so nobody is locked out of editing their own
    // address by a name they cannot fix through the form (spec §3.4).
    const check = validatePreferredNameChange(body.preferred_name, prevPreferredName);
    if (!check.valid) throw new ValidationError({ preferred_name: check.error });
    updates.preferred_name = check.value;
  }
```

After the UPDATE runs and before the response is sent:

```js
  // Display name is derived, so it is recomputed on every profile write.
  // previousPreferredName is passed ONLY when the caller sent a preferred_name,
  // so a phone-only edit cannot re-raise the §3.5 notice.
  if ('preferred_name' in updates) {
    await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
  } else {
    await refreshDisplayName(req.user.id);
  }
```

- [ ] **Step 4: Run the test to verify staffPortal passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/staffPortal.displayName.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Wire `contractor.js` (step 4 save)**

Add the same two imports. Before the transaction opens, read the previous value:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;
```

In the `fieldErrors` block (**[verified 2026-08-04]** `:86-91`, where `validatePhone` already runs), alongside the existing phone checks:

```js
  const nameCheck = validatePreferredNameChange(preferred_name, prevPreferredName);
  if (!nameCheck.valid) fieldErrors.preferred_name = nameCheck.error;
```

Blank gets a hard 400 here, and that is **intentional and different from the admin paths**. This is the staff-facing step 4 form where the name is a required field (it already carried a `*` and a required rule); "Tell us what to call you." is the correct response to an empty submit. The blank-is-legal carve-out exists only for admins editing someone else's skeleton profile.

Use `nameCheck.value` in place of `preferred_name` in **both** parameter arrays: the UPDATE at `:162` and the INSERT at `:183` (cites current at 2026-08-04; match on the arrays that open with `[preferred_name, phoneCheck.value, ...]` / `[req.user.id, preferred_name, ...]`). After `COMMIT` and after `client.release()` (**[verified]** the handler releases in a `finally` at `:205-207`, so a pool-based call in the tail is safe):

```js
  await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
```

- [ ] **Step 6: Wire `me.js` (staff tip-page PATCH)**

Add the same two imports. Before the `preferred_name` handling at `:147`:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [req.user.id]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;
```

**[verified]** the existing block is lines **147-151** (the closing `}` is on 151), not 147-150. Replace this exact text:

```js
  if ('preferred_name' in updates) {
    const t = String(updates.preferred_name || '').trim();
    if (!t) throw new ValidationError('preferred_name cannot be blank');
    updates.preferred_name = t;
  }
```

with:

```js
  if ('preferred_name' in updates) {
    const check = validatePreferredNameChange(updates.preferred_name, prevPreferredName);
    // ValidationError's FIRST argument is a fieldErrors object, not a message
    // string (server/utils/errors.js:12). The existing line here passes a bare
    // string, which lands in the fieldErrors slot; do not copy that pattern.
    if (!check.valid) throw new ValidationError({ preferred_name: check.error });
    updates.preferred_name = check.value;
  }
```

After the `UPDATE contractor_profiles` at `:169-172`:

```js
    await refreshDisplayName(req.user.id, pool, { previousPreferredName: prevPreferredName });
```

- [ ] **Step 7: Wire `admin/users.js`**

Add the same two imports. In PUT `/users/:id/profile` at `:302`, after the destructuring:

```js
  const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;

  // Blank stays legal on the admin path (spec §3.4). preferred_name is optional
  // here today, and an admin editing a skeleton profile (hired directly, no
  // application, no name yet) must not get a 400 for a field they never touched.
  if (String(preferred_name || '').trim() !== '') {
    const nameCheck = validatePreferredNameChange(preferred_name, prevPreferredName);
    if (!nameCheck.valid) throw new ValidationError({ preferred_name: nameCheck.error });
  }
```

Use the validated value in the upsert parameter array at `:350-359`. After the upsert:

```js
  await refreshDisplayName(userId, pool, { previousPreferredName: prevPreferredName });
```

**Do NOT edit the hire path** (`:158-199`, the `status === 'hired'` block in PUT `/users/:id/status`). **[verified 2026-08-04]** it seeds through `seedContractorProfileFromApplication(client, ...)` (`:183`), and Step 9 puts the refresh INSIDE that helper, so this route inherits it. The first draft of this step said "check which applies"; the answer is now settled on main, and adding a second call here would just re-run the same UPDATE. (The direct-hire else-branch inserts only `hire_date`, no name, so it needs no refresh either.)

- [ ] **Step 8: Wire `admin/contractorTipPage.js` (the missed fourth path)**

Add the same two imports. **[verified]** the block is lines **60-65**, not 60-63: `:64` is the closing `);` of the query call and `:65` is the closing `}` of the `if`. The first draft of this plan cited 60-63 and marked it verified, which would have left a dangling `);` and `}` and broken the parse. Match on the text, not the range. Replace:

```js
  if ('preferred_name' in req.body) {
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [String(req.body.preferred_name || '').trim() || null, userId]
    );
  }
```

with:

```js
  if ('preferred_name' in req.body) {
    const prevRow = await pool.query('SELECT preferred_name FROM contractor_profiles WHERE user_id = $1', [userId]);
    const prevPreferredName = prevRow.rows[0]?.preferred_name ?? null;
    // Blank stays legal on the admin path, same as admin/users.js. `nextName`
    // is declared OUTSIDE the guard so the validated, whitespace-normalized
    // value is what reaches the column, not the raw body string.
    let nextName = String(req.body.preferred_name || '').trim() || null;
    if (nextName !== null) {
      const check = validatePreferredNameChange(req.body.preferred_name, prevPreferredName);
      if (!check.valid) throw new ValidationError({ preferred_name: check.error });
      nextName = check.value;
    }
    await pool.query(
      'UPDATE contractor_profiles SET preferred_name = $1, updated_at = NOW() WHERE user_id = $2',
      [nextName, userId]
    );
    await refreshDisplayName(userId, pool, { previousPreferredName: prevPreferredName });
  }
```

Confirm `ValidationError` is imported in this file; add it from `../../utils/errors` if not.

Apply the same `nextName` shape in Step 7's `admin/users.js` edit: declare the validated value outside the non-empty guard so the normalized string, not the raw body value, lands in the upsert parameter array.

- [ ] **Step 9: Wire `agreement.js` and the seeds**

`server/routes/agreement.js`, in POST `/` after the agreements upsert commits and the client is released:

```js
  // Signing supplies the legal name, which can change the last initial.
  // NO previousPreferredName: this cannot have changed the preferred name, so
  // it must not re-raise a §3.5 notice.
  await refreshDisplayName(req.user.id);
```

`server/utils/contractorSeed.js`, after the upsert at `:17-78`, using the caller's transaction client:

```js
  await refreshDisplayName(userId, client);
```

`server/db/seedTestData.js`, after each of the two `contractor_profiles` INSERTs (`:59`, `:97`), call `refreshDisplayName(<userId>, client)`. Without this, every route test that asserts on a staff name sees a NULL `display_name`.

`server/scripts/staffPaymentImport/importFromSheet.js:294` creates profiles during a sheet import (`INSERT INTO contractor_profiles (user_id, preferred_name, phone, email)`). It is named in spec §4.2 and was missing from the first draft of this plan entirely. Add the refresh after that INSERT:

```js
          await refreshDisplayName(userId, client);
```

using whatever client that script already holds. Without it, imported staff land with a NULL `display_name` and render by bare preferred name until someone re-runs the backfill.

**One call, in `contractorSeed.js`.** With the refresh inside the helper, all three of its callers (admin Hire, pre-hired application submit at `application.js:245`, register-with-application at `auth.js:229`) are covered without touching those routes. Do not add a second call in any of them; Step 7 already says why for `admin/users.js`.

- [ ] **Step 10: Run every suite these files reach**

One at a time (the suites share the dev database):

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/staffPortal.displayName.test.js
node -r dotenv/config --test server/routes/staffPortal.test.js
node -r dotenv/config --test server/routes/auth.preferredName.test.js
node -r dotenv/config --test server/routes/staffPortal/accountReads.test.js
node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js
node -r dotenv/config --test server/routes/admin/users.managerScrub.test.js
node -r dotenv/config --test server/routes/admin/users.stubCoParticipated.test.js
node -r dotenv/config --test server/routes/admin/users.tipsGate.test.js
```

Expected: PASS. Any failure here is a real regression; read it before adjusting anything.

- [ ] **Step 11: Commit**

```bash
cd ~/projects/os
git add server/routes/contractor.js server/routes/me.js server/routes/staffPortal.js server/routes/admin/users.js server/routes/admin/contractorTipPage.js server/routes/agreement.js server/utils/contractorSeed.js server/db/seedTestData.js server/scripts/staffPaymentImport/importFromSheet.js server/routes/staffPortal.displayName.test.js
git commit -m "feat(staff-name): validate and refresh display_name on all six write paths" -- server/routes/contractor.js server/routes/me.js server/routes/staffPortal.js server/routes/admin/users.js server/routes/admin/contractorTipPage.js server/routes/agreement.js server/utils/contractorSeed.js server/db/seedTestData.js server/scripts/staffPaymentImport/importFromSheet.js server/routes/staffPortal.displayName.test.js
```

---

### Task 6: Stop step 5 from asking for a name

The highest-value change in the plan. It deletes the copy that produced `TwistidTreets` and stops Payday Protocols from silently overwriting the step 4 answer.

**Files:**
- Modify: `server/routes/payment.js` (**[verified 2026-08-04]** the `preferred_name` write is at `:181-188`, and the tip-link `displayName` is at `:243`)
- Modify: `client/src/pages/PaydayProtocols.js` (`:76`, `:102`, `:152`, `:183`, `:418-423`, `:425-437` — all still exact)
- Test: `server/routes/payment.noNameWrite.test.js`

**[verified] DANGER:** the first draft of this plan cited `payment.js:161-168` for the name write. **The `if (promotedRows === 0)` onboarding-promotion Sentry telemetry block now spans `:162-175`** (the 7/26 onboarding-gate lane rewrote it around `promoteOnboardingIfEligible`). Deleting it would silently remove the breadcrumb that finds a staffer stuck mid-onboarding. Verify you are looking at the `// Persist preferred_name on contractor_profiles` comment before deleting anything.

**[verified 2026-08-04] the route enforces a W-9 server-side** (`payment.js:112-114`: no `req.files.w9` and no stored `w9_file_url` means a 400 `{ w9: 'A signed W-9 is required.' }` before the name logic is ever reached). The harness below must seed a reusable W-9 or the 200 assertion can never pass.

- [ ] **Step 1: Write the failing test**

Create `server/routes/payment.noNameWrite.test.js`. Copy the harness from Task 5 Step 1 verbatim (the `req` helper, the `before`/`after` bodies including the `token_version` RETURNING and the `{ userId, tokenVersion }` signing), changing exactly these lines:

- `const EMAIL = \`pay-nn-${NONCE}@example.com\`;`
- the profile seed: `'INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)', [userId, 'Fareed']`
- the agreement seed: `[userId, 'Mohammad F Shafiuddin', EMAIL]`
- the mount: `app.use('/api/payment', require('./payment'));`
- add after the seeds: `await require('../utils/refreshDisplayName').refreshDisplayName(userId);`
- add after that a W-9 seed, or every POST 400s at the server-side W-9 gate (`payment.js:112-114`) before the name logic runs; `payment_profiles.user_id` cascades on user delete, so teardown needs nothing extra:

```js
await pool.query(
  `INSERT INTO payment_profiles (user_id, w9_file_url, w9_filename)
   VALUES ($1, '/files/test-w9.pdf', 'w9.pdf')`,
  [userId]
);
```

Then the tests:

```js
test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('POST', '/api/payment', { preferred_payment_method: 'check' });
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
});

test('POST /api/payment ignores a preferred_name in the body', async () => {
  const res = await req('POST', '/api/payment', {
    preferred_name: 'LumpyIceCream',
    preferred_payment_method: 'venmo',
    venmo_handle: '@test-handle',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
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
Expected: the auth guard PASSES; the name test FAILS with `preferred_name` now `'LumpyIceCream'`.

- [ ] **Step 3: Remove the server-side write**

In `server/routes/payment.js`, delete the block at `:181-188`:

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

Replace it with a comment so nobody re-adds it:

```js
      // NO name write here. Payday Protocols used to ask for the preferred name
      // a second time, with copy inviting a stage name, and overwrote step 4's
      // answer. The field is gone from the client and the write is gone from
      // here. Step 4 (routes/contractor.js) is the only name entry point.
      // Spec §3.3.
```

Remove `preferred_name` from the destructuring of `req.body` (`:57`, inside the handler after the method check).

At `:243`, replace `displayName: req.body.preferred_name` with a read from the profile. **[verified]** the transaction client is released (`:229`) before this tail runs, so `pool.query` here is correct and not a pool deadlock:

```js
      const { rows: dnRows } = await pool.query(
        'SELECT display_name, preferred_name FROM contractor_profiles WHERE user_id = $1',
        [req.user.id]
      );
      const { url, id: linkId } = await createTipPaymentLink({
        userId: req.user.id,
        displayName: dnRows[0]?.display_name || dnRows[0]?.preferred_name || null,
        token,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/payment.noNameWrite.test.js`
Expected: PASS

- [ ] **Step 5: Replace the client field with a read-only line**

In `client/src/pages/PaydayProtocols.js`:

Remove `preferred_name: ''` from the form state at `:76`, the hydration at `:102`, the validation rule at `:152`, and the `data.append('preferred_name', ...)` at `:183`.

Add the display state and hydrate it in the same `.then(prof => ...)` that already runs at `:102`:

```js
  const [displayName, setDisplayName] = useState('');
  // ...inside the existing profile-fetch .then:
  setDisplayName(prof.display_name || prof.preferred_name || '');
```

Replace the `form-group` block at `:425-437` with:

```jsx
<div className="form-group">
  <div className="meta-k" style={{ marginBottom: 4 }}>Your tip page</div>
  <p className="form-helper" style={{ marginTop: 0 }}>
    Your tip page will read <strong>{displayName || 'your name'}</strong>.{' '}
    <Link to="/contractor-profile">Change this</Link>
  </p>
</div>
```

Import `Link` from `react-router-dom` if it is not already imported.

Update the intro paragraph at `:418-423` to drop "Your name is required":

```jsx
<p className="text-small text-muted" style={{ marginBottom: '1.25rem' }}>
  Your tip page lives at <strong>drbartender.com/tip/your-name</strong> with a
  QR you can print. The tip handles below are <strong>optional</strong>. Add
  them now, later from My Tip Page, or never. None of this is shared outside DRB.
</p>
```

`GET /api/contractor` returns `display_name` once Task 10 Step 4 widens all three of its return paths; until then this degrades to `preferred_name`, which is why the fallback is there.

- [ ] **Step 6: Verify the client builds, then walk step 5**

Run: `cd ~/projects/os/client && CI=true npx react-scripts build`
Expected: build succeeds with no lint errors. `CI=true` makes warnings fatal, which is what the pre-push hook gates on.

This step deletes a form field, removes a validation rule, and adds a new read-only line, so a build is not enough. On the dev server, as a test staffer who has completed step 4, open `/payday-protocols`:
- there is **no** name input anywhere on the page
- the tip-page block reads "Your tip page will read **Name L.**" with their actual display name
- "Change this" navigates to `/contractor-profile`
- the intro paragraph no longer says the name is required
- submitting the form with only a payment method still succeeds and completes onboarding
- afterwards, their `contractor_profiles.preferred_name` is unchanged from what step 4 saved

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
git add server/routes/payment.js client/src/pages/PaydayProtocols.js server/routes/payment.noNameWrite.test.js
git commit -m "fix(staff-name): step 5 stops asking for a name (this is where TwistidTreets came from)" -- server/routes/payment.js client/src/pages/PaydayProtocols.js server/routes/payment.noNameWrite.test.js
```

---

### Task 7: Server read-site swaps, non-money

**Files (all line numbers [verified] against main at 9141171a, 2026-08-04):**
- `server/routes/shifts.js:195,238,240,292,481`
- `server/routes/calendar.js:179`
- `server/routes/staffShiftActions.js:840`
- `server/routes/proposals/cancel.js:170`
- `server/routes/publicTip.js:83,227`
- `server/routes/admin/contractorTipPage.js:91,110,145,160,190,211,268,294`
- `server/routes/messages.js:20,34,37`
- `server/routes/adminCoverSwaps.js:81`
- `server/routes/staffPortal.js:99`
- `server/routes/admin/applications.js:164`
- `server/utils/presenceStore.js:12`
- `server/utils/beoHandlers.js:223`
- `server/utils/staffShiftHandlers.js:306,544`
- `server/utils/marketingHandlers.js:390`
- `server/utils/globalSearch.js:117,125`
- `server/utils/eventDetailsPayload.js:107` and `:238-271` (the 8/03 staff event-details revival moved beo.js's roster + `computeName` here; see Step 2)
- `server/routes/serviceExtensions/admin.js:74,75` (post-plan surface, shipped 8/03)
- `server/utils/outstandingDocuments.js:43` (post-plan surface, shipped 7/26 after this plan)

- [ ] **Step 1: Swap the SQL, per the table below**

**There is no single mechanical rewrite.** The first draft of this plan said "the mechanical form everywhere" and named two exceptions; there are in fact five distinct shapes, and applying the generic form to the wrong one either publishes an email address on a public page or produces a column the client never reads. **[verified]** every expression below was read out of the file at HEAD.

**Address by text, not by line number.** `admin/contractorTipPage.js` is edited by Task 5 before this task runs, so every line number in it has already shifted. Match on the quoted expression.

---

**Shape A. `COALESCE(cp.preferred_name, u.email)` -> prepend `cp.display_name`.**

| file | current expression |
|---|---|
| `shifts.js:195` | `COALESCE(cp.preferred_name, u.email) AS name` |
| `shifts.js:238,240` | `'name', COALESCE(cp.preferred_name, u.email)` and its `ORDER BY` |
| `shifts.js:292` | `COALESCE(cp.preferred_name, u.email) AS staff_name,` |
| `calendar.js:179` | `COALESCE(cp.preferred_name, u.email) AS name` |
| `staffShiftActions.js:840` | `COALESCE(cp.preferred_name, u.email) AS display_name` |
| `proposals/cancel.js:170` | `DISTINCT COALESCE(cp.preferred_name, u.email) AS name` |
| `eventDetailsPayload.js:107` | `COALESCE(cp.preferred_name, u.email) AS name,` |
| `serviceExtensions/admin.js:74` | `COALESCE(cp.preferred_name, u.email) AS requested_by_name,` |
| `serviceExtensions/admin.js:75` | `COALESCE(ovcp.preferred_name, ov.email) AS override_by_name` (aliases `ovcp`/`ov`; becomes `COALESCE(ovcp.display_name, ovcp.preferred_name, ov.email)`) |

Each becomes `COALESCE(cp.display_name, cp.preferred_name, u.email) AS <same alias>` (adjusting aliases on the `ovcp` row).

Three of these are **post-plan code this sweep now covers** (rev 3): `eventDetailsPayload.js:107` is the ack-list projection that used to be `beo.js:100` — its `name` today only drives the `ORDER BY` and the viewer checks (`:329` maps it out of the response), but it is swapped anyway so Task 14's reverse grep shows only its two documented exemptions. `serviceExtensions/admin.js:74-75` label who requested / who overrode a service extension in the admin `ServiceExtensionPanel` ("Requested by X", "Overridden by Y"), a pure display surface.

---

**Shape B. Bare `cp.preferred_name AS <alias>` with NO email term in the query -> two-deep only.**

| file | current expression |
|---|---|
| `publicTip.js:83` | `cp.preferred_name AS display_name,` |
| `publicTip.js:227` | `SELECT u.id AS user_id, cp.preferred_name AS display_name` |
| `staffPortal.js:99` | `cp.preferred_name AS requester_preferred_name,` |
| `admin/applications.js:164` | `cp.preferred_name AS actor_name` |
| `beoHandlers.js:223` | `cp.preferred_name AS staff_name,` |
| `staffShiftHandlers.js:306,544` | `cp.preferred_name AS staff_name, cp.phone AS staff_phone` |
| `marketingHandlers.js:390` | `cp.preferred_name AS bartender_name,` |
| `admin/contractorTipPage.js` | `cp.preferred_name AS bartender_name` (two occurrences) |

Each becomes `COALESCE(cp.display_name, cp.preferred_name) AS <same alias>`.

**`publicTip.js` is the reason this shape exists as its own rule.** **[verified]** both of its queries sit under an explicit "public-safe column allowlist" comment and have no `u.email` term. Adding one, as the generic three-deep form would, publishes a bartender's email address to anyone holding a public tip link. Two-deep, never three, on these two.

**`beoHandlers.js` and `staffShiftHandlers.js` belong here and not in the salutation list**, which is counterintuitive enough to be worth stating: their `staff_name` flows to `sendAndLogSms({ recipientName })`, which **[verified]** writes only to the `sms_messages.recipient_name` log column (`server/utils/sms.js:151` is the function, `:168` and `:179` the two INSERTs). The message `body` is composed separately and never uses it. This is a list-display label, so it takes the display name.

**`messages.js:71` + the four `POST /messages/send` INSERT sites are the same ruling** (added rev 3.2, from the checkpoint-2 review): the admin-broadcast recipient SELECT feeds `sms_messages.recipient_name` at all four INSERT tuples, identical in kind to the two handlers above. Rev 2/3 never listed the site and it was briefly misremembered as an exemption; checkpoint 2 established no such exemption is recorded and the line-above ruling governs. Converted as select-alongside (`cp.display_name` joins the SELECT; one `recipient.display_name || recipient.preferred_name` resolution feeds all four INSERTs). The only true exemptions remain `staffHiringEmailTemplates.js:290` and `exportKnownPeople.js:38`.

---

**Shape C. Bare `cp.preferred_name` with NO alias -> select `display_name` ALONGSIDE, do not replace.**

The client reads the JSON key `preferred_name` directly, so replacing the column renames the key and silently breaks the consumer.

| file | current expression | consumer |
|---|---|---|
| `messages.js:20` | `SELECT u.id AS user_id, cp.preferred_name, u.email, cp.phone, ag.sms_consent` | `AdminDashboard.js:632` |
| `adminCoverSwaps.js:81` | `cp.preferred_name, cp.phone, cp.position` | admin cover-swap UI |
| `shifts.js:481` | `SELECT sr.*, u.email, cp.preferred_name, cp.phone` | `AdminDashboard.js:486`, `ShiftDrawer.js:371,650,653` |

Each becomes `..., cp.preferred_name, cp.display_name, ...`. **The client-side halves of these three are Task 12**, not this task; they are listed here only so the pairing is visible.

---

**Shape D. A JS display expression fed by a SELECT above it -> change BOTH halves.**

In `admin/contractorTipPage.js`, three SELECTs feed three display expressions. Changing only the display half yields `undefined`.

| SELECT (add `cp.display_name`) | display expression | becomes |
|---|---|---|
| `SELECT pp.tip_page_token, pp.stripe_payment_link_id, cp.preferred_name` (first) | `displayName: row.preferred_name,` | `displayName: row.display_name \|\| row.preferred_name,` |
| same SELECT text (second occurrence) | `displayName: row.preferred_name,` | `displayName: row.display_name \|\| row.preferred_name,` |
| `SELECT pp.tip_page_token, pp.stripe_payment_link_url, cp.preferred_name` | `const displayName = (row && row.preferred_name) \|\| 'your bartender';` | `const displayName = (row && (row.display_name \|\| row.preferred_name)) \|\| 'your bartender';` |

---

**Shape E. Constants, custom chains, filters and sorts.**

`presenceStore.js:12` (**not** line 8) is a constant with an `INITCAP` fallback; preserve it:

```js
const NAME_SQL = "COALESCE(cp.display_name, cp.preferred_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";
```

`globalSearch.js:117` has its own chain; preserve the tail and prepend:

```sql
           COALESCE(cp.display_name, cp.preferred_name, a.full_name, u.email) AS name,
```

`outstandingDocuments.js:43` (post-plan, the needs-attention "X has no alcohol certification" rows and `/admin/hiring/uncertified`) has the same shape; prepend and preserve its tail:

```js
const DISPLAY_NAME = 'COALESCE(cp.display_name, cp.preferred_name, a.full_name, u.email)';
```

Search filters must match what the admin can see, or typing the name you are looking at fails to find it:
- `globalSearch.js:125`: add `OR LOWER(cp.display_name) LIKE $1 ESCAPE '\\'`
- `messages.js:34`: `AND (cp.display_name ILIKE $1 OR cp.preferred_name ILIKE $1 OR u.email ILIKE $1)`

`messages.js:37` sorts; change the `ORDER BY` to `COALESCE(cp.display_name, cp.preferred_name) ASC` so the recipient picker is alphabetized on what is rendered. That query is Shape C, so it now returns both columns and the sort has something real to sort on.

---

**Do not touch** `server/routes/shifts.queries.js:48` (was `:42` before the 8/03 event-details revival). It already extracts a single initial from `preferred_name` for a cover marker and is correct as-is. `eventDetailsPayload.js:179` carries the identical `cover_for_first_initial` extraction and is equally left alone: an initial is an initial.

- [ ] **Step 2: Replace the eventDetailsPayload computeName with the shared helper**

**[rewritten 2026-08-04]** The 8/03 staff event-details revival (beda7043) gutted `server/routes/beo.js` down to three thin routes (164 lines; no name code at all) and moved the roster and its local `computeName` into `server/utils/eventDetailsPayload.js`, which is now shared by BOTH `beo.js` (admin view + nudge links) and the staff portal's shift-keyed `eventDetails.js`. One edit here therefore covers both route families. The old instructions (`beo.js:100`, `computeName` at `:185-204`) point at deleted code; everything below is against the payload builder.

The ack-list projection at `eventDetailsPayload.js:107` is swapped per the Shape A table above.

For the team roster: **[verified 2026-08-04]** the local `computeName` spans `:241-260` with its leading comment at `:238-240`, `computeInitials` spans `:262-268`, and the call site `const display_name = computeName(r);` is at `:271` inside the `team_roster` map. Delete `:238-260` (comment + `computeName`) only, leaving `computeInitials` intact. Add the import at the top of the file (same directory now):

```js
const { computeDisplayName } = require('./staffDisplayName');
```

Replace the call site (`const display_name = computeName(r);`) with:

```js
    // Shared helper (spec §5). Two deliberate differences from the deleted local
    // computeName: agreement-first precedence (it read applications first, but
    // the signed agreement is what everything else in this system prefers), and
    // the empty-preferred-name case, which the helper covers by falling back
    // to the legal first name so a client-facing surface never shows an email.
    const display_name =
      computeDisplayName({
        preferredName: r.preferred_name,
        legalFullName: r.agreements_name || r.applications_name,
      }) || (r.email && r.email.includes('@') ? r.email.split('@')[0] : 'Staff');
```

**[verified]** the roster query (`:132-153`) already selects `cp.preferred_name`, `a.full_name AS applications_name`, `ag.full_name AS agreements_name`, and `u.email`, and orders by `sr.id`, so no query change and no ordering impact. The raw `cp.preferred_name` it selects is helper INPUT, not display output; leave it bare.

**[verified]** `beo.test.js`'s roster fixtures are one-legal-source-per-teammate (apps-only, agreements-only, email-only), so its expectations (`Rosa M.`, `Diego R.`, `Noor E.`, email local-part) survive the precedence change; `eventDetails.test.js`'s `team_roster` assertions are shape/gating-only. If either goes red, read it — that is a real behavior change, not an expectation to update blindly.

- [ ] **Step 3: Run every suite these changes reach**

Grep-derived, one at a time:

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/beo.test.js
node -r dotenv/config --test server/routes/eventDetails.test.js
node -r dotenv/config --test server/routes/drinkPlans.beo.test.js
node -r dotenv/config --test server/routes/publicTip.test.js
node -r dotenv/config --test server/routes/adminCoverSwaps.test.js
node -r dotenv/config --test server/routes/admin/presence.test.js
node -r dotenv/config --test server/routes/calendar.description.test.js
node -r dotenv/config --test server/routes/shifts.approval.test.js
node -r dotenv/config --test server/routes/shifts.cancelUnassign.test.js
node -r dotenv/config --test server/routes/shifts.withdraw.test.js
node -r dotenv/config --test server/routes/staffShiftActions.test.js
node -r dotenv/config --test server/routes/staffPortal.test.js
node -r dotenv/config --test server/routes/serviceExtensions/admin.test.js
node -r dotenv/config --test server/utils/outstandingDocuments.test.js
```

(The last three are post-plan suites that reach the rev-3 additions: `eventDetails.test.js` shares `eventDetailsPayload.js` with `beo.test.js`; the extension and documents suites cover their swapped queries. Their fixtures insert `contractor_profiles` rows directly, which leaves `display_name` NULL, so the three-deep COALESCE falls through to today's strings and expectations hold.)

Expected: PASS. Because Task 5 now refreshes `display_name` in `seedTestData.js` and the COALESCE is three-deep, a fixture seeded with only a `preferred_name` and no agreement renders **the bare preferred name**, unchanged from today. If a fixture DOES have an agreement, its expected string gains a last initial: update the fixture's expectation, not the helper. A fixture rendering an **email address** means the refresh did not fire; that is a bug in Task 5, not an expectation to bake in.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/os
SRC="server/routes/shifts.js server/routes/calendar.js server/routes/staffShiftActions.js server/routes/proposals/cancel.js server/routes/publicTip.js server/routes/admin/contractorTipPage.js server/routes/messages.js server/routes/adminCoverSwaps.js server/routes/staffPortal.js server/routes/admin/applications.js server/routes/serviceExtensions/admin.js server/utils/presenceStore.js server/utils/beoHandlers.js server/utils/staffShiftHandlers.js server/utils/marketingHandlers.js server/utils/globalSearch.js server/utils/eventDetailsPayload.js server/utils/outstandingDocuments.js"
# Add every fixture file Step 3 told you to update. A commit whose own suite
# fails is not a checkpoint; list them explicitly (never `git add -A`).
FIXTURES="<the *.test.js paths you actually edited in Step 3>"
git add $SRC $FIXTURES
git commit -m "refactor(staff-name): read display_name on roster, search and document surfaces" -- $SRC $FIXTURES
```

---

### Task 8: Money-screen read swaps

Separated from Task 7 because two of these queries **sort and aggregate on the name string**, so the swap changes ordering. That is exactly where count and sorted-list assertions bite.

**Files:**
- `server/routes/admin/payroll.js:34,42,558,655`
- `server/routes/admin/users.js:33,442,455`
- `server/routes/stripePayouts.js:11 (comment), :20`

- [ ] **Step 1: Swap the SQL**

Same three-deep form as Task 7, including inside the `ORDER BY COALESCE(...)` at `admin/payroll.js:42` and `admin/users.js:455`, and inside the `ARRAY(SELECT COALESCE(...))` at `admin/payroll.js:655`.

**Exception, `admin/users.js:33` and `:442`.** Those two projections select the bare column, so the JSON key the client reads would change. Select **both** instead:

```sql
        cp.preferred_name, cp.display_name,
```

`:442` feeds `GET /admin/active-staff` (the StaffDashboard list) and `:33` feeds the admin users list. Task 12 updates both consumers to prefer `display_name`.

Update the stale comment at `stripePayouts.js:11`:

```js
// staff_name resolves the tip line's staffer from contractor_profiles.display_name
// (preferred name plus last initial, see utils/staffDisplayName.js), then the raw
// preferred name, then the users.email fallback. Read-side display only: matching
// keys on tips.target_user_id, never on this string.
```

- [ ] **Step 2: Run the payroll suites and read the output**

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/admin/payroll.test.js
node -r dotenv/config --test server/routes/admin/payroll.redesign.test.js
node -r dotenv/config --test server/routes/admin/users.activeStaff.test.js
node -r dotenv/config --test server/routes/admin/users.tipsGate.test.js
node -r dotenv/config --test server/routes/staffPortal/payouts.test.js
node -r dotenv/config --test server/routes/staffPortal/payouts.paystub.test.js
```

Expected: PASS. If a sorted-list or array-order assertion fails, the cause is that a fixture's display name sorts differently from its preferred name. Fix the fixture's expected ordering. **Do not** revert the column or add a sort on `preferred_name` to paper over it.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/os
SRC="server/routes/admin/payroll.js server/routes/admin/users.js server/routes/stripePayouts.js"
# Same rule as Task 7: any fixture whose expected ordering you fixed in Step 2
# belongs in this commit, or this checkpoint ships with a red suite.
FIXTURES="<the *.test.js paths you actually edited in Step 2>"
git add $SRC $FIXTURES
git commit -m "refactor(staff-name): money SCREENS read display_name (records stay legal)" -- $SRC $FIXTURES
```

---

### Task 9: 1099 workbench reads the legal name

The one genuine money defect in scope. The year-end contractor list currently labels rows with the nickname, so Nevver's 1099 row reads `TwistidTreets`.

**Files:**
- Modify: `server/routes/admin/payrollTax.js:137`
- Test: `server/routes/admin/payrollTax.legalName.test.js`

**[verified]** the route is `router.get('/payroll/tax-totals', ...)` at `payrollTax.js:100`, mounted at `/api/admin`, so the full path is **`/api/admin/payroll/tax-totals`**. The first draft of this plan used `/api/admin/payroll-tax`, which 404s.

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/payrollTax.legalName.test.js`. Copy the harness from Task 5 Step 1 verbatim, changing exactly these lines:

- paths go up two levels: `require('../../db')`, `require('../../utils/errors')`
- `const EMAIL = \`ptax-ln-${NONCE}@example.com\`;`
- the user INSERT uses `'admin'` for the role
- the profile seed: `[userId, 'TwistidTreets']`
- the agreement seed: `[userId, 'Nevver Sayles', EMAIL]`
- the mount: `app.use('/api/admin', require('./payrollTax'));`

Seed one ledger row so the contractor appears in the totals. **[verified]** `staff_payment_history` requires `source_account`, `source_file` and a UNIQUE `row_fingerprint`, `platform` is CHECK-constrained to a fixed list, and `CONSTRAINT sph_before_boundary` requires `paid_on < 2026-06-02` unless `boundary_exception` is true. Using a 2025 date satisfies that naturally:

```js
const YEAR = 2025;

// ...in before(), after the profile and agreement seeds:
await pool.query(
  `INSERT INTO staff_payment_history
     (contractor_id, paid_on, amount_cents, platform, source_account, row_fingerprint, source_file)
   VALUES ($1, DATE '2025-03-15', 25000, 'venmo', 'test-account', $2, 'plan-test')`,
  [userId, `ptax-ln-${NONCE}`]
);
```

**[verified] the teardown must delete this row first.** `staff_payment_history.contractor_id` is `INTEGER NOT NULL REFERENCES users(id)` with **no `ON DELETE CASCADE`** (`server/db/schema.sql:4048`, inside the CREATE at `:4043`), so the Task 5 `after()` hook's bare `DELETE FROM users` raises a foreign-key violation, fails teardown, and strands an orphan row plus a permanently-consumed UNIQUE `row_fingerprint` in the shared dev database. Change the `after()` to:

```js
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) {
    await pool.query('DELETE FROM staff_payment_history WHERE contractor_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await pool.end();
});
```

Then:

```js
test('the harness authenticates at all (guards the JWT claim shape)', async () => {
  const res = await req('GET', `/api/admin/payroll/tax-totals?year=${YEAR}`);
  assert.notEqual(res.status, 401, `auth failed: ${JSON.stringify(res.body)}`);
  assert.notEqual(res.status, 404, 'route path is wrong');
});

test('the 1099 list labels rows with the LEGAL name, never the nickname', async () => {
  const res = await req('GET', `/api/admin/payroll/tax-totals?year=${YEAR}`);
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'seeded contractor missing from the 1099 list');
  assert.equal(row.name, 'Nevver Sayles');
  assert.ok(!row.name.includes('Twistid'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/payrollTax.legalName.test.js`
Expected: the auth/route guard PASSES; the name test FAILS with `'TwistidTreets' !== 'Nevver Sayles'`.

- [ ] **Step 3: Fix the query**

In `server/routes/admin/payrollTax.js`, replace line 137:

```sql
            COALESCE(cp.preferred_name, u.email) AS name,
```

with the **whole** precedence chain `paystubData.js:40` uses, `cp.preferred_name` included:

```sql
            -- A 1099 is a government document, so this is the LEGAL name, not
            -- the display name. Same precedence as paystubData.js:40, INCLUDING
            -- the cp.preferred_name term: user 61 has neither an agreement nor
            -- an application, and a legal-only chain would put a raw email
            -- address on a tax document.
            COALESCE(ag.full_name, ap.full_name, cp.preferred_name, u.email) AS name,
```

Add the joins onto the existing alias `c`, alongside the current `LEFT JOIN contractor_profiles`:

```sql
  LEFT JOIN agreements   ag ON ag.user_id = c.user_id
  LEFT JOIN applications ap ON ap.user_id = c.user_id
```

**[verified]** both tables have a UNIQUE `user_id`, so neither join can fan out and inflate the money totals. **Keep** the `LEFT JOIN contractor_profiles`: the chain still references `cp`.

**[verified]** this query ends `ORDER BY total_cents DESC, name ASC`, so the tiebreaker sort now runs on the legal name. Same class of change Task 8 warns about; if a row-order assertion moves, fix the expectation, not the chain.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/os
node -r dotenv/config --test server/routes/admin/payrollTax.legalName.test.js
node -r dotenv/config --test server/routes/admin/payroll.test.js
```

Expected: PASS. The second run guards against the added joins changing any money total.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add server/routes/admin/payrollTax.js server/routes/admin/payrollTax.legalName.test.js
git commit -m "fix(payroll-tax): 1099 contractor list reads the legal name, not the nickname" -- server/routes/admin/payrollTax.js server/routes/admin/payrollTax.legalName.test.js
```

---

### Task 10: Client helper port, onboarding copy, live preview

**Files:**
- Create: `client/src/utils/preferredName.js`
- Test: `client/src/utils/preferredName.test.js`
- Modify: `client/src/pages/ContractorProfile.js:112, 131, 197-201` (**[re-cited 2026-08-04]** the onboarding-draft lanes rebuilt this page: the rules array is `:111-116`, `scrollToFirstError` is `:131`, the preferred-name block is `:197-201`, and the profile fetch effect spans `:42-82` with a `useFormDraft` overlay at `:99-107`)
- Modify: `server/routes/contractor.js` (GET `/`: **all three** return paths)

**Interfaces:**
- Produces: `computeDisplayName({ preferredName, legalFullName })` and `validatePreferredName(raw)` from `client/src/utils/preferredName.js`, used by Tasks 10 and 11.

**Known duplication:** the browser needs the preview without a round trip per keystroke, and CRA cannot import from outside `client/src`. This file is a hand-kept port of `server/utils/staffDisplayName.js` plus `staffDisplayName.validate.js`. Both sides carry the **same case table**, so drift in either shows up as a red test.

- [ ] **Step 1: Write the failing test**

Create `client/src/utils/preferredName.test.js`:

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
  [null, 'Nevver Sayles', 'Nevver S.'],
  ['', 'Joseph Key', 'Joseph K.'],
  [null, 'Zul', 'Zul'],
  [null, null, null],
  ['Nicholas or Nick', 'Nicholas George DiCristina', 'Nicholas or Nick D.'],
];

test.each(CASES)('computeDisplayName(%s, %s) === %s', (preferredName, legalFullName, expected) => {
  expect(computeDisplayName({ preferredName, legalFullName })).toBe(expected);
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

Create `client/src/utils/preferredName.js`. Copy the bodies of `computeDisplayName` (Task 1 Step 3) and `validatePreferredName` (Task 2 Step 3) **verbatim**, including `TITLES`, `tokens`, `isMiddleInitial`, `fixCase` and `norm`, changing only `module.exports` to named `export` statements. `validatePreferredNameChange` is not needed here (grandfathering is enforced server-side). Add this header:

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

- [ ] **Step 4: Return `legal_name` and `display_name` from GET /api/contractor**

**[verified 2026-08-04]** this endpoint has **three** return paths, and the first draft of this plan patched only the last and rarest one:
- `:31` early return for any profile that has a `preferred_name`. **This is the path every existing staffer hits.**
- `:40-69` the application-fallback object.
- `:72` the bare `sanitizeProfile(profile) || {}`.

Fetch the legal name once near the top of the handler, then add it to all three:

```js
  // Legal name (read-only) so the preferred-name field can preview the display
  // name live. Same precedence as refreshDisplayName / paystubData.
  const legalRes = await pool.query(
    `SELECT COALESCE(ag.full_name, ap.full_name) AS legal_name
       FROM users u
       LEFT JOIN agreements   ag ON ag.user_id = u.id
       LEFT JOIN applications ap ON ap.user_id = u.id
      WHERE u.id = $1`,
    [req.user.id]
  );
  const legal_name = legalRes.rows[0]?.legal_name || null;
```

Then:
- `:31` becomes `return res.json({ ...sanitizeProfile(profile), legal_name });`
- `:40-69` gains `legal_name,` and `display_name: profile?.display_name || null,` as object properties
- `:72` becomes `res.json({ ...(sanitizeProfile(profile) || {}), legal_name });`

**[verified]** `sanitizeProfile` (`contractor.js:17-21`) is a **denylist** that strips only `seniority_adjustment`, so `display_name` passes through untouched. No allowlist edit is needed.

- [ ] **Step 5: Run test to verify the port passes**

Run: `cd ~/projects/os/client && CI=true npx react-scripts test --watchAll=false src/utils/preferredName.test.js`
Expected: PASS, all 21 parity cases plus both validator groups.

- [ ] **Step 6: Replace the field copy**

In `client/src/pages/ContractorProfile.js`, import the helpers:

```js
import { computeDisplayName, validatePreferredName } from '../utils/preferredName';
```

Store `legal_name` in component state from the profile fetch (`api.get('/contractor').then(...)` at `:43-81`). **[2026-08-04, draft-lane interplay]** two placement rules, both consequences of the onboarding-draft rework:
- Set it **outside** the `if (d._from_application || d.preferred_name)` guard at `:45` — a skeleton profile (admin-hired, no name yet) skips that branch, and the preview should still know the surname initial.
- Keep `legalName` in its own `useState`, **never inside `form`** — the `useFormDraft` overlay (`:99-107`) restores saved drafts over `form`, and while its empty-value filter would normally drop it, a stale draft captured after this feature ships would replay an old `legal_name` over a fresh one. State outside `form` is untouchable by drafts and by the FormData submit loop at `:151`.

Then derive the preview above the `return`:

```jsx
  // Live preview. Seeing "LumpyIceCream S." appear under a sentence about
  // introducing yourself to a guest is most of the enforcement (spec §3.1).
  const namePreview = computeDisplayName({
    preferredName: form.preferred_name,
    legalFullName: legalName,
  });
```

Replace the block at `:197-201` (the whole `form-group` div holding the "Preferred Name *" label):

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

**[verified]** `useFormValidation` rules take `test: (v, data) => boolean` (`client/src/hooks/useFormValidation.js:26-28`, still exact), and its `message` is only ever "Please fill in: ...". Do not modify the hook. Replace the rule at `:112`:

```js
  const rules = [
    { field: 'preferred_name', label: 'Preferred Name', test: (v) => validatePreferredName(v).valid },
    { field: 'phone', label: 'Phone' },
    { field: 'city', label: 'City' },
    { field: 'state', label: 'State' },
  ];
```

and in `submit`, immediately after the existing `const result = validate(rules, form);` guard, surface the specific reason:

```js
    const nameCheck = validatePreferredName(form.preferred_name);
    if (!nameCheck.valid) {
      setFieldErrors({ preferred_name: nameCheck.error });
      setError(nameCheck.error);
      scrollToFirstError();
      return;
    }
```

**[verified 2026-08-04]** `scrollToFirstError` already exists at `ContractorProfile.js:131`.

- [ ] **Step 7: Verify the build and walk it manually**

```bash
cd ~/projects/os/client && CI=true npx react-scripts build
```

Then, on the running dev server, log in as a test staffer and open `/contractor-profile`. Concretely:
- the label reads "What do I call you?"
- typing `Lumpy` shows a preview line ending in the test user's last initial
- clearing the field shows the generic fallback sentence
- typing `Miss Taylor` and submitting shows "Skip the title, just the name you go by." and scrolls to the field
- typing `Fareed` and submitting saves and advances to `/payday-protocols`

- [ ] **Step 8: Commit**

```bash
cd ~/projects/os
git add client/src/utils/preferredName.js client/src/utils/preferredName.test.js client/src/pages/ContractorProfile.js server/routes/contractor.js
git commit -m "feat(staff-name): 'What do I call you?' copy with live display-name preview" -- client/src/utils/preferredName.js client/src/utils/preferredName.test.js client/src/pages/ContractorProfile.js server/routes/contractor.js
```

---

### Task 11: Staff portal copy

**Files:**
- Modify: `client/src/pages/staff/account/ProfileSection.js:44, 330-338`

**Interfaces:**
- Consumes: `computeDisplayName` and `validatePreferredName` from `client/src/utils/preferredName.js` (Task 10). **[verified]** `legal_name` already arrives from `accountReads.js:78`.

- [ ] **Step 1: Replace the helper constant and add imports**

Replace line 44:

```js
const PREFERRED_NAME_HELPER =
  'Whatever you actually go by. A short form, a chosen name, the name your people use. '
  + 'Chip for Vernon, Alexis for Alexander, Shea for Tashea, Fareed for Mohammad.';
```

Add:

```js
import { computeDisplayName, validatePreferredName } from '../../../utils/preferredName';
```

- [ ] **Step 2: Relabel the field, add the preview and client-side validation**

**[verified]** the `TextField` at `:330-338` sits inside a `sp-tf-row` wrapper; replace by matching the `<TextField ... />` element text, not by line range.

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

Immediately after the enclosing `sp-tf-row`, add the preview:

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

In `handleSave`, before the PATCH fires, add the same immediate-feedback check the onboarding form has (spec §3.4 says both surfaces get it). Skip it when the value is unchanged, mirroring the server's grandfathering:

```js
    const stored = (profile?.preferred_name || '').trim().replace(/\s+/g, ' ');
    const submitted = (form.preferred_name || '').trim().replace(/\s+/g, ' ');
    if (submitted !== stored) {
      const nameCheck = validatePreferredName(form.preferred_name);
      if (!nameCheck.valid) {
        setFieldErrors((e) => ({ ...e, preferred_name: nameCheck.error }));
        return;
      }
    }
```

- [ ] **Step 3: Verify the build and walk it manually**

```bash
cd ~/projects/os/client && CI=true npx react-scripts build
```

On the running dev server, open the staff portal account page as a test staffer:
- the field label reads "What do I call you?" with the new helper text
- the preview under it shows their current display name and updates as you type
- entering `Mrs. Smith` and saving shows an inline error and does not PATCH
- saving their existing name unchanged still succeeds
- changing to a new valid name saves and the preview matches what the roster shows

- [ ] **Step 4: Commit**

```bash
cd ~/projects/os
git add client/src/pages/staff/account/ProfileSection.js
git commit -m "feat(staff-name): staff portal preferred-name copy, preview and validation" -- client/src/pages/staff/account/ProfileSection.js
```

---

### Task 12: Client read-site swaps and the admin legal-name row

**Files:**
- `client/src/components/adminos/drawers/ShiftDrawer.js:371,650,653`
- `client/src/pages/AdminDashboard.js:256,269,486,605-639`
- `client/src/pages/admin/StaffDashboard.js:26,27,119,126,174`
- `client/src/pages/admin/userDetail/AdminUserDetail.js:166,350,510-520`
- `client/src/pages/admin/userDetail/tabs/OverviewTab.js:185-189` (match by text; the enclosing `<div>` opens at `:185`)
- `client/src/pages/staff/TipCardPage.js:110,275`
- `server/routes/me.js:75,120` (the staff tip-page GET that feeds TipCardPage)

**[verified 2026-08-04]** `client/src/components/staff/TeamRosterCard.js` needs **no edit**. It already renders `member.display_name`, and that value is computed by `server/utils/eventDetailsPayload.js` (which took the roster over from `beo.js` on 8/03 and now feeds the staff `ShiftDetail` page too), which Task 7 Step 2 rewires. Listed so it is accounted for rather than looking like an omission. Same class: the staff HomePage cover-broadcast row (`HomePage.js:349-357`) derives "Diego R." client-side from `requester_preferred_name`; after Task 7's Shape B swap the server string already carries the initial and that derivation degrades to a no-op (a two-word given name compacts to first word + initial, which is acceptable) — do not "fix" it.

- [ ] **Step 1: Swap the rendered field**

In each cited line, prefer `display_name` and keep `preferred_name` as a fallback wherever the server sends both:

```js
{s.display_name || s.preferred_name || displayEmail}
```

The search filters at `AdminDashboard.js:256,605-639` and `ShiftDrawer.js:371` must match on `display_name` too, so typing what you see finds the person.

`AdminUserDetail.js:166` becomes:

```js
  const displayName = profile?.display_name || profile?.preferred_name || user.email;
```

- [ ] **Step 2: Feed TipCardPage from the server**

`server/routes/me.js` is in this task's Files list and its commit **on purpose**: the first draft of this plan required this edit and left the file out of both, so it would never have landed.

At `:75`, add `cp.display_name,` alongside `cp.preferred_name,`. At `:120` (the `preferred_name: row.preferred_name || null,` line in the response object), add `display_name: row.display_name || null,` alongside it.

Then `TipCardPage.js:110`:

```js
        display_name: tipPage.display_name || methods.display_name
          || tipPage.preferred_name || methods.preferred_name || null,
```

and `:275` renders `{data.display_name || 'your bartender'}`.

- [ ] **Step 3: Show the legal name on the admin record**

**[verified]** no server change is needed. `GET /admin/users/:id` (`admin/users.js:57`) already returns the full `agreement` and `application` rows, and `AdminUserDetail.js:163` already destructures them. The first draft of this plan wrongly routed this through `admin/users.js:442`, which is a different endpoint (`GET /admin/active-staff`).

Pass the legal name down at `AdminUserDetail.js:510-520`, alongside the existing `profile={profile}`:

```jsx
          legalName={agreement?.full_name || application?.full_name || null}
```

In `OverviewTab.js`, add `legalName` to the destructured props, and in the **non-editing** branch of the profile card add a read-only row:

```jsx
<div>
  <div className="meta-k" style={{ marginBottom: 4 }}>Legal name</div>
  <div className="meta-v">{legalName || <span className="muted">not on file</span>}</div>
</div>
```

In the **editing** branch, relabel the input and cap its length. **[verified]** the enclosing `<div>` opens at `:185` and the block runs `:185-189`; replacing only `186-189` leaves an unbalanced element and fails the build. Match on the text, replacing the whole `<div>` that contains the "Preferred name" label:

```jsx
<div>
  <div className="meta-k" style={{ marginBottom: 4 }}>What we call them</div>
  <input className="input" value={editForm.preferred_name} onChange={e => updateField('preferred_name', e.target.value)} maxLength={20} />
  <FieldError error={profileFieldErrors?.preferred_name} />
</div>
```

- [ ] **Step 4: Verify the build and walk it manually**

```bash
cd ~/projects/os/client && CI=true npx react-scripts build
```

On the dev server, as an admin:
- the staff list, the assign picker in a shift drawer, and the message recipient picker all show "Name L." rather than a bare first name or an email
- searching the staff list for a surname initial finds the person
- a user detail record shows both "What we call them" and "Legal name"
- a staffer with no agreement shows "not on file" for the legal name
- the staff tip card page shows the display name, not "your bartender"

- [ ] **Step 5: Commit**

```bash
cd ~/projects/os
git add client/src/components/adminos/drawers/ShiftDrawer.js client/src/pages/AdminDashboard.js client/src/pages/admin/StaffDashboard.js client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/admin/userDetail/tabs/OverviewTab.js client/src/pages/staff/TipCardPage.js server/routes/me.js
git commit -m "refactor(staff-name): admin and staff surfaces render display_name; legal name on the record" -- client/src/components/adminos/drawers/ShiftDrawer.js client/src/pages/AdminDashboard.js client/src/pages/admin/StaffDashboard.js client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/admin/userDetail/tabs/OverviewTab.js client/src/pages/staff/TipCardPage.js server/routes/me.js
```

---

### Task 13: The admin visibility notice

Visibility, never a gate. The name is live the moment it is typed; this is how Dallas finds out about it.

**Files:**
- Create: `server/routes/admin/nameNotices.js`
- Modify: `server/routes/admin/index.js` (**[verified]** a real composition router)
- Test: `server/routes/admin/nameNotices.test.js`
- Modify: `client/src/pages/admin/overview/queueItems.js` (**[re-cited 2026-08-04]** `buildStaffingItems` at `:45`; the 7/26 document-visibility lane gave it a third `uncertified = []` parameter, a per-person documents block, and a RANK sort before the return)
- Modify: `client/src/pages/admin/overview/queueItems.test.js` (**[verified 2026-08-04]** this suite exists and asserts on `buildStaffingItems` with BOTH 2-arg and 3-arg calls; its arity changes from 3 to 5)
- Modify: `client/src/index.css` (the `.queue-meta-btn` rule, Step 5)
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js` (**[re-cited 2026-08-04]** `QUEUE_ICON` at `:13-17`; `queueItemHref` MOVED to `queueItems.js:28-39` and already has the `'user'` target)
- Modify: `client/src/pages/admin/overview/OverviewPage.js` (**[re-cited 2026-08-04]** the `buildStaffingItems` call at `:240-241`; the admin-gated fetch effect at `:213-226`)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces: `GET /api/admin/name-notices -> { rows: [{ user_id, display_name, preferred_name, legal_name }] }` and `POST /api/admin/name-notices/:userId/ack -> { ok: true }`. `buildStaffingItems(unstaffed, newApplications, uncertified, nameNotices, onAck)` gains two parameters AFTER the existing `uncertified` third parameter. Getting this order wrong is not cosmetic: notices passed third would render as "undefined has no alcohol certification" documents rows.

A separate router file rather than another route in `admin/users.js`, so a literal path can never be shadowed by the existing `/users/:id` patterns.

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/nameNotices.test.js`. Copy the harness from Task 5 Step 1 verbatim, changing:

- paths go up two levels: `require('../../db')`, `require('../../utils/errors')`
- `const EMAIL = \`nn-${NONCE}@example.com\`;` and an admin role
- the profile seed: `[userId, 'TwistidTreets']`, the agreement seed: `[userId, 'Nevver Sayles', EMAIL]`
- the mount: `app.use('/api/admin', require('./nameNotices'));`
- add a second, staff-role user and token (`staffUserId` / `staffToken`) for the permission test, since the Task 5 harness defines only one. **Delete it in `after()` too**, or it leaks into the shared dev database on every run:

```js
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  if (staffUserId) await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
  await pool.end();
});
```

Then:

```js
before(async () => {
  // ...harness setup above, then:
  await require('../../utils/refreshDisplayName').refreshDisplayName(userId, pool);
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
});

test('lists unreviewed names with both the display and legal name', async () => {
  const res = await req('GET', '/api/admin/name-notices');
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r) => r.user_id === userId);
  assert.ok(row, 'unreviewed row missing from the notice list');
  assert.equal(row.preferred_name, 'TwistidTreets');
  assert.equal(row.legal_name, 'Nevver Sayles');
  assert.equal(row.display_name, 'TwistidTreets S.');
});

test('ack stamps the row and drops it from the list', async () => {
  assert.equal((await req('POST', `/api/admin/name-notices/${userId}/ack`)).status, 200);
  const res = await req('GET', '/api/admin/name-notices');
  assert.ok(!res.body.rows.some((r) => r.user_id === userId));
});

// GUARD (spec §2, §7): the notice is not a gate.
test('acking does not change the rendered name', async () => {
  const before = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  await req('POST', `/api/admin/name-notices/${userId}/ack`);
  const after = await pool.query('SELECT display_name FROM contractor_profiles WHERE user_id = $1', [userId]);
  assert.equal(after.rows[0].display_name, before.rows[0].display_name);
  assert.equal(after.rows[0].display_name, 'TwistidTreets S.');
});

test('a deactivated staffer never appears in the queue', async () => {
  await pool.query('UPDATE contractor_profiles SET preferred_name_reviewed_at = NULL WHERE user_id = $1', [userId]);
  await pool.query("UPDATE users SET onboarding_status = 'deactivated' WHERE id = $1", [userId]);
  const res = await req('GET', '/api/admin/name-notices');
  assert.ok(!res.body.rows.some((r) => r.user_id === userId));
  await pool.query("UPDATE users SET onboarding_status = 'approved' WHERE id = $1", [userId]);
});

test('rejects a non-admin caller', async () => {
  const saved = token;
  token = staffToken;
  try {
    const res = await req('GET', '/api/admin/name-notices');
    assert.ok(res.status === 401 || res.status === 403, `expected a permission failure, got ${res.status}`);
  } finally {
    token = saved;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/nameNotices.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Write the router**

Create `server/routes/admin/nameNotices.js`. Note the import shape: **[verified]** `auth` and `adminOnly` are BOTH named exports of `middleware/auth`, and there is no `middleware/roles`.

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
const { auth, adminOnly } = require('../../middleware/auth');
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
        -- Deactivated staff are not working, so their name is not going on
        -- anything and a departed staffer is not a thing that needs attention.
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

Mount it in `server/routes/admin/index.js` by adding one line alongside the existing sub-routers:

```js
router.use('/', require('./nameNotices'));
```

**[verified]** that file's header notes mount order is irrelevant because sub-router paths are non-overlapping. `/name-notices` does not collide with any existing path, and it is a literal segment that `users.js`'s `/users/:id` patterns cannot shadow, which is why this is a separate file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/os && node -r dotenv/config --test server/routes/admin/nameNotices.test.js`
Expected: PASS, all 5 tests

- [ ] **Step 5: Add the queue item and wire "Got it"**

The first draft of this plan built the endpoint and never called it, so the strip would have accumulated one permanent row per staff member. The ack must be wired in this same task.

**[verified 2026-08-04]** `client/src/pages/admin/overview/queueItems.test.js` exists and calls `buildStaffingItems` with both 2-arg and 3-arg (`uncertified`) forms; the new parameters are optional in effect (`nameNotices || []` and `onAck` unused when the list is empty), so those calls keep passing, but add one case for the new item type so the notice is covered. **The empty `[]` in the third slot is load-bearing** — it is the existing `uncertified` parameter:

```js
test('buildStaffingItems emits an info-priority name notice per unreviewed name', () => {
  const items = buildStaffingItems([], 0, [], [
    { user_id: 7, legal_name: 'Nevver Sayles', preferred_name: 'TwistidTreets', display_name: 'TwistidTreets S.' },
  ], () => {});
  const row = items.find((i) => i.type === 'name-notice');
  expect(row).toBeTruthy();
  expect(row.priority).toBe('info');
  expect(row.title).toBe('Nevver Sayles goes by TwistidTreets');
  expect(row.target).toBe('user');
  expect(row.ref).toBe(7);
});
```

In `client/src/pages/admin/overview/queueItems.js`, extend `buildStaffingItems` (`:45`). The two new parameters go AFTER the existing `uncertified`, and the notice loop goes after the `(uncertified || []).forEach(...)` documents block and **before the final `items.sort(...)` return** (the RANK sort the document-visibility lane added; `'info'` ranks last, which is right for an informational row):

```js
export function buildStaffingItems(unstaffed, newApplications, uncertified = [], nameNotices = [], onAck) {
  const items = (unstaffed || []).map(e => {
    // ...unchanged...
  });
  if (newApplications > 0) {
    // ...unchanged...
  }
  (uncertified || []).forEach(u => {
    // ...unchanged documents block...
  });
  // Informational: a staffer told us what to call them. Usually a pleasant
  // fact, occasionally a conversation. Never blocks the name (spec §3.5).
  for (const n of nameNotices || []) {
    items.push({
      id: 'name-' + n.user_id, type: 'name-notice', priority: 'info',
      title: `${n.legal_name || 'A staffer'} goes by ${n.preferred_name}`,
      sub: `shows as ${n.display_name || n.preferred_name}`,
      meta: 'Got it', metaAction: () => onAck(n.user_id),
      target: 'user', ref: n.user_id,
    });
  }
  items.sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3)); // ...unchanged...
  return items;
}
```

**[verified 2026-08-04]** `queueItemHref` now lives in `queueItems.js` (`:28-39`), not `NeedsYouStrip.js`, and it **already maps `'user'` to `/staffing/users/:ref`** (`:37`, added for the documents rows). No href change is needed anywhere; the first draft's "add the target" edit is done for us.

In `NeedsYouStrip.js`, add only the icon, to the existing `QUEUE_ICON` map at `:13-17` (which already carries `'lead-call'` and `documents`; `userplus` **[verified]** exists in `adminos/Icon.js`):

```js
  'lead-call': 'alert', documents: 'alert', 'name-notice': 'userplus',
```

and make the `meta` cell (`:71`, `<div className="queue-meta">{a.meta}</div>` inside `renderRow`) clickable when the item carries a `metaAction`, stopping propagation so it acks instead of navigating:

```jsx
{a.metaAction
  ? <button type="button" className="queue-meta queue-meta-btn"
      onClick={(e) => { e.stopPropagation(); a.metaAction(); }}>{a.meta}</button>
  : a.meta}
```

**[verified 2026-08-04]** `.queue-meta` exists in `client/src/index.css` (`:12835`, plus a light-skin override at `:11646`) but `.queue-meta-btn` still does **not**. Composing both keeps the existing type treatment; add the button reset next to the existing `.queue-meta` rule at `:12835` so it does not render as a default browser button inside the strip:

```css
html[data-app="admin-os"] .queue-meta-btn {
  background: none; border: 1px solid var(--line); border-radius: 4px;
  padding: 1px 6px; cursor: pointer; color: inherit; font: inherit;
}
html[data-app="admin-os"] .queue-meta-btn:hover { border-color: var(--ink-2); }
```

`client/src/index.css` is in this task's Files list and commit pathspec because of this.

In `OverviewPage.js`, fetch the notices and supply the ack callback. **[2026-08-04]** the GET belongs **inside the existing `if (isAdmin)` block of the fetch effect (`:213-226`)**, right beside the `/admin/hiring/uncertified` call, and for the same documented reason: the route is `adminOnly`, and a manager's 403 would trip the `role_denial` audit. The standalone-effect version below is therefore replaced by one gated load function invoked from that block:

```js
  const [nameNotices, setNameNotices] = useState([]);
  const loadNameNotices = useCallback(() => {
    api.get('/admin/name-notices')
      .then(r => setNameNotices(r.data.rows || []))
      .catch(() => setNameNotices([]));
  }, []);
  // inside the existing fetch effect's `if (isAdmin) { ... }` block:
  //   loadNameNotices();
  // (and add loadNameNotices to that effect's dependency array)

  const ackNameNotice = useCallback(async (userId) => {
    // Optimistic: the row is informational, so a failed ack costs nothing but a
    // reappearance on the next load.
    setNameNotices(rows => rows.filter(r => r.user_id !== userId));
    try { await api.post(`/admin/name-notices/${userId}/ack`); }
    catch { loadNameNotices(); }
  }, [loadNameNotices]);

  const staffingItems = useMemo(
    () => buildStaffingItems(unstaffed, newApplications, uncertified, nameNotices, ackNameNotice),
    [unstaffed, newApplications, uncertified, nameNotices, ackNameNotice]
  );
```

The `.catch` on the fetch keeps a failed request from breaking the whole strip. The memo replaces the existing one at `:239-241`; `uncertified` stays in both the call and the deps.

- [ ] **Step 6: Verify the build and walk it manually**

```bash
cd ~/projects/os/client && CI=true npx react-scripts build
```

On the dev server, as an admin:
- change a test staffer's preferred name from the staff portal
- the admin overview Staffing tab shows "Legal Name goes by NewName" with a "Got it" button
- clicking "Got it" removes the row and does not navigate
- reloading the page does not bring it back
- clicking the row body (not the button) opens that staffer's record

- [ ] **Step 7: Commit**

```bash
cd ~/projects/os
P="server/routes/admin/nameNotices.js server/routes/admin/nameNotices.test.js server/routes/admin/index.js client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/queueItems.test.js client/src/pages/admin/overview/NeedsYouStrip.js client/src/pages/admin/overview/OverviewPage.js client/src/index.css"
git add $P
git commit -m "feat(staff-name): informational Needs Attention notice with a working Got it action" -- $P
```

---

### Task 14: Full verification

- [ ] **Step 1: Re-run the backfill and prove no drift**

Task 5 changed the write paths since the Task 4 backfill ran, so re-populate and audit:

```bash
cd ~/projects/os
node -r dotenv/config server/scripts/refreshDisplayNames.js
node -r dotenv/config server/scripts/refreshDisplayNames.js --check; echo "exit=$?"
```

Expected: `OK: <n> rows, no drift`, `exit=0`.

- [ ] **Step 2: Run the full server suite, serially**

```bash
cd ~/projects/os
node -r dotenv/config --test --test-concurrency=1 "server/**/*.test.js"
```

Expected: PASS. `--test-concurrency=1` is required: the suites share the dev database, and the bare `npm test` script runs files in parallel, so cross-suite interference will read as a display-name regression.

- [ ] **Step 3: Run the client suite and build**

```bash
cd ~/projects/os/client
CI=true npx react-scripts test --watchAll=false
CI=true npx react-scripts build
```

- [ ] **Step 4: Confirm the salutation surfaces are untouched**

```bash
cd ~/projects/os
git diff main --stat -- server/routes/shifts.approval.js server/utils/lastMinuteStaffingConfirmation.js server/utils/eventEveSms.js server/utils/lastMinuteAlert.js server/utils/payrollDisputeNotify.js server/utils/paystubData.js server/routes/auth.js server/routes/shifts.queries.js server/utils/gratuityStaffNotice.js server/utils/staffHiringEmailTemplates.js server/utils/coverBroadcast.js
```

Expected: **empty output.** Every one of these must still read the bare `preferred_name` ("Hi Fareed", not "Hi Fareed S."). `auth.js:317,367` feeds the staff shell user pill, where someone is looking at their own name; `shifts.queries.js:48` already extracts a cover-marker initial; and `paystubData.js` must still resolve legal-name-first. The last three joined this list in rev 3: `gratuityStaffNotice.js:67` salutes the staffer in their own gratuity-change email, `staffHiringEmailTemplates.js:290` salutes them in their own paperwork reminder, and `coverBroadcast.js:190-199` already reduces the requester to bare initials for the SMS. A non-empty diff here means a swap went somewhere it should not have.

Then confirm the reverse, that the swap actually happened everywhere the table said:

```bash
cd ~/projects/os
rg -n "COALESCE\(cp\.preferred_name" server --glob '!*.test.js'
```

Expected: **exactly two hits**, both documented exemptions, and nothing else:
- `server/utils/staffHiringEmailTemplates.js:290` — salutation into the recipient's own email (see the diff list above).
- `server/scripts/staffPaymentImport/exportKnownPeople.js:38` — review-CSV tooling for the CLOSED staff-payment-import project; per the import project's standing rule, its scripts are not touched without reading that project file first, and a cosmetic name-format change in an archived matching aid buys nothing.

Any OTHER hit is a Shape A or B site the table listed and the swap missed (or new code that landed mid-build and needs a table row).

- [ ] **Step 5: Commit any fixture updates**

```bash
cd ~/projects/os
git status --short
# stage only the files you actually changed, then:
git commit -m "test(staff-name): fixture expectations for display-name rendering" -- <paths>
```

---

## Post-implementation

Production deploy runs `initDb()` (schema) automatically. The backfill is a separate manual step, and the **first** production run is the only one that uses `--stamp-existing`:

```bash
# against production, after the deploy lands
node -r dotenv/config server/scripts/refreshDisplayNames.js --stamp-existing
node -r dotenv/config server/scripts/refreshDisplayNames.js --check
```

Never pass `--stamp-existing` again. A later re-run with that flag would silently ack every pending notice, which is the exact state the notice exists to prevent. Plain re-runs are always safe.

**Run it promptly after the deploy.** The write paths go live with the deploy, but the stamp lands only when the script runs. Any staffer who changes their name in that window has `preferred_name_reviewed_at` correctly set to NULL, and `--stamp-existing`'s `COALESCE(..., NOW())` then stamps exactly those rows, acking a genuinely pending notice. The window is minutes if you run the script right after the deploy, and the cost is one missed notice, not a wrong name. If it matters, check the notice list before and after:

```bash
node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT user_id, preferred_name FROM contractor_profiles WHERE preferred_name_reviewed_at IS NULL AND preferred_name IS NOT NULL\").then(r=>{console.log(r.rows);process.exit(0)})"
```

### Rollback

Reverting the whole batch is clean: the columns are additive, and every read is `COALESCE(cp.display_name, cp.preferred_name, ...)`, so removing the reads falls back to exactly today's behavior.

**Reverting Task 5 alone is not clean** and is the one hazard worth naming. If the write paths are reverted while Tasks 7, 8 and 12 remain, `display_name` stops being maintained but keeps its last value, and every read prefers that stale non-NULL string forever. The three-deep COALESCE cannot rescue a stale value, only a missing one, so the failure is silent: people render under names they have since changed. If Task 5 has to come out, either revert the read swaps with it or run `refreshDisplayNames.js` on a schedule until it goes back in.

The backfill also trims stored `preferred_name` whitespace, which is not reversible from the column alone. It is 10 rows on prod (checkpoint-1 dry run, 2026-08-04) and cosmetic, but a true rollback of that takes a database snapshot, not the script.

### Owed to Dallas: four rows no script touches (spec §6)

Trued to live prod at the checkpoint-1 review (2026-08-04): the committed validator was dry-run over all 61 prod rows. User 205 is already fixed (`Nevver`, renders `Nevver S.`) and drops off; user 15 joins — the spec's original list predates both.

| user | value | what it needs |
|---|---|---|
| 15 | `Ariel  D. Smith` | a real preferred name (currently a full formal name; the double space trims away), then a profile edit |
| 61 | `Miss Taylor` | a legal name on file (needed for money records too), then a real preferred name |
| 31 | `Nicholas or Nick ` | he picks one |
| 62 | `Adelle M. Reynolds` | duplicate of user 51, out of scope here |

None of these blocks the deploy: the grandfathering rule means each of these people can still save their own profile with the name already stored. Do not carry dev-run ids (1456/1486/1487/1488/1497/1499) into the prod operation.

## Revision history

- **rev 3.3, 2026-08-04.** Ship fold (batches 3-4; lane merged as 64b1e038). Three plan snippets were wrong and are corrected by the shipped code, recorded here so a re-run never transcribes them: Task 13's OverviewPage snippet declared `loadNameNotices`/`ackNameNotice` BELOW the effect whose dependency array references them (a temporal-dead-zone ReferenceError on every admin render — the `useCallback`s must precede the effect); Task 13's meta-cell snippet nested the `queue-meta-btn` button inside the existing `queue-meta` div (render either, not both); Task 12's legal-name row must be a `dt`/`dd` pair (its non-editing container is a `dl`). Security-checkpoint folds: the ack route is integer-guarded, scoped `AND preferred_name_reviewed_at IS NULL`, 404s on no-op; ContractorProfile mirrors server grandfathering client-side (validate only a CHANGED name) so legacy-name staffers can still save, restoring this plan's own operator-table promise. Task 14 Step 2's serial-suite command needs `NODE_ENV=test` (calcom + drinkPlanConsult self-guard and abort without it); its four observed failures were all main-side debts (two = that env guard, one expired balanceReminderScheduling fixture red since ~7/16, one payrollDisputeNotify 400ms flake), now on the fix-list.
- **rev 3.2, 2026-08-04.** Checkpoint-2 fold. Task 7 gains the `messages.js` recipient-log row (the four `POST /messages/send` INSERTs take the display name per the standing beoHandlers/staffShiftHandlers ruling; the previously claimed exemption was verified unrecorded). Fix round also contained: the `payment.noNameWrite` suite now stubs the `getStripe` seam before any require (its first runs hit LIVE Stripe — two orphaned live Payment Links pending deactivation); the two post-commit `refreshDisplayName` awaits are try/catch+Sentry contained; admin name validation joins `fieldErrors`. Deferred to final review: `readPreferredName` dedup, PaydayProtocols same-tab Link, and suite coverage for the four messages INSERTs.
- **rev 3.1, 2026-08-04.** Build-time amendments from the lane's checkpoint reviews. Operator hand-fix table trued to a live-prod dry run of the committed validator (205 out — already `Nevver`; 15 in; trim count 10 not 8; dev ids flagged do-not-carry). Task 13's harness call becomes `refreshDisplayName(userId, pool)` — the batch-2 pre-work dropped the helper's `= pool` default so an unthreaded transaction client fails loudly instead of deadlocking the pool.
- **rev 1, 2026-07-26.** First draft (13 tasks). The `plan-fidelity` / `plan-decomposition` / `plan-feasibility` fleet returned 11 blockers.
- **rev 2, 2026-07-26.** Full rewrite against the fleet's blockers, plus a same-day correction pass: the single mechanical read swap became the five-shape per-site table, line-range anchors became text anchors where Task 5 shifts them, and the three-lane split collapsed to one lane after four of thirteen tasks proved to edit outside their own footprint.
- **rev 3, 2026-08-04.** Freshness audit against main at `9141171a` (~113 commits after rev 2), applied as targeted amendments. Four findings would have broken the build or the tests outright: (1) Task 6's harness could never see a 200, because POST `/api/payment` enforces a server-side W-9 (`:112-114`, predates the plan) that 400s before the name logic; the harness now seeds a reusable W-9 row. (2) Task 3's application fixture omitted `positions_interested` (NOT NULL, no default), a 23502 before the agreement-precedence assertion ever ran. (3) Task 7 Step 2 targeted deleted code: the 8/03 staff event-details revival (beda7043) gutted `beo.js` to 164 lines and moved the roster + local `computeName` into `server/utils/eventDetailsPayload.js` (now shared with the staff portal's shift-keyed `eventDetails.js`); the step is rewritten against the payload builder (`computeName` `:241-260`, call site `:271`), with beo.test.js/eventDetails.test.js fixture-survival verified fixture-by-fixture. (4) Task 13's `buildStaffingItems` gained a third `uncertified` parameter plus a RANK sort from the 7/26 document-visibility lane, so the planned `(…, nameNotices, onAck)` extension would have parked notices in the documents slot and rendered "undefined has no alcohol certification"; the signature is now `(unstaffed, newApplications, uncertified, nameNotices, onAck)`, the loop sits before the sort, the test case carries the load-bearing empty `[]`, and the `'user'` target edit is dropped entirely because `queueItemHref` moved to `queueItems.js` and already maps it.

  New post-plan display surfaces joined the Task 7 sweep: `serviceExtensions/admin.js:74-75` (admin panel "Requested by / Overridden by" labels, shipped 8/03), `outstandingDocuments.js:43` (`DISPLAY_NAME` behind the needs-attention documents rows, shipped 7/26 after this plan), and `eventDetailsPayload.js:107` (the relocated ack-list projection, now ordering-only but swapped so Task 14's sweep gate stays clean); their three suites joined the Task 7 run list, and the two utils joined the lane footprint. Task 14's reverse grep gained its two honest exemptions (`staffHiringEmailTemplates.js:290` self-salutation; `exportKnownPeople.js:38` archived import tooling), and its untouched-salutation diff gained `gratuityStaffNotice.js`, `staffHiringEmailTemplates.js`, and `coverBroadcast.js`.

  Resolved by intervening code rather than drifted: `admin/users.js`'s hire path now definitively seeds through `seedContractorProfileFromApplication`, so Task 5 Step 7's conditional refresh there is deleted and the helper-internal refresh (Step 9) covers all three of that helper's callers, including two the plan never knew (`application.js:245` pre-hired submit, `auth.js:229` register-with-application). Task 10 was re-anchored to the draft-lane rebuild of `ContractorProfile.js` (rules `:112`, scroll `:131`, field block `:197-201`) with two new placement rules keeping `legal_name` out of reach of the `useFormDraft` overlay; the staff HomePage cover-broadcast initial derivation is documented as degrading to a no-op after the Shape B swap. Verified still current, unlisted here only when exact: every Task 8 money cite, all of Task 9 (route path, alias `c`, ORDER BY, `staff_payment_history` constraints, now cited at `:4043-4059`), Task 11, all Task 12 client cites, `auth.js:317,367`, `paystubData.js:40`, publicTip's allowlist comment, the admin composition router's non-overlap header, the 929/919 file-size claims, and the `.queue-meta-btn` absence. Stale line cites corrected throughout (`contractor.js` −1/+9, `payment.js` +1 and the telemetry DANGER block now `:162-175`, `shifts.js` −5, `shifts.queries.js` `:48`, `schema.sql` `contractor_profiles` end `:95`, `me.js` `:120`, `index.css` +9, `auth` exports `:140`, `contractorSeed` upsert `:17-94`).
