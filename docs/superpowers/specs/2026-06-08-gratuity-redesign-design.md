# Gratuity Section Redesign — Sign & Pay Card

- **Date:** 2026-06-08
- **Branch / worktree:** `gratuity-redesign`
- **Status:** Approved design, ready for implementation plan
- **Surface:** Proposal client-facing Sign & Pay card (`mode === 'signAndPay'`)

## 1. Background

A Claude Design handoff bundle (`gratuity-redesign/`) reskins the gratuity block on the
proposal **Sign & Pay** card in the project's apothecary visual vocabulary. The handoff ships
a drop-in replacement (`.claude/_gratuity-redesign/DROP-IN-CODE.md`) that swaps the markup and
CSS while claiming to leave all logic untouched.

An exhaustive parity audit (5 lenses, each finding adversarially re-verified) confirmed the
drop-in preserves the money-critical behavior verbatim — every handler, the skip-jar floor
raise, the `gratuityDirty` re-quote signal, the dollar-input attributes, the floor-warning gate,
and the entire server money chain. But it also surfaced that the "logic-inert" claim is
overstated in three ways, and that the new copy makes a pass-through claim worth getting right.
This spec captures the reskin **plus** the deliberate fixes and behavior changes decided with
the owner.

### Decisions locked during design
- **No payroll change.** The payroll engine nets each tip's pro-rata Stripe fee before payout
  (`server/utils/payrollAccrual.js:159` pays `splitEvenly(netGratuity, n)`;
  `server/utils/payrollMath.js:61-68` `proRataFeeCents`). This is **intended**: Dr. Bartender
  pays out 100% of what it receives from Stripe and keeps nothing; the card processor's cost
  comes out of the tip. The copy must not contradict this and must not explain merchant
  processing to clients.
- **Floor is hardened from "warn" to "block."** A no-jar client must not be able to submit
  below the gratuity floor by any path.

## 2. Scope

One client surface, its parent, and the stylesheet:
- `client/src/pages/proposal/proposalView/SignAndPaySection.js` — the `{gratuityEnabled && (...)}`
  block (currently lines ~216-259) and the `PaymentForm` `disabled` expression (line ~317).
- `client/src/pages/proposal/proposalView/ProposalView.js` — the `handleSign` function (`:226`)
  gains a below-floor guard (§3.3). Its gratuity **props/state are not otherwise changed**:
  `tipJar`/`setTipJar` (`:42`), `gratuityTotal`/`setGratuityTotal` (`:43`), `gratuityDirty`,
  `gratuityEnabled`, `gratuitySuggested`, `gratuityFloor`
  (`:335 = Math.round(50 * gratuityStaffCount * gratuityHours)`), `gratuityStaffNoun`. No new
  prop is introduced.
- `client/src/index.css` — append the gratuity-block CSS after the `.payment-tablet-autopay`
  rules (~line 9570).

### Non-goals (explicitly out of scope)
- Any change to `payrollAccrual.js` / `payrollMath.js` / gratuity payout math.
- The mockup's standalone running-total line (would widen the prop contract).
- The mockup's third "Custom" chip (the dollar input already serves custom entry).
- Any change to the server floor enforcement (`deriveGratuityRate`, the
  `proposals_gratuity_jar_check` DB CHECK) — those stay as the authoritative backstop.

## 3. Requirements

### 3.1 Presentation reskin (behavior-preserving)
Replace the `.gratuity-chooser` markup with the drop-in's `.gratuity-block`:
- Two tip-jar **choice tablets** (Keep the tip jar / Skip the tip jar) mirroring the
  Pay Deposit / Pay in Full `payment-tablet` pattern, with per-tablet description subtext.
- Preset **chips** (brass tokens) replacing the ghost buttons.
- The dollar field inside a parchment **input frame** with the currency mark.
- Restore an explicit **"Tip jar at the bar?"** `sign-pay-eyebrow` above the tablets (for
  consistency with the sibling "How would you like to pay?" eyebrow at `:263`), in addition to
  the new "Step · Gratuity" framing.
- Append the gratuity CSS to `index.css`. All referenced tokens already exist with the exact
  values in the drop-in (`--amber`, `--brass`, `--brass-bright`, `--paper`, `--sage`, `--rust`,
  `--cream-text`, `--deep-brown`, `--text-muted`, `--font-display`, `--font-body`).

**Invariants that MUST stay byte-identical to the live block** (confirmed safe by the audit):
- Outer `{gratuityEnabled && (...)}` render gate.
- "Keep the tip jar" radio onChange: `setTipJar(true); setGratuityDirty(true)`.
- "Skip the tip jar" radio onChange including the floor raise:
  `setTipJar(false); setGratuityDirty(true); setGratuityTotal((g) => Math.max(Number(g) || 0, gratuityFloor))`.
- Suggested chip: gated by `{tipJar && (...)}`, onClick `setGratuityTotal(gratuitySuggested); setGratuityDirty(true)`.
- Dollar input: `type="number"`, `min={tipJar ? 0 : gratuityFloor}`, `step="1"`,
  `value={gratuityTotal}`, onChange `setGratuityTotal(e.target.value); setGratuityDirty(true)`.
- Floor-warning render gate: `!tipJar && Number(gratuityTotal) < gratuityFloor`, with `role="alert"`.
- `role="radiogroup" aria-label="Tip jar"` on the wrapper.
- `gratuityStaffNoun` interpolated everywhere (no hardcoded "bartender" literal).

### 3.2 Logic change A — gate the "None" chip
The drop-in renders the `None` ($0) chip unconditionally. Gate it inside the **same**
`{tipJar && (...)}` fragment as the suggested chip, so neither preset renders in no-jar mode
(matching live `SignAndPaySection.js:235-244`). The `None` onClick is unchanged
(`setGratuityTotal(0); setGratuityDirty(true)`). Effect: no one-tap path to $0 when the jar is
skipped.

### 3.3 Logic change B — hard floor block (new behavior)
Today the no-jar floor only renders a warning; the Pay button stays live. Change to block:
- Define `gratuityBelowFloor = gratuityEnabled && !tipJar && Number(gratuityTotal) < gratuityFloor`.
- Keep the existing red floor warning (it is the visible reason).
- **Disable the Pay button:** OR `gratuityBelowFloor` into the `PaymentForm` `disabled`
  expression at `SignAndPaySection.js:317`
  (`!sigName.trim() || !sigData || !venueComplete || gratuityBelowFloor`).
- **Guard `handleSign` (`ProposalView.js:226`):** as a money-path belt-and-suspenders, when
  `gratuityBelowFloor` is true, early-return **before** any Stripe confirm and set the form-error
  banner (`formError`) to the floor message. With Pay already disabled this guard should never be
  reached via the UI; it exists so no programmatic path can submit a below-floor no-jar gratuity
  even before the server `deriveGratuityRate` / DB-CHECK backstop.

### 3.4 Logic change C — keyboard focus visibility
The tablets hide the native radio (`opacity:0; pointer-events:none`) but ship no focus style.
Add a `.tip-tablet:focus-within` rule mirroring the input frame's focus treatment
(`border-color: var(--amber); box-shadow: 0 0 0 3px rgba(29,140,137,0.18)`), so keyboard
(Tab/Arrow) users see focus on a control that gates the floor. WCAG 2.1 SC 2.4.7.

### 3.5 Copy
- Intro paragraph: **"Every dollar goes straight to your {gratuityStaffNoun}s. None of it is
  kept by Dr. Bartender."** (the owner's message; the em dash from the drop-in is replaced with a
  period per the no-em-dash house rule).
- Keep the **"100% to your {gratuityStaffNoun}s"** input-frame hint chip.
- Accept the drop-in's colon-less no-jar amount label
  (`Gratuity for your {gratuityStaffNoun}s`) — consistent with the other eyebrow labels.
- No merchant-processing / card-fee language anywhere in client copy.
- Sweep the integrated JSX for any remaining em dash before commit.

## 4. Edge cases & states
- **Empty input:** `Number('') === 0`; in no-jar mode this is `< gratuityFloor`, so the warning
  shows and Pay is disabled — correct.
- **Jar mode:** `None`/$0 is valid; presets show; no floor; Pay not gated by gratuity.
- **Switching jar → no-jar:** the skip radio's `Math.max(..., gratuityFloor)` raises the amount
  to the floor, so the default state after switching is valid; only a subsequent manual reduction
  can trip the block.
- **`gratuityEnabled === false`** (staff × hours ≤ 0): whole block hidden; `gratuityBelowFloor`
  is false; Pay ungated by gratuity.
- **payOnly mode:** untouched — the gratuity block only renders in `signAndPay`.

## 5. Verification
- `CI=true react-scripts build` in `client/` (the Vercel lint gate).
- Manual eyeball on the proposal Sign & Pay page:
  - Both jar states render correctly; tablets, chips, and parchment input styled.
  - No-jar mode: presets hidden; typing below the floor shows the warning **and** disables Pay;
    raising to/above the floor re-enables Pay.
  - Jar mode: None/suggested chips work; $0 allowed.
  - Keyboard Tab/Arrow shows a focus ring on the tablets and still toggles selection.
- Confirm no behavioral regression in the preserved handlers (gratuityDirty still invalidates the
  cached Stripe secret and forces a fresh server-quoted total).

## 6. Files
- `client/src/pages/proposal/proposalView/SignAndPaySection.js` — gratuity block markup,
  `None`-chip gating, `gratuityBelowFloor` + Pay `disabled`.
- `client/src/pages/proposal/proposalView/ProposalView.js` — `handleSign` floor guard.
- `client/src/index.css` — appended gratuity-block CSS incl. `.tip-tablet:focus-within`.
- (Reference only, unchanged) `server/utils/payrollAccrual.js`, `server/utils/payrollMath.js`,
  `server/utils/pricingEngine.js` (`deriveGratuityRate`), `schema.sql`
  (`proposals_gratuity_jar_check`).
