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
- **`gratuityDirty` invariant:** every gratuity-mutating control — both radios, every preset chip,
  and the dollar input — calls `setGratuityDirty(true)`, so the cached Stripe `clientSecret` is
  invalidated and the server re-quotes the total. Any control added later MUST do the same; the
  client must never pay against a stale secret.
- **Floor-warning class:** the warning element adopts the drop-in's `gratuity-floor-warn` class
  (replacing `payment-policy-warn`); the render gate and `role="alert"` are unchanged.
- **`.assured` span:** keep the drop-in's `<span className="assured">Every dollar</span>` italic
  emphasis when applying the em-dash → period copy edit (§3.5); it is styled by a CSS rule in the
  appended block.

### 3.2 Logic change A — gate the "None" chip
The drop-in renders the `None` ($0) chip unconditionally. Gate it inside the **same**
`{tipJar && (...)}` fragment as the suggested chip, so neither preset renders in no-jar mode
(matching live `SignAndPaySection.js:235-244`). The `None` onClick is unchanged
(`setGratuityTotal(0); setGratuityDirty(true)`). Effect: no one-tap path to $0 when the jar is
skipped.

### 3.3 Logic change B — hard floor block (new behavior)
Today the no-jar floor only renders a warning; the Pay button stays live. Change to block, with a
**single source of truth** for the below-floor condition:
- **Compute `gratuityBelowFloor` once, in `ProposalView.js`**, and pass it to `SignAndPaySection`
  as a prop — do not recompute it in the child. Coerce so an empty/undefined value cannot slip
  through (`Number(undefined)` is `NaN`, and `NaN < floor` is `false`):
  `gratuityBelowFloor = gratuityEnabled && !tipJar && (Number(gratuityTotal) || 0) < gratuityFloor`
  (mirrors the skip-radio's `Math.max(Number(g) || 0, ...)` at `SignAndPaySection.js:228`).
- Keep the existing red floor warning (it is the visible reason).
- **Disable the Pay button:** OR the `gratuityBelowFloor` prop into the `PaymentForm` `disabled`
  expression at `SignAndPaySection.js:317`
  (`!sigName.trim() || !sigData || !venueComplete || gratuityBelowFloor`).
- **Do not fetch a payment intent below the floor.** The debounced create-intent effect
  (`ProposalView.js:127-189`) must early-return when `gratuityBelowFloor` is true. Otherwise it
  POSTs a below-floor body, the server returns the floor `ValidationError`, and the client renders
  the generic "Unable to load payment form" banner while the cached secret is cleared and the
  Elements form unmounts. Below the floor the user must see ONLY the floor warning + a disabled
  Pay button, never a generic Stripe-load error.
- **Guard `handleSign` (`ProposalView.js:226`):** as a money-path belt-and-suspenders, when
  `gratuityBelowFloor` is true, set `formError` to the shared floor message **and `throw`**
  (mirroring the existing validation early-exits at `:232`/`:237`/`:249`, which `throw` so
  `PaymentForm` aborts the Stripe `confirmPayment`). A bare `return` would let the confirm proceed
  against a cached secret, so it must throw.
- **One floor message, one floor rate.** The inline floor warning and the `handleSign` `formError`
  read from a single shared message constant so they cannot drift. The client floor uses the
  literal `50` (`ProposalView.js:335`), duplicating the server `GRATUITY_FLOOR_RATE = 50`
  (`pricingEngine.js:190`); prefer deriving the client floor from the snapshot the server already
  emits, or at minimum flag the duplication so a server bump (e.g. to $60) cannot silently
  under-block the client. The server `deriveGratuityRate` + `proposals_gratuity_jar_check` DB CHECK
  remain the authoritative backstop regardless.

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
- **Accepted copy decision (recorded):** the "every dollar / 100% to your {staff}s" framing is
  retained by owner decision. It is accurate in that Dr. Bartender keeps **$0** of the gratuity;
  the only amount the staff member does not receive is the card processor's pro-rata fee
  (`payrollAccrual.js:159`), a standard, un-surfaced cost of accepting cards. This is a deliberate,
  documented acceptance of the "promise vs. net payout" nuance the spec-risk review raised, not an
  oversight. Do not add merchant-processing explainer copy.

## 4. Edge cases & states
- **Empty / cleared / non-numeric input:** the below-floor check uses `Number(gratuityTotal) || 0`
  (§3.3), so `''`, `null`, and `undefined` all coerce to `0`, which in no-jar mode is
  `< gratuityFloor`: warning shows, Pay disabled, no intent fetched. On submit, `gratuity_total`
  normalizes blank to 0.
- **Jar mode:** `None`/$0 is valid; presets show; no floor; Pay not gated by gratuity.
- **Switching jar → no-jar:** the skip radio's `Math.max(Number(g) || 0, gratuityFloor)` raises
  the amount to the floor, silently overwriting a lower typed value, so the default state after
  switching is valid; the floor warning does not appear on the switch itself, only on a subsequent
  manual reduction below the floor.
- **`gratuityEnabled === false`** (staff × hours ≤ 0): whole block hidden; `gratuityBelowFloor`
  is false; Pay ungated by gratuity.
- **payOnly mode:** immune by construction — the gratuity block only renders in `signAndPay`, and a
  payOnly proposal was already signed and validated under the floor rules, so it cannot carry a
  below-floor no-jar gratuity even though its Pay button is `disabled={false}`. The new block does
  not touch payOnly.

## 5. Verification
- `CI=true react-scripts build` in `client/` (the Vercel lint gate).
- Manual eyeball on the proposal Sign & Pay page:
  - Both jar states render correctly; tablets, chips, and parchment input styled.
  - No-jar mode: presets hidden; typing below the floor shows the warning **and** disables Pay;
    raising to/above the floor re-enables Pay.
  - Jar mode: None/suggested chips work; $0 allowed.
  - Keyboard Tab/Arrow shows a focus ring on the tablets and still toggles selection.
  - Below the floor: NO create-intent fires and the user sees only the floor warning + disabled
    Pay (never the generic "Unable to load payment form" banner).
- Confirm no behavioral regression in the preserved handlers (gratuityDirty still invalidates the
  cached Stripe secret and forces a fresh server-quoted total).
- **Validation parity:** confirm the server still rejects a below-floor no-jar gratuity
  (`GRATUITY_BELOW_FLOOR` from `deriveGratuityRate`) if the client block is bypassed (e.g. DevTools
  removes `disabled`) — client guard and server floor must agree.

## 6. Files
- `client/src/pages/proposal/proposalView/SignAndPaySection.js` — gratuity block markup,
  `None`-chip gating, `gratuityBelowFloor` + Pay `disabled`.
- `client/src/pages/proposal/proposalView/ProposalView.js` — compute `gratuityBelowFloor`, pass it
  as a prop, gate the create-intent effect on it, and add the `handleSign` floor guard.
- `client/src/index.css` — appended gratuity-block CSS incl. `.tip-tablet:focus-within`.
- (Reference only, unchanged) `server/utils/payrollAccrual.js`, `server/utils/payrollMath.js`,
  `server/utils/pricingEngine.js` (`deriveGratuityRate`, `GRATUITY_FLOOR_RATE`), `schema.sql`
  (`proposals_gratuity_jar_check`).
- **Drop-in source (reference, present in this worktree, untracked):**
  `.claude/_gratuity-redesign/DROP-IN-CODE.md` (JSX + CSS) and
  `.claude/_gratuity-redesign/Gratuity-Section.html` (full mockup) — the exact markup/CSS to
  recreate, not the integration target. Re-copy from the handoff bundle if missing.
