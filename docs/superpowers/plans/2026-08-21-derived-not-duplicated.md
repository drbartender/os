# Derived, Not Duplicated Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five money-display defects that all share one shape: a number that is copied or hardcoded where it should be derived, so the copy drifts from the engine and a client reads something we do not charge.

**Architecture:** One small lane, five independent tasks, no schema changes. Task 1 exports the hosted rate-tier selection from `pricingEngine.js` so its three copies collapse to one. Task 2 puts the bound floor AMOUNT on the pricing snapshot and renders it instead of a hardcoded `$550`. Task 3 fixes the quote's `extras` list, which gates without the BYOB tier and therefore hides a $7.50/guest add-on from every BYOB client. Task 4 adds the sign-time observability that turns "should the legacy branch expire?" from a guess into evidence. Task 5 deletes the CSS the options-ladder retirement orphaned.

**Tech Stack:** Existing stack only, no new dependencies. Raw SQL via `pg`, Express routers, `node --test` with the repo's `node:http` harness, React 18 + jest/RTL (CRA), vanilla CSS in `index.css`.

**Spec:** None. These are five fix-list items, not a feature; the reasoning is in this plan's task preambles and in the review findings that produced them (the 2026-08-20/21 options-ladder lane fleets). Related design docs for context: `docs/superpowers/specs/2026-08-20-proposal-options-ladder-design.md`.

**Provenance (all verified against main 2026-08-21, re-verify before building):**
- `server/utils/pricingEngine.js:77` `hostedBaseComponents(pkg, guestCount, durationHours)` selects the rate tier and returns `{ billedGuests, rawBase }`. NOT exported (`module.exports` at :615). Snapshot carries `floor_applied`, `floor_reason`, `billed_guests` at :605-607 but NOT the floor amount.
- Copy 2: `server/routes/proposals/publicOptions.js` `perGuestRateFor` (added 2026-08-20 for the ladder's per-guest subline) repeats the same three-line selection.
- Copy 3: `server/routes/packages.js:~226` (admin margin calculator) picks the small rate for the BASE but then uses plain `pkg.extra_hour_rate`, never `extra_hour_rate_small`. Its own comment claims it matches `pricingEngine`'s `isSmall`; it half does.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:92` renders the literal `Hosted minimum $550 applied.` while the options drawer renders the real per-package `min_total` from the payload.
- Every active non-class per_guest package currently carries `min_total = 550.00` (a P4 migration normalized them; the 400-1000 values in the seed comments are the rollback reference). So the hardcode is LATENT, not live. It becomes live the day one package's floor changes.
- `server/utils/proposalRules.js:158` gates `mocktail-bar` on BYOB behind `the-formula`/`the-full-compound` being in `addonIds`; the same rule is re-asserted at `:89` in `validateProposalRules`. The quote's `extras` list is built with `addonIds: selectedExtras` (no tier), while the same package's `visible_extra_ids` is built with the tier included.
- `server/routes/proposals/publicToken.js:364` `AND ($14::numeric IS NULL OR ABS(total_price - $14::numeric) < 0.005)`. The ONLY caller that sends `acknowledged_total` is `client/src/pages/proposal/proposalView/ProposalView.js` (armed 2026-08-21).
- `server/utils/pricingEngine.test.js` exists and is the home for Task 1's tests.

## Global Constraints

- **No em dashes** in copy, comments, or docs. Commas, colons, parentheses.
- **Max effort on Tasks 1-3.** They touch pricing. Money on proposals is DOLLARS; comparisons in integer cents via `Math.round(Number(x) * 100)`.
- **`pricingEngine.js` is pure**: no DB calls, no I/O. Task 1 must not change a single computed value; it is a pure extraction.
- **Server tests one at a time from repo root.** Client gate: `cd client && CI=true npx react-scripts build` before any commit touching `client/`.
- **Explicit staging only; no backticks in commit messages** (`git commit -F -` heredoc).
- `publicOptions.js`, `publicToken.js` and `pricingEngine.js` are sensitive-listed: full fleet on the lane before merge.

## Lane map

```yaml
lanes:
  - id: derived-numbers
    phase: 1
    scope: >
      Five independent display-correctness fixes that share one root: a number
      duplicated or hardcoded instead of derived. Export the hosted rate-tier
      selection and collapse its three copies; put the bound floor amount on the
      pricing snapshot and render it instead of a hardcoded $550; build the
      quote's extras list with the tier in the gate so mocktail-bar stops being
      invisible to BYOB clients; add a Sentry breadcrumb for sign posts that
      arrive without acknowledged_total; delete the .oo-* CSS the compare
      retirement orphaned. No schema changes.
    footprint:
      - server/utils/pricingEngine.js
      - server/utils/pricingEngine.test.js
      - server/routes/proposals/publicOptions.js
      - server/routes/proposals/publicOptions.test.js
      - server/routes/proposals/publicToken.js
      - server/routes/proposals/publicToken.test.js
      - server/routes/packages.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/index.css
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, database-review]
```

---

# Lane derived-numbers

### Task 1: Export the hosted rate-tier selection, collapse three copies to one

The same three-line "is this a small event, so use the `_small` columns"
decision exists in three places. The engine is truth; the ladder's per-guest
subline copies it; the admin margin calculator copies it WRONG (small base,
standard extra-hour rate). Today every `_small` column happens to pair with an
identical standard `extra_hour_rate`, so nothing diverges. Set one package's
`extra_hour_rate_small` differently and the margin calculator starts lying about
a number you price against.

**Files:**
- Modify: `server/utils/pricingEngine.js` (add + export `hostedRates`; `hostedBaseComponents` consumes it)
- Modify: `server/routes/proposals/publicOptions.js` (`perGuestRateFor` consumes it)
- Modify: `server/routes/packages.js` (margin calculator consumes it)
- Test: `server/utils/pricingEngine.test.js`

**Interfaces:**
- Produces: `hostedRates(pkg, guestCount)` exported from `server/utils/pricingEngine.js`, returning `{ isSmall: boolean, rate3: number|null, rate4: number, extra: number }`. `rate3` is null when the package has no 3-hour rate at either tier. Consumers do their own arithmetic; this returns SELECTION ONLY, never a total, so nothing has to divide a base back into a rate.

- [ ] **Step 1: Write the failing test** in `server/utils/pricingEngine.test.js`:

```js
test('hostedRates: below min_guests takes the small tier, at or above takes standard', () => {
  const { hostedRates } = require('./pricingEngine');
  const pkg = {
    min_guests: 50,
    base_rate_4hr: 12, base_rate_4hr_small: 17,
    base_rate_3hr: 10, base_rate_3hr_small: 15,
    extra_hour_rate: 4, extra_hour_rate_small: 6,
  };
  assert.deepEqual(hostedRates(pkg, 30), { isSmall: true, rate3: 15, rate4: 17, extra: 6 });
  assert.deepEqual(hostedRates(pkg, 50), { isSmall: false, rate3: 10, rate4: 12, extra: 4 });
});

test('hostedRates: a missing small column falls back to the standard one, never to zero', () => {
  const { hostedRates } = require('./pricingEngine');
  const pkg = {
    min_guests: 50,
    base_rate_4hr: 12, base_rate_4hr_small: 17,
    base_rate_3hr: 10, base_rate_3hr_small: null,
    extra_hour_rate: 4, extra_hour_rate_small: null,
  };
  const r = hostedRates(pkg, 30);
  assert.equal(r.rate3, 10, 'falls back to the standard 3hr rate');
  assert.equal(r.extra, 4, 'falls back to the standard extra-hour rate');
});

test('hostedRates: no min_guests means never small', () => {
  const { hostedRates } = require('./pricingEngine');
  const pkg = { min_guests: null, base_rate_4hr: 12, base_rate_4hr_small: 17,
    base_rate_3hr: null, base_rate_3hr_small: null, extra_hour_rate: 4, extra_hour_rate_small: 9 };
  assert.deepEqual(hostedRates(pkg, 1), { isSmall: false, rate3: null, rate4: 12, extra: 4 });
});
```

- [ ] **Step 2: Run it and watch it fail.** `node --test server/utils/pricingEngine.test.js` from the repo root. Expected: fails on `hostedRates is not a function`.

- [ ] **Step 3: Add the helper** in `server/utils/pricingEngine.js`, immediately ABOVE `hostedBaseComponents` (:77):

```js
/**
 * The hosted rate-tier SELECTION, and nothing else.
 *
 * Exported because this decision had drifted into three copies: here,
 * publicOptions.js's per-guest subline, and the admin margin calculator, which
 * picked the small BASE but the standard extra-hour rate. Returns rates rather
 * than a total on purpose: a consumer that needed a rate back out of a base
 * would have to divide, which puts float error on a number a client reads.
 *
 * The rate tier keys on ACTUAL guests, never billedGuests: the billing minimum
 * decides how many heads you pay for, not which price list you are on.
 */
function hostedRates(pkg, guestCount) {
  const isSmall = !!(pkg.min_guests && guestCount < pkg.min_guests);
  return {
    isSmall,
    rate3: (isSmall ? (pkg.base_rate_3hr_small || pkg.base_rate_3hr) : pkg.base_rate_3hr) ?? null,
    rate4: Number(isSmall ? (pkg.base_rate_4hr_small ?? pkg.base_rate_4hr) : pkg.base_rate_4hr),
    extra: Number(isSmall ? (pkg.extra_hour_rate_small || pkg.extra_hour_rate) : pkg.extra_hour_rate),
  };
}
```

Add `hostedRates` to the `module.exports` object at :615.

- [ ] **Step 4: Rewrite `hostedBaseComponents` to consume it**, leaving its arithmetic byte-identical:

```js
function hostedBaseComponents(pkg, guestCount, durationHours) {
  const billedGuests = Math.max(guestCount, Number(pkg.min_billed_guests || 0));
  const { rate3: rate3hr, rate4: rate4hr, extra: extraRate } = hostedRates(pkg, guestCount);
  let rawBase;
  if (rate3hr && durationHours <= 3) rawBase = billedGuests * Number(rate3hr);
  else if (durationHours <= 4) rawBase = billedGuests * rate4hr;
  else rawBase = billedGuests * rate4hr + billedGuests * (durationHours - 4) * extraRate;
  return { billedGuests, rawBase };
}
```

- [ ] **Step 5: Prove the extraction changed no price.** Run the ENGINE suite plus every suite that prices: `node --test server/utils/pricingEngine.test.js`, then one at a time `server/routes/proposals/publicOptions.test.js`, `server/routes/proposals/publicSwitch.test.js`, `server/utils/changeRequests.test.js` (if present), `server/routes/proposals/public.calculate.test.js`. All must pass with zero changes to their expectations. A changed expectation means the extraction was not pure; stop and diff.

- [ ] **Step 6: Point `perGuestRateFor` at the helper** in `server/routes/proposals/publicOptions.js`, replacing its inline selection:

```js
const perGuestRateFor = (pkg) => {
  if (pkg.pricing_type !== 'per_guest') return null;
  const guests = Number(proposal.guest_count) || 0;
  const hours = Number(proposal.event_duration_hours) || 0;
  const { rate3, rate4, extra } = hostedRates(pkg, guests);
  if (rate3 && hours <= 3) return Number(rate3);
  return hours <= 4 ? rate4 : rate4 + extra * (hours - 4);
};
```

Add `hostedRates` to the existing `require` of `../../utils/pricingEngine` (create the require if the file does not already have one).

- [ ] **Step 7: Fix the margin calculator** in `server/routes/packages.js` (~:226). This is the copy that was WRONG, so its output changes when a small extra-hour rate differs from the standard one:

```js
  const { rate4: base, extra: extraRate } = hostedRates(pkg, guests);
  const extra = Math.max(0, hours - 4) * (Number(extraRate) || 0);
  const billedGuests = Math.max(guests, Number(pkg.min_billed_guests) || 0);
  revenue = (base || 0) * billedGuests + extra * billedGuests;
  if (pkg.min_total) revenue = Math.max(revenue, Number(pkg.min_total));
```

Note the second change: the old line computed `(base + extra) * billedGuests` where `extra` was already an hours-multiplied figure, which is the same thing written less clearly. Keep the multiplication explicit so the next reader does not have to check.

- [ ] **Step 8: Run the packages suite** (`node --test server/routes/packages.test.js` if it exists; otherwise hit `GET /api/packages/:id/margin` on the dev server and confirm the number is unchanged for a 120-guest 4-hour event, where small rates do not apply).

- [ ] **Step 9: Commit** with explicit paths.

### Task 2: Put the bound floor amount on the snapshot, and stop hardcoding $550

`ProposalPricingBreakdown.js:92` says `Hosted minimum $550 applied.` The options
drawer, right below it, renders the real per-package `min_total` from the quote
payload. Every package is 550 today, so they agree by luck. The day one floor
changes, the same screen shows two different numbers for the same rule.

**Files:**
- Modify: `server/utils/pricingEngine.js` (add `floor_amount` to the snapshot)
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:92`
- Test: `server/utils/pricingEngine.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: `snapshot.floor_amount` (number|null): the dollar floor that actually bound this price when `floor_reason === 'dollar_min'`, else null. Additive; every existing snapshot field keeps its shape, and a LEGACY snapshot without the field must render the old sentence rather than a blank.

- [ ] **Step 1: Write the failing test:**

```js
test('a dollar-floored price reports the floor AMOUNT, not just the reason', () => {
  const pkg = {
    id: 1, category: 'hosted', pricing_type: 'per_guest', bar_type: 'full_bar',
    min_guests: 50, min_billed_guests: 25, min_total: 400,
    base_rate_4hr: 12, base_rate_4hr_small: 17, base_rate_3hr: null,
    base_rate_3hr_small: null, extra_hour_rate: 4, extra_hour_rate_small: 4,
    bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40,
    first_bar_fee: 0, additional_bar_fee: 0,
  };
  // 30 guests on the small tier is 30 x $17 = $510, under a $900 floor, so the
  // DOLLAR floor binds rather than the billed-guest one.
  const snap = calculateProposal({
    pkg: { ...pkg, min_total: 900 }, guestCount: 30, durationHours: 4,
    numBars: 0, addons: [], adjustments: [],
  });
  assert.equal(snap.floor_reason, 'dollar_min');
  assert.equal(snap.floor_amount, 900, 'the amount that bound, from the package');
});

test('a price the rate set carries no floor amount', () => {
  const snap = calculateProposal({
    pkg: {
      id: 1, category: 'hosted', pricing_type: 'per_guest', bar_type: 'full_bar',
      min_guests: 50, min_billed_guests: 25, min_total: 400,
      base_rate_4hr: 12, base_rate_4hr_small: 17, base_rate_3hr: null,
      base_rate_3hr_small: null, extra_hour_rate: 4, extra_hour_rate_small: 4,
      bartenders_included: 1, guests_per_bartender: 100, extra_bartender_hourly: 40,
      first_bar_fee: 0, additional_bar_fee: 0,
    },
    guestCount: 120, durationHours: 4, numBars: 0, addons: [], adjustments: [],
  });
  assert.equal(snap.floor_reason, null);
  assert.equal(snap.floor_amount, null);
});
```

- [ ] **Step 2: Run it and watch it fail** on `floor_amount` being `undefined`.

- [ ] **Step 3: Emit the field.** In `calculateProposal`, beside `floor_reason` at :606:

```js
    floor_reason: floorReason,
    // The amount that actually bound, so a consumer can NAME it instead of
    // hardcoding one. Only meaningful on the dollar-floor branch: on
    // 'guest_min' the binding constraint is a headcount, which billed_guests
    // already carries.
    floor_amount: floorReason === 'dollar_min' ? Number(pkg.min_total || 0) : null,
```

- [ ] **Step 4: Run the engine suite** and confirm both new tests pass and nothing else moved.

- [ ] **Step 5: Render it** in `ProposalPricingBreakdown.js:92`, keeping a legacy fallback so an old stored snapshot does not render a blank:

```jsx
        {snapshot?.floor_reason === 'dollar_min' && (
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {/* The amount comes off the snapshot. Hardcoding it meant this line
                and the options drawer directly below could disagree about the
                same rule the moment one package's floor changed. Legacy
                snapshots predate the field, so they keep the old sentence. */}
            Hosted minimum {snapshot.floor_amount != null ? fmt(snapshot.floor_amount) : '$550'} applied.
          </p>
        )}
```

- [ ] **Step 6: Client gate.** `cd client && CI=true npx react-scripts build`, then `CI=true npx react-scripts test --watchAll=false`.

- [ ] **Step 7: Commit** with explicit paths.

### Task 3: Build the quote's extras list with the tier in the gate

`mocktail-bar` ($7.50/guest) is visible on BYOB only when The Formula or The Full
Compound is in the selection. The quote's `extras` list gates on
`selectedExtras` alone, with no tier, so that rule can never be satisfied and
the add-on is invisible to EVERY BYOB client, including the ones the rule exists
to serve. The same package's `visible_extra_ids` gates WITH the tier, so the two
fields on one payload disagree about the same add-on.

**Files:**
- Modify: `server/routes/proposals/publicOptions.js` (the `extras` build)
- Test: `server/routes/proposals/publicOptions.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: no shape change. The `extras` array gains entries it should always have had; nothing is removed and no field changes.

- [ ] **Step 1: Write the failing test** in `publicOptions.test.js` (the fixture proposal is BYOB, 120 guests):

```js
test('mocktail-bar is offered once a qualifying tier rides the request', async () => {
  const mocktail = await addonIdBySlug('mocktail-bar');
  const formula = await addonIdBySlug('the-formula');
  assert.ok(mocktail && formula, 'seeded catalog carries both');

  const without = await request('POST', `/api/proposals/t/${token}/options`, { body: {} });
  assert.ok(!without.body.extras.some((x) => x.addon_id === mocktail),
    'no tier: correctly gated out');

  const withTier = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { tier_addon_id: formula },
  });
  assert.ok(withTier.body.extras.some((x) => x.addon_id === mocktail),
    'The Formula unlocks it, and the offered list must say so');
});

test('the extras list agrees with the current option visible_extra_ids', async () => {
  const formula = await addonIdBySlug('the-formula');
  const res = await request('POST', `/api/proposals/t/${token}/options`, {
    body: { tier_addon_id: formula },
  });
  const current = res.body.options.find((o) => o.is_current);
  const offered = res.body.extras.map((x) => x.addon_id).sort((a, b) => a - b);
  const visible = [...current.visible_extra_ids].sort((a, b) => a - b);
  assert.deepEqual(offered, visible,
    'two fields on one payload must not disagree about what is offered');
});
```

- [ ] **Step 2: Run it and watch the second assertion of the first test fail** (`node --test server/routes/proposals/publicOptions.test.js`).

- [ ] **Step 3: Pass the tier into the gate.** In the `extras` build:

```js
    const currentPkg = catalog.packages.find(p => p.id === proposal.package_id);
    const extras = (currentPkg
      ? visibleAddonsFor({
        addons: catalog.addons, pkg: currentPkg, guestCount: Number(proposal.guest_count),
        // The tier belongs in the gate. Rules like mocktail-bar's are written
        // against a selection that INCLUDES it, so gating on selectedExtras
        // alone made that rule unsatisfiable and hid a $7.50/guest add-on from
        // every BYOB client. The same package's visible_extra_ids already
        // gates this way; these two fields disagreed on one payload.
        addonIds: tierForPkg ? [...selectedExtras, tierForPkg] : selectedExtras,
      })
      : []
    )
```

- [ ] **Step 4: Run the suite.** Both new tests pass; the pre-existing 30 still pass.

- [ ] **Step 5: Check the client twin does not now disagree.** The drawer's extras strip filters `data.extras`; confirm `client/src/utils/proposalRules.js` `filterAddons` applies the same mocktail-bar gate (it does, at the `hasSlug` check), so a newly-offered row is not immediately rendered as blocked. Run `cd client && CI=true npx react-scripts test --watchAll=false`.

- [ ] **Step 6: Commit** with explicit paths.

### Task 4: Make the sign-time legacy branch an evidence question

The sign UPDATE self-disarms when `acknowledged_total` is absent. As of
2026-08-21 the only client sends it, so the branch should now be dead. Whether to
make it MANDATORY is a real decision, and the honest input is data, not a
calendar: if nothing hits the legacy branch for a few weeks, tightening is safe;
if something does, there is a caller nobody knew about, which is worth more than
the guard.

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (the sign handler)
- Test: `server/routes/proposals/publicToken.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a Sentry capture, DSN-gated like every other capture in the file. No behavior change: an absent field still signs exactly as it does today.

- [ ] **Step 1: Write the failing test:**

```js
test('a sign WITHOUT acknowledged_total still succeeds, and is recorded', async () => {
  const p = await insertSignableProposal();
  sentryMessages.length = 0;
  const res = await request('POST', `/api/proposals/t/${p.token}/sign`, {
    body: {
      client_signed_name: 'Legacy Client',
      client_signature_data: 'data:image/png;base64,AAAA',
      document_version: AGREEMENT_VERSION,
    },
  });
  assert.equal(res.status, 200, `legacy sign must still work: ${res.raw}`);
  const legacy = sentryMessages.filter((m) => m.ctx?.tags?.issue === 'sign_without_ack');
  assert.equal(legacy.length, 1, 'and it pages so the branch can be retired on evidence');
});
```

Stub Sentry the same way `publicSwitch.test.js` does (require-cache override before the router is required) and set `SENTRY_DSN_SERVER` in the test env, or the capture is silently gated off and the assertion passes for the wrong reason.

- [ ] **Step 2: Run it and watch the Sentry assertion fail.**

- [ ] **Step 3: Add the capture** in the sign handler, where `acknowledged_total` is read:

```js
  // The sign-time total assertion self-disarms without this field, which was
  // correct while no client sent it. As of 2026-08-21 the proposal page always
  // does, so this branch should be dead. It is recorded rather than refused:
  // refusing on a schedule would 400 a client whose page was open across the
  // deploy, on the last click of the funnel, to close a hole a token holder
  // could already walk through by simply signing. Retire the branch when this
  // capture has been silent for a few weeks, not before.
  if (ackTotal === null || ackTotal === undefined) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('sign: no acknowledged_total, assertion self-disarmed', {
        level: 'info',
        tags: { route: 'proposals/sign', issue: 'sign_without_ack' },
        extra: { proposalId: proposal.id },
      });
    }
  }
```

- [ ] **Step 4: Run** `node --test server/routes/proposals/publicToken.test.js` and `publicToken.signTotal.test.js`, one at a time.

- [ ] **Step 5: Commit** with explicit paths.

### Task 5: Delete the CSS the compare retirement orphaned, and lane gate

The options-ladder lane deleted `CompareTable.js` and the pick/tray/compare
render paths but left roughly 55 rule blocks behind. They are inert, but they
also SHADOW the live drawer: `.oo-extras`, `.oo-extra`, `.oo-extra-name`,
`.oo-extra-rate` and `.oo-extras-head` are each declared twice, and the legacy
copies still contribute margins the new rules do not reset. Two earlier attempts
mangled the file with regex, so this one is done by hand, in one reviewable diff.

**Files:**
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Pure deletion.

- [ ] **Step 1: Build the kill list.** From the repo root:

```bash
for c in $(grep -o '^\.oo-[a-z0-9-]*' client/src/index.css | sed 's/^\.//' | sort -u); do
  n=$(grep -rho "$c" client/src --include=*.js | wc -l)
  [ "$n" -eq 0 ] && echo "$c"
done
```

Every class this prints has zero JS references. Keep the shared survivors, which WILL appear because the drawer still uses them: `oo-status`, `oo-busy`, `oo-back`, `oo-sr`, `oo-error`, `oo-lane`, `oo-item`, and every `oo-extra*` / `oo-drawer*` / `oo-rung*` / `oo-anchor*` / `oo-commit*` / `oo-banner*` / `oo-entry*` / `oo-contents*` / `oo-confirm*` / `oo-reprice*` / `oo-skel` / `oo-grab` / `oo-head*` / `oo-body` / `oo-break` / `oo-expand*` / `oo-x` / `oo-kicker` / `oo-title` / `oo-event` / `oo-insurance` / `oo-backdrop`.

- [ ] **Step 2: Delete by hand, not by script.** Open the legacy block (it starts at the `.oo-pick, .oo-compare` custom-property line and runs to just before the drawer block's banner comment) and remove only whole rules whose ENTIRE selector list is on the kill list. Leave any rule with a mixed selector list alone and note it. Multi-line selector lists are why two scripted attempts corrupted this file: a continuation line looks like a rule start.

- [ ] **Step 3: Prove nothing live lost its styling:**

```bash
for c in $(grep -rho "oo-[a-z0-9-]*" client/src --include=*.js | sort -u); do
  grep -q "\.$c[ ,{:]" client/src/index.css || echo "MISSING RULE: $c"
done
```

Expected: no output. (`oo-narrow` is a false positive from the word "too-narrow" in a comment; ignore it if it appears.)

- [ ] **Step 4: Prove the file is still structurally sound.** Brace balance must be zero:

```bash
python3 -c "s=open('client/src/index.css').read(); print(s.count('{') - s.count('}'))"
```

- [ ] **Step 5: Confirm the duplicate declarations are gone.** `.oo-extras`, `.oo-extra`, `.oo-extra-name`, `.oo-extra-rate` and `.oo-extras-head` must each be declared exactly once.

- [ ] **Step 6: Client gate** (`build` then the full suite), and eyeball the drawer on the dev server at both breakpoints: the retirement must not have taken a live rule with it.

- [ ] **Step 7: Lane gate.** Run every suite this lane reaches, one at a time from the repo root: `pricingEngine.test.js`, `publicOptions.test.js`, `publicToken.test.js`, `publicToken.signTotal.test.js`, `publicSwitch.test.js`, `public.calculate.test.js`, plus `packages.test.js` if it exists. Then the full client suite and build. Commit; lane ready for its fleet.

---

## Notes for the executor

- **Task 1 is a refactor of money code, so the bar is "no number moved".** If any pricing test's EXPECTATION needs editing, the extraction is wrong. Stop and diff rather than updating the expectation.
- **Task 3 changes what a client is offered**, so it is the one task with a revenue effect: BYOB clients on The Formula or higher can buy Mocktail Bar for the first time. Worth telling Dallas when it merges rather than burying it.
- **Task 5 has failed twice by script.** If a by-hand pass feels risky, the acceptable outcome is to skip it and re-file: the rules are inert, and a mangled `index.css` affects every surface in the app.
