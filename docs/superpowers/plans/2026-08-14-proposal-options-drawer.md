# Proposal Options Drawer + Switch Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bottom-of-page "See other options" panel with a drawer entered beside the package title, streamlined to a three-card peek, whose "Switch to this package" action really rewrites the proposal pre-signature, with the money seams closed (stale-intent cancellation, sign-time total assertion, hidden add-ons carried).

**Architecture:** Server first: the quote endpoint (`publicOptions.js`) learns to carry the proposal's own hidden add-ons onto every option and to report per-option dropped items; a new sibling route `publicSwitch.js` owns the one write (FOR UPDATE transaction: cancel stale intents, re-price via `priceProposedState`, cents-compare the acknowledged total, rewrite row + addons + snapshot, reconcile payment status, refresh invoices, audit log); the public GET gains `options_available` and the sign UPDATE gains a total assertion in its WHERE. Client second: `OtherOptionsPanel` becomes a drawer body (bottom sheet on mobile, right side panel on desktop) with the peek tier and the switch flow, and the pin-to-compare machinery is deleted.

**Tech Stack:** Existing stack only, no new dependencies. Raw SQL via `pg`, Express routers, `node --test` with the repo's `node:http` harness, React 18 + vanilla CSS in `index.css`, raw axios on the public token page (matching `ProposalView.js`).

**Spec:** `docs/superpowers/specs/2026-08-14-proposal-options-drawer-design.md` (spec-fleet findings folded 2026-08-14; hidden-add-on carry decided by Dallas).

**Proven context (verified against the repo 2026-08-14, not from memory):**
- `server/routes/proposals/publicOptions.js`: `PROPOSAL_SELECT` at :44 already selects `total_price_override`, `client_signed_at`, `gratuity_floor_rate`, `num_bartenders`. `UNSIGNABLE` blacklist at :55. `notComparable(reason)` at :57. `safeIds` at :61 (caps 40, integer ids). Tier slugs via `BYOB_BUNDLE_SLUGS`. `ownHidden` carried only on the current-package branch (:186); the alternatives branch (:195-204) filters `selectedExtras` by `visibleAddonsFor` and drops hidden add-ons. `priceProposedState(proposal, {package_id, addon_ids, addon_quantities, addon_variants, num_bartenders}, pool, catalog)` call at :208 passes `num_bartenders: proposal.num_bartenders ?? null` unconditionally. Errors: `instanceof ValidationError` decides available:false (:225). Route: `router.post('/t/:token/options', optionsQuoteLimiter, requireUuidToken(...), ...)` at :72. Response shape at :344: `{comparable, reason, event:{...}, current_package_id, current_total, options:[{package_id, slug, name, category, pricing_type, total, available, reason, is_current}], tiers:[{addon_id, name, covers, total, selected}], extras:[{addon_id, name, rate, extra_hour_rate, billing_type, category, selected}]}`.
- `server/utils/changeRequests.js:65`: `async function priceProposedState(proposal, proposed, db = pool, catalog = null)` returns an engine snapshot: `.total` (dollars number), `.addons` array of `{id, name, billing_type, rate, quantity, line_total, variant}`, `.staffing` (`required`, `actual`), `.gratuity` (carries `floor_rate`; asserted by test in Task 5), `.package`, `.inputs`. It does NOT read `proposal.num_bartenders` itself; callers pass it.
- `server/routes/proposals/crud.js:604-646`: the write precedent. `reconcileProposalPaymentStatus({status, amountPaid, totalPrice})` from `server/utils/proposalStatus.js` returns `{changed, status, autopayDisarmed, overpaid, overpaidCents}`; addon rewrite is DELETE then one bulk 8-column INSERT `(proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)` from `snapshot.addons`; `proposal_activity_log` INSERT with `(proposal_id, action, actor_type, actor_id, details)`.
- `server/db/schema.sql:926`: `proposal_activity_log(id, proposal_id, action VARCHAR(50), actor_type VARCHAR(20) DEFAULT 'system', actor_id, details JSONB, created_at)`. No schema changes needed anywhere in this plan.
- `server/utils/invoiceLifecycle.js:99`: `refreshUnlockedInvoices(proposalId, dbClient)`, in-tx capable via `db(dbClient)`, excludes `OFF_LEDGER_INVOICE_LABELS`, no-op when no unlocked invoices exist (deferred-group case).
- `server/routes/stripeCreateIntent.js:128`: pending-intent lookup is `SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`; cancel pattern at :159-166 (`stripe.paymentIntents.cancel(id)` then `UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1`), skipping `succeeded`/`processing`/`canceled`; a failed cancel is warned, never swallowed silently.
- `server/routes/proposals/publicToken.js`: public GET at :59 with the public-safe allowlist SELECT (keyed `WHERE p.token = $1`, LATERAL `open_invoice_token`); sign UPDATE at :260 with WHERE `id = $7 AND client_signed_at IS NULL AND status NOT IN ('accepted','deposit_paid','balance_paid','confirmed','completed','archived')`, `ConflictError('...', 'ALREADY_ACCEPTED')` when no row.
- `server/middleware/rateLimiters.js:49`: `optionsQuoteLimiter` (120/15min, `keyGenerator: req.params?.token || req.ip`); file exports a flat object at :215; `rateLimiters.js` IS sensitive-listed (:108).
- `scripts/sensitive-paths.txt`: `publicOptions.js` :271, `changeRequests.js` :272, `proposalExtrasFold.js` :226, `proposalStatus.js` :227 listed. **`publicToken.js` is NOT listed** and must be added along with the new `publicSwitch.js`.
- `server/utils/proposalExtrasFold.js:82`: `withRepriceQuantities(rows)` and `loadRepriceAddons` exist; `foldExtrasIntoProposal` is same-package delta machinery and is NOT used by this plan.
- `server/utils/proposalRules.js:144`: `visibleAddonsFor({addons, pkg, guestCount, addonIds})`; always-hidden slugs `parking-fee` (:166), `handcrafted-syrups-3pack` (:165); `applies_to` gate at :156 (`'all'` or `pkg.category` match); guest-count gates for glassware slugs at :160.
- `client/src/pages/proposal/proposalView/ProposalView.js`: `showOptions` state :30, `handleWantOption` mailto :316, `handleSign` :325 (throws on failure; posts to `/proposals/t/${token}/sign`), gratuity seeding effect :175-182 gated on `!gratuityDirty`, secret-invalidation debounce effect :273-291, `isPayableStatus` :97, bottom button block :681-686, `totalPrice` derived from `snapshot.total` :464.
- `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`: package `h2` at :25, Total row in `tfoot` :72-81, mobile scroll CTA :164-174.
- `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`: 345 lines; `MAX_COMPARE`/pick/tray/`view === 'compare'` are the parts being deleted; `load`/`reQuote` debounce, `reqRef` sequencing, keep-last-good error handling (:38-79) are load-bearing keepers. `CompareTable.js` (200 lines) is deleted; `ExtrasPanel.js` stays.
- Server route tests: `node --test`, one suite at a time from repo root, shared dev DB, nonce'd fixtures, exemplar `server/routes/proposals/publicOptions.test.js` (its harness stubs the router mounts and seeds catalog fixtures).
- The dev catalog has 11 active comparable packages including "Walk Test Package" (launch check in spec).

## Global Constraints

- **No em dashes** in copy, comments, or docs. Commas, colons, parentheses.
- **Max effort everywhere.** Every server file here is a money path. Money in DOLLARS on proposals (proposals money law); every acknowledged-total comparison in integer cents via `Math.round(Number(x) * 100)`.
- **One pooled connection** for the whole switch handler; nothing after `pool.connect()` uses bare `pool.query` until release. `refreshUnlockedInvoices` receives the client.
- **AppError discipline:** throw `ValidationError`/`NotFoundError`/`ConflictError`; check `statusCode` or `instanceof`, never `.status`.
- **Election-at-payment law:** the switch endpoint NEVER writes `tip_jar`, `gratuity_rate`, or `gratuity_floor_rate` columns; the snapshot's gratuity block comes from the engine and must carry `floor_rate`.
- **Server tests one at a time from repo root:** `node --test server/routes/proposals/publicSwitch.test.js` etc.
- **Client gate:** `cd client && CI=true npx react-scripts build` before any commit touching `client/`.
- **Explicit staging only; no backticks in commit messages** (plain quotes; `git commit -F -` heredoc).
- **Copy is locked:** link "See other packages for this event"; header "Same date, different package."; card action "Switch to this package."; deltas neutral color.
- **Frontend calls on this page use raw axios + BASE_URL** (public token page, no JWT), matching `ProposalView.js`.

## Lane map

```yaml
lanes:
  - id: oo-switch-server
    phase: 1
    scope: >
      All server work: quote endpoint carries hidden add-ons onto every option
      and reports per-option dropped items plus the num_bartenders
      override-only rule; options_available on the public GET; the
      publicSwitch.js endpoint (guards, stale-intent cancel, reprice, cents
      409, row+addons+snapshot rewrite, reconcile, invoice refresh, audit
      log, allowlist response); sign-time total assertion; switch rate
      limiter; sensitive-paths additions; ARCHITECTURE/README updates.
    footprint:
      - server/routes/proposals/publicOptions.js
      - server/routes/proposals/publicOptions.test.js
      - server/routes/proposals/publicSwitch.js
      - server/routes/proposals/publicSwitch.test.js
      - server/routes/proposals/publicToken.js
      - server/routes/proposals/publicToken.test.js
      - server/routes/proposals/publicToken.signTotal.test.js
      - server/routes/proposals/index.js
      - server/middleware/rateLimiters.js
      - scripts/sensitive-paths.txt
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, database-review]

  - id: oo-drawer-client
    phase: 2
    scope: >
      The drawer: entry link beside the package title gated on
      options_available; bottom sheet and side panel treatments with a11y;
      peek tier, anchor strip, delta-hero cards, dropped-add-on notice;
      switch flow (in-flight, 409 re-show, lost-response refetch, success
      adopt + Total highlight, secret invalidation, gratuity reseed);
      sign POST carries acknowledged_total; pick/compare retirement
      (CompareTable deleted); sessionStorage keyed on updated_at;
      bottom button removed; README tree update.
    footprint:
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/proposal/otherOptions/OtherOptionsPanel.js
      - client/src/pages/proposal/otherOptions/ExtrasPanel.js
      - client/src/pages/proposal/otherOptions/CompareTable.js
      - client/src/index.css
      - README.md
    depends_on: [oo-switch-server]
    review_fleet: [code-review, consistency-check, ui-ux-review]
```

The client lane consumes only the HTTP contracts pinned in the Interfaces blocks below, so it can be built from this plan without reading lane 1's diffs, but it merges after lane 1 so integration tests run against the real endpoints.

---

# Lane oo-switch-server

### Task 1: Quote endpoint: hidden add-ons on every option + dropped list + override-only num_bartenders

**Files:**
- Modify: `server/routes/proposals/publicOptions.js` (the option-pricing loop, :150-230, and the response assembly)
- Test: `server/routes/proposals/publicOptions.test.js` (extend)

**Interfaces:**
- Produces (consumed by Task 3 and the client lane): each element of `options[]` gains `dropped: [{addon_id, name}]` (possibly empty), listing the proposal's own hidden add-ons that cannot apply to that option plus any client-selected extras invisible on it. Option totals now INCLUDE the proposal's own hidden add-ons wherever they fit.
- Produces: exported helper `computeOwnHidden(proposal, currentAddonRows, catalog, pkgById)` and `fitsPackage(addon, pkg)` so `publicSwitch.js` prices identically (Task 4 imports them; quote and switch must never disagree or every switch 409s).

- [ ] **Step 1: Write the failing tests** (append to `publicOptions.test.js`, using its existing fixture helpers):

```js
test('own hidden add-ons ride every option, not just the current card', async () => {
  // Fixture: proposal on hosted pkg A with a hand-added parking-fee addon row.
  // Assert: every option with matching applies_to has the fee inside .total
  // (compare against a control proposal without the fee: totals differ by the
  // fee on EVERY available option, and delta math stays consistent), and
  // dropped is [] for those options.
});

test('applies_to-incompatible hidden addon appears in dropped, not the price', async () => {
  // Fixture: hidden addon with applies_to = 'byob' on a hosted proposal.
  // Assert: BYOB option prices it; hosted options list it in dropped by name.
});

test('num_bartenders passes only when a true override is in effect', async () => {
  // Fixture A: proposal whose snapshot staffing.actual === staffing.required
  // (a persisted derivation). Assert: an option with a different
  // guests_per_bartender ratio prices with ITS OWN derived staffing (no
  // phantom over-ratio bartender line in its total).
  // Fixture B: staffing.actual !== staffing.required (real admin override).
  // Assert: the override count carries into the option's pricing.
});
```

- [ ] **Step 2: Run to verify they fail:** `node --test server/routes/proposals/publicOptions.test.js` from repo root. Expected: the three new tests FAIL (totals exclude the fee, no `dropped` field, phantom staffing).

- [ ] **Step 3: Implement.** In `publicOptions.js`:

```js
/** Event facts, not package features: an admin-added add-on the client cannot
 *  see (parking fee) follows the event onto every option (spec 2026-08-14,
 *  decision 10). applies_to is the only gate that can drop one. */
function fitsPackage(addon, pkg) {
  return addon.applies_to === 'all' || addon.applies_to === pkg.category;
}
```

In the per-option pricing closure, compute once above both branches (the current-package `ownHidden` logic at :186 generalizes): `ownHidden` = the proposal's own addon rows whose catalog addon is NOT in `visibleAddonsFor` for the CURRENT package (this is what "hidden" means: the client could not have picked it). Then for EVERY option:

```js
const ridingHidden = ownHidden.filter(a => fitsPackage(a, pkg));
const droppedHidden = ownHidden.filter(a => !fitsPackage(a, pkg));
const invisibleExtras = selectedExtras.filter(id => !visibleIds.has(id));
const addonIds = [...new Set([
  ...selectedExtras.filter(id => visibleIds.has(id)),
  ...ridingHidden.map(a => a.id),
])];
if (tierForPkg) addonIds.push(tierForPkg);
```

`num_bartenders` becomes override-only (replaces the unconditional pass at :220):

```js
// The column holds persisted DERIVATIONS as well as true overrides (crud
// writes staffing.actual back). Carrying a derivation onto a package with a
// different ratio prices phantom over-ratio bartenders that quote and commit
// would AGREE on, so the 409 gate can't catch it. Only a real override rides.
const snapStaff = proposal.pricing_snapshot?.staffing || null;
const nbOverride = snapStaff
  && Number(snapStaff.actual) !== Number(snapStaff.required)
  ? proposal.num_bartenders : null;
```

Pass `num_bartenders: nbOverride` in the `priceProposedState` call. Attach to each option in the response assembly:

```js
dropped: [
  ...droppedHidden.map(a => ({ addon_id: a.id, name: a.name })),
  ...invisibleExtras.map(id => {
    const a = catalog.addons.find(x => x.id === id);
    return a ? { addon_id: a.id, name: a.name } : null;
  }).filter(Boolean),
],
```

Export `fitsPackage` and the `ownHidden` computation (as `computeOwnHidden`) from the module alongside the router (`module.exports = router; module.exports.fitsPackage = fitsPackage; ...`, matching how sibling files export helpers).

- [ ] **Step 4: Run to verify pass, and run the FULL suite** (the current-card echo tests and the visibility-gate regression tests in this file protect shipped behavior): `node --test server/routes/proposals/publicOptions.test.js`. Expected: all PASS.

- [ ] **Step 5: Commit** (lane checkpoint): `git add server/routes/proposals/publicOptions.js server/routes/proposals/publicOptions.test.js` then commit "quote: hidden add-ons ride every option; override-only num_bartenders; dropped list".

### Task 2: Switch rate limiter

**Files:**
- Modify: `server/middleware/rateLimiters.js`

**Interfaces:**
- Produces: `switchLimiter` export, token-keyed, 20 per 15 min, consumed by Task 4.

- [ ] **Step 1: Implement** below `optionsQuoteLimiter` (:62), same shape, tighter cap:

```js
// The switch WRITES the proposal (package, total, snapshot). Same token key
// as optionsQuoteLimiter so browsing can never spend this budget, but a
// write endpoint gets a tight cap: a real client switches a handful of
// times, not 120.
const switchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many changes at once. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

Add `switchLimiter` to the export object at :215.

- [ ] **Step 2: Commit** with Task 4 (the limiter is inert until mounted; fold into Task 4's commit).

### Task 3: `options_available` on the public GET

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (GET `/t/:token`, :59)
- Test: `server/routes/proposals/publicToken.test.js` (extend)

**Interfaces:**
- Produces (consumed by client lane Task 1): `options_available: boolean` on the GET `/t/:token` JSON payload.

- [ ] **Step 1: Failing tests** (extend the existing publicToken suite with its fixture pattern):

```js
// options_available true: status 'sent', no override, unsigned, ungrouped,
// catalog has >= 2 comparable packages.
// options_available false, one test each: status 'draft'; status 'modified';
// total_price_override set; client_signed_at set; grouped and undecided
// (group_id set, chosen_proposal_id null); grouped and DECIDED stays true.
```

- [ ] **Step 2: Run to verify fail:** `node --test server/routes/proposals/publicToken.test.js`.

- [ ] **Step 3: Implement.** After the row loads (it already selects `status`, `total_price_override` via... note: the GET's SELECT does NOT currently pull `total_price_override` or `group_id`; add `p.total_price_override, p.group_id` to the SELECT list, and they must NOT leak: strip them from the response object before `res.json` exactly as the route already shapes fields). Compute with one cheap query:

```js
const SWITCHABLE = ['sent', 'viewed'];
let optionsAvailable = SWITCHABLE.includes(proposal.status)
  && proposal.total_price_override === null
  && !proposal.client_signed_at;
if (optionsAvailable && proposal.group_id !== null) {
  const g = await pool.query(
    'SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1',
    [proposal.group_id]);
  optionsAvailable = !!g.rows[0] && g.rows[0].chosen_proposal_id !== null;
}
if (optionsAvailable) {
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS n FROM service_packages
      WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR id = $1`,
    [proposal.package_id]);
  optionsAvailable = cnt.rows[0].n >= 2;
}
```

Attach `options_available: optionsAvailable` to the payload; delete `total_price_override` and `group_id` from the returned object.

- [ ] **Step 4: Run to verify pass**, plus the whole existing suite in the file.

- [ ] **Step 5: Commit:** "public GET: options_available flag (whitelist + override + group + catalog gates)".

### Task 4: The switch endpoint

**Files:**
- Create: `server/routes/proposals/publicSwitch.js`
- Modify: `server/routes/proposals/index.js` (mount, next to the :13 publicOptions mount)
- Modify: `scripts/sensitive-paths.txt` (add `server/routes/proposals/publicSwitch.js` and `server/routes/proposals/publicToken.js` in the :262 block with a one-line why)
- Test: `server/routes/proposals/publicSwitch.test.js`

**Interfaces:**
- Consumes: `fitsPackage`/`computeOwnHidden` (Task 1), `switchLimiter` (Task 2), `priceProposedState`, `reconcileProposalPaymentStatus`, `refreshUnlockedInvoices`, `getStripe` via `stripeClient.js`.
- Produces (the client lane's contract): `POST /api/proposals/t/:token/switch` with body `{package_id, tier_addon_id, extra_addon_ids, acknowledged_total}` (dollars). 200: the full public proposal payload, byte-shape-identical to GET `/t/:token` (including `options_available`). 409 `TOTAL_CHANGED`: `{error, code: 'TOTAL_CHANGED', quote}` where `quote` is the fresh options-POST response body. Other refusals: 409 with codes `SWITCH_NOT_AVAILABLE` (status/override/signed/grouped), `PAYMENT_IN_FLIGHT`, 400 `ValidationError` on malformed body, 404 on bad token.

- [ ] **Step 1: Failing tests, the guard matrix first** (new file, modeled on `publicOptions.test.js`'s harness: dotenv + `NODE_ENV='test'` first lines, nonce'd fixtures, cleanup in `after`, Stripe stubbed at the `stripeClient` module boundary the way `stripeCreateIntent`'s tests stub it):

```js
// 404: unknown token. 400: non-UUID token (requireUuidToken).
// 409 SWITCH_NOT_AVAILABLE: status draft / modified / accepted; signed row;
//   total_price_override set; grouped-undecided; amount_paid > 0 (the
//   force-rewound fixture: status 'sent', amount_paid 100).
// 400 ValidationError: package_id absent; package_id not an offered option
//   (a class package id; an inactive non-current id).
// 409 PAYMENT_IN_FLIGHT: stripe_sessions pending row whose stubbed intent
//   status is 'processing'; another whose status is 'succeeded'.
// Happy path: cancels the cancelable pending intent (stub asserts
//   paymentIntents.cancel called; stripe_sessions row flipped 'canceled'),
//   rewrites package_id/total_price/pricing_snapshot, addon rows replaced
//   through engine output, gratuity block rebuilt for the new staffing basis
//   with floor_rate carried (mandate fixture), deposit_amount untouched,
//   invoice re-derived (amount_due matches new total minus locked),
//   activity_log row with old/new package + totals + dropped + ip,
//   response is the public allowlist shape (assert admin_notes,
//   client_signature_ip, stripe ids ABSENT), options_available present.
// 409 TOTAL_CHANGED: acknowledged_total off by a dollar; body carries the
//   fresh quote; row unchanged (total, addons, snapshot all original).
// Cents discipline: acknowledged_total 350.004999 vs engine 350.00 PASSES
//   (rounds to same cents); 350.01 vs 350.00 fails with TOTAL_CHANGED.
// Idempotent replay: same body twice; second returns 200 and the row,
//   addon rows, and invoice are byte-identical to after the first.
// Hidden addon carry: parking-fee proposal switching packages keeps the fee
//   row and the fee inside total_price; applies_to-incompatible hidden addon
//   is dropped, named in the activity log details and the response's quote...
//   (assert via a fresh options POST: dropped list matches).
```

- [ ] **Step 2: Run to verify fail:** `node --test server/routes/proposals/publicSwitch.test.js`. Expected: route not mounted, all FAIL.

- [ ] **Step 3: Implement `publicSwitch.js`.** Skeleton with the full transaction shape (this is the money core; the file should land near 300 lines with comments):

```js
router.post('/t/:token/switch', switchLimiter,
  requireUuidToken('token', 'This proposal is no longer available'),
  asyncHandler(async (req, res) => {
    const packageId = Number(req.body.package_id);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      throw new ValidationError('package_id is required');
    }
    const ackCents = Math.round(Number(req.body.acknowledged_total) * 100);
    if (!Number.isFinite(ackCents)) {
      throw new ValidationError('acknowledged_total is required');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Every guard evaluates against the LOCKED row: the quote endpoint's
      // unlocked read is the wrong model for a write; a webhook must not be
      // able to commit between guard-check and write.
      const { rows: [p] } = await client.query(
        `SELECT ${PROPOSAL_SELECT_FOR_SWITCH} FROM proposals p
          WHERE p.token = $1 FOR UPDATE OF p`, [req.params.token]);
      if (!p) throw new NotFoundError('This proposal is no longer available');

      const refusal =
        !['sent', 'viewed'].includes(p.status) ? 'status'
        : p.total_price_override !== null ? 'custom_pricing'
        : p.client_signed_at ? 'already_signed'
        : Number(p.amount_paid) > 0 ? 'amount_paid'
        : null;
      if (refusal) throw new ConflictError(
        'This proposal can no longer be reconfigured online. Reply to your email or give us a call.',
        'SWITCH_NOT_AVAILABLE');
      if (p.group_id !== null) { /* SELECT chosen_proposal_id; undecided -> same ConflictError */ }

      // Money in flight blocks the switch; a cancelable stale intent is
      // canceled HERE, server-side (create-intent's stale-cancel pattern):
      // client-side secret invalidation cannot revoke a live intent, and a
      // pre-switch intent settling post-switch passes the webhook's payable
      // guard and records the OLD amount against the NEW configuration.
      const pend = await client.query(
        `SELECT stripe_payment_intent_id FROM stripe_sessions
          WHERE proposal_id = $1 AND status = 'pending'`, [p.id]);
      for (const row of pend.rows) {
        let intent;
        try { intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id); }
        catch (e) { console.warn(...); continue; }  // gone at Stripe: not in flight
        if (['processing', 'succeeded'].includes(intent.status)) {
          throw new ConflictError(
            'A payment for this proposal is already in progress.', 'PAYMENT_IN_FLIGHT');
        }
        if (intent.status !== 'canceled') {
          await stripe.paymentIntents.cancel(intent.id);   // throws -> 500, tx rolls back, row untouched
          await client.query(
            `UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1`,
            [intent.id]);
        }
      }

      // Reprice: identical inputs to the quote (Task 1 exports), so quote and
      // commit can only disagree if the world moved, which is what 409 is for.
      const snapshot = await priceProposedState(p, {
        package_id: packageId, addon_ids, addon_quantities, addon_variants,
        num_bartenders: nbOverride,   // override-only rule, same code as Task 1
      }, client, catalog);

      if (Math.round(Number(snapshot.total) * 100) !== ackCents) {
        await client.query('ROLLBACK');
        const quote = await buildQuote(...);   // fresh options-POST body, outside the dead tx
        return res.status(409).json({
          error: 'Prices were updated. Take another look.',
          code: 'TOTAL_CHANGED', quote,
        });
      }

      // Commit writes, in the crud.js:604-646 order: proposal row, reconcile,
      // addon delete + bulk 8-column reinsert from snapshot.addons, invoice
      // refresh, activity log. total_price and pricing_snapshot from engine
      // output verbatim; tip_jar/gratuity_rate/gratuity_floor_rate/
      // deposit_amount are NEVER in the SET list.
      await client.query(
        `UPDATE proposals SET package_id = $1, total_price = $2,
                pricing_snapshot = $3, updated_at = NOW()
          WHERE id = $4`,
        [packageId, snapshot.total, JSON.stringify(snapshot), p.id]);
      const rec = reconcileProposalPaymentStatus({
        status: p.status, amountPaid: p.amount_paid, totalPrice: snapshot.total });
      // amount_paid = 0 was guarded above, so rec.changed firing means a
      // guard hole was exercised: apply it AND capture to Sentry.
      ...
      await refreshUnlockedInvoices(p.id, client);
      await client.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, 'package_switched', 'client', $2)`,
        [p.id, JSON.stringify({
          from_package_id: p.package_id, to_package_id: packageId,
          old_total: Number(p.total_price), new_total: Number(snapshot.total),
          dropped: droppedNames, ip,
        })]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }

    // Post-commit, autocommit client released: respond with the same
    // public-safe payload GET /t/:token builds (shared helper, Step 4),
    // NEVER the raw row.
    res.json(await buildPublicProposalPayload(req.params.token));
  }));
```

Observability, both in this handler: `Sentry.captureMessage('switch guard hole: amount_paid > 0 reconciled', ...)` when `rec.changed` fires (the guards made it unreachable, so firing means a hole was exercised), and a module-level per-token counter that captures once when a token accumulates 5+ TOTAL_CHANGED 409s inside 10 minutes (engine/quote drift, or a grinding token; in-memory counter is fine, this is a breadcrumb not a ledger).

`addon_ids`/quantities/variants are built exactly as the quote endpoint builds them for the chosen option (client-visible extras filtered by `visibleAddonsFor` for the TARGET package, riding hidden add-ons via `fitsPackage`, tier append), reusing Task 1's exports; `package_id` validity = it appears in the same catalog query the quote uses (active non-class, or the current package).

- [ ] **Step 4: Extract the payload builder.** In `publicToken.js`, lift the GET's SELECT + response shaping into an exported `buildPublicProposalPayload(token, db = pool)` used by both the GET (which keeps its own view-count bump and addons/drink-plan parallel fetch around it) and the switch response. The GET's behavior must not change: the existing publicToken tests are the regression gate.

- [ ] **Step 5: Mount** in `server/routes/proposals/index.js` beside the :13 options mount: `router.use('/', require('./publicSwitch')); // /t/:token/switch: public pre-signature reconfigure`. Add both files to `scripts/sensitive-paths.txt`.

- [ ] **Step 6: Run to verify pass:** `node --test server/routes/proposals/publicSwitch.test.js`, then `node --test server/routes/proposals/publicToken.test.js` (payload-builder extraction regression), then `node --test server/routes/proposals/publicOptions.test.js` (shared helpers untouched in behavior).

- [ ] **Step 7: Commit:** "switch endpoint: guarded pre-signature reconfigure with stale-intent cancel + cents 409 + audit".

### Task 5: Sign-time total assertion

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (sign route, UPDATE at :260)
- Test: `server/routes/proposals/publicToken.signTotal.test.js` (new, sibling of `publicToken.signPhone.test.js`)

**Interfaces:**
- Produces (client lane Task 4 consumes): sign POST body accepts `acknowledged_total` (dollars). Mismatch: 409 `{error: 'The total for this proposal has changed. Please review the updated price and sign again.', code: 'TOTAL_CHANGED'}`. Absent field: legacy behavior, no assertion (old tabs and the pay-only flow must not break).

- [ ] **Step 1: Failing tests:**

```js
// Sign with acknowledged_total === row total: succeeds (row signed).
// Sign with acknowledged_total one dollar off: 409 TOTAL_CHANGED, row
//   NOT signed (client_signed_at still null, status unchanged).
// Sign with NO acknowledged_total: succeeds byte-for-byte as today
//   (backward compat for in-flight tabs; the updated client always sends it).
// Cents tolerance: 350.004999 vs 350.00 row: succeeds.
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.** The WHERE gains one AND, only when the field is present (TOCTOU-collapse in the same statement, exactly like the status guard):

```js
const ackGiven = req.body.acknowledged_total !== undefined && req.body.acknowledged_total !== null;
const ackTotal = ackGiven ? Number(req.body.acknowledged_total) : null;
if (ackGiven && !Number.isFinite(ackTotal)) throw new ValidationError('Invalid total');
```

In the UPDATE: `AND ($14::numeric IS NULL OR ABS(total_price - $14::numeric) < 0.005)` with `ackGiven ? ackTotal : null` as the param. On zero rows, disambiguate: re-read the row; if `client_signed_at` is set or status unsignable, keep `ALREADY_ACCEPTED`; otherwise throw `ConflictError('The total for this proposal has changed. Please review the updated price and sign again.', 'TOTAL_CHANGED')`.

- [ ] **Step 4: Run new suite + `publicToken.test.js` + `publicToken.signPhone.test.js` to verify pass and no regression.**

- [ ] **Step 5: Commit:** "sign: total assertion in the sign UPDATE WHERE (409 TOTAL_CHANGED)".

### Task 6: Lane docs + gate

- [ ] ARCHITECTURE.md route table: add `POST /api/proposals/t/:token/switch` (public, UUID token, switchLimiter) and note `options_available` on the GET row. README folder tree: add `publicSwitch.js`. One commit: "docs: switch endpoint + options_available".
- [ ] Run every suite this lane touched, one at a time, from repo root: `publicOptions.test.js`, `publicSwitch.test.js`, `publicToken.test.js`, `publicToken.signPhone.test.js`, `publicToken.signTotal.test.js`. All green before per-lane review.

---

# Lane oo-drawer-client

### Task 1: Entry link + bottom button removal

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` (:25 h2 block), `client/src/pages/proposal/proposalView/ProposalView.js` (:30, :681-686)

**Interfaces:**
- Consumes: `proposal.options_available` (server Task 3).
- Produces: `onOpenOptions` prop into ProposalPricingBreakdown; `drawerOpen` state in ProposalView replaces `showOptions`.

- [ ] **Step 1:** In `ProposalPricingBreakdown.js`, the package `h2` becomes a flex row with the link, rendered only when available and payable:

```jsx
<div className="oo-entry-row">
  <h2 style={styles.sectionTitle}>{proposal.package_name}</h2>
  {proposal.options_available && (showSignAndPay || showPayOnly) && (
    <button type="button" className="oo-entry-link" onClick={onOpenOptions}>
      See other packages for this event
    </button>
  )}
</div>
```

- [ ] **Step 2:** In `ProposalView.js`: rename `showOptions` state to `drawerOpen` plus a `drawerEverOpened` ref (mount-once, hide on close); DELETE the `.oo-open` bottom-button block (:681-686); pass `onOpenOptions={() => setDrawerOpen(true)}` into `ProposalPricingBreakdown`. The drawer mounts once `drawerEverOpened` and hides via CSS when closed, so tier/extras selections and the quote survive close/reopen. Hide the link and the drawer whenever `signedThisSession.current` is set or the status leaves the payable set (reuse `isPayableStatus`).
- [ ] **Step 3:** CSS in `index.css`: `.oo-entry-row` (flex, baseline, gap), `.oo-entry-link` (quiet brass underline link, `font-size: 0.85rem`, no button chrome, visible focus ring).
- [ ] **Step 4:** `cd client && CI=true npx react-scripts build`. Commit: "entry link beside package title; bottom button removed".

### Task 2: Drawer shell (sheet, panel, a11y, sessionStorage)

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`, `client/src/index.css`

**Interfaces:**
- Produces: `<OtherOptionsPanel open onClose token proposal onSwitched />` contract consumed by ProposalView; internal `useDrawerChrome` behavior (scroll lock, focus trap, Esc).

- [ ] **Step 1:** Wrap the panel body in a drawer container:

```jsx
<div className={`oo-drawer ${open ? 'oo-drawer-open' : ''}`} role="dialog"
     aria-modal="true" aria-label="Same date, different package" ref={drawerRef}>
  <button type="button" className="oo-drawer-handle" aria-label="Expand options"
          onClick={() => setSnap(s => (s === 'peek' ? 'full' : 'peek'))} {...dragHandlers} />
  <div className="oo-anchor" aria-live="off">
    YOURS · {currentName} · {fmt(anchorTotal)}
  </div>
  <div className={`oo-drawer-body ${snap === 'full' ? 'oo-scrollable' : ''}`}>...</div>
</div>
```

Behavior effects: while `open`, `document.body.style.overflow = 'hidden'` (restore on close); keydown Esc calls `onClose`; on open, focus the drawer; on close, return focus to the entry link (`onClose` receives no args, ProposalView keeps a ref on the link). Drag: pointerdown/move/up on the handle toggling `snap` when the drag crosses 80px, transform-based (`translateY`) between the two snap heights. Peek state's body is `overflow: hidden` (drag never fights list scroll); full state scrolls internally.

- [ ] **Step 2: CSS.** Mobile (default): fixed bottom sheet, `border-radius 16px 16px 0 0`, `transform: translateY(100%)` closed, peek `translateY(calc(100% - 340px))`, full `translateY(6vh)`, `transition: transform 0.28s ease`, `z-index` above the page, on-paper background matching the card system, drag handle bar. Desktop `@media (min-width: 1024px)`: right side panel, `position: fixed; top: 0; right: 0; height: 100vh; width: min(440px, 92vw); transform: translateX(100%)`, open `translateX(0)`, no backdrop, left border in the brass hairline; handle hidden; internal scroll always on. `.oo-anchor` sticky top inside the drawer.
- [ ] **Step 3: sessionStorage.** Persist `{tierId, extraIds, updatedAt: proposal.updated_at}` under `oo-drawer-${token}` on every selection change; on mount, restore only when `updatedAt === proposal.updated_at` (an admin edit invalidates); never store quotes or totals.
- [ ] **Step 4:** Skeleton cards while `loading` in peek (three pulsing card outlines, existing `.spinner` idiom is too heavy here; simple `.oo-skel` blocks). Client build green. Commit: "drawer shell: sheet + side panel, a11y, sessionStorage".

### Task 3: Peek tier, anchor, cards, retirement of compare

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`
- Delete: `client/src/pages/proposal/otherOptions/CompareTable.js`
- Modify: `client/src/index.css`, `README.md` (folder tree)

**Interfaces:**
- Consumes: `options[].dropped` from the quote (server Task 1).
- Produces: `pickPeek(options, currentPackageId)` pure helper (exported for tests).

- [ ] **Step 1:** Delete pick/compare: `MAX_COMPARE`, `picked`, `togglePick`, `pickedCols`, the `view === 'compare'` branch, the tray, the `CompareTable` import, and `CompareTable.js` itself (tracked delete needs the per-action yes: surface it at execution). Card foot and `aria-pressed` selection semantics go with them.
- [ ] **Step 2:** Peek selection, pure and testable:

```js
export function pickPeek(options, currentPackageId) {
  const avail = options.filter(o => o.available && !o.is_current);
  const current = options.find(o => o.is_current);
  const byDist = [...avail].sort((a, b) =>
    Math.abs(a.total - current.total) - Math.abs(b.total - current.total));
  const below = byDist.find(o => o.total < current.total) || null;
  const above = byDist.find(o => o.total > current.total) || null;
  const structural = current.isByob
    ? byDist.find(o => !o.isByob && o !== below && o !== above)
    : avail.find(o => o.isByob && o !== below && o !== above);
  const picked = [below, above, structural].filter(Boolean);
  // Backfill to three distinct cards when a slot is empty (cheapest package,
  // no BYOB fit): next-nearest by distance.
  for (const o of byDist) {
    if (picked.length >= 3) break;
    if (!picked.includes(o)) picked.push(o);
  }
  return picked;
}
```

Peek renders `pickPeek(...)` as flat cards (no lanes) under the anchor, then "See all packages" toggles `expanded`; expanded renders the EXISTING lane groupings with every option (peek cards re-slot, never duplicated) plus unavailable cards with reasons. `available: false` never appears in peek (the filter above).

- [ ] **Step 3:** Card changes: delta line becomes the visual hero (`.oo-card-delta` up to `1.05rem`, `font-weight 500`, neutral `var(--deep-brown)`; explicitly NOT sage); action button `Switch to this package` replaces the tap-to-compare hit target (card body stays a plain div now, no giant button wrapper: the switch button is the single control, which also simplifies the a11y tree); `dropped.length > 0` renders `.oo-card-dropped`: "Not included with this package: {names}. It comes off the price here."
- [ ] **Step 4:** Anchor total = the current card's displayed total (`is_current` option's `total`), the same value deltas are computed from. Jest test for `pickPeek` (below/above/structural, cheapest-package backfill, BYOB-current case, fewer-than-three case). Client build green. README tree updated (CompareTable removed). Commit: "peek tier + switch cards; compare flow retired".

### Task 4: The switch flow

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`, `client/src/pages/proposal/proposalView/ProposalView.js`, `client/src/index.css`

**Interfaces:**
- Consumes: `POST /t/:token/switch` contract (server Task 4), sign `acknowledged_total` (server Task 5).

- [ ] **Step 1: Switch action in the panel:**

```js
const [switching, setSwitching] = useState(null); // package_id in flight
const doSwitch = async (option) => {
  if (switching) return;                          // double-tap gate
  setSwitching(option.package_id);
  try {
    const res = await axios.post(`${BASE_URL}/proposals/t/${token}/switch`, {
      package_id: option.package_id,
      tier_addon_id: selRef.current.tierId ?? null,
      extra_addon_ids: selRef.current.extraIds || [],
      acknowledged_total: option.total,
    });
    onSwitched(res.data);                          // ProposalView adopts + closes
  } catch (err) {
    if (err.response?.status === 409 && err.response.data?.code === 'TOTAL_CHANGED'
        && err.response.data.quote) {
      setData(err.response.data.quote);            // adopt the fresh quote
      setError('Prices were updated. Take another look.');
    } else if (err.response?.status === 409) {
      setError(err.response.data?.error || 'This proposal can no longer be changed online.');
    } else {
      // Lost response: the switch may have committed. Reconcile with truth.
      try {
        const fresh = await axios.get(`${BASE_URL}/proposals/t/${token}`);
        onSwitched(fresh.data, { maybeUnchanged: true });
      } catch { setError('We could not make that change just now.'); }
    }
  } finally { setSwitching(null); }
};
```

Button: `disabled={!!switching}`, label swaps to a small inline spinner + "Switching…" while its own id is in flight.

- [ ] **Step 2: `onSwitched` in ProposalView:** `setProposal(payload)`; `setDrawerOpen(false)`; clear both cached secrets and `depositIntentAutopayRef` (the existing gratuity debounce effect is bypassed: clear immediately, a switch is not a keystroke stream); `setGratuityDirty(false)` so the seeding effect (:175) reseeds tip/total from the NEW snapshot; flash the Total: set a `totalFlash` state driving `.total-flash` (2s brass background fade via CSS animation) on the tfoot total cell, announce via the existing toast (`toast.success('Switched to ' + payload.package_name)`) which doubles as the live-region announcement.
- [ ] **Step 3: Sign carries the rendered total:** in `handleSign` (:325), add `acknowledged_total: totalPrice` to the sign POST body. In its catch, on `code === 'TOTAL_CHANGED'`: refetch GET `/t/:token`, `setProposal`, and set `formError` to the server's message so the client re-reviews and signs again.
- [ ] **Step 4:** Client build green. Manual walk on the dev server (`npm run dev`, a seeded sent proposal): open drawer, toggle an extra, switch down, watch Total flash and gratuity reseed, sign with the new total. Commit: "switch flow: 409 re-show, lost-response reconcile, secret invalidation, sign assertion".

### Task 5: Lane polish + gate

- [ ] Kill dead code: `handleWantOption` + the mailto and its DELIBERATE SEAM comment block in ProposalView (:306-323), the `onWantOption`/`onChoose` prop chain, `.oo-open`/`.oo-open-btn`/tray/compare CSS blocks in `index.css`.
- [ ] Copy check: link, header (`oo-pick-head` h2 becomes "Same date, <em>different package</em>."), card action, dropped notice, 409 banner. No em dashes anywhere.
- [ ] Full client gate `CI=true npx react-scripts build`; jest suites in the touched tree (`pickPeek` test, any ProposalView tests). Commit: "drawer polish: dead code out, copy locked".

---

## Self-review notes (spec coverage)

- Spec decisions 1-11 map to: link/bottom-button (client 1), sheet/panel/a11y/sessionStorage (client 2), header copy (client 5), peek tier + boundaries + anchor + delta + dropped notice (client 3), switch reality + intent cancel + 409 + reconcile + invoice + audit + allowlist (server 4), hidden-addon carry (server 1 + 4), sign assertion (server 5 + client 4), options_available incl. draft/modified/grouped gating (server 3), limiter (server 2), docs (server 6, client 3), election-at-payment law (Global Constraints + server 4 SET list).
- Launch checks (Walk Test Package in prod; drink-plan flip verify) are release-time items, not lane tasks: they run at push time and are recorded in the spec.
- Out of scope confirmed absent: no analytics, no admin notification (audit row only), no add-on purchase surface, no compare-group changes, no schema changes.
