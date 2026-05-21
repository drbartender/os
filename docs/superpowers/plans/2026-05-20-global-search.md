# Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin one search, reachable from every admin page, that finds a person and their records by partial name, phone, or email across clients, proposals, events, and staff.

**Architecture:** A new read-only endpoint `GET /api/admin/search` returns four capped result groups. The query logic lives in a standalone util (`server/utils/globalSearch.js`) so it can be unit-tested directly, matching the codebase's pattern of testing util functions rather than routes. The existing `⌘K` `CommandPalette` (already on every admin page, already carrying a TODO for exactly this) gets a debounced live-results section wired to the endpoint. No schema change.

**Tech Stack:** Node.js / Express, raw SQL via `pg`, React 18, the built-in `node:test` runner (server), CRA Jest (client).

**Spec:** `docs/superpowers/specs/2026-05-20-global-search-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/utils/globalSearch.js` | Create | Pure helpers (LIKE-escaping, phone-digit extraction, phone formatting, status labels) and `runGlobalSearch`, which runs the four group queries and shapes results. |
| `server/utils/globalSearch.test.js` | Create | `node:test` suite: pure-helper tests (offline) plus a database-backed `runGlobalSearch` test against the `clients` table. |
| `server/routes/admin/search.js` | Create | Thin Express router: `GET /search`, `auth, requireAdminOrManager`, delegates to `runGlobalSearch`. |
| `server/routes/admin/index.js` | Modify | Mount the new search sub-router. |
| `client/src/components/adminos/CommandPalette.js` | Modify | Add a debounced query, live result groups, loading / empty / error states, and result-to-route navigation. |
| `client/src/index.css` | Modify | One rule for the result-row sub-label. |
| `ARCHITECTURE.md` | Modify | Add `GET /api/admin/search` to the Admin route table. |
| `README.md` | Modify | Add the two new files to the folder tree and a Key Features note. |

**Commits:** Two. Commit 1 after Task 2 (the tested search utility). Commit 2 after Task 4 (the endpoint and command-palette wiring, verified together in the browser). Tasks 1 and 3 do not commit on their own.

---

## Task 1: Pure search helpers

Pure, database-free functions. Written and tested first because they hold the subtle logic (LIKE-metacharacter escaping, phone-digit normalization) and need no fixtures.

**Files:**
- Create: `server/utils/globalSearch.js`
- Create: `server/utils/globalSearch.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/globalSearch.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
} = require('./globalSearch');

test('escapeLikePattern > escapes LIKE wildcards and the escape char', () => {
  assert.strictEqual(escapeLikePattern('50%'), '50\\%');
  assert.strictEqual(escapeLikePattern('a_b'), 'a\\_b');
  assert.strictEqual(escapeLikePattern('x\\y'), 'x\\\\y');
  assert.strictEqual(escapeLikePattern('plain'), 'plain');
});

test('extractDigits > keeps only digits', () => {
  assert.strictEqual(extractDigits('(555) 867-5309'), '5558675309');
  assert.strictEqual(extractDigits('Gandalf'), '');
  assert.strictEqual(extractDigits(''), '');
  assert.strictEqual(extractDigits(null), '');
});

test('formatPhoneDisplay > formats a clean 10-digit number', () => {
  assert.strictEqual(formatPhoneDisplay('5558675309'), '(555) 867-5309');
  assert.strictEqual(formatPhoneDisplay('(555) 867-5309'), '(555) 867-5309');
});

test('formatPhoneDisplay > passes through anything that is not 10 digits', () => {
  assert.strictEqual(formatPhoneDisplay('123'), '123');
  assert.strictEqual(formatPhoneDisplay(''), '');
  assert.strictEqual(formatPhoneDisplay(null), '');
});

test('humanizeStaffStatus > maps known statuses and falls back', () => {
  assert.strictEqual(humanizeStaffStatus('approved'), 'Active bartender');
  assert.strictEqual(humanizeStaffStatus('applied'), 'Applicant (applied)');
  assert.strictEqual(humanizeStaffStatus('rejected'), 'Rejected applicant');
  assert.strictEqual(humanizeStaffStatus('something_else'), 'Staff');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/globalSearch.test.js`
Expected: FAIL. The test file cannot load because `./globalSearch` does not exist yet (`Cannot find module`).

- [ ] **Step 3: Write the minimal implementation**

Create `server/utils/globalSearch.js`:

```js
// Global record search helpers. Pure functions shared by runGlobalSearch
// (added in the next task) and exercised directly by the unit tests.

const STAFF_STATUS_LABELS = new Map([
  ['in_progress', 'Applicant (incomplete)'],
  ['applied', 'Applicant (applied)'],
  ['interviewing', 'Applicant (interviewing)'],
  ['hired', 'Onboarding'],
  ['submitted', 'Active bartender'],
  ['reviewed', 'Active bartender'],
  ['approved', 'Active bartender'],
  ['rejected', 'Rejected applicant'],
  ['deactivated', 'Deactivated'],
]);

// Escape LIKE metacharacters (and the escape char itself) so a typed `%` or
// `_` matches literally instead of expanding into a wildcard scan.
function escapeLikePattern(term) {
  return String(term).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// Strip everything but digits. Normalizes a typed phone fragment so it can be
// compared against an equally-normalized stored column.
function extractDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

// Render a stored phone as (XXX) XXX-XXXX. Anything that is not a clean
// 10-digit number is returned unchanged so partial values still display.
function formatPhoneDisplay(raw) {
  const d = extractDigits(raw);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw == null ? '' : String(raw);
}

// Map a user's onboarding_status to a short human label for the staff result.
function humanizeStaffStatus(status) {
  return STAFF_STATUS_LABELS.get(status) || 'Staff';
}

module.exports = {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/globalSearch.test.js`
Expected: PASS. 5 tests passing, 0 failing.

- [ ] **Step 5: No commit yet**

Continue to Task 2. The commit at the end of Task 2 covers Tasks 1 and 2 together.

---

## Task 2: `runGlobalSearch` query engine

Add the database-backed search function and a fixture-backed test for it.

**Files:**
- Modify: `server/utils/globalSearch.js` (replace with the complete version below)
- Modify: `server/utils/globalSearch.test.js` (replace with the complete version below)
- Modify: `README.md` (folder tree)

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `server/utils/globalSearch.test.js` with:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
  runGlobalSearch,
} = require('./globalSearch');

// ---- pure helpers (no database) ----

test('escapeLikePattern > escapes LIKE wildcards and the escape char', () => {
  assert.strictEqual(escapeLikePattern('50%'), '50\\%');
  assert.strictEqual(escapeLikePattern('a_b'), 'a\\_b');
  assert.strictEqual(escapeLikePattern('x\\y'), 'x\\\\y');
  assert.strictEqual(escapeLikePattern('plain'), 'plain');
});

test('extractDigits > keeps only digits', () => {
  assert.strictEqual(extractDigits('(555) 867-5309'), '5558675309');
  assert.strictEqual(extractDigits('Gandalf'), '');
  assert.strictEqual(extractDigits(''), '');
  assert.strictEqual(extractDigits(null), '');
});

test('formatPhoneDisplay > formats a clean 10-digit number', () => {
  assert.strictEqual(formatPhoneDisplay('5558675309'), '(555) 867-5309');
  assert.strictEqual(formatPhoneDisplay('(555) 867-5309'), '(555) 867-5309');
});

test('formatPhoneDisplay > passes through anything that is not 10 digits', () => {
  assert.strictEqual(formatPhoneDisplay('123'), '123');
  assert.strictEqual(formatPhoneDisplay(''), '');
  assert.strictEqual(formatPhoneDisplay(null), '');
});

test('humanizeStaffStatus > maps known statuses and falls back', () => {
  assert.strictEqual(humanizeStaffStatus('approved'), 'Active bartender');
  assert.strictEqual(humanizeStaffStatus('applied'), 'Applicant (applied)');
  assert.strictEqual(humanizeStaffStatus('rejected'), 'Rejected applicant');
  assert.strictEqual(humanizeStaffStatus('something_else'), 'Staff');
});

// ---- runGlobalSearch (hits the local database) ----
// Fixture client name carries a recognizable prefix so cleanup is exact.

const MARKER = 'zz_searchtest_';

before(async () => {
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, 'direct')`,
    [`${MARKER}gandalf`, `${MARKER}grey@example.com`, '(555) 867-5309']
  );
});

after(async () => {
  await pool.query("DELETE FROM clients WHERE name LIKE 'zz_searchtest_%'");
  await pool.end();
});

test('runGlobalSearch > matches a client by partial name', async () => {
  const { clients } = await runGlobalSearch('gandalf');
  assert.ok(clients.some((c) => c.type === 'client' && c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > matches a client by partial email', async () => {
  const { clients } = await runGlobalSearch('grey@exam');
  assert.ok(clients.some((c) => c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > matches a client by phone digits despite stored formatting', async () => {
  const { clients } = await runGlobalSearch('867-5309');
  assert.ok(clients.some((c) => c.name === `${MARKER}gandalf`));
});

test('runGlobalSearch > returns empty groups for a query under 2 characters', async () => {
  const res = await runGlobalSearch('g');
  assert.deepStrictEqual(res, { clients: [], proposals: [], events: [], staff: [] });
});

test('runGlobalSearch > returns empty groups for a query over 100 characters', async () => {
  const res = await runGlobalSearch('x'.repeat(101));
  assert.deepStrictEqual(res, { clients: [], proposals: [], events: [], staff: [] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/globalSearch.test.js`
Expected: FAIL. The pure-helper tests still pass, but the five `runGlobalSearch` tests fail because `runGlobalSearch` is `undefined` (`runGlobalSearch is not a function`).

Note: this test connects to the local PostgreSQL database using `.env`, the same as `server/utils/messageScheduling.test.js`. The local database must be running.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `server/utils/globalSearch.js` with:

```js
// Global record search. Powers GET /api/admin/search and the Cmd/Ctrl+K
// command palette: one query string matched against clients, proposals,
// events, and staff by partial name, email, or phone number.

const { pool } = require('../db');
const { getEventTypeLabel } = require('./eventTypes');

const GROUP_LIMIT = 6;

const STAFF_STATUS_LABELS = new Map([
  ['in_progress', 'Applicant (incomplete)'],
  ['applied', 'Applicant (applied)'],
  ['interviewing', 'Applicant (interviewing)'],
  ['hired', 'Onboarding'],
  ['submitted', 'Active bartender'],
  ['reviewed', 'Active bartender'],
  ['approved', 'Active bartender'],
  ['rejected', 'Rejected applicant'],
  ['deactivated', 'Deactivated'],
]);

// Escape LIKE metacharacters (and the escape char itself) so a typed `%` or
// `_` matches literally instead of expanding into a wildcard scan.
function escapeLikePattern(term) {
  return String(term).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// Strip everything but digits. Normalizes a typed phone fragment so it can be
// compared against an equally-normalized stored column.
function extractDigits(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

// Render a stored phone as (XXX) XXX-XXXX. Anything that is not a clean
// 10-digit number is returned unchanged so partial values still display.
function formatPhoneDisplay(raw) {
  const d = extractDigits(raw);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw == null ? '' : String(raw);
}

// Map a user's onboarding_status to a short human label for the staff result.
function humanizeStaffStatus(status) {
  return STAFF_STATUS_LABELS.get(status) || 'Staff';
}

// Compose the sub-label for a proposal or event row: event type, then the
// formatted event date when one is set.
function eventDetail(row) {
  const label = getEventTypeLabel({
    event_type: row.event_type,
    event_type_custom: row.event_type_custom,
  });
  return [label, row.event_date_label].filter(Boolean).join(' · ');
}

// Run the global search. `rawQuery` is the user's typed string. Returns four
// capped, most-recent-first result groups. A query shorter than 2 characters
// or longer than 100 short-circuits to empty groups without touching the
// database; the upper bound caps the cost of the unindexed LIKE scans.
async function runGlobalSearch(rawQuery) {
  const q = String(rawQuery == null ? '' : rawQuery).trim();
  const empty = { clients: [], proposals: [], events: [], staff: [] };
  if (q.length < 2 || q.length > 100) return empty;

  const likeTerm = '%' + escapeLikePattern(q.toLowerCase()) + '%';
  const digits = extractDigits(q);
  // Only match phone columns once at least 3 digits are typed, otherwise a
  // one- or two-digit fragment matches nearly every stored number.
  const phoneTerm = digits.length >= 3 ? '%' + digits + '%' : null;
  const params = [likeTerm, phoneTerm, GROUP_LIMIT];

  const clientsSql = `
    SELECT c.id, c.name, c.email, c.phone
    FROM clients c
    WHERE LOWER(c.name) LIKE $1 ESCAPE '\\'
       OR LOWER(c.email) LIKE $1 ESCAPE '\\'
       OR ($2::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2)
    ORDER BY c.created_at DESC
    LIMIT $3
  `;

  const proposalsSql = `
    SELECT p.id, c.name AS client_name, p.event_type, p.event_type_custom,
           to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status NOT IN ('deposit_paid','balance_paid','confirmed','completed','archived')
      AND (
        LOWER(c.name) LIKE $1 ESCAPE '\\'
        OR LOWER(c.email) LIKE $1 ESCAPE '\\'
        OR ($2::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2)
      )
    ORDER BY p.created_at DESC
    LIMIT $3
  `;

  const eventsSql = `
    SELECT p.id, c.name AS client_name, p.event_type, p.event_type_custom,
           to_char(p.event_date, 'FMMon FMDD, YYYY') AS event_date_label
    FROM proposals p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status IN ('deposit_paid','balance_paid','confirmed','completed')
      AND (
        LOWER(c.name) LIKE $1 ESCAPE '\\'
        OR LOWER(c.email) LIKE $1 ESCAPE '\\'
        OR ($2::text IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE $2)
      )
    ORDER BY p.created_at DESC
    LIMIT $3
  `;

  const staffSql = `
    SELECT u.id,
           COALESCE(cp.preferred_name, a.full_name, u.email) AS name,
           u.onboarding_status
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN applications a ON a.user_id = u.id
    WHERE u.role IN ('staff','manager')
      AND (
        LOWER(u.email) LIKE $1 ESCAPE '\\'
        OR LOWER(cp.preferred_name) LIKE $1 ESCAPE '\\'
        OR LOWER(cp.email) LIKE $1 ESCAPE '\\'
        OR LOWER(a.full_name) LIKE $1 ESCAPE '\\'
        OR ($2::text IS NOT NULL AND regexp_replace(cp.phone, '[^0-9]', '', 'g') LIKE $2)
        OR ($2::text IS NOT NULL AND regexp_replace(a.phone, '[^0-9]', '', 'g') LIKE $2)
      )
    ORDER BY u.created_at DESC
    LIMIT $3
  `;

  const [clients, proposals, events, staff] = await Promise.all([
    pool.query(clientsSql, params),
    pool.query(proposalsSql, params),
    pool.query(eventsSql, params),
    pool.query(staffSql, params),
  ]);

  return {
    clients: clients.rows.map((r) => ({
      type: 'client',
      id: r.id,
      name: r.name,
      detail: r.email || formatPhoneDisplay(r.phone),
    })),
    proposals: proposals.rows.map((r) => ({
      type: 'proposal',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
    })),
    events: events.rows.map((r) => ({
      type: 'event',
      id: r.id,
      name: r.client_name,
      detail: eventDetail(r),
    })),
    staff: staff.rows.map((r) => ({
      type: 'staff',
      id: r.id,
      name: r.name,
      detail: humanizeStaffStatus(r.onboarding_status),
    })),
  };
}

module.exports = {
  escapeLikePattern,
  extractDigits,
  formatPhoneDisplay,
  humanizeStaffStatus,
  runGlobalSearch,
};
```

Notes for the implementer:
- The phone clause normalizes the stored column with `regexp_replace(col, '[^0-9]', '', 'g')`. `[^0-9]` is used rather than `\D` deliberately: `\D` inside a JavaScript string literal would lose its backslash and reach Postgres as the literal letter `D`.
- `ESCAPE '\\'` in the JavaScript template literal reaches Postgres as `ESCAPE '\'`. This matches the existing pattern in `server/routes/admin/hiring.js`.
- When `phoneTerm` is `null`, the guard `$2::text IS NOT NULL` makes the phone branch false, so a name-only query never scans phone columns.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/globalSearch.test.js`
Expected: PASS. 10 tests passing, 0 failing. The phone test passing confirms a digit-only query (`867-5309`) matches a client whose phone is stored with formatting (`(555) 867-5309`).

- [ ] **Step 5: Run the server linter**

Run: `npm run lint`
Expected: no errors for `server/utils/globalSearch.js` or `server/utils/globalSearch.test.js`.

- [ ] **Step 6: Update the README folder tree**

In `README.md`, find this pair of lines in the `server/utils/` section:

```
│   │   ├── geocode.js          # Nominatim geocoding (address → lat/lng)
│   │   ├── invoiceHelpers.js   # Invoice auto-generation, line items, locking
```

Replace it with:

```
│   │   ├── geocode.js          # Nominatim geocoding (address → lat/lng)
│   │   ├── globalSearch.js     # Global record search query engine (clients/proposals/events/staff)
│   │   ├── invoiceHelpers.js   # Invoice auto-generation, line items, locking
```

- [ ] **Step 7: Commit**

```bash
git add server/utils/globalSearch.js server/utils/globalSearch.test.js README.md
git commit -m "feat(search): global record search query utility"
```

---

## Task 3: `/api/admin/search` endpoint

A thin router that exposes `runGlobalSearch`. No automated test (the project has no route-test harness; routes are verified through their callers). The endpoint is exercised end-to-end in Task 4.

**Files:**
- Create: `server/routes/admin/search.js`
- Modify: `server/routes/admin/index.js`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Create the route file**

Create `server/routes/admin/search.js`:

```js
// GET /api/admin/search — global record search powering the Cmd/Ctrl+K
// command palette. Read-only; matches clients, proposals, events, and staff
// by partial name, email, or phone. Search logic lives in
// server/utils/globalSearch.js so it can be unit-tested directly.

const express = require('express');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { runGlobalSearch } = require('../../utils/globalSearch');

const router = express.Router();

router.get('/search', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const results = await runGlobalSearch(req.query.q);
  res.json({ results });
}));

module.exports = router;
```

- [ ] **Step 2: Mount the sub-router**

In `server/routes/admin/index.js`, find:

```js
router.use('/', require('./labratBugs'));

module.exports = router;
```

Replace it with:

```js
router.use('/', require('./labratBugs'));
router.use('/', require('./search'));

module.exports = router;
```

- [ ] **Step 3: Run the server linter**

Run: `npm run lint`
Expected: no errors for `server/routes/admin/search.js`.

- [ ] **Step 4: Update the ARCHITECTURE route table**

In `ARCHITECTURE.md`, find this row in the Admin route table:

```
| GET | `/hiring/search` | Admin | Cross-state applicant search (Applied/Interview/Onboarding/Active/Rejected/Unfinished) |
```

Add a new row directly after it:

```
| GET | `/hiring/search` | Admin | Cross-state applicant search (Applied/Interview/Onboarding/Active/Rejected/Unfinished) |
| GET | `/search` | Admin/Manager | Global record search across clients, proposals, events, staff (matches partial name / email / phone) |
```

- [ ] **Step 5: Update the README folder tree**

In `README.md`, find this pair of lines in the `server/routes/admin/` section:

```
│   │   │   ├── settings.js     # /settings + /test-email + /backfill-geocodes + /badge-counts (incl. open_tester_bugs)
│   │   │   └── labratBugs.js   # /tester-bugs (list + PATCH triage state for the LabRatBugsPage)
```

Replace it with:

```
│   │   │   ├── settings.js     # /settings + /test-email + /backfill-geocodes + /badge-counts (incl. open_tester_bugs)
│   │   │   ├── labratBugs.js   # /tester-bugs (list + PATCH triage state for the LabRatBugsPage)
│   │   │   └── search.js       # /search — global record search across clients/proposals/events/staff
```

- [ ] **Step 6: No commit yet**

Continue to Task 4. The endpoint is only observable through the command palette, so it is committed together with the frontend in Task 4 after a browser check.

---

## Task 4: Wire live search into the command palette

Replace `CommandPalette` with a version that runs a debounced search and renders live result groups, then add the result-row sub-label style.

**Files:**
- Modify: `client/src/components/adminos/CommandPalette.js` (replace with the complete version below)
- Modify: `client/src/index.css`
- Modify: `README.md`

- [ ] **Step 1: Replace the CommandPalette component**

Replace the entire contents of `client/src/components/adminos/CommandPalette.js` with:

```jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import api from '../../utils/api';
import useDebounce from '../../hooks/useDebounce';

// Result groups, in display order. `key` matches the endpoint response;
// `type` matches each result's `type` field and keys into PATH_BY_TYPE.
const RECORD_GROUPS = [
  { key: 'clients',   group: 'Clients',   type: 'client',   icon: 'users' },
  { key: 'proposals', group: 'Proposals', type: 'proposal', icon: 'clipboard' },
  { key: 'events',    group: 'Events',    type: 'event',    icon: 'calendar' },
  { key: 'staff',     group: 'Staff',     type: 'staff',    icon: 'userplus' },
];

const PATH_BY_TYPE = {
  client: '/clients',
  proposal: '/proposals',
  event: '/events',
  staff: '/staffing/users',
};

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  // Monotonic id: a response whose id is stale (input changed since) is dropped.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setLoading(false);
      setSearchError(false);
    }
  }, [open]);

  useDebounce(() => {
    const term = q.trim();
    if (term.length < 2) {
      reqIdRef.current += 1; // invalidate any in-flight request
      setResults(null);
      setLoading(false);
      setSearchError(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setSearchError(false);
    api.get('/admin/search', { params: { q: term } })
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        setResults(res.data.results);
        setLoading(false);
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setSearchError(true);
        setLoading(false);
      });
  }, 200, [q]);

  if (!open) return null;

  const go = (path) => () => { navigate(path); onClose(); };

  const navGroups = [
    { group: 'Jump to', items: [
      { label: 'Dashboard',   icon: 'home',      onClick: go('/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/hiring') },
      { label: 'Financials',  icon: 'dollar',    onClick: go('/financials') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',     onClick: go('/drink-plans') },
      { label: 'Cocktail Menu', icon: 'book',    onClick: go('/cocktail-menu') },
      { label: 'Lab Notes',   icon: 'pen',       onClick: go('/blog') },
      { label: 'Settings',    icon: 'gear',      onClick: go('/settings') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: go('/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: go('/email-marketing/campaigns/new') },
    ]},
  ];

  const filteredNav = navGroups
    .map(g => ({ ...g, items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter(g => g.items.length);

  const recordGroups = results
    ? RECORD_GROUPS
        .map(g => ({ ...g, items: results[g.key] || [] }))
        .filter(g => g.items.length)
    : [];

  const term = q.trim();
  const showNoMatches = !loading && !searchError && results && !recordGroups.length && term.length >= 2;
  const showNoResults = !recordGroups.length && !filteredNav.length && !loading && !searchError && !showNoMatches;

  return (
    <div className="palette-scrim open" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Search clients, proposals, events, staff…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list scroll-thin">
          {recordGroups.map(g => (
            <div key={g.key}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => {
                const path = `${PATH_BY_TYPE[it.type]}/${it.id}`;
                return (
                  <div key={`${it.type}-${it.id}`} className="palette-item" onClick={go(path)}
                    role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') go(path)(); }}>
                    <Icon name={g.icon} />
                    <div>
                      <div>{it.name}</div>
                      {it.detail && <div className="palette-item-sub">{it.detail}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {loading && <div className="palette-item muted">Searching…</div>}
          {searchError && <div className="palette-item muted">Search unavailable.</div>}
          {showNoMatches && <div className="palette-item muted">No matches for “{term}”.</div>}

          {filteredNav.map(g => (
            <div key={g.group}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => (
                <div key={it.label} className="palette-item" onClick={it.onClick} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') it.onClick(); }}>
                  <Icon name={it.icon} />
                  <div>
                    <div>{it.label}</div>
                  </div>
                  <div className="shortcut"><span className="kbd">↵</span></div>
                </div>
              ))}
            </div>
          ))}

          {showNoResults && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the sub-label style**

In `client/src/index.css`, find this line (around line 11512):

```css
html[data-app="admin-os"] .palette-item .shortcut { margin-left: auto; display: flex; gap: 3px; }
```

Add a new line directly after it:

```css
html[data-app="admin-os"] .palette-item .shortcut { margin-left: auto; display: flex; gap: 3px; }
html[data-app="admin-os"] .palette-item-sub { font-size: 11.5px; color: var(--ink-4); margin-top: 1px; }
```

- [ ] **Step 3: Verify the client build**

Run: `cd client; $env:CI='true'; npm run build`
Expected: `Compiled successfully` (or compiled with no errors). With `CI=true`, ESLint warnings are promoted to errors, so this catches unused imports and hook-dependency issues. Then `cd ..` to return to the repository root.

- [ ] **Step 4: Manual browser verification**

Make sure the dev server is running. If it was already running, restart it, because Tasks 1 through 3 changed server files (kill the process on port 5000 and relaunch via `npm run dev`).

In a browser, log in to the admin dashboard, then verify:

- Press `Ctrl+K` (or `Cmd+K`). The command palette opens.
- Type a known client's partial name. Within a moment a **Clients** group appears with matching rows; each row shows the name and an email or formatted phone beneath it.
- Type a fragment of a client's phone number (3 or more digits). The same client appears under **Clients**.
- Type a partial name of someone who has a live (unpaid) proposal. A **Proposals** group appears.
- Type a partial name of someone with a booked (paid) event. An **Events** group appears.
- Type a partial name or email of a staff member or applicant. A **Staff** group appears, each row showing a status label such as "Active bartender".
- Click a result in each group. The palette closes and navigates to that record's detail page (`/clients/:id`, `/proposals/:id`, `/events/:id`, `/staffing/users/:id`).
- Type a single character. No record groups show (only the static page jumps).
- Type a string that matches nothing (for example `zzzzzz`). "No matches for …" appears.
- Type a page name such as `events`. The static "Jump to" group still filters and works.

- [ ] **Step 5: Update the README Key Features**

In `README.md`, find:

```
### Admin Dashboard
- **Staffing**: Application review, hire/reject, interview notes, user management, SMS messaging (compose, recipient picker, shift invitation templates, grouped message history)
```

Replace it with:

```
### Admin Dashboard
- **Global Search**: A `Cmd/Ctrl+K` command palette on every admin page searches clients, proposals, events, and staff by partial name, phone number, or email, and jumps straight to the matching record.
- **Staffing**: Application review, hire/reject, interview notes, user management, SMS messaging (compose, recipient picker, shift invitation templates, grouped message history)
```

- [ ] **Step 6: Commit**

Commit only after the manual checklist in Step 4 passes.

```bash
git add server/routes/admin/search.js server/routes/admin/index.js client/src/components/adminos/CommandPalette.js client/src/index.css ARCHITECTURE.md README.md
git commit -m "feat(search): global search endpoint and command palette"
```

---

## Notes for the implementer

- **No schema change.** The dataset is small, so `ILIKE`-style scans and `regexp_replace` are instant. No migration, no index.
- **Out of scope** (do not add): archived proposals, search by proposal token or id, drink plans, invoices, cocktails, fuzzy matching, pagination, and search on the staff portal or public site.
- **Access:** the endpoint uses `auth, requireAdminOrManager`, matching the clients and proposals routes. Managers already see those records.
- **Server tests** run with `node --test <file>` and connect to the local database via `.env`, the same as `server/utils/messageScheduling.test.js`. There is no `npm test` script.
