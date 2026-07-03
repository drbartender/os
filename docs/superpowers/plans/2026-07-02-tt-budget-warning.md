---
spec: docs/superpowers/specs/2026-07-02-tt-budget-warning-design.md
lanes:
  - id: tt-budget-warning
    footprint:
      - server/routes/thumbtack.js
      - server/routes/thumbtack.test.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/getOne.js   # added at execution: crud.js hit the 1000-line ratchet, GET /:id extracted here (surfaced + approved in-session)
      - server/routes/proposals/index.js    # added at execution: mounts getOne last (greedy /:id)
      - server/db/schema.sql
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - client/src/index.css
      - README.md                           # added at execution: folder tree gained getOne.js
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # server/routes/thumbtack.js is on scripts/sensitive-paths.txt (webhook); schema change; max effort
    # EXECUTED 2026-07-02: squash-merged to main a4efe12. Fleet = 5 explicit PASS
    # (code/security/database/performance/consistency; perf agent misfired twice,
    # re-driven per the iron rule). Review quick wins folded in: idx_thumbtack_leads_proposal_id
    # + bounded entity-decode input. Owed: Dallas eyeball smoke (badge + panel line in the app).
---

# Thumbtack Budget Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse the budget a Thumbtack lead states in its Q&A into `thumbtack_leads` columns at webhook time, deliver it on the proposal payload, and flag pre-acceptance proposals whose computed total exceeds the stated cap with a red header badge plus a context line in the payment panel.

**Architecture:** A pure `extractBudget(details)` parser in the webhook route (sibling of `extractGuestCount`) feeds three new columns on `thumbtack_leads`. The single-proposal GET gains a lateral join so `budget_min` / `budget_max` / `budget_raw` ride the existing proposal payload (no new endpoint, no new client fetch). The badge and panel line are pure client-side renders off those fields, so proposal edits refresh the warning for free. Forward-only: NO backfill of existing leads.

**Tech Stack:** Express route (raw SQL via `pool.query`), `node:test` suites against the shared dev DB, React admin pages, vanilla CSS in `index.css`.

## Global Constraints

- Budget columns are integer WHOLE DOLLARS, never cents, matching `proposals.total_price` units (the documented proposals exception). Comment this at the schema and parser.
- `budget_max` NULL means "no cap known" ("I'm not sure" only, or any "More than $X" token). Null cap never flags.
- Badge renders ONLY on status `draft` or `sent`. The payment-panel line renders at every status. Admin-only; nothing client-facing.
- No em dashes in any copy (badge, tooltip, comments in client-visible strings).
- All SQL parameterized. Schema ALTERs idempotent (`ADD COLUMN IF NOT EXISTS`).
- Server suites run ALONE against the shared dev DB: `node --test server/routes/thumbtack.test.js`, then `node --test server/routes/proposals/crud.test.js` (never together; FK-collision teardown risk).
- The dev DB does NOT auto-apply `schema.sql`: Task 2 applies the ALTER by hand. Prod gets it via initDb on deploy.
- Commits are in-lane checkpoints (squashed at merge): explicit pathspec always, never `git add .`.
- `server/routes/thumbtack.js` is sensitive-path: full fleet at merge; no shortcuts.

---

### Task 1: `extractBudget` parser + `parseLead` pass-through

**Files:**
- Modify: `server/routes/thumbtack.js` (helpers section, after `extractGuestCount` ~line 92; both `parseLead` branches ~lines 134-152 and ~158-176; exports ~line 483)
- Test: `server/routes/thumbtack.test.js` (pure unit tests section, after the `extractGuestCount` tests ~line 32)

**Interfaces:**
- Consumes: nothing new; `details` is the existing `[{question, answer}]` array `parseLead` already handles.
- Produces: `extractBudget(details)` returning `{ budgetMin: number|null, budgetMax: number|null, budgetRaw: string|null }` (whole dollars); `parseLead(body)` result gains `budgetMin`, `budgetMax`, `budgetRaw` on BOTH the V4 and legacy branches. Task 2 reads `lead.budgetMin` / `lead.budgetMax` / `lead.budgetRaw`.

- [ ] **Step 1: Write the failing unit tests**

Add to `server/routes/thumbtack.test.js` directly after the `extractGuestCount` tests (~line 32), before the `computeDurationHours` tests:

```js
// Pure unit tests for the stated-budget parser (exported from thumbtack.js).
// Answer shapes below are real prod payload values verified 2026-07-02
// (see the spec's Production findings).
test('extractBudget: single range', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$300 - $400' }]),
    { budgetMin: 300, budgetMax: 400, budgetRaw: '$300 - $400' }
  );
});
test('extractBudget: multi-select collapses to min-of-mins / max-of-maxes', () => {
  const raw = '$300 - $400, $400 - $500, $200 - $300 (typically only for small/brief events)';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 200, budgetMax: 500, budgetRaw: raw }
  );
});
test('extractBudget: "Under $200" bounds [0, 200]', () => {
  const raw = 'Under $200 (typically only for small/brief events)';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 0, budgetMax: 200, budgetRaw: raw }
  );
});
test('extractBudget: "More than $750" leaves an open max (no flag possible)', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'More than $750' }]),
    { budgetMin: 750, budgetMax: null, budgetRaw: 'More than $750' }
  );
});
test('extractBudget: any "More than" token forces the open max even mixed with ranges', () => {
  const raw = 'More than $750, $500 - $600, $600- $750';
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: raw }]),
    { budgetMin: 500, budgetMax: null, budgetRaw: raw }
  );
});
test('extractBudget: unsure-only is all nulls (entity-decoded before matching)', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'I&#39;m not sure' }]),
    { budgetMin: null, budgetMax: null, budgetRaw: null }
  );
});
test('extractBudget: unsure token mixed with a range is ignored, raw keeps the decoded answer', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'I&#39;m not sure, $300 - $400' }]),
    { budgetMin: 300, budgetMax: 400, budgetRaw: "I'm not sure, $300 - $400" }
  );
});
test('extractBudget: free-form "$300 to $600" and the missing-space "$600- $750"', () => {
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$300 to $600' }]),
    { budgetMin: 300, budgetMax: 600, budgetRaw: '$300 to $600' }
  );
  assert.deepEqual(
    thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$600- $750' }]),
    { budgetMin: 600, budgetMax: 750, budgetRaw: '$600- $750' }
  );
});
test('extractBudget: no budget question, junk answer, bare single number, or null details are all nulls', () => {
  const NULLS = { budgetMin: null, budgetMax: null, budgetRaw: null };
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Beverage types', answer: 'Beer, Wine' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Budget', answer: 'call me to discuss' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget([{ question: 'Budget', answer: '$400' }]), NULLS);
  assert.deepEqual(thumbtackRouter.extractBudget(null), NULLS);
});
test('parseLead: V4 and legacy both carry the budget fields', () => {
  const v4 = thumbtackRouter.parseLead({
    event: { eventType: 'NewLeadV4' },
    data: { negotiationID: 'neg-budget', request: { details: [{ question: 'Budget', answer: '$300 - $400' }] } },
  });
  assert.equal(v4.budgetMin, 300);
  assert.equal(v4.budgetMax, 400);
  assert.equal(v4.budgetRaw, '$300 - $400');
  const legacy = thumbtackRouter.parseLead({
    leadID: 'lead-budget',
    request: { details: [{ question: 'Budget', answer: 'More than $750' }] },
  });
  assert.equal(legacy.budgetMin, 750);
  assert.equal(legacy.budgetMax, null);
  assert.equal(legacy.budgetRaw, 'More than $750');
});
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `node --test server/routes/thumbtack.test.js`
Expected: the new `extractBudget` tests FAIL with `TypeError: thumbtackRouter.extractBudget is not a function`; existing tests still pass.

- [ ] **Step 3: Implement the parser**

In `server/routes/thumbtack.js`, insert after `extractGuestCount` (after ~line 92):

```js
/** Minimal HTML-entity decode for Thumbtack Q&A answers (prod sends e.g. I&#39;m). */
function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Stated budget from the Thumbtack details Q&A. The answer is a comma-joined
 * multi-select of ranges ("Under $200 (...)", "$300 - $400", "$600- $750",
 * "More than $750", "I'm not sure"). Returns integer WHOLE DOLLARS, matching
 * proposals.total_price units (the documented proposals dollars exception):
 *   { budgetMin, budgetMax, budgetRaw }
 * budgetMax null = no cap known (unsure-only, or ANY "More than $X" token),
 * so the over-budget badge can never fire. All three null when no budget
 * question exists or nothing parses. A bare single number with no under/more
 * keyword contributes nothing: not an observed prod shape, and guessing a
 * bound from it risks a wrong flag.
 */
function extractBudget(details) {
  const NONE = { budgetMin: null, budgetMax: null, budgetRaw: null };
  if (!Array.isArray(details)) return NONE;
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    if (!String(d.question || '').toLowerCase().includes('budget')) continue;
    const raw = decodeEntities(String(d.answer || '')).slice(0, 500);
    let min = null;
    let max = null;
    let openMax = false;
    for (const token of raw.split(',')) {
      const t = token.trim().toLowerCase();
      if (!t || t.includes('not sure')) continue;
      // 50..100000 filter: discards thousands-separator shrapnel (a "$1,000"
      // split on commas yields junk fragments) and zero/absurd values.
      const nums = (t.match(/\d+/g) || []).map(Number).filter((n) => n >= 50 && n <= 100000);
      if (!nums.length) continue;
      if (/\bunder\b|\bless than\b/.test(t)) {
        min = 0;
        max = max === null ? nums[0] : Math.max(max, nums[0]);
      } else if (/\bmore than\b|\bover\b|\babove\b/.test(t)) {
        min = min === null ? nums[0] : Math.min(min, nums[0]);
        openMax = true;
      } else if (nums.length >= 2) {
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        min = min === null ? lo : Math.min(min, lo);
        max = max === null ? hi : Math.max(max, hi);
      }
      // single bare number with no keyword: contributes nothing
    }
    if (min === null && max === null) return NONE;
    if (openMax) max = null;
    return { budgetMin: min, budgetMax: max, budgetRaw: raw };
  }
  return NONE;
}
```

Note on `Under` + earlier range mixes: `min = 0` unconditionally in the under-branch is correct because 0 is always the lowest possible min.

- [ ] **Step 4: Thread the fields through `parseLead`**

In the V4 branch's return object (after `guestCount: extractGuestCount(req.details),` ~line 150), add:

```js
      ...extractBudget(req.details),
```

In the legacy branch's return object (after `guestCount: extractGuestCount(req.details),` ~line 174), add the same line:

```js
    ...extractBudget(req.details),
```

At the exports block (bottom of file, beside `module.exports.extractGuestCount`), add:

```js
module.exports.extractBudget = extractBudget; // exported for unit tests
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `node --test server/routes/thumbtack.test.js`
Expected: PASS (all tests, new and pre-existing).

- [ ] **Step 6: Commit (checkpoint)**

```bash
git add server/routes/thumbtack.js server/routes/thumbtack.test.js
git commit -m "feat(thumbtack): parse stated budget from lead Q&A (extractBudget + parseLead pass-through)"
```

---

### Task 2: schema columns, webhook INSERT, integration test, docs

**Files:**
- Modify: `server/db/schema.sql` (after the `event_duration` ALTER on `thumbtack_leads`, ~line 1743)
- Modify: `server/routes/thumbtack.js` (the lead INSERT, ~lines 275-290)
- Test: `server/routes/thumbtack.test.js` (webhook integration section)
- Modify: `ARCHITECTURE.md` (~line 1193, the `thumbtack_leads` schema block)

**Interfaces:**
- Consumes: `lead.budgetMin` / `lead.budgetMax` / `lead.budgetRaw` from Task 1's `parseLead`.
- Produces: `thumbtack_leads.budget_min INTEGER`, `budget_max INTEGER`, `budget_raw TEXT`, populated on every new lead INSERT. Task 3 reads these columns.

- [ ] **Step 1: Add the idempotent schema ALTER**

In `server/db/schema.sql`, directly after the `ALTER COLUMN event_duration TYPE NUMERIC(4,1);` statement on `thumbtack_leads` (~line 1743), add:

```sql
-- Stated budget parsed from the lead's Q&A at webhook time (extractBudget in
-- routes/thumbtack.js). WHOLE DOLLARS, not cents, matching proposals.total_price
-- units (the documented proposals exception). budget_max NULL = no cap known
-- ("I'm not sure" or any "More than $X" answer): the over-budget badge never
-- fires. budget_raw = the decoded original answer, for admin display.
-- Forward-only by design: existing leads are NOT backfilled (2026-07-02).
ALTER TABLE thumbtack_leads
  ADD COLUMN IF NOT EXISTS budget_min INTEGER,
  ADD COLUMN IF NOT EXISTS budget_max INTEGER,
  ADD COLUMN IF NOT EXISTS budget_raw TEXT;
```

- [ ] **Step 2: Apply the ALTER to the dev DB by hand**

schema.sql is not auto-applied to dev. From the repo root:

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query('ALTER TABLE thumbtack_leads ADD COLUMN IF NOT EXISTS budget_min INTEGER, ADD COLUMN IF NOT EXISTS budget_max INTEGER, ADD COLUMN IF NOT EXISTS budget_raw TEXT').then(()=>{console.log('dev DB: budget columns applied');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```

Expected output: `dev DB: budget columns applied`

- [ ] **Step 3: Write the failing integration test**

In `server/routes/thumbtack.test.js`:

Extend the neg-id declarations (~lines 72-75). The existing lines are:

```js
const negA = `test-fail-${Date.now()}`;
const negB = `test-pii-${Date.now()}`;
const negC = `test-half-${Date.now()}`;
const created = { negotiationIds: [negA, negB, negC], proposalIds: [], clientIds: [] };
```

Change to:

```js
const negA = `test-fail-${Date.now()}`;
const negB = `test-pii-${Date.now()}`;
const negC = `test-half-${Date.now()}`;
const negD = `test-budget-${Date.now()}`;
const created = { negotiationIds: [negA, negB, negC, negD], proposalIds: [], clientIds: [] };
```

Add a payload helper next to `postLeadV4` (~line 127):

```js
// V4 lead whose details carry a stated Budget answer (multi-select,
// entity-encoded exactly like real prod payloads).
function postLeadV4Budget(negotiationId, budgetAnswer) {
  const body = JSON.stringify({
    event: { eventType: 'NewLeadV4' },
    data: {
      negotiationID: negotiationId,
      customer: { firstName: 'Budget', lastName: 'Harness', phone: `+1555${String(Date.now()).slice(-7)}` },
      request: {
        category: { name: 'Bartending' }, description: 'budget harness',
        location: { city: 'Chicago', state: 'IL', zipCode: '60601' },
        proposedTimes: [{ start: '2026-09-19T23:00:00Z', end: '2026-09-20T03:00:00Z' }],
        details: [
          { question: 'Estimated guest count', answer: '76 - 100 guests' },
          { question: 'Budget', answer: budgetAnswer },
        ],
      },
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;
  return httpReq('POST', '/api/thumbtack/leads', headers, body);
}
```

Add the test after the fractional-window test (~line 211):

```js
test('webhook persists the parsed stated budget on the lead row', async () => {
  thumbtackRouter.__setDeps({ createDraftProposalFromLead }); // real builder
  const res = await postLeadV4Budget(negD, 'I&#39;m not sure, $300 - $400, $400 - $500');
  assert.equal(res.status, 200);
  const lead = await pool.query(
    'SELECT budget_min, budget_max, budget_raw, client_id, proposal_id FROM thumbtack_leads WHERE negotiation_id = $1',
    [negD]
  );
  assert.equal(lead.rows.length, 1, 'lead persisted');
  if (lead.rows[0].client_id) created.clientIds.push(lead.rows[0].client_id);
  if (lead.rows[0].proposal_id) created.proposalIds.push(lead.rows[0].proposal_id);
  assert.equal(lead.rows[0].budget_min, 300, 'unsure token ignored; min of selected ranges');
  assert.equal(lead.rows[0].budget_max, 500, 'max of selected ranges');
  assert.equal(lead.rows[0].budget_raw, "I'm not sure, $300 - $400, $400 - $500", 'raw stored decoded');
});
```

- [ ] **Step 4: Run the suite to verify the new test fails**

Run: `node --test server/routes/thumbtack.test.js`
Expected: the new test FAILS on `budget_min` = null vs 300 (the INSERT does not write the columns yet). If it instead errors `column "budget_min" does not exist`, Step 2 was skipped; run it.

- [ ] **Step 5: Wire the columns into the webhook INSERT**

In `server/routes/thumbtack.js`, replace the INSERT statement (~lines 275-290) with:

```js
    // Insert the Thumbtack lead
    await dbClient.query(
      `INSERT INTO thumbtack_leads (
        negotiation_id, client_id, customer_id, customer_name, customer_phone,
        category, description, location_city, location_state, location_zip,
        location_address, event_date, event_duration, guest_count, lead_type,
        lead_price, charge_state, budget_min, budget_max, budget_raw, raw_payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        lead.negotiationId, clientId, lead.customerId, truncate(lead.customerName, 255),
        truncate(lead.customerPhone, 50), truncate(lead.category, 255), truncate(lead.description),
        truncate(lead.locationCity, 255), truncate(lead.locationState, 50), truncate(lead.locationZip, 20),
        lead.locationAddress, lead.eventDate, lead.eventDuration,
        lead.guestCount, lead.leadType, lead.leadPrice, lead.chargeState,
        lead.budgetMin, lead.budgetMax, truncate(lead.budgetRaw, 500),
        JSON.stringify(body),
      ]
    );
```

(Only the column list, placeholder count, and the three new params change; everything else is verbatim.)

- [ ] **Step 6: Run the suite to verify it passes**

Run: `node --test server/routes/thumbtack.test.js`
Expected: PASS (all tests).

- [ ] **Step 7: Update ARCHITECTURE.md**

In the `**thumbtack_leads**` schema block (~line 1193), the current line

```
- `event_date` TIMESTAMPTZ, `event_duration` INTEGER (minutes), `guest_count`
```

is stale (`event_duration` became `NUMERIC(4,1)` hours). Replace it and document the new columns:

```
- `event_date` TIMESTAMPTZ, `event_duration` NUMERIC(4,1) (hours, end - start of the lead window), `guest_count`
- `budget_min` / `budget_max` INTEGER (whole dollars), `budget_raw` TEXT — stated budget parsed from the lead Q&A at webhook time (forward-only, no backfill; `budget_max` NULL = no cap known, never flags)
```

- [ ] **Step 8: Commit (checkpoint)**

```bash
git add server/db/schema.sql server/routes/thumbtack.js server/routes/thumbtack.test.js ARCHITECTURE.md
git commit -m "feat(thumbtack): persist stated budget columns on lead capture"
```

---

### Task 3: deliver budget on the single-proposal GET

**Files:**
- Modify: `server/routes/proposals/crud.js` (the `GET /:id` query, ~lines 366-377)
- Test: `server/routes/proposals/crud.test.js`

**Interfaces:**
- Consumes: `thumbtack_leads.budget_min` / `budget_max` / `budget_raw` from Task 2.
- Produces: `proposal.budget_min`, `proposal.budget_max`, `proposal.budget_raw` on the `GET /api/proposals/:id` response (null for non-TT proposals). Task 4 reads exactly these three response fields.

- [ ] **Step 1: Write the failing route test**

In `server/routes/proposals/crud.test.js`, add after the existing PATCH/status cases (anywhere at top level after `insertDraftProposal` is defined; keep it a GET so it consumes no `adminWriteLimiter` slot):

```js
test('GET /:id carries the linked Thumbtack lead stated budget (lateral join)', async () => {
  const proposalId = await insertDraftProposal({ total_price: 505 });
  const negId = `budget-join-${Date.now()}`;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, proposal_id, budget_min, budget_max, budget_raw, raw_payload)
     VALUES ($1, $2, 300, 400, '$300 - $400', '{}'::jsonb)`,
    [negId, proposalId]
  );
  let body;
  try {
    const res = await request('GET', `/api/proposals/${proposalId}`, { token: primaryToken });
    assert.equal(res.status, 200);
    body = res.body;
  } finally {
    await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [negId]);
  }
  assert.equal(body.budget_min, 300);
  assert.equal(body.budget_max, 400);
  assert.equal(body.budget_raw, '$300 - $400');
});
```

Note: `request(method, path, { token, body })` (crud.test.js:78) is this suite's existing HTTP helper, and `insertDraftProposal` and `primaryToken` already exist in the harness. The lead row is cleaned inline (this suite's `created*` sets do not track `thumbtack_leads`); proposal + client ride the existing `createdProposalIds` / `createdClientIds` cleanup. GETs consume no `adminWriteLimiter` slot, so `primaryToken` is safe here.

- [ ] **Step 2: Run the suite to verify the new test fails**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: the new test FAILS with `body.budget_min` undefined vs 300. (Suite precondition: >=2 admin/manager users in the dev DB; the harness asserts this itself.)

- [ ] **Step 3: Add the lateral join**

In `server/routes/proposals/crud.js` `GET /:id` (~line 366), replace the query with:

```js
  const result = await pool.query(`
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.source AS client_source,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.includes AS package_includes,
           u.email AS created_by_email, u.cc_id AS user_cc_id,
           tb.budget_min, tb.budget_max, tb.budget_raw
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN LATERAL (
      -- Stated budget of the TT lead auto-drafted into this proposal: context for
      -- the admin over-budget badge. Newest lead wins, matching /lead-cost.
      SELECT tl.budget_min, tl.budget_max, tl.budget_raw
        FROM thumbtack_leads tl
       WHERE tl.proposal_id = p.id
       ORDER BY tl.id DESC
       LIMIT 1
    ) tb ON true
    WHERE p.id = $1
  `, [req.params.id]);
```

(Only the three `tb.` select fields and the `LEFT JOIN LATERAL` block are new; everything else is verbatim.)

- [ ] **Step 4: Run the suite to verify it passes**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "feat(proposals): deliver stated budget on GET /:id via thumbtack_leads lateral join"
```

---

### Task 4: header badge, payment-panel line, CSS

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js` (derived vars near the top of the component; badge row ~lines 372-378)
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js` (the `dl` block, after the Acquisition entry ~line 248)
- Modify: `client/src/index.css` (after `.lm-hold-badge`, ~line 9857)

**Interfaces:**
- Consumes: `proposal.budget_min` / `budget_max` / `budget_raw` from Task 3's GET payload (the panel receives the same `proposal` prop).
- Produces: UI only; nothing downstream.

- [ ] **Step 1: Add the derived flags in ProposalDetail.js**

Near the component's other derived values (after `statusInfo` is computed), add:

```js
  // Over-budget badge (Thumbtack stated budget vs computed total): pre-acceptance
  // only. budget_max null = no cap known ("not sure" / "More than $X"), never flags.
  const overBudget = proposal && proposal.budget_max != null
    && Number(proposal.total_price) > Number(proposal.budget_max)
    && ['draft', 'sent'].includes(proposal.status);
  const budgetRangeLabel = overBudget
    ? (Number(proposal.budget_min) > 0
        ? `$${proposal.budget_min}-$${proposal.budget_max}`
        : `under $${proposal.budget_max}`)
    : null;
```

- [ ] **Step 2: Render the badge**

In the header badge row, directly after the `last_minute_hold` badge block (~line 377, after its closing `)}`), add:

```jsx
              {overBudget && (
                <span
                  className="budget-over-badge"
                  title="Thumbtack lead stated this budget. Consider a discount or trimmed scope to win the job."
                >
                  ⚠ Over stated budget: ${Math.round(Number(proposal.total_price))} vs {budgetRangeLabel}
                </span>
              )}
```

- [ ] **Step 3: Add the payment-panel context line**

In `ProposalDetailPaymentPanel.js`, directly after the Acquisition `{leadCostCents != null && (...)}` block (~line 248), add:

```jsx
          {proposal.budget_raw && (
            <>
              <dt>Stated budget</dt>
              <dd>{proposal.budget_raw}</dd>
            </>
          )}
```

- [ ] **Step 4: Add the badge CSS**

In `client/src/index.css`, directly after the `.lm-hold-badge` rule (~line 9857), add:

```css
/* Over-stated-budget badge (Thumbtack lead): red family, sits beside the
   orange lm-hold-badge in the proposal header. */
.budget-over-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #8a1f1f;
  background: #fbe4e4;
  border: 1px solid #c0392b;
  border-radius: 999px;
  vertical-align: middle;
}
```

- [ ] **Step 5: Verify with the CI-exact client build**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero ESLint warnings (CI=true makes warnings fatal, matching Vercel).

- [ ] **Step 6: Manual smoke (dev DB, running app)**

The feature is forward-only, so no existing lead has budget columns; stage one by hand on the dev DB against any TT draft proposal (pick an id from `SELECT proposal_id FROM thumbtack_leads WHERE proposal_id IS NOT NULL LIMIT 5`):

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"UPDATE thumbtack_leads SET budget_min=300, budget_max=400, budget_raw='\$300 - \$400' WHERE proposal_id=(SELECT proposal_id FROM thumbtack_leads WHERE proposal_id IS NOT NULL ORDER BY id DESC LIMIT 1) RETURNING proposal_id\").then(r=>{console.log('staged on proposal', r.rows[0] && r.rows[0].proposal_id);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```

Open that proposal in the admin app: a draft/sent proposal totaling over $400 shows the red badge in the header and "Stated budget: $300 - $400" in the payment panel; mark-accepted (or an archived/accepted proposal) hides the badge but keeps the panel line. Revert the staged row afterward (`UPDATE thumbtack_leads SET budget_min=NULL, budget_max=NULL, budget_raw=NULL WHERE proposal_id=<id>`).

Note: the backend dev server is Claude-managed and does NOT auto-reload; restart it after the server-side tasks before this smoke (find the :5000 listener, kill, relaunch, confirm boot lines).

- [ ] **Step 7: Commit (checkpoint)**

```bash
git add client/src/pages/admin/ProposalDetail.js client/src/pages/admin/ProposalDetailPaymentPanel.js client/src/index.css
git commit -m "feat(admin): over-stated-budget badge + payment-panel budget line"
```

---

## Completion

All four tasks done = the lane is feature-complete. Lane wrap-up (not part of task execution): full-fleet per-lane review (sensitive path `server/routes/thumbtack.js`), squash-merge to `main` via `scripts/merge-lane.sh`, worktree cleanup. Both server suites must have passed individually; the client CI build must be clean. No push: push is Dallas's explicit call.
