# Proposal Options Drawer + Switch Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bottom-of-page "See other options" panel with a drawer entered beside the package title, streamlined to a three-card peek, whose "Switch to this package" action really rewrites the proposal pre-signature, with the money seams closed (stale-intent cancellation, sign-time total assertion, hidden add-ons carried).

**Architecture:** Server first: a small shared module (`optionsPricingShared.js`) pins the pricing identity (proposal SELECT, hidden-add-on rules, override-only staffing) so quote and switch cannot drift; the quote endpoint (`publicOptions.js`) carries the proposal's own hidden add-ons onto every option and reports per-option dropped items; the public GET's payload shaping is extracted into a shared builder, gains `options_available`, and a new sibling route `publicSwitch.js` owns the one write (FOR UPDATE transaction: cancel stale intents, re-price, cents-compare the acknowledged total, rewrite row + addons + snapshot, reconcile, refresh invoices, audit log); the sign UPDATE gains a total assertion. Client second: `OtherOptionsPanel` becomes a drawer body first (shell before entry, so every interim state works), then the entry link moves beside the package title, then peek tier and the switch flow land, with an RTL suite owning the spec's client test list.

**Tech Stack:** Existing stack only, no new dependencies. Raw SQL via `pg`, Express routers, `node --test` with the repo's `node:http` harness, React 18 + jest/RTL (CRA) + vanilla CSS in `index.css`, raw axios on the public token page (matching `ProposalView.js`).

**Spec:** `docs/superpowers/specs/2026-08-14-proposal-options-drawer-design.md` (spec-fleet findings folded 2026-08-14; hidden-add-on carry decided by Dallas). Plan-fleet findings folded 2026-08-14.

**Proven context (verified against the repo 2026-08-14 by the plan fleet, live-queried where stated):**
- `server/routes/proposals/publicOptions.js`: `PROPOSAL_SELECT` at :44 is exactly the pricing field set `priceProposedState` reads (plus token/status/signature gates). `UNSIGNABLE` :55, `notComparable` :57, `safeIds` :61 (caps 40, integer ids). Route order at :74-75 is `requireUuidToken` THEN `optionsQuoteLimiter` (UUID gate first, so junk tokens never spend a bucket; the switch mounts in the same order). `ownHidden` carried only on the current-package branch (:186). The unconditional `num_bartenders` pass exists at TWO call sites: the option loop (:218) and the BYOB tiers loop (:286); both must take the override-only rule or tier cards disagree with option cards. `instanceof ValidationError` decides available:false (:225). Response shape :344.
- `server/routes/proposals/publicOptions.test.js`: mounts the REAL router on a fresh express app and uses the REAL seeded dev catalog (its own header says so); it has NO service_addons fixture machinery, so hidden-addon tests that need an `applies_to='byob'` addon must insert and clean up nonce'd `service_addons` rows themselves (Task 1 adds that helper).
- `server/utils/changeRequests.js:65`: `async function priceProposedState(proposal, proposed, db = pool, catalog = null)`. It reads OFF THE PROPOSAL: `package_id, guest_count, event_duration_hours, num_bars, adjustments, pricing_snapshot (syrups), total_price_override, gratuity_rate, tip_jar, gratuity_floor_rate, client_provides_glassware, id`. Returned snapshot: `.total` (dollars), `.addons` `{id, name, billing_type, rate, quantity, line_total, variant}`, `.staffing` (`required`, `actual`), `.gratuity` (carries `floor_rate`; engine shape at `pricingEngine.js:574-604`).
- `server/routes/proposals/crud.js:604-646`: the write precedent. `reconcileProposalPaymentStatus({status, amountPaid, totalPrice})` (`server/utils/proposalStatus.js:18-35`) returns `{changed, status, autopayDisarmed, overpaid, overpaidCents}`; addon rewrite is DELETE then one bulk 8-column INSERT from `snapshot.addons`; `proposal_activity_log` INSERT shape.
- `server/db/schema.sql:926`: `proposal_activity_log(proposal_id, action, actor_type, actor_id, details JSONB, created_at)`. No schema changes anywhere in this plan.
- `server/utils/invoiceLifecycle.js:99`: `refreshUnlockedInvoices(proposalId, dbClient)`, in-tx capable, no-op when no unlocked invoices exist.
- `server/routes/stripeCreateIntent.js:127-176`: pending lookup on `stripe_sessions` status 'pending'; cancel pattern skipping succeeded/processing/canceled; a failed cancel warns, never silent. Stripe obtained via `getStripe` from `server/utils/stripeClient.js`. Test precedent: `stripeCreateIntent.test.js` overrides `getStripe` in the require cache BEFORE requiring the router; `publicSwitch.test.js` stubs the same way (and stubs `refreshUnlockedInvoices` the same way for the atomicity-failure test).
- `server/routes/proposals/publicToken.js`: GET :59 public allowlist SELECT (`WHERE p.token = $1`, LATERAL `open_invoice_token`); the FULL payload also includes the addons fetch, `drink_plan_token`, `client_phone_prefill`, `payment_policy`, and the sent-to-viewed display handling built at :107-177; sign UPDATE at :260 has 13 params, `$14` free; `requireUuidToken` (`server/utils/tokens.js:22-26`) throws NotFoundError, so a non-UUID token is a 404, not a 400. Line anchors in this file WILL rot within the lane (Tasks 3/4 edit above the sign route); find the sign UPDATE by content, not by :260.
- `server/middleware/rateLimiters.js:49`: `optionsQuoteLimiter` (120/15min, token-keyed); export object at :215; file sensitive-listed.
- `scripts/sensitive-paths.txt`: `publicOptions.js`, `changeRequests.js`, `proposalExtrasFold.js`, `proposalStatus.js` listed; **`publicToken.js` NOT listed**; this lane adds it and `publicSwitch.js` and `optionsPricingShared.js`.
- `server/utils/proposalRules.js:144`: `visibleAddonsFor({addons, pkg, guestCount, addonIds})`; always-hidden slugs `parking-fee`/`handcrafted-syrups-3pack`; `applies_to` gate :156; guest gates :160.
- Cross-route helper sharing: router-attached exports exist (`thumbtack.js:674`, `potions.js:419`) but every consumer is a test; the repo's proven production-sharing mechanism is a small module (`changeRequests.js` pattern). Hence `optionsPricingShared.js`.
- Client: `ProposalView.js` is 695 lines (soft cap 700 warns, never blocks; this lane's additions cross it, offset partly by the mailto deletion; acknowledged, no split owed). `showOptions` :30, `handleWantOption` :316, `handleSign` :325, gratuity seeding :175-182 gated on `!gratuityDirty`, secret debounce :273-291, `isPayableStatus` :97, bottom-button block :681-686 (INCLUDES the panel mount at :686), `totalPrice` :464. `ProposalPricingBreakdown.js` h2 :25, tfoot :72-81, CTA :164-174. `OtherOptionsPanel.js` decorates options client-side (`isByob` exists only after its useMemo; the RAW quote payload carries `category`). `CompareTable.js` exists to delete; `ExtrasPanel.js` stays. Client jest precedent lives in the touched tree (`proposalView/gratuityFloor.test.js`); client suites run via `cd client && CI=true npm test` (root `npm test` globs server only). RTL is available (CRA).
- Error middleware serializes `code` on AppError; 11 active comparable packages in the dev catalog including "Walk Test Package" (live-queried).
- The dev server is Claude-managed and normally already running; check before spawning a second instance.

## Global Constraints

- **No em dashes** in copy, comments, or docs. Commas, colons, parentheses.
- **Max effort everywhere.** Money in DOLLARS on proposals; every acknowledged-total comparison in integer cents via `Math.round(Number(x) * 100)`.
- **One pooled connection** for the whole switch handler, and NOTHING that takes its own connection runs while it is held: the 409 fresh-quote build happens AFTER rollback and release (Task 5 Step 3 is explicit; this is the SERVER-17 / capture-lead class).
- **AppError discipline:** `ValidationError`/`NotFoundError`/`ConflictError`; check `statusCode` or `instanceof`, never `.status`.
- **Election-at-payment law:** the switch endpoint NEVER writes `tip_jar`, `gratuity_rate`, `gratuity_floor_rate`, or `deposit_amount`; the snapshot's gratuity block comes from the engine and must carry `floor_rate`.
- **Server tests one at a time from repo root.** Client gate: `cd client && CI=true npx react-scripts build` before any commit touching `client/`; client suites via `cd client && CI=true npm test`.
- **Explicit staging only; no backticks in commit messages** (`git commit -F -` heredoc).
- **Copy is locked and used verbatim:** link "See other packages for this event"; header "Same date, different package." (plain, no added emphasis markup); card action "Switch to this package."; 409 line "Prices were updated, take another look." (one sentence, comma); deltas neutral color.
- **Frontend calls on this page use raw axios + BASE_URL** (public token page, no JWT), matching `ProposalView.js`.

## Lane map

```yaml
lanes:
  - id: oo-switch-server
    phase: 1
    scope: >
      All server work: the optionsPricingShared module pinning quote/switch
      pricing identity; quote endpoint carries hidden add-ons onto every
      option (BOTH call sites take the override-only num_bartenders rule)
      and reports per-option dropped items; public-payload builder
      extraction; options_available; the publicSwitch.js endpoint; the
      sign-time total assertion; switch rate limiter; sensitive-paths
      additions; walkthroughs-owed entries; ARCHITECTURE/README updates.
      NOTE for the push decision: this lane alone changes displayed totals
      on the LIVE shipped panel (hidden add-ons priced into every option,
      persisted staffing derivations re-derived per target package). That
      is intended and correct per spec decision 10 (prices become honest),
      the panel has had no recorded use, and its only action is the mailto;
      the dropped-notice UI arrives with lane 2.
    footprint:
      - server/routes/proposals/optionsPricingShared.js
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
      - docs/walkthroughs-owed.md
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, database-review, performance-review]

  - id: oo-drawer-client
    phase: 2
    scope: >
      The drawer, shell-first so every interim state works: drawer chrome
      on the existing panel (still opened by the legacy button), then the
      entry link beside the package title, then peek tier and cards, then
      the switch flow, then the RTL behavior suite owning the spec's
      client test list, then polish (dead mailto out, copy check).
    footprint:
      - client/src/pages/proposal/proposalView/ProposalView.js
      - client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
      - client/src/pages/proposal/otherOptions/OtherOptionsPanel.js
      - client/src/pages/proposal/otherOptions/OtherOptionsPanel.test.js
      - client/src/pages/proposal/otherOptions/pickPeek.js
      - client/src/pages/proposal/otherOptions/pickPeek.test.js
      - client/src/pages/proposal/otherOptions/ExtrasPanel.js
      - client/src/pages/proposal/otherOptions/CompareTable.js
      - client/src/index.css
      - README.md
    depends_on: [oo-switch-server]
    review_fleet: [code-review, consistency-check, security-review, ui-ux-review]
```

The client lane consumes only the HTTP contracts pinned in the Interfaces blocks, so it can be built from this plan alone, but merges after lane 1 so integration runs against real endpoints.

---

# Lane oo-switch-server

### Task 1: Pricing identity module + quote endpoint changes

**Files:**
- Create: `server/routes/proposals/optionsPricingShared.js`
- Modify: `server/routes/proposals/publicOptions.js` (BOTH pricing call sites, response assembly)
- Test: `server/routes/proposals/publicOptions.test.js` (extend; add a service_addons fixture helper)

**Interfaces:**
- Produces (Task 5 and the client lane consume): `optionsPricingShared.js` exports
  - `PROPOSAL_SELECT` (moved verbatim from publicOptions.js :44; publicOptions imports it back),
  - `fitsPackage(addon, pkg)` (`applies_to === 'all' || applies_to === pkg.category`),
  - `computeOwnHidden(proposalAddonRows, catalog, currentPkg, guestCount)` (the proposal's own addon rows invisible to the client on the CURRENT package),
  - `overrideOnlyBartenders(proposal)` (returns `proposal.num_bartenders` only when the stored snapshot shows `staffing.actual !== staffing.required`, else `null`).
- Produces: each element of `options[]` gains `dropped: [{addon_id, name}]`; option totals now INCLUDE the proposal's own hidden add-ons wherever `fitsPackage` holds.

- [ ] **Step 1: Fixture helper + failing tests.** Add to `publicOptions.test.js` a helper that INSERTs a nonce'd `service_addons` row (e.g. `applies_to: 'byob'`, unique slug) and deletes it in `after` (the harness uses the real dev catalog and has no such machinery today). Then the failing tests:

```js
test('own hidden add-ons ride every option, not just the current card', ...);
  // parking-fee row on a hosted proposal: every applies_to-compatible option's
  // total includes the fee (diff vs a control proposal without it), dropped []
test('applies_to-incompatible hidden addon appears in dropped, not the price', ...);
  // nonce'd applies_to='byob' hidden addon on a hosted proposal: BYOB option
  // prices it; hosted options name it in dropped
test('num_bartenders passes only on a true override, at BOTH call sites', ...);
  // Fixture A (derivation: snapshot.staffing.actual === required): an option
  // with a different guests_per_bartender ratio prices with ITS OWN derived
  // staffing, AND the BYOB tier-card totals agree with the BYOB option total
  // (the :286 tiers loop takes the same rule).
  // Fixture B (true override: actual !== required): the override carries.
```

- [ ] **Step 2: Run to verify fail:** `node --test server/routes/proposals/publicOptions.test.js`. Expected: three new tests FAIL (fee missing from alternative totals, no `dropped` field, phantom staffing / tier disagreement).

- [ ] **Step 3: Implement.** Create `optionsPricingShared.js` with the four exports (PROPOSAL_SELECT moved, not copied; publicOptions.js imports it). In publicOptions.js:

```js
const { PROPOSAL_SELECT, fitsPackage, computeOwnHidden, overrideOnlyBartenders }
  = require('./optionsPricingShared');
```

Compute `ownHidden` once above both branches. For EVERY option:

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

Replace the unconditional `num_bartenders: proposal.num_bartenders ?? null` with `num_bartenders: overrideOnlyBartenders(proposal)` at BOTH call sites (:218 option loop AND :286 tiers loop). Attach `dropped` in the response assembly (droppedHidden + invisibleExtras mapped to `{addon_id, name}`).

- [ ] **Step 4: Run to verify pass, full suite** (the echo/visibility regression tests protect shipped behavior): `node --test server/routes/proposals/publicOptions.test.js`.

- [ ] **Step 5: Two commits, separately revertable price behaviors:** first `git add server/routes/proposals/optionsPricingShared.js server/routes/proposals/publicOptions.js server/routes/proposals/publicOptions.test.js` commit "quote: hidden add-ons ride every option; per-option dropped list"; then the override-only change as its own commit "quote: num_bartenders only on a true override, both call sites" (stage the same files; in-lane bisection can then tell which change moved a price).

### Task 2: Switch rate limiter

**Files:** Modify `server/middleware/rateLimiters.js`.

**Interfaces:** Produces `switchLimiter` (token-keyed, 20/15min), consumed by Task 5.

- [ ] **Step 1: Implement** below `optionsQuoteLimiter`, same shape, `max: 20`, message `'Too many changes at once. Please try again in a moment.'`. Add to the export object.
- [ ] **Step 2: Commit rides with Task 5** (inert until mounted).

### Task 3: Extract the public payload builder (refactor, own gate)

**Files:**
- Modify: `server/routes/proposals/publicToken.js`
- Test: existing `server/routes/proposals/publicToken.test.js` is the regression gate (no new tests)

**Interfaces:**
- Produces (Tasks 4 and 5 consume): `buildPublicProposalPayload(token, db = pool)` exported from publicToken.js, returning the COMPLETE public payload: the allowlist row, the addons array, `drink_plan_token`, `client_phone_prefill`, `payment_policy`, and the sent-to-viewed display handling, everything ProposalView renders from. The GET keeps OUTSIDE the builder only its side effects: the view-count bump and view logging. This boundary is what makes the switch's 200 response genuinely shape-identical to the GET.

- [ ] **Step 1:** Lift the GET's SELECT + payload assembly (:59-177 today; find by content) into the builder; the GET calls it and layers the view bump around it. Pure refactor, zero behavior change.
- [ ] **Step 2: Run the regression gate:** `node --test server/routes/proposals/publicToken.test.js` and `node --test server/routes/proposals/publicToken.signPhone.test.js`. Expected: all PASS unchanged.
- [ ] **Step 3: Commit alone:** "publicToken: extract buildPublicProposalPayload (no behavior change)". A GET regression now bisects to this commit, not the money commit.

### Task 4: `options_available`

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (inside the builder from Task 3)
- Test: `server/routes/proposals/publicToken.test.js` (extend)

**Interfaces:**
- Produces (client lane consumes): `options_available: boolean` on the GET payload AND therefore on the switch's 200 response (both come from the builder).

- [ ] **Step 1: Failing tests:** true on `sent` (no override, unsigned, ungrouped, catalog >= 2); false one test each for: `draft`; `modified`; `total_price_override` set; `client_signed_at` set; grouped-undecided; grouped-DECIDED stays true.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement inside the builder.** Add `p.total_price_override, p.group_id` to the SELECT; compute:

```js
const SWITCHABLE = ['sent', 'viewed'];
let optionsAvailable = SWITCHABLE.includes(proposal.status)
  && proposal.total_price_override === null && !proposal.client_signed_at;
if (optionsAvailable && proposal.group_id !== null) {
  const g = await db.query('SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1', [proposal.group_id]);
  optionsAvailable = !!g.rows[0] && g.rows[0].chosen_proposal_id !== null;
}
if (optionsAvailable) {
  const cnt = await db.query(
    `SELECT COUNT(*)::int AS n FROM service_packages
      WHERE (is_active = true AND bar_type IS DISTINCT FROM 'class') OR id = $1`,
    [proposal.package_id]);
  optionsAvailable = cnt.rows[0].n >= 2;
}
```

Attach `options_available`; DELETE `total_price_override` and `group_id` from the returned object (never leak).
- [ ] **Step 4: Run to verify pass** plus the whole file's suite. **Commit:** "public payload: options_available flag".

### Task 5: The switch endpoint

**Files:**
- Create: `server/routes/proposals/publicSwitch.js`
- Modify: `server/routes/proposals/index.js` (mount beside :13), `scripts/sensitive-paths.txt` (add `publicSwitch.js`, `publicToken.js`, `optionsPricingShared.js` with one-line whys)
- Test: `server/routes/proposals/publicSwitch.test.js`

**Interfaces:**
- Consumes: `optionsPricingShared` exports (Task 1), `switchLimiter` (Task 2), `buildPublicProposalPayload` (Task 3), `priceProposedState`, `reconcileProposalPaymentStatus`, `refreshUnlockedInvoices`, `getStripe`.
- Produces (client lane contract): `POST /api/proposals/t/:token/switch`, body `{package_id, tier_addon_id, extra_addon_ids, acknowledged_total}` (dollars). 200: `buildPublicProposalPayload` output (incl. `options_available`). 409 `TOTAL_CHANGED`: `{error: 'Prices were updated, take another look.', code: 'TOTAL_CHANGED', quote}` where `quote` is the fresh options-POST body. Other refusals: 409 `SWITCH_NOT_AVAILABLE`, 409 `PAYMENT_IN_FLIGHT`, 400 ValidationError (malformed body), 404 (unknown OR non-UUID token: `requireUuidToken` throws NotFoundError).

- [ ] **Step 1: Failing tests, guard matrix first** (stub `getStripe` via the require cache BEFORE requiring the router, the `stripeCreateIntent.test.js` precedent; stub `refreshUnlockedInvoices` the same way only in the atomicity test):

```js
// 404: unknown token; 404: non-UUID token (NotFoundError, not 400).
// 409 SWITCH_NOT_AVAILABLE: draft / modified / accepted; signed; override set;
//   grouped-undecided; amount_paid > 0 (force-rewound fixture: sent + 100 paid).
// 400 ValidationError: package_id absent / not an offered option.
// 409 PAYMENT_IN_FLIGHT: pending stripe_sessions row whose stubbed intent is
//   'processing'; another 'succeeded'.
// Happy path: cancelable pending intent canceled (stub asserts) + session row
//   'canceled'; package_id/total_price/pricing_snapshot rewritten; addons
//   replaced from engine output; gratuity block rebuilt with floor_rate
//   (mandate fixture); deposit_amount untouched; invoice re-derived;
//   activity_log row (old/new package + totals + dropped + ip); response is
//   builder-shaped (admin_notes/signature ip/stripe ids ABSENT,
//   options_available PRESENT).
// DISCOUNTED proposal (adjustments row) switches cleanly: quote total ===
//   commit total, no 409 (guards the SELECT carrying `adjustments`).
// Differing-ratio staffing AT THE SWITCH CALL SITE: derivation fixture
//   switches hosted-to-hosted across guests_per_bartender ratios both
//   directions without phantom over-ratio lines; true-override fixture keeps
//   the override (quote-level coverage in Task 1 does not cover this file's
//   own overrideOnlyBartenders call).
// No-invoice branch: grouped-DECIDED proposal with no minted invoice
//   switches cleanly; refreshUnlockedInvoices no-ops.
// 409 TOTAL_CHANGED: acknowledged_total off by a dollar; body carries fresh
//   quote; row unchanged. Cents tolerance: 350.004999 vs 350.00 passes;
//   350.01 fails.
// Idempotent replay: same body twice; second 200; row + addons + invoice
//   identical EXCLUDING updated_at (the switch stamps it).
// Atomicity: refreshUnlockedInvoices stubbed to throw; whole tx rolls back;
//   row, addons, activity log all unchanged.
// Hidden addon carry: parking-fee kept across packages inside total_price;
//   applies_to-incompatible hidden addon dropped + named in activity details.
```

- [ ] **Step 2: Run to verify fail** (route not mounted).

- [ ] **Step 3: Implement `publicSwitch.js`.** Route order `requireUuidToken` THEN `switchLimiter` (repo convention: junk tokens never spend a bucket). Handler shape:

```js
const { PROPOSAL_SELECT, fitsPackage, computeOwnHidden, overrideOnlyBartenders }
  = require('./optionsPricingShared');
// SELECT: the shared pricing set plus the guard fields.
const SWITCH_SELECT = `${PROPOSAL_SELECT}, p.amount_paid, p.group_id`;

router.post('/t/:token/switch',
  requireUuidToken('token', 'This proposal is no longer available'),
  switchLimiter,
  asyncHandler(async (req, res) => {
    // validate body: package_id integer > 0; ackCents = Math.round(Number(...)*100) finite
    let conflictQuoteNeeded = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [p] } = await client.query(
        `SELECT ${SWITCH_SELECT} FROM proposals p WHERE p.token = $1 FOR UPDATE OF p`,
        [req.params.token]);
      // guards on the LOCKED row: status whitelist sent/viewed; override null;
      // unsigned; amount_paid === 0; grouped-undecided refused (chosen_proposal_id
      // check); package_id in the same catalog query the quote uses.
      // stale intents: SELECT pending stripe_sessions; per row retrieve via
      // getStripe(); 'processing'/'succeeded' -> ConflictError PAYMENT_IN_FLIGHT;
      // else cancel + flip session row 'canceled' (create-intent pattern; a
      // failed cancel throws, tx rolls back, row untouched).
      const snapshot = await priceProposedState(p, {
        package_id, addon_ids, addon_quantities, addon_variants,
        num_bartenders: overrideOnlyBartenders(p),
      }, client, catalog);
      if (Math.round(Number(snapshot.total) * 100) !== ackCents) {
        await client.query('ROLLBACK');
        conflictQuoteNeeded = true;          // quote is built AFTER release
      } else {
        // crud.js:604-646 order: UPDATE proposals SET package_id, total_price,
        // pricing_snapshot, updated_at = NOW() (NEVER tip_jar/gratuity_rate/
        // gratuity_floor_rate/deposit_amount); reconcile (rec.changed firing
        // means a guard hole: apply it AND Sentry.captureMessage); DELETE +
        // bulk 8-column INSERT proposal_addons from snapshot.addons;
        // refreshUnlockedInvoices(p.id, client); activity log INSERT
        // ('package_switched', 'client', {from/to package ids, old/new totals,
        // dropped names, ip}); COMMIT.
      }
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    // ONLY after release (one-connection law: the quote build and the payload
    // builder take their own connections):
    if (conflictQuoteNeeded) {
      const quote = await buildFreshQuote(req.params.token);  // options-POST body
      return res.status(409).json({
        error: 'Prices were updated, take another look.',
        code: 'TOTAL_CHANGED', quote,
      });
    }
    res.json(await buildPublicProposalPayload(req.params.token));
  }));
```

`addon_ids`/quantities/variants built exactly as the quote builds them for the chosen option (visible extras via `visibleAddonsFor` for the TARGET package, riding hidden via `fitsPackage`, tier append). Sentry observability in this handler: capture on `rec.changed`, and a module-level per-token counter capturing once at 5+ TOTAL_CHANGED within 10 minutes.

- [ ] **Step 4: Mount + sensitive-paths.** `router.use('/', require('./publicSwitch')); // /t/:token/switch: public pre-signature reconfigure` in index.js beside :13. Add the three files to sensitive-paths.txt.
- [ ] **Step 5: Run to verify pass:** `node --test server/routes/proposals/publicSwitch.test.js`, then `publicToken.test.js` and `publicOptions.test.js` (shared-helper regression).
- [ ] **Step 6: Commit:** "switch endpoint: guarded pre-signature reconfigure with stale-intent cancel + cents 409 + audit".

### Task 6: Sign-time total assertion

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (sign route; find the UPDATE by content)
- Test: `server/routes/proposals/publicToken.signTotal.test.js` (new)

**Interfaces:**
- Produces (client lane consumes): sign POST accepts `acknowledged_total` (dollars). Mismatch: 409 `{error: 'The total for this proposal has changed. Please review the updated price and sign again.', code: 'TOTAL_CHANGED'}`. Absent field: legacy behavior (in-flight old tabs keep working).

- [ ] **Step 1: Failing tests:** matching total signs; one-dollar-off is 409 TOTAL_CHANGED with row NOT signed; absent field signs exactly as today; 350.004999 vs 350.00 row signs (cents tolerance).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** Validate the field when present (`Number.isFinite` else ValidationError). WHERE gains `AND ($14::numeric IS NULL OR ABS(total_price - $14::numeric) < 0.005)` with `ackGiven ? ackTotal : null`. On zero rows: re-read; signed/unsignable keeps `ALREADY_ACCEPTED`; otherwise `ConflictError(..., 'TOTAL_CHANGED')`.
- [ ] **Step 4: Run** the new suite + `publicToken.test.js` + `publicToken.signPhone.test.js`.
- [ ] **Step 5: Commit:** "sign: total assertion in the sign UPDATE WHERE (409 TOTAL_CHANGED)".

### Task 7: Lane gate + docs + owed walkthroughs

- [ ] ARCHITECTURE.md route table: `POST /api/proposals/t/:token/switch` (public, UUID token, switchLimiter); note `options_available` on the GET. README folder tree: `publicSwitch.js`, `optionsPricingShared.js`. Commit: "docs: switch endpoint + options_available".
- [ ] Append to `docs/walkthroughs-owed.md` (the ONE owed-items file, which push time re-reads): (1) verify "Walk Test Package" is not `is_active` in the prod catalog before this ships; (2) walk a drink-plan preview across a hosted-to-BYOB switch and back (planner derives from the proposal row; the flip case has never existed). Same commit.
- [ ] Run every touched suite one at a time from repo root: `publicOptions.test.js`, `publicSwitch.test.js`, `publicToken.test.js`, `publicToken.signPhone.test.js`, `publicToken.signTotal.test.js`, AND the spec-named adjacent money suites the switch's calls reach: `server/routes/proposals/crud.test.js`, the extras-fold suites (`node --test server/utils/proposalExtrasFold.stability.test.js` and siblings matching `proposalExtrasFold*.test.js`), the invoice-lifecycle suites (glob `server/utils/invoiceLifecycle*.test.js` and `server/routes/invoice*.test.js`, run what exists), `server/routes/stripeCreateIntent.test.js`, and the webhook gratuity suites (glob `server/routes/*paymentIntent*` / `*webhook*` test files, run what exists). All green before per-lane review.

---

# Lane oo-drawer-client

Order is shell-first so every interim commit leaves a working page: the legacy bottom button keeps opening the panel until the entry link exists.

### Task 1: Drawer shell on the existing panel

**Files:**
- Modify: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.js`, `client/src/index.css`, `client/src/pages/proposal/proposalView/ProposalView.js` (minimal: pass `open`/`onClose`)

**Interfaces:**
- Produces: `<OtherOptionsPanel open onClose token proposal onSwitched />` contract. The legacy bottom button still toggles it in this task (it now opens the drawer instead of inline-expanding).

- [ ] **Step 1: Drawer chrome.** Wrap the panel body:

```jsx
<div className={`oo-drawer ${open ? 'oo-drawer-open' : ''}`} role="dialog"
     aria-modal="true" aria-label="Same date, different package." ref={drawerRef}>
  <button type="button" className="oo-drawer-handle" aria-label="Expand options"
          onClick={() => setSnap(s => (s === 'peek' ? 'full' : 'peek'))} {...dragHandlers} />
  <div className="oo-anchor">YOURS · {currentName} · {fmt(anchorTotal)}</div>
  <div className={`oo-drawer-body ${snap === 'full' ? 'oo-scrollable' : ''}`}>...</div>
</div>
```

The visible header h2 becomes the locked copy now, not at polish: "Same date, different package." (plain text, no emphasis markup), so mid-lane walks and ui-ux-review see the real header.

- [ ] **Step 2: Chrome behaviors, each an explicit implementation, none left to an interfaces line:** body scroll lock while open (restore on close); Esc closes; **focus trap**: on open, focus the drawer container (`tabIndex={-1}`), a keydown handler cycles Tab/Shift-Tab within the drawer's focusable elements while open; on close, focus returns to the opener (ProposalView passes an `openerRef`); drag handle via pointerdown/move/up toggling snap when the drag crosses 80px; peek body `overflow: hidden` (drag never fights scroll), full state scrolls internally; skeleton cards (`.oo-skel` pulsing blocks) while the quote loads in peek.
- [ ] **Step 3: CSS.** Mobile default: fixed bottom sheet, `translateY(100%)` closed, peek `translateY(calc(100% - 340px))`, full `translateY(6vh)`, `transition: transform 0.28s ease`, radius 16px top, drag-handle bar, on-paper background. Desktop `@media (min-width: 1024px)`: fixed right panel `width: min(440px, 92vw)`, `translateX(100%)` closed, no backdrop, brass hairline left border, handle hidden, always internally scrollable. `.oo-anchor` sticky inside.
- [ ] **Step 4: sessionStorage.** Persist `{tierId, extraIds, updatedAt: proposal.updated_at}` under `oo-drawer-${token}` on selection change; restore on mount only when `updatedAt === proposal.updated_at`; never store quotes or totals (deliberate narrowing of spec decision 8's parenthetical: the quote re-fetches on refresh, only selections persist).
- [ ] **Step 5: Named manual walk (the build gate cannot see any of this).** On the already-running Claude-managed dev server (do NOT spawn a second): open a seeded sent proposal; button opens the sheet at peek with anchor + skeletons then cards; drag up snaps full and the list scrolls; drag down snaps peek and the list does not scroll; page behind never scrolls while open; Esc closes and focus lands back on the button; reopen keeps tier/extras selections; hard refresh keeps them; bump the proposal's `updated_at` (any admin edit) and refresh: selections reset. Desktop width: panel slides from the right, sign rail stays visible, no dim.
- [ ] **Step 6:** `cd client && CI=true npx react-scripts build`. Commit: "drawer shell: sheet + side panel chrome, a11y, sessionStorage".

### Task 2: Entry link beside the package title

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js`, `client/src/pages/proposal/proposalView/ProposalView.js`, `client/src/index.css`

**Interfaces:**
- Consumes: `proposal.options_available` (server Task 4), the drawer contract (Task 1).

- [ ] **Step 1:** The package `h2` block (:25) becomes a flex row; link renders only when `proposal.options_available && (showSignAndPay || showPayOnly)`, copy exactly "See other packages for this event", `onClick={onOpenOptions}`.
- [ ] **Step 2:** ProposalView: `drawerOpen` state + `drawerEverOpened` ref (mount once, hide on close) replace `showOptions`; DELETE the bottom `.oo-open` block (:681-686), moving the panel mount up beside the layout with `open={drawerOpen}`; entry link gets the `openerRef` for focus return; link and drawer hide when `signedThisSession.current` or the status leaves the payable set. KEEP passing `onWantOption` untouched this task (deleting the prop now would strand `handleWantOption` as an unused function and fail the CI build; the mailto dies in Task 5's sweep).
- [ ] **Step 3:** `.oo-entry-row` / `.oo-entry-link` CSS (quiet brass underline link, visible focus ring).
- [ ] **Step 4:** Manual check on the dev server: link sits beside the title only for a payable, flag-true proposal; opens the drawer; bottom button is gone. Build gate. Commit: "entry link beside package title; bottom button removed".

### Task 3: Peek tier + cards + compare retirement

**Files:**
- Create: `client/src/pages/proposal/otherOptions/pickPeek.js`, `client/src/pages/proposal/otherOptions/pickPeek.test.js`
- Modify: `OtherOptionsPanel.js`, `client/src/index.css`, `README.md`
- Delete: `client/src/pages/proposal/otherOptions/CompareTable.js` (tracked delete: per-action approval at execution)

**Interfaces:**
- Consumes: `options[].dropped` (server Task 1).
- Produces: `pickPeek(options, currentPackageId)` pure module (operates on RAW quote options: derive BYOB via `category === 'byob'`, the payload carries no `isByob` field).

- [ ] **Step 1: `pickPeek.js`** (own module so the jest test needs no component render):

```js
const isByob = (o) => o.category === 'byob';
export function pickPeek(options) {
  const current = options.find(o => o.is_current);
  const avail = options.filter(o => o.available && !o.is_current);
  const byDist = [...avail].sort((a, b) =>
    Math.abs(a.total - current.total) - Math.abs(b.total - current.total));
  const below = byDist.find(o => o.total < current.total) || null;
  const above = byDist.find(o => o.total > current.total) || null;
  const structural = isByob(current)
    ? byDist.find(o => !isByob(o) && o !== below && o !== above)
    : avail.find(o => isByob(o) && o !== below && o !== above);
  const picked = [below, above, structural].filter(Boolean);
  for (const o of byDist) {
    if (picked.length >= 3) break;
    if (!picked.includes(o)) picked.push(o);
  }
  return picked;
}
```

Jest test (`cd client && CI=true npm test -- pickPeek`): below/above/structural on a hosted current; BYOB current gets a hosted structural; cheapest package backfills two above; fewer than three available returns what exists; `available: false` never appears.

- [ ] **Step 2: Retire compare.** Delete `MAX_COMPARE`, `picked`, `togglePick`, `pickedCols`, the `view === 'compare'` branch, the tray, the `CompareTable` import and file. Card body becomes a plain div; the single control is the switch button (Task 4 wires it; this task renders it disabled-less with a no-op, or wires directly if built together).
- [ ] **Step 3: Peek rendering.** Peek = `pickPeek(options)` flat under the anchor + "See all packages" toggling `expanded`; expanded = the existing lane groupings with every option (peek cards re-slot, never duplicated), unavailable cards only here, with reasons. Delta line is the card hero (`.oo-card-delta` ~1.05rem, weight 500, `var(--deep-brown)`, NOT sage). `dropped.length > 0` renders `.oo-card-dropped`: "Not included with this package: {names}. It comes off the price here." Anchor total = the `is_current` option's displayed total (same source as deltas).
- [ ] **Step 4:** Build gate + pickPeek jest green. README tree updated (CompareTable removed, pickPeek added). Commit: "peek tier + switch cards; compare flow retired".

### Task 4: The switch flow

**Files:**
- Modify: `OtherOptionsPanel.js`, `ProposalView.js`, `client/src/index.css`

**Interfaces:**
- Consumes: switch contract (server Task 5), sign `acknowledged_total` (server Task 6).

- [ ] **Step 1: Switch action** in the panel (state `switching`; double-tap gated):

```js
const doSwitch = async (option) => {
  if (switching) return;
  setSwitching(option.package_id);
  try {
    const res = await axios.post(`${BASE_URL}/proposals/t/${token}/switch`, {
      package_id: option.package_id,
      tier_addon_id: selRef.current.tierId ?? null,
      extra_addon_ids: selRef.current.extraIds || [],
      acknowledged_total: option.total,
    });
    onSwitched(res.data);
  } catch (err) {
    if (err.response?.status === 409 && err.response.data?.code === 'TOTAL_CHANGED'
        && err.response.data.quote) {
      setData(err.response.data.quote);
      setError('Prices were updated, take another look.');
    } else if (err.response?.status === 409) {
      setError(err.response.data?.error || 'This proposal can no longer be changed online.');
    } else {
      try {
        const fresh = await axios.get(`${BASE_URL}/proposals/t/${token}`);
        onSwitched(fresh.data, { maybeUnchanged: true });
      } catch { setError('We could not make that change just now.'); }
    }
  } finally { setSwitching(null); }
};
```

Button disabled while any switch is in flight; its own card shows spinner + "Switching…".
- [ ] **Step 2: `onSwitched` in ProposalView:** `setProposal(payload)`; `setDrawerOpen(false)`; clear both cached secrets + `depositIntentAutopayRef` immediately (a switch is not a keystroke stream, bypass the 400ms debounce); `setGratuityDirty(false)` so the seeding effect reseeds from the NEW snapshot; `totalFlash` state driving a 2s brass fade on the tfoot total; `toast.success('Switched to ' + payload.package_name)` (Toast carries `role="status" aria-live="polite"`, so this IS the live-region announcement).
- [ ] **Step 3: Sign carries the rendered total:** `handleSign` adds `acknowledged_total: totalPrice`; on `code === 'TOTAL_CHANGED'` in its catch: refetch GET `/t/:token`, `setProposal`, set `formError` to the server message.
- [ ] **Step 4:** ProposalView will cross the 700-line soft cap here (695 today; the warn is acceptable, and Task 5's mailto deletion claws most of it back; no split owed). Manual happy-path walk on the already-running dev server: open drawer, toggle an extra, switch down, Total flashes, gratuity reseeds, sign with the new total. The 409 and lost-response branches are NOT hand-testable; Task 5's RTL suite owns them. Build gate. Commit: "switch flow: 409 re-show, lost-response reconcile, secret invalidation, sign assertion".

### Task 5: Client behavior tests (the spec's client list, owned)

**Files:**
- Create: `client/src/pages/proposal/otherOptions/OtherOptionsPanel.test.js`
- Test command: `cd client && CI=true npm test -- OtherOptionsPanel`

**Interfaces:** Consumes everything above; RTL + jest-dom (import per-file, no setupTests) + axios mocked with `jest.mock('axios')`.

- [ ] **Step 1: Write the suite**, one test per spec bullet:

```js
// 409 re-show: axios.post rejects with {response:{status:409, data:{code:
//   'TOTAL_CHANGED', quote: freshQuote}}}; assert the drawer renders the
//   fresh quote's totals and the banner 'Prices were updated, take another
//   look.', and NO onSwitched call.
// Lost response: axios.post rejects with a network error; axios.get resolves
//   the fresh payload; assert onSwitched called with it.
// Double-tap: two rapid clicks; axios.post called ONCE.
// sessionStorage: seed oo-drawer-<token> with matching updatedAt; mount;
//   assert tier/extras restored. Seed with a STALE updatedAt; assert reset.
// Entry link absence: render ProposalPricingBreakdown with
//   options_available:false; assert no link. With flag true but
//   showSignAndPay/showPayOnly false; assert no link.
// Secret invalidation + reseed (ProposalView-level, mock axios GET/POST):
//   after onSwitched, assert a NEW create-intent POST fires (old secret
//   never reused) and the gratuity input shows the new snapshot's total.
```

- [ ] **Step 2: Run to green:** `cd client && CI=true npm test -- OtherOptionsPanel` and the pickPeek suite. Commit: "client behavior suite: 409, lost-response, storage, link gating, reseed".

### Task 6: Polish + lane gate

- [ ] Dead code out: `handleWantOption` + the mailto + the DELIBERATE SEAM comment (:306-323), the `onWantOption`/`onChoose` prop chain, `.oo-open`/tray/compare CSS blocks.
- [ ] Copy check against the locked strings (link, header plain, card action, dropped notice, 409 banner comma form). No em dashes.
- [ ] Full gates: `cd client && CI=true npx react-scripts build`; `cd client && CI=true npm test` (whole client tree, includes `proposalView/gratuityFloor.test.js` and the new suites). Commit: "drawer polish: mailto retired, copy locked".

---

## Self-review notes (spec coverage)

- Spec decisions 1-11: shell/a11y/sessionStorage (client 1), entry link + bottom removal (client 2), header copy (client 1), peek + boundaries + anchor + delta + dropped notice (client 3), switch reality + intent cancel + 409 + reconcile + invoice + audit + allowlist (server 5), hidden-addon carry both call sites (server 1 + 5), sign assertion (server 6 + client 4), options_available with draft/modified/grouped gating (server 4), limiter (server 2), payload builder (server 3), docs (server 7, client 3), election-at-payment law (constraints + server 5).
- Spec Testing section: switch matrix incl. discount fixture, differing-ratio at the switch call site, no-invoice branch, atomicity, replay-minus-updated_at (server 5); sign matrix (server 6); the client list is owned by client Task 5.
- Launch checks recorded in `docs/walkthroughs-owed.md` (server Task 7), the one owed-items file push time re-reads.
- Out of scope confirmed absent: no analytics, no admin notification (audit row only), no add-on purchase surface, no compare-group changes, no schema changes.
