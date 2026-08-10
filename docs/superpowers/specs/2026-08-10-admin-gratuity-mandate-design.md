# Admin Gratuity Mandate (Pre-Payment Preset)

**Date:** 2026-08-10
**Status:** Approved (section-by-section, 2026-08-10 brainstorm)

## 1. Problem

Some events (corporate, graduations, bar mitzvahs, kids-centered parties) reliably produce weak or no guest tipping, so the host must prepay the gratuity even when they allow a tip jar at the bar. Today gratuity enters only through the client's election at payment (spec 2026-08-03): the admin editor's gratuity block was deleted, the admin PATCH refuses `tip_jar`/`gratuity_total`, and unpaid proposals never carry a gratuity. There is no way for admin to put a required gratuity on a quote.

This is the deliberate inverse of the Delara problem: there the system made a client's own election look like a mandate. Here admin genuinely mandates, with explicit provenance.

## 2. Scope

Pre-payment only. Admin sets the mandate while quoting. Adding or raising gratuity on an already-paid booking stays out of scope: the `"Gratuity rate cannot be increased after payment"` guard in `crud.js` stays, and the rare paid case remains a manual operation. Post-payment lowering stays with cancel-line-item.

## 3. Data model

New column: `proposals.gratuity_floor_rate NUMERIC(10,4)`, NULL meaning no mandate. Every existing row is NULL; no backfill.

Setting a mandate derives the rate from the admin-entered dollars (dollars divided by staff-count times hours, rounded to NUMERIC(10,4), same as `deriveGratuityRate`) and writes it to BOTH `gratuity_floor_rate` and `gratuity_rate`, then recomputes the snapshot so the quote shows the Gratuity line and the raised total immediately. The rate is canonical; the entered dollars are a point-in-time input. Staffing or duration changes rescale the mandated dollars through the existing rate-constant rescale machinery in `crud.js`.

`gratuity_rate_change_origin` is NOT touched by the mandate write. The origin-admin freeze (muted staffing notices, only writer `lineItemCancel.js`) does not ride along with this feature. The mandate column itself is the provenance: `gratuity_floor_rate IS NOT NULL` means admin mandated, origin NULL with a rate means client elected.

The snapshot's `gratuity` block gains `floor_rate` (number or null), so the public proposal page and checkout read the mandate without API changes.

DB CHECK amendment: `(tip_jar OR gratuity_rate >= 50)` becomes

```
(tip_jar OR gratuity_rate >= 50 OR (gratuity_floor_rate IS NOT NULL AND gratuity_rate >= gratuity_floor_rate))
```

This fixes the corner where admin mandates under $50/staff/hr and the client answers no-jar: today's CHECK would reject that write mid-payment.

## 4. Admin editor

A small "Prepaid gratuity" block returns to the proposal editor where the old block was deleted:

- Dollar amount input.
- A "Standard ($50/staff/hr = $X)" quick-fill chip that computes the standard dollars for the event's current staff-count and hours in one click.
- A clear control that removes the mandate (`gratuity_floor_rate` back to NULL, `gratuity_rate` back to 0, snapshot recomputed).
- Read-only once `amount_paid > 0`.

PATCH contract: the endpoint still refuses `tip_jar` and `gratuity_total`. It accepts exactly one new field, `gratuity_mandate_total` (dollars, or null to clear). Server-side validation: reject when `amount_paid > 0`, reject when staff-count times hours is 0 (no basis to mandate against, mirrors the chooser's own disable gate), reject above `GRATUITY_SANITY_MAX_RATE`, reject negative or non-finite input.

The CLAUDE.md Checkout-gratuity invariant text is updated in the same change: "unpaid proposals never carry a gratuity" gains the admin-mandate carve-out, and the PATCH contract sentence names the one new field.

## 5. Checkout behavior

The jar radio stays and still records the client's answer in `tip_jar`. Under a mandate it carries no price difference: both branches floor at the mandated dollars, the amount box `min` is the mandated dollars, and the client can only go up. The $50/staff/hr no-jar floor does NOT stack on top: under a mandate, the mandate is the only floor, per the ruling that choosing no-jar must not charge more.

Copy under a mandate: the heading states rather than invites, "A prepaid gratuity of $X is included for your {staff_noun}s," with the amount box there to give more. The no-jar radio drops its "a prepaid gratuity of $50 per {staff_noun} per hour is added" sentence, since nothing extra is charged. No em dashes in any client copy.

Untouched-chooser path is unchanged from today's mechanics: no election metadata is stamped, the webhook leaves every gratuity field alone, and the client is charged `total_price`, which already includes the mandate. The jar answer defaults to jar-yes in that case, same as today.

Client-side floor derivation: `ProposalView` reads `pricing_snapshot.gratuity.floor_rate`; floor dollars = `floor_rate x staff_count x hours` when set, else the existing rule (0 with jar, hardcoded 50 without, with the existing keep-in-sync comment).

## 6. Server enforcement

Belt and suspenders in the same three places the $50 floor lives today:

1. **`deriveGratuityRate`** gains the mandate floor (new parameter, e.g. `floorRate`). An election whose total lands below the mandated dollars returns a clean `GRATUITY_BELOW_FLOOR` with a message naming the required dollars. The derived-rate re-assertion applies to the mandate floor exactly as it does to the no-jar 50 today. `stripeCreateIntent.js` passes the row's `gratuity_floor_rate`.
2. **Webhook apply** (`paymentIntentSucceeded.js`): before writing, the metadata rate is validated against the FOR UPDATE row's `gratuity_floor_rate` in addition to the existing DB CHECK pre-validation. A stale or tampered intent cannot undercut the mandate; the failure degrades to "not applied, alerted" exactly like today's SAVEPOINT path, never holding the payment hostage.
3. **DB CHECK** as amended in section 3, the final backstop.

Cancel-line-item interplay: lowering a paid gratuity through `lineItemCancel.js` also clears `gratuity_floor_rate`. Admin deliberately reducing a paid gratuity means the mandate is no longer binding, and a stale floor would trip the amended CHECK on the lowered rate. Its existing origin-admin stamp is unchanged.

## 7. What does not change

- **Payroll:** the mandate lands in the snapshot as the same `Gratuity` line (`GRATUITY_LABEL`) that `extractGratuityCents` already reads. The funding gate (`amount_paid >= total_price`) works naturally because the mandate is inside `total_price` from the day it is quoted. Fee netting applies as with any elected gratuity.
- **Invoices:** the balance invoice derives from the total, which already includes the line. No new labels, so `OFF_LEDGER_INVOICE_LABELS` is untouched.
- **Service extensions:** keep reading `gratuity_rate` as they do now; a mandated rate flows through identically.
- **Election metadata shape:** unchanged (`tip_jar`, `gratuity_rate` strings). The webhook still stamps origin NULL on a client election.
- **PAYABLE guard, SAVEPOINT degradation, autopay, record-payment:** unchanged.

## 8. Migration and rollout

One idempotent `ADD COLUMN IF NOT EXISTS` plus the CHECK constraint swap in `schema.sql` (drop and re-add under the same name, idempotent guards). Prod DDL runs before the code push, per standing order of operations. Dev DB gets the same DDL so local suites exercise the new CHECK; note the dev DB historically lacks prod CHECKs, so ci-smoke remains the honest gate.

## 9. Testing

Extend the suites that own each seam, run one server suite at a time against the dev DB:

- `pricingEngine.test.js`: mandate floor in `deriveGratuityRate` (below, at, above; jar and no-jar; mandate under 50 with no-jar allowed), snapshot `floor_rate` propagation, rescale on staffing change.
- `proposals/crud.test.js`: PATCH accepts `gratuity_mandate_total`, writes both columns and snapshot, refuses when paid, refuses zero-basis, clear-to-null path, still refuses `tip_jar`/`gratuity_total`.
- `stripeCreateIntent.test.js`: below-mandate election rejected, at-mandate accepted, untouched-chooser path charges the mandated total with no metadata.
- `stripeWebhook.gratuityApply.test.js`: apply respects the row floor, undercut metadata degrades to not-applied-alerted.
- `lineItemCancel.test.js`: lowering clears the mandate, amended CHECK holds.
- Client `gratuityFloor.test.js`: floor from `floor_rate`, both radio branches, no stacking with the 50 rule.

Money and checkout code: the lane gets the full review fleet at merge, and push time gets the fleet plus `/second-opinion` on the sensitive commits.
