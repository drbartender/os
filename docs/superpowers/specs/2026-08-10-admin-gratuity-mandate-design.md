# Admin Gratuity Mandate (Pre-Payment Preset)

**Date:** 2026-08-10
**Status:** Approved (section-by-section, 2026-08-10 brainstorm); revised same day after the design-stage fleet (6 agents, findings folded in; signed-guard decision approved by Dallas).

## 1. Problem

Some events (corporate, graduations, bar mitzvahs, kids-centered parties) reliably produce weak or no guest tipping, so the host must prepay the gratuity even when they allow a tip jar at the bar. Today gratuity enters only through the client's election at payment (spec 2026-08-03): the admin editor's gratuity block was deleted, the admin PATCH refuses `tip_jar`/`gratuity_total`, and unpaid proposals never carry a gratuity. There is no way for admin to put a required gratuity on a quote.

This is the deliberate inverse of the Delara problem: there the system made a client's own election look like a mandate. Here admin genuinely mandates, with explicit provenance.

## 2. Scope

Pre-payment AND pre-signature only. Admin sets the mandate while quoting. Once the client has signed (`client_signed_at` set or `status = 'accepted'`) or paid anything (`amount_paid > 0`), mandate changes are rejected: a recorded signature must never stand against a total admin changed afterward. (Grounding note: no "cannot be increased after payment" guard exists in `crud.js` today; the PATCH simply never accepts gratuity input. The signed/paid rejection in section 4 is NEW code and is the only such protection.) Post-payment lowering stays with cancel-line-item; adding gratuity to a paid booking stays a manual operation.

## 3. Data model

New column: `proposals.gratuity_floor_rate NUMERIC(10,4)`, NULL meaning no mandate. Every existing row is NULL; no backfill.

**Presence semantics: a mandate exists iff `gratuity_floor_rate > 0`, uniformly at every layer** (engine, client, webhook, CHECK usage). The PATCH rejects non-positive dollars (fleet finding: a stored floor of 0 with a `!= null` presence test at the webhook would silently disable the $50 no-jar rule). `calculateProposal` normalizes: any non-positive `gratuityFloorRate` input stamps `null`.

Setting a mandate derives the rate from the admin-entered dollars (dollars divided by staff-count times hours, rounded to NUMERIC(10,4), same as `deriveGratuityRate`) and writes it to BOTH `gratuity_floor_rate` and `gratuity_rate`, then recomputes the snapshot so the quote shows the Gratuity line and the raised total immediately. The rate is canonical; the entered dollars are a point-in-time input. Staffing or duration changes rescale the mandated dollars through the existing rate-constant rescale machinery in `crud.js` (the editor only sends the mandate field when the admin actually touched it, section 4, so an untouched field can never re-derive a stale dollar figure).

**Snap-to-floor tolerance (fleet-approved refinement):** a rescaled mandate's displayed floor (rate x new basis, rounded to cents) can round-trip to a rate a hair below the stored floor, which the strict DB CHECK would reject at the exact displayed minimum. `deriveGratuityRate` therefore snaps a derived rate up to the mandate floor when the entered total is within the existing half-cent tolerance of the floor dollars. The legacy no-jar 50 branch keeps its current reject-only behavior byte-identically.

`gratuity_rate_change_origin` is NOT touched by mandate writes. The origin-admin freeze (muted staffing notices, only writer `lineItemCancel.js`) does not ride along with this feature. The mandate column itself is the provenance: `gratuity_floor_rate > 0` means admin mandated, origin NULL with a rate means client elected. (The generic `proposal_activity_log` 'updated' row with `new_total` is the accepted audit trail for mandate set/clear; no dedicated log entry.)

The snapshot's `gratuity` block gains `floor_rate` (number or null), so the public proposal page and checkout read the mandate without API changes.

**Every persisting snapshot writer must carry the floor (fleet blocker #1).** `calculateProposal` rebuilds the gratuity block from scratch, so every caller that persists its result for an EXISTING row must pass the row's `gratuity_floor_rate`, or an unrelated save silently strips the snapshot key while the column survives and checkout stops floor-enforcing client-side. The complete caller audit:

- `server/routes/proposals/crud.js` (PATCH): passes the resolved floor. In scope.
- `server/utils/proposalExtrasFold.js` (~line 176, PERSISTS via `UPDATE proposals SET pricing_snapshot`; reached from `lineItemCancel.js`, `drinkPlans/submit.js`, `drinkPlans/lab.js`): passes the row's floor. In scope.
- `server/routes/proposals/metadata.js` `/calculate` (preview, no persist): passes the draft/stored floor so the preview matches what saves. In scope.
- `server/utils/changeRequests.js` (~line 77): pass the row's floor through for consistency; audited at implementation time for whether it persists (either way the pass-through is correct and cheap).
- `server/routes/proposals/public.js` and `server/utils/thumbtackProposalDraft.js`: CREATE paths for new rows, which have no mandate; they correctly default to null. No change.
- `recomputeSnapshotGratuity` preserves `floor_rate` via its `...snap.gratuity` spread; a test pins that.

DB CHECK amendment: `(tip_jar = true OR gratuity_rate >= 50)` becomes

```
(tip_jar = true OR gratuity_rate >= 50 OR (gratuity_floor_rate IS NOT NULL AND gratuity_rate >= gratuity_floor_rate))
```

This fixes the corner where admin mandates under $50/staff/hr and the client answers no-jar: today's CHECK would reject that write mid-payment.

**CHECK swap mechanism (fleet-corrected):** `initDb()` replays `schema.sql` on every server boot, so a plain guarded re-add would no-op forever and an unconditional drop-and-add would re-validate the table per boot with a constraint-free window. The swap is a DO block that drops the constraint ONLY when its current definition lacks `gratuity_floor_rate` (checked via `pg_get_constraintdef`), then re-adds under the existing name behind the usual NOT EXISTS guard. One-time swap, idempotent on every later boot. The rollback comment block in `schema.sql` gains the new column and constraint.

## 4. Admin editor

A small "Prepaid gratuity" block returns to the proposal editor where the old block was deleted (the editor mounts on both the proposal page and the event page; the block appearing on both is intended):

- "Require prepaid gratuity" checkbox, disabled until the live preview has loaded and the event has a positive staffing basis (so it can never seed $0), with a dollar input, the "Standard ($50/staff/hr = $X)" quick-fill chip showing the computed dollars, and a clear control.
- Read-only (all controls disabled) once the proposal is signed or paid.
- **Dirty-gated (fleet blocker #3):** the form tracks whether the admin touched the mandate controls this session and sends `gratuity_mandate_total` ONLY when touched and not locked. An untouched form omits the key, the server carries the stored mandate forward, and a duration/staffing edit rescales the dollars at the canonical rate instead of re-deriving from a stale displayed figure.

PATCH contract: the endpoint still refuses `tip_jar` and `gratuity_total`. It accepts exactly one new field, `gratuity_mandate_total` (dollars > 0 to set, `null` to clear, absent carries forward). Server-side validation, in a helper module `server/utils/gratuityMandate.js` (extracted for the file-size ratchet; `crud.js` is at 995 lines and must not grow past 1000):

- Reject any mandate key when signed or paid (section 2).
- Reject non-positive dollars (section 3 presence semantics).
- Reject when staff-count times hours is 0 ("set staffing and duration first"). The zero-basis rejection applies to SET only; **clear works regardless of basis** (a mandated proposal whose staffing is later zeroed must remain clearable).
- Reject above `GRATUITY_SANITY_MAX_RATE`, non-finite, negative (via `deriveGratuityRate`).
- **Clear semantics (fleet blocker #4):** clear acts only when a mandate actually exists (`gratuity_floor_rate > 0`); on a row with no mandate it is a no-op, so it can never wipe a client-elected gratuity (e.g. on a refunded-to-zero proposal). A real clear also forces `tip_jar = true` (mirroring `lineItemCancel.js`), because zeroing the rate while `tip_jar = false` violates the CHECK.

Staffing edited to zero on a mandated proposal (no mandate key in the body): the rate carries forward, the dollar line computes to $0 and disappears from the total, and the floor column stays set but inert. Accepted; the admin clears it or restores staffing.

## 5. Checkout behavior

The jar radio stays and still records the client's answer in `tip_jar`. Under a mandate it carries no price difference: both branches floor at the mandated dollars, the amount box `min` is the mandated dollars, and the client can only go up. The $50/staff/hr no-jar floor does NOT stack on top: under a mandate, the mandate is the only floor, per the ruling that choosing no-jar must not charge more.

**Client guard contract change (fleet blocker: the jar-yes branch is the mandate's default and today's guard is unreachable there):** `isGratuityBelowFloor` currently short-circuits false whenever `tipJar` is true. It gains a `mandated` flag that bypasses that short-circuit, and `gratuityFloorMessage` gains a mandate variant ("This event includes a required gratuity of at least $X for your bartenders."). BOTH callers pass the flag: the inline warning in `SignAndPaySection` AND the `handleSign` guard in `ProposalView` (~line 329). The floor-dollar derivation moves into `gratuityFloor.js` as a tested helper. Without this, a jar-yes client who clears the amount box would reach the server and get a raw 400.

Copy under a mandate: the heading states rather than invites ("Gratuity for your {staff_noun}s"); the intro sentence becomes "A prepaid gratuity of $X is included for your {staff_noun}s." (the "None of it is kept by Dr. Bartender." framing stays); the no-jar radio's "$50 per {staff_noun} per hour is added" sentence is replaced with "No jar at the bar. Your prepaid gratuity covers your {staff_noun}s."; and the preset chips row ($0 "No thanks" / $25 suggested) is hidden, since both presets sit below the floor. No em dashes in any client copy.

Untouched-chooser path is unchanged from today's mechanics: no election metadata is stamped, the webhook leaves every gratuity field alone, and the client is charged `total_price`, which already includes the mandate. The jar answer defaults to jar-yes in that case, same as today.

Client-side floor derivation: `ProposalView` reads `pricing_snapshot.gratuity.floor_rate`; floor dollars = `floor_rate x staff_count x hours` when > 0, else the existing rule (0 with jar, hardcoded 50 without, with the existing keep-in-sync comment).

## 6. Server enforcement

Belt and suspenders in the same three places the $50 floor lives today:

1. **`deriveGratuityRate`** gains `floorRate` (default 0). When `floorRate > 0` it SUBSTITUTES for `GRATUITY_FLOOR_RATE` in both the entered-total check and the derived-rate re-assertion, on both jar answers; the reject message names the required dollars; the snap-to-floor tolerance of section 3 applies. When 0, behavior is byte-identical to today. `stripeCreateIntent.js` widens its proposal SELECT to include `gratuity_floor_rate` and passes it.
2. **Webhook apply** (`paymentIntentSucceeded.js`): the jar/50 clause MOVES out of the pre-row `rateUsable` check (which becomes shape-only: finite, >= 0, <= sanity max) to after the FOR UPDATE row read, because the floor lives on the row. Post-read rule: mandate (`> 0`) present means `electRate >= floor`; absent means the legacy `(tip_jar OR rate >= 50)`. This ordering is REQUIRED, not optional: the old inline pre-flight rejects the sub-$50 no-jar mandate case that the amended CHECK exists to permit, and it would drop a legitimately charged gratuity after capture. Failure emits `warnGratuityApplySkipped('below_floor', ...)`; the SAVEPOINT degradation is unchanged and payment recording is never hostage. Known consequence: some legacy failures change skip-reason strings (`invalid_metadata` becomes `below_floor` for sub-50 no-jar metadata); the tests pin the new strings and nothing in the repo filters on the old one.
3. **DB CHECK** as amended in section 3, the final backstop.

Cancel-line-item interplay: lowering a paid gratuity through `lineItemCancel.js` also clears `gratuity_floor_rate`, on EVERY lowering, including one that lands above the floor. This is deliberate: admin reducing a paid gratuity means the mandate is no longer the operative agreement, and a stale floor would trip the amended CHECK on a below-floor target. (`lineItemCancel` already forces `tip_jar = true` below 50, so the clear cannot strand a CHECK violation.) Its existing origin-admin stamp is unchanged. On an UNPAID mandated proposal cancel-line-item remains technically reachable as a second removal path with different side effects (origin stamp); accepted, the editor clear is the intended path.

## 7. What does not change

- **Payroll:** the mandate lands in the snapshot as the same `Gratuity` line (`GRATUITY_LABEL`) that `extractGratuityCents` already reads. The funding gate (`amount_paid >= total_price`) works naturally because the mandate is inside `total_price` from the day it is quoted. Fee netting applies as with any elected gratuity.
- **Invoices:** the balance invoice derives from the total, which already includes the line. No new labels, so `OFF_LEDGER_INVOICE_LABELS` is untouched.
- **Service extensions:** keep reading `gratuity_rate` as they do now; a mandated rate flows through identically.
- **Election metadata shape:** unchanged (`tip_jar`, `gratuity_rate` strings). The webhook still stamps origin NULL on a client election.
- **PAYABLE guard, SAVEPOINT degradation, autopay, record-payment:** unchanged.
- **`eventDetailsPayload.gratuity_prepaid`** (`rate > 0`, crew-facing BEO flag): a mandate flips it true from quote time, same semantics an elected-but-not-yet-fully-funded gratuity has today between deposit and balance. Accepted as-is.
- **Other `gratuity_rate` readers** (`changeRequests.js`, admin views): read the rate as today; no behavior change beyond the floor pass-through in section 3.

**Accepted operational seams (documented, not built):**

- **No automatic client notice** when a mandate changes the total of a `sent`/`viewed` quote. The admin re-sends through the existing notify-client flow when the client has already seen the old number. (Signed quotes are locked by section 2.)
- **Stale-intent window:** an intent minted before a mandate lands can settle at the pre-mandate amount. The additive credit + derived status leave the proposal short of paid-in-full, the balance-invoice cascade bills the remainder, and the balance-invoice monitor alerts on drift; until collected, the payroll funding gate pays the crew $0 gratuity. Practice: set the mandate before sending the payment link.
- **`scripts/reset-unpaid-gratuity.js`** currently selects `amount_paid = 0 AND gratuity_rate > 0`, which is exactly the shape of a valid mandate; it gains `AND gratuity_floor_rate IS NULL` so a re-run can never wipe mandated quotes.

## 8. Migration and rollout

One idempotent `ADD COLUMN IF NOT EXISTS` plus the definition-conditional CHECK swap of section 3 in `schema.sql`, with the DDL run on prod before the code push, per standing order of operations. Dev DB gets the same DDL so local suites exercise the new CHECK (this closes the dev/prod CHECK gap for this constraint); ci-smoke remains the honest gate. The applied dev DDL is additive and CHECK-weakening, so a scrapped lane needs no dev-DB rollback. No backfill: NULL means no mandate.

## 9. Testing

Extend the suites that own each seam, run one server suite at a time against the dev DB:

- `pricingEngine.test.js`: mandate floor in `deriveGratuityRate` (below, at, above; jar and no-jar; mandate under 50 with no-jar allowed; snap-to-floor round-trip; no-floor path byte-identical), snapshot `floor_rate` stamping + non-positive coercion to null, `recomputeSnapshotGratuity` preservation, rescale at constant rate on a changed basis.
- `gratuityMandate` resolution (via `proposals/crud.test.js`): set writes both columns + snapshot + total; clear only-when-mandated + forces `tip_jar` true; carry-forward on absent key incl. rescale; signed guard; paid guard; non-positive rejection; zero-basis rejection on set, clear allowed at zero basis; still refuses `tip_jar`/`gratuity_total`.
- `proposalExtrasFold.stability.test.js`: a fold on a mandated proposal preserves snapshot `floor_rate` and the row column.
- `metadata.calculate.test.js`: draft mandate preview (explicit `num_bartenders`), null preview, absent-key legacy path, non-positive 400.
- `stripeCreateIntent.test.js`: below-mandate election rejected with the mandate message, at-mandate no-jar accepted, above-mandate accepted, untouched-chooser path charges the mandated total with no metadata (pinned dollar values).
- `stripeWebhook.gratuityApply.test.js`: undercut metadata skipped with reason `below_floor` (string pinned), at/above applied with `floor_rate` preserved and origin NULL, legacy no-jar sub-50 without mandate still skipped (new reason pinned), sub-50 no-jar WITH mandate applied.
- `lineItemCancel.test.js`: lowering clears the mandate, amended CHECK holds.
- Client `gratuityFloor.test.js`: `mandated` flag behavior, floor-dollar helper, message variants, legacy paths pinned.
- In-lane browser walk of the mandated checkout (local dev, before merge, not only post-push).

Money and checkout code: a mid-lane review checkpoint (code-review + consistency-check) runs when the server half is complete, the full review fleet runs at lane merge, and push time gets the fleet plus `/second-opinion` on the sensitive commits.

## 10. Documentation

- `.claude/CLAUDE.md` (note the path; there is no root CLAUDE.md) Checkout-gratuity bullet: amend ALL falsified clauses, not just one: "election persists ONLY at payment" (now: except the admin mandate), the three-place $50 floor sentence (mandate replaces it on both jar answers), "unpaid proposals never carry a gratuity" (admin-mandate carve-out + the exact PATCH contract), and "a link-paid proposal cannot collect a prepaid gratuity" (metadata-less payments still never touch the gratuity FIELDS, but a mandated gratuity rides inside `total_price` and is collected by any payment).
- `ARCHITECTURE.md`: proposals schema bullet for the new column; the verbatim CHECK quote (~line 931); the "editor and PATCH have NO gratuity write path" / "`/calculate` previews the STORED rate only" passages (~line 1595); the snapshot gratuity key list (~line 930).
- `README.md`: one Key Features line.
