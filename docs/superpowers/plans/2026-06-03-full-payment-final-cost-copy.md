# Full-Payment "Final Cost" Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This is a copy-only, behavior-inert change — no unit tests, verify with a client build + eyeball.

**Goal:** When a proposal forces full payment (event ≤14 days out), the page and the proposal SMS make clear this is the **complete, final cost** — no separate deposit, no later balance — so a client (especially a Thumbtack lead arriving with a "deposit to book" mental model) can't read their full payment as a deposit. This is the copy gap behind Jim Strachan's "it said deposit only."

**Architecture:** Three string edits — the full-payment notice and a new caption on the proposal page, plus a less deposit-priming initial-proposal SMS. No logic changes.

**Tech Stack:** React (CRA), plain JS template string for SMS. No em dashes in client copy (house style).

---

### Task 1: Proposal-page copy (the ≤14-day full-payment surfaces)

**Files:**
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js:103-107`
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js:164-168`

- [ ] **Step 1: Strengthen the full-payment notice.** Replace `SignAndPaySection.js:103-107`:

```jsx
  const fullRequiredNotice = fullPaymentRequired ? (
    <p className="payment-policy-note">
      Because your event is within 2 weeks, the full event total is due now to confirm
      your booking. This is the complete cost, there is no separate deposit and no balance later.
    </p>
  ) : null;
```

- [ ] **Step 2: Add a caption under "Full Payment Due."** In `ProposalPricingBreakdown.js`, the `fullPaymentRequired` branch (lines 164-168) currently renders only the row. Replace that branch with the row plus a caption:

```jsx
          {fullPaymentRequired ? (
            <>
              <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
                <span style={styles.paymentLabel}>Full Payment Due</span>
                <span style={styles.paymentValue}>{snapshot ? fmt(snapshot.total) : '—'}</span>
              </div>
              <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                This is the complete cost for your event. No separate deposit, no balance due later.
              </p>
            </>
          ) : (
```

(Leave the `: (` deposit/balance branch that follows untouched.)

- [ ] **Step 3: Verify the build + render.**

Run: `cd client; $env:CI='true'; npx react-scripts build`
Expected: build succeeds, no lint errors.
Eyeball: open a proposal whose event is ≤14 days out → notice + caption show "complete cost / no deposit / no balance"; open one >14 days out → unchanged deposit + remaining-balance terms.

- [ ] **Step 4: Commit** — `git add client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js && git commit -m "copy(proposal): make forced full payment read as the complete final cost"`

---

### Task 2: Initial-proposal SMS copy (de-prime the "deposit to book" framing)

**Files:**
- Modify: `server/utils/smsTemplates.js:16-18`

- [ ] **Step 1: Soften "View and book here."** The current template (`initialProposalSms`) reads:

> `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)} on ${dt(eventDate)}. View and book here: ${link}. Let me know if you have any questions or need any changes.`

"book here" primes a reserve-with-a-deposit expectation. Replace lines 16-18 with:

```js
function initialProposalSms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)} on ${dt(eventDate)}. Review the details and check out here: ${link}. Let me know if you have any questions or need any changes.`;
}
```

(Rationale: "Review the details and check out" is neutral — it works whether the proposal takes a deposit or full payment, and doesn't imply a small holding deposit. Wording is easily tweakable; this is the recommended string.)

- [ ] **Step 2: Verify the existing SMS test still passes.** `server/utils/sendProposalSentEmail.test.js:81` asserts the body matches `/Dallas here/` — still true. Run it in isolation:

Run: `node --test server/utils/sendProposalSentEmail.test.js`
Expected: PASS.

- [ ] **Step 3: Commit** — `git add server/utils/smsTemplates.js && git commit -m "copy(sms): neutral initial-proposal wording (drop deposit-priming 'book')"`

---

## Verification (whole plan)
- `cd client; $env:CI='true'; npx react-scripts build` is clean.
- `node --test server/utils/sendProposalSentEmail.test.js` and `node --test server/utils/smsTemplates.test.js` pass (the latter directly asserts `initialProposalSms`'s greeting/label/date/link/no-em-dash invariants).
- Visual check of the proposal page in both the ≤14-day (forced full) and >14-day (deposit) states.

## Self-review notes
- Behavior-inert: no pricing, status, or routing logic touched — only display/notification strings.
- House style respected: no em dashes; commas/periods only.
- The exact wording is a recommendation; Dan can adjust the strings without changing the plan's structure.
