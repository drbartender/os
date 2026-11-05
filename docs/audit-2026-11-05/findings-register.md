# Findings register, audit 2026-11-05

Every finding the five auditors raised (53), plus the two the verify passes raised on top (AUTH-12, AUTH-13), with the lane that owned it, what happened to it and where the commits are. The full evidence for each is in `reports/<domain>.md` (the audit) and `fixes/<domain>-fixes.md` (the fixer's rounds, test evidence and residuals). A finding "moved" to another lane was fixed there to keep one file in one lane; its row says where.

Severity is the auditor's; outcome is the orchestrator's after the verify passes. Commits are on the lane's branch (`git log main..<branch>`); they are checkpoints and will be squashed at merge.

## Payments (branch `audit-payments`, 23 commits)

| ID | Sev | Claim (short) | Outcome | Commits |
|---|---|---|---|---|
| PAY-01 | high | A syrup-only extras payment lowers every balance the system charges or bills (the contract under-collected by the syrup money) | fixed across three rounds: one partition, read through one helper (`contractBalanceDueCents` / `contractPaidCents`: the money collected outside the contract, netted), at every balance site (autopay, charge-balance, the Balance invoice mint and refresh, the drink-plan balance fold, the public payload and `paidState`, the portal, the reminders, the monitor's SQL twin), the paid-flag ladder and the webhook derivations, the first-payment CASE rails, record-payment, the admin PATCH and comp ladders, the payroll duty gate; the extras invoice stores whether its money folded into the contract (`invoices.folded_into_total`, monotone upward) and every reader takes that fact before the line shape; money law 8 gained a dated sentence. Residuals: the auto-complete sweep (`balanceScheduler.js` ~247) and `payrollAccrual.js`'s gratuity funded gate (the payouts lane's file) still read the raw difference, so on a row owing contract money beside paid off-contract money the event can complete and the contract gratuity pool while money is owed (one line each; a follow-up lane after both merge); legacy rows the old rail short-charged before the fix (balance_paid with a paid unfolded extras invoice inside `amount_paid`) now read a netted balance no door accepts and their pending reminders still fire (a one-off query and a manual settle for the owner) | b0bf50c, 0cad68e, bc4a22e, 2957896, d6a411b, e0c7d93, 3618267, f2f3c01 |
| PAY-02 | high | The Deposit invoice is payable from the public invoice page before the agreement is signed; the webhook credits it without converting the booking | fixed: a contract-label invoice refuses an intent while the proposal is not booked (409 to the proposal page); the webhook invoice branch converts the booking (deposit_paid, Balance invoice, hold, ladder) and records an unsigned settle; `open_invoice_token` only on booked rows; the portal hides Pay balance on an unbooked row; the booked-status list bound as a parameter | 7d7a2dc, 95a2bd6, 393eb1b |
| PAY-03 | medium | Toggling autopay after the deposit intent is minted is ignored | fixed: autopay is part of the intent reuse identity (cancel and mint fresh when it differs) | 6b9a292 |
| PAY-04 | medium | A chargeback on a proposal charge is never reconciled | fixed: disputes recorded through the refund reconciler as 'dispute'-scope ledger rows (idempotent on the dispute id; a redelivery recognized before the cap), invoices re-opened at full demand, status demoted and autopay disarmed, reversed when won; with POUT-06 (the tip dispute cumulative = refunded + dispute amount, capped) | b647694, 65681cb |
| PAY-05 | low | Admin record-payment of a partial never mints the Balance invoice | fixed in the shared helper, which also stands down while an open Full Payment invoice already demands the remainder | c861971, 2c32523 |
| PAY-06 | low | Checkout charges the env deposit while the invoice, retainer and compare page use the row's | fixed: every rail charges the row's deposit with the env value as the NULL fallback; the payload carries the effective deposit and the client renders no literal | 7f7d09e, 1fdc7e9 |
| PAY-07 | low | Past-due decided at UTC midnight, a day early for Chicago | fixed | cd086ca |
| PAY-08 | low | Invoice label edits fence only the off-ledger label; manual line items unvalidated | fixed: every system label refused on admin mint and rename; finite bounded money; `amount_due` derived from lines | b566ae2 |
| PAY-09 | low | The deposit option offered and charged above a sub-deposit contract total | fixed: `full_payment_required` with a reason; the deposit option refused server-side | 1f68f62, 1fdc7e9 |
| PRC-03 | medium | Pay-now drink-plan extras priced flat while the fold prices them with the engine (moved from pricing) | fixed: the pay-now charge and the invoice lines are the fold's own two engine legs; a fold-delta disagreement refuses before any write | 420edc2, 0cad68e, 3618267 |
| ESIG-03 | medium | A client can pay without signing (moved from e-signatures) | fixed in the record: `accepted_at` stamped at settle so the booking is counted; an `unsigned_payment` activity row, a Sentry warning and an admin alert; refusing confirmation of an unsigned deposit is a product decision noted in the commit | e67bf0e |
| POUT-06 | medium | Dispute withdrawal treats `dispute.amount` as the cumulative refund (moved from payouts) | fixed with PAY-04 | b647694 |
## Payouts (branch `audit-payouts`, 20 commits)

| ID | Sev | Claim (short) | Outcome | Commits |
|---|---|---|---|---|
| POUT-01 | high | A manager can rewrite a contractor's payout handles with no audit row | fixed: the four payout-destination fields admin-only, audit row with field names only, manager tab hides the card | 33f0264 |
| POUT-02 | high | Unassign or deny after the event re-accrues only when a bonus lock moved | fixed: unassign, deny and the cover swap re-accrue unconditionally; cancel keeps its lock gate (a completed shift cancelled by mistake would otherwise lose its lines) | dd0ee43, e1252b8 |
| POUT-03 | high | Accrual's prior-line lookup ignores the pay period (double wage after a date move; zeroed wage when a claw stub wins) | fixed, narrowed after two verify rounds: the prior map is keyed by period, a payable line for the same contractor and shift in another period stops that worker with a Sentry warning, a pure clawback stub never seeds hours or rate, a stopped worker keeps the duty lines beside their wage; the clawback lands in today's period again (main's rule) | d752699, 656f442, 93223f9 |
| POUT-04 | high | `/api/me` has no onboarding gate | moved to auth (AUTH-01) | see auth |
| POUT-05 | medium | A W-9 or certification replaced from the Account page is stored under a key no admin surface can open | fixed: stored as `/files/` plus the key, a prefix-aware signer route, idempotent backfills beside their tables | 22dc1ba, 7e734a5 |
| POUT-06 | medium | Dispute withdrawal treats `dispute.amount` as the cumulative refund | moved to payments (with PAY-04) | see payments |
| POUT-07 | medium | Tip assign accepts any tip and any shift | fixed: refuses a placed, rolled-forward or fully refunded tip and a recipient not on the shift; a partly refunded unplaced tip is placed with its refund clawed at placement (the tip routes moved to `payrollTips.js` for the size cap); residual: a one-statement window on the frozen-event path where a process death leaves the claw unbooked (root alternative: the roll-forward's success write keeps the clawback marker) | c4a654c, a260726, a1e54d6, 9e0c842 |
| POUT-08 | medium | Admin user detail decrypts bank numbers unguarded (one bad row 500s the page) | fixed: one shared safe mask | e4619f7, 5b88d2c |
| POUT-09 | low | Profile PUT writes two tables as two autocommits; method unvalidated | fixed: one transaction on one held client; the shared allowed set | 79935bc |
| POUT-10 | low | Three writers disagree on the allowed payment methods; direct_deposit with no bank data | fixed: one exported set and one eligibility rule in every writer; a method the row can no longer pay is cleared, never stored | 94d6f01, 52aeb78 |
| POUT-11 | low | Payout-event PATCH computes the wage from unrounded hours | fixed | 7351a7b |
| POUT-12 | low | A staff member's first name in a code comment | fixed in the finding's file; the same name sits at ten other sites outside this lane's footprint (`server/scripts/staffPaymentImport/*`, `server/index.js`): for the ledger | 10c5295 |
| POUT-13 | low | A DATE rendered through `toISOString` drifts east of UTC | DEFERRED: no exported local-components helper exists; proposed `localDateYmd` in `businessTime.js` or `TZ=UTC` in the start script; no failure today (Render runs UTC) | none |
| AUTH-10 | low | Managers receive the full agreements row | fixed here (the lane owns `admin/users.js`): IP and user agent stripped for everyone, the signature image for managers | 0bd4d67 |

Payouts residuals for the owner (from `fixes/payouts-fixes.md`): a duplicate line a period already holds for a stopped worker (minted before the rule) stays payable until an admin zeroes it (the warning names it); after an event-date correction across two open periods the stopped worker's line stays in the original period, which accrual never resolves again; a tip refunded inside the event's own week and then re-split after a roster removal pays part of the refunded tip again (pre-existing; the proposed fix is a pool that uses each tip's gross minus its refunded cents).

## Auth (branch `audit-auth`, 16 commits)

| ID | Sev | Claim (short) | Outcome | Commits |
|---|---|---|---|---|
| AUTH-01 | high | `/api/me/staff-home` has no `requireOnboarded` (a self-registered account reads staffers' emails and client data) | fixed: router-wide gate on `staffPortal.js` and `me.js`, and on the cover claim; every onboarding page call checked (none hits `/api/me`) | 4dadd63, 9ffc365 |
| AUTH-02 | high | The quote wizard backfills a stranger's email onto a phone+name-matched client row (portal takeover) | fixed: the public wizard never resolves or stamps a phone-only row (`phoneMatch: false`); the admin path keeps the backfill; product note: a returning phone-only Thumbtack lead who uses the wizard becomes a second row to merge by hand, and the harvester then marks that lead's harvest failed until merged | fc8f623 |
| AUTH-03 | high | The calendar feed ignores account status; deactivation never rotates the token | fixed: the feed fails closed like `auth.js`; deactivation and rejection rotate the token | 0972b24, 5222915 |
| AUTH-04 | medium | The OTP attempt ceiling is read-then-written around the compare (parallel guesses pass it) | fixed: the increment is a conditional claim before the compare | 6db2451, 8dc5645 |
| AUTH-05 | low | Drink-plan `admin_notes` reach any onboarded staffer | fixed: rides the contact gate | 4d0db81 |
| AUTH-06 | low | The public blog image proxy serves any root-level image by basename | fixed: only `blog_`/`email_` uuid keys, any stored extension shape; writers store a sanitized extension | 8f3bfea, ce91afd |
| AUTH-07 | low | The failed-login log line writes the submitted email | fixed | 3157d19 |
| AUTH-08 | low | Agreement and change-request IPs from the first X-Forwarded-For hop | moved to e-signatures (ESIG-01) | see e-signatures |
| AUTH-09 | low | The public proposal payload returns the signature image | moved to e-signatures (ESIG-09) | see e-signatures |
| AUTH-10 | low | Managers receive the full agreements row | moved to payouts | see payouts |
| AUTH-11 | low | `request-email-change` is an email-existence oracle for any authenticated account | fixed by the router-wide gate (the 409 for onboarded users is the spec'd behavior, unchanged) | 4dadd63 |
| AUTH-12 | high | NEW (verify pass): the wizard's email-match branch attaches a stranger to an existing client's row and hands them the token | fixed: a submit that resolves to an existing row gets no token; the link goes only to the address on file, the SMS only to the phone on file; the panel says so, honestly on a failed send; product-visible: a returning client re-quoting with their own email reads "Check your email" | 97ad261, 6188f03, efce4d6 |
| AUTH-13 | medium | NEW (verify pass): the wizard held its pooled client through the post-COMMIT tail while helpers took their own connections (the SERVER-17 shape) | fixed: released right after COMMIT | de49b05 |

Auth residual for the owner: when the proposal mail fails but the SMS half goes out, the matched-row panel reports the email failure while the link is already on the client's phone (copy only).

## E-signatures (branch `audit-esign`, 26 commits including three reverts)

| ID | Sev | Claim (short) | Outcome | Commits |
|---|---|---|---|---|
| ESIG-01 | medium | Staff agreement and change-request IPs are the forgeable first X-Forwarded-For hop (AUTH-08) | fixed: proxy-validated `req.ip`, bounded | f903864 |
| ESIG-02 | medium | A signed proposal's terms are rewritten by the admin PATCH with the signature attached; no signed record kept | fixed: the sign stores `client_signed_total` and `client_signed_snapshot` from the row read under the lock; an admin edit or a line removal that moves a priced term, the total or the venue on a signed row with no money on it (paid, external, or a settling debit) voids the signature inside the transaction with a `signature_voided` activity row carrying the prior record, and the page shows Sign & Pay again; paid rows keep their signature and the stored record; residual: a card deposit confirmed but not yet credited (seconds, or a 3DS challenge) is invisible to the guard, so an edit in that window voids a signature the webhook cannot restore (the round-3 attempt to read pending intents treated every page view as money and was reverted) | 5dffa6f, db04254, 5fe8ad4, ffd27c6, e54aa3b |
| ESIG-03 | medium | A client can pay without signing | moved to payments | see payments |
| ESIG-04 | medium | No download of the signed staff agreement for the signer or the admin; one best-effort email | fixed: the signer's Download, an admin/manager PDF route with a prefix check, "Copy not emailed" with a resend | 57442c1 |
| ESIG-05 | medium | No retrievable record of the proposal as signed | fixed in part: the sign-time emails carry the version, the signed name and time, the server's price rows and the acknowledged total, from the stored signed record; DEFERRED: a stored proposal PDF and a token-gated signed-copy route for archived rows | 97fe7dc |
| ESIG-06 | medium | `signature_data` unvalidated (non-image under draw; one-character typed; 1 MB blob) | fixed: one shared validator (bounded PNG/JPEG by magic bytes, or a bounded printable typed name); residual: a typed value of invisible characters only still passes the length rule (the stricter rule refused Persian and Indic joiners and was reverted) | 907ba90, e36f8b7 |
| ESIG-07 | medium | The electronic W-9's certification exists only in a browser-built PDF | fixed in part: the certification event (time, proxy IP, user agent, form revision, method) is recorded server-side in the profile transaction; DEFERRED: server-side rendering of the fill-mode PDF | bd0b5d4 |
| ESIG-08 | medium | A re-sign overwrites the prior signature, name, consent and PDF key | fixed: every sign appends an `agreement_signatures` history row under the row lock, `first_signed_at` kept, the superseded key preserved; DEFERRED (product rule): refusing a same-version re-sign unless an admin allows it | b39c26b, 9c9f69b |
| ESIG-09 | low | The public payload carries the signature image (AUTH-09) | fixed | dc260c7 |
| ESIG-10 | low | The contractor agreement text has no content pin | fixed: sha256 pin per version, the hash stored on the row | 4e1d25b |
| ESIG-11 | low | The staff sign does not bind the version the signer rendered | fixed: the page sends the version, a stale one is a 409 | 10bfd8e |
| ESIG-12 | low | No electronic-signature consent on the draw path | fixed in part: the statement under the pad in both modes; DEFERRED (owner's call): a recorded `ack_esign_consent` needs a new frozen agreement version (the exact change list is in the fixer report) | 97813ec |
| ESIG-13 | low | Unbounded signer fields; acks `!!`-coerced | fixed | 4d29bbd |
| ESIG-14 | low | Admin `sent`→`accepted` yields an unsignable row; archived→draft keeps a stale signature | fixed: an unsigned accepted row can be signed; any restore out of archived onto a pre-payment status clears a stale signature, never over money | 7564f68, 3399964 |

## Pricing (branch `audit-pricing`, 6 commits; the comp work on `audit-pricing-comp`, 13 commits)

| ID | Sev | Claim (short) | Outcome | Commits |
|---|---|---|---|---|
| PRC-01 | high | Comping an extras invoice lowers `total_price` only; the next re-price bills the comped add-on again | OPEN, split out: three rounds built a protected comp line that follows the current price of the items it comps (`audit-pricing-comp`), and the deciding verify read still found two reachable money defects (the planner pre-fills the plan with the booking's contract syrups, so a comp waives them too; a departed item re-added beside a surviving comped item is free again). The owner decides: take the comp branch into a new lane with those two closed, or fix the original defect the other way (the comp removes the add-on through the cancel-line core) | on `audit-pricing-comp`: 735a4d0, a03ce1e, acb8e7f, ddc170e, 328b30e, 027438d, 7efa6ae |
| PRC-02 | medium | The portal change-request preview re-derives the crew, dropping an admin's extra bartender | fixed: one shared `overrideOnlyBartenders` rule | 7179c2f |
| PRC-03 | medium | Pay-now drink-plan extras priced flat while the fold prices them with the engine | moved to payments | see payments |
| PRC-04 | low | Invoice unit price does not multiply to the line total | fixed: derived only when the line total divides into whole cents | 1eff62d, d7fe1b7 |
| PRC-05 | low | Unvalidated guest_count, num_bars, num_bartenders, duration on the admin routes | fixed: one input gate on create, PATCH and the preview; a stored out-of-bounds value re-sent unchanged still saves | 8c72fcb, 2a61b42 |
| PRC-06 | low | PACKAGES_REPORT.md contradicts the engine and seeds | fixed (docs) | 9186d8a |

## Observations the auditors recorded without a finding (for the owner's ledger)

- The payroll pool reads the forced Shared Gratuity surcharge at full amount on a comped booking (`extractGratuityCents`), so payroll can pool a surcharge the client never paid (pricing report, cross-domain note).
- The proposal sign route carries no `isLegalHold` guard; the held proposal is signable only if it were unsigned and sent (e-signatures report, could-not-verify).
- The autopay claim, the completion sweep and the balance monitor carry no legal-hold exclusion; the spec scopes the guards elsewhere (payments report, could-not-verify).
- The law-4 frozen-rate defects the pricing auditor re-verified as still open (D0939, D0950, D1009, D1012, D1087, D1090, D1110) and the four payments ledger items re-verified as present are listed in their reports and not re-raised here.
- A pre-existing fixture in `publicToken.signPhone.test.js` carries a ten-digit number outside the 555 exchange (outside every lane's diff).
