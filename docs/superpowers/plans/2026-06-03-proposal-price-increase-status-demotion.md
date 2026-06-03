# Proposal Price-Increase Status Demotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This touches money/status state — work at max care.

**Goal:** When an admin raises a proposal's total above what's already been paid, the proposal stops claiming "Paid in full." A `balance_paid` proposal whose new total exceeds `amount_paid` is demoted to `deposit_paid` (money is in, a balance is now due), which clears the false "Paid in full" chip and re-enables the **"Record outside payment"** admin action. (Note: "Generate payment link" stays gated for `deposit_paid` by design at `ProposalDetailPaymentPanel.js:30`, and that's fine — the new balance is collected via the auto-created "Additional Services" invoice, not a fresh proposal-token link.) The demotion is **manual-collection only**: if autopay was enrolled, it is cleared so the balance scheduler can never silently charge a saved card off an admin price edit.

**Architecture:** One conditional block inside the existing proposal-edit transaction in `crud.js`, right after the main `UPDATE proposals ... total_price` runs. It reads the pre-edit row (`old`, already fetched at `crud.js:446`) and the freshly computed `snapshot.total`. No new endpoints, no schema changes. Complements the existing `createAdditionalInvoiceIfNeeded` (`crud.js:657`), which already auto-bills the difference — this fix corrects the *status* so the UI and downstream consumers stop treating the proposal as fully paid.

**Tech Stack:** Node/Express, raw SQL via `pg`, `node:test`.

**Scope guard:** Only `balance_paid` is demoted (the verified, reported case). `confirmed` and `completed` are intentionally left alone — a completed event should not be repriced for collection through this path, and `confirmed` is out of the reported scope. Money math elsewhere (`ProposalDetailPaymentPanel` balance, invoices) is already correct; this only fixes the lying `status` column and the gated "Record outside payment" action.

---

### Task 1: Demote status on a price increase inside the edit transaction

**Files:**
- Modify: `server/routes/proposals/crud.js` — insert immediately after the `updatedRow` UPDATE (after line 604), still inside the `BEGIN`/`COMMIT` transaction (COMMIT is at line 649).

- [ ] **Step 1: Add the demotion block.** Insert after the `updatedRow = await dbClient.query(...)` UPDATE (line 604) and before the add-ons `DELETE`/`INSERT` (line 607):

```js
    // Re-evaluate payment status when a price increase outruns what's been paid
    // (CLAUDE.md: never leave a proposal marked paid when it isn't). A fully-paid
    // proposal whose new total exceeds amount_paid is no longer paid in full —
    // demote balance_paid -> deposit_paid so the UI stops showing "Paid in full"
    // and re-enables the "Record outside payment" action. The matching
    // $325-style "Additional Services" invoice is created post-commit by
    // createAdditionalInvoiceIfNeeded (below) and is the client's pay surface.
    // MANUAL ONLY: if autopay was enrolled, clear it so the balance scheduler
    // cannot charge the saved card off an admin price edit.
    const newTotalCents = Math.round(Number(snapshot.total) * 100);
    const paidCents = Math.round(Number(old.amount_paid || 0) * 100);
    if (old.status === 'balance_paid' && newTotalCents > paidCents) {
      await dbClient.query(
        `UPDATE proposals SET status = 'deposit_paid', autopay_enrolled = false, autopay_status = NULL WHERE id = $1`,
        [req.params.id]
      );
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'status_changed', 'admin', $2, $3)`,
        [req.params.id, req.user.id, JSON.stringify({
          from: 'balance_paid', to: 'deposit_paid',
          reason: 'price increased above amount paid', new_total: snapshot.total,
        })]
      );
    }
```

- [ ] **Step 2: Confirm `old` carries the fields used.** `old` is `SELECT *` from `proposals` (`crud.js:442`), so `old.status`, `old.amount_paid`, `old.autopay_enrolled` are present. No change needed — just verify by reading line 442.

- [ ] **Step 3: Verify the downstream invoice path still fires.** No change — `createAdditionalInvoiceIfNeeded(proposalId, oldTotalCents, invClient)` at `crud.js:657` runs post-commit regardless of status and creates the balance invoice for the delta. The demotion and the invoice are complementary.

---

### Task 2: Test the demotion (and the no-op cases)

**Files:**
- Modify: `server/routes/proposals/crud.test.js` — add cases alongside the existing PATCH tests (reuse that file's harness for seeding a proposal and calling `PATCH /api/proposals/:id`).

- [ ] **Step 1: Write the failing tests.** Mirror the existing PATCH-test setup in `crud.test.js` (the `insertDraftProposal()` helper at ~line 168 and the PATCH cases at ~lines 680-717). NOTE: `insertDraftProposal` accepts `total_price`/`status`/`payment_type` overrides but **not** `amount_paid` or `autopay_enrolled` — after seeding, run a direct `UPDATE proposals SET amount_paid=$1, autopay_enrolled=$2 WHERE id=$3` (the established pattern in sibling tests) to set up the `balance_paid` + paid + autopay-on fixture. `createAdditionalInvoiceIfNeeded` is NOT stubbed in this file, so drive case 1 through the real HTTP PATCH route (not a direct function call) and `await` the response before asserting the invoice, since it's created in the post-COMMIT transaction. Add three cases:

```js
// 1. balance_paid + price increase -> demoted to deposit_paid, autopay cleared
test('PATCH price increase on a paid proposal demotes balance_paid -> deposit_paid', async () => {
  // seed: a proposal with status='balance_paid', amount_paid=400, total_price=400,
  //       autopay_enrolled=true, on a cheaper package.
  // act: PATCH /api/proposals/:id changing package_id to a $725 package.
  // assert:
  //   row.status === 'deposit_paid'
  //   row.autopay_enrolled === false
  //   row.autopay_status === null
  //   an 'Additional Services' invoice for the $325 delta exists (createAdditionalInvoiceIfNeeded)
});

// 2. balance_paid + NO price increase (e.g. same total, edit venue) -> status unchanged
test('PATCH with no price increase leaves balance_paid intact', async () => {
  // seed balance_paid/amount_paid=400/total=400; PATCH only the venue.
  // assert row.status === 'balance_paid' (no demotion, no spurious activity-log entry).
});

// 3. price DECREASE on balance_paid -> status unchanged (still paid in full or overpaid)
test('PATCH price decrease does not demote', async () => {
  // seed balance_paid/amount_paid=400/total=400; PATCH to a cheaper $300 package.
  // assert row.status === 'balance_paid'.
});
```

- [ ] **Step 2: Run, expect FAIL** (before Task 1) then PASS (after). Run in isolation (shared dev DB):

Run: `node --test server/routes/proposals/crud.test.js`
Expected: the three new cases PASS; existing cases still PASS.

- [ ] **Step 3: Commit** — `git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js && git commit -m "fix(proposals): demote balance_paid->deposit_paid when an edit raises total above amount paid"`

---

## Verification (whole plan)
- `node --test server/routes/proposals/crud.test.js` — new + existing cases pass.
- Manual against a scratch proposal: take it to `balance_paid` (full payment), edit the package up; confirm the admin detail page now shows a balance due, the green "Paid in full" chip is gone, the "Record outside payment" action is available again (no longer hidden), and `autopay_enrolled` is false. ("Generate payment link" stays hidden for `deposit_paid` by design.) Confirm the auto-created "Additional Services" invoice covers the delta.
- Regression: editing an unpaid (`sent`/`viewed`/`accepted`) proposal is unaffected (the `old.status === 'balance_paid'` guard).

## Self-review notes
- **Autopay safety is the load-bearing detail.** Demoting to `deposit_paid` without clearing `autopay_enrolled` would let `balanceScheduler` claim the proposal (it targets `status='deposit_paid' AND autopay_enrolled=true`) and charge the new balance off-session — exactly the surprise charge Dan vetoed. The block sets `autopay_enrolled=false` and `autopay_status=NULL`.
- **Idempotent:** a second edit when already `deposit_paid` does not match the `old.status === 'balance_paid'` guard, so it won't re-fire or double-log.
- **No scope creep:** `confirmed`/`completed` deliberately untouched; client-facing proposal-page balance copy untouched (post-upgrade collection goes through the Additional Services invoice, not the proposal page).
- **No placeholders in implementation:** Task 1 is complete code. Task 2's bodies describe seed/act/assert against `crud.test.js`'s existing harness rather than guessing its private setup helpers — fill the seed/act lines from the sibling PATCH tests already in that file.
