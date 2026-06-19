# Open Threads Ledger

**Recovered from 438 threads across ~109 session transcripts, 2026-05-08 to 2026-06-09.** After deduping and cross-referencing against MEMORY.md (56 entries), this ledger surfaces **~165 genuinely OPEN items across 14 projects/areas**, with another ~115 marked LIKELY-DONE or TRACKED for completeness. Items shown most-recent date first within each project, with the highest-value OPEN items pulled to the top for triage. Where a thread is reflected in an existing memory entry as SHIPPED/DONE/PARKED, it's tagged TRACKED and dropped to the tail.

---

## Live / Needs-a-Decision (the highest-value OPEN items)

These are the threads most likely to bite you if forgotten — fresh, real, not tracked anywhere else.

| Item | Project | Why it matters | Last seen |
|---|---|---|---|
| **Last-minute staffing parity gap in Stripe full-payment webhook** | staff-portal/payments | `checkout.session.completed` 'full' branch settles paid-in-full but does NOT set `last_minute_hold=true` or call `notifyLastMinuteBooking()`. Admin-generated link for <72h event → staff never get the coverage blast. You explicitly chose to skip in the deploy push. | 2026-06-08 |
| **stripe.js at 1,720 lines (over hard cap; --no-verify used)** | staff-portal/payments | Webhook handler extraction now owns the deferred PI balance-branch guard hardening + a real webhook amount_paid test harness. Audit found Batch 3a additions will be blocked by the ratchet — extraction is load-bearing. | 2026-06-08 |
| **mergeClients ships unwired** | staff-portal/payments | When a route adopts it, it MUST be admin-gated + activity-logged + confirmation-guarded. Easy to forget. | 2026-06-08 |
| **amount_paid vs captured-amount check (pre-existing money gap)** | staff-portal/payments | Stripe webhook sets `amount_paid = total_price` on settle without checking `session.amount_total` matches. Assigned to the price-increase plan doc, not yet fixed. | 2026-06-08 |
| **Audit batch plan left untracked** | infra/process | `docs/superpowers/plans/2026-06-09-audit-findings-batch-plan.md` covers Batches 1-6 for 113 remaining audit findings, deliberately untracked to avoid colliding with parallel window. Commit it before it gets lost. | 2026-06-09 |
| **Audit blocker: defense-in-depth webhook accepted_at stamp** | staff-portal/payments | Belt-and-suspenders fix beyond the Stripe webhook (which you deliberately left untouched). Acknowledged safe follow-up. | 2026-06-09 |
| **Vite migration as its own project** | infra/process | 15-16 client HIGH advisories tied to dead CRA. Decision locked (Vite not Next), but not scheduled. Currently accept-and-document the advisories. | 2026-06-09 |
| **Two-step destructive DROP COLUMN safety** | infra/process | For dropping `notifications_opt_in` and old duplicate agreement columns: ship the code stopping use first, sit a day, then drop. Confirmation never captured before session end. | 2026-06-09 |
| **D1: should email-harvest also cover CC-import placeholder clients** | comms | Open decision gating Batch 5. Claude leans 'both'; awaiting your call. | 2026-06-09 |
| **D2/D3: drop notifications_opt_in + thumbs-up Bucket 2 wirings** | comms | Two Batch 5 decisions pending (signup checkbox that lies; equipment picker, gratuity rate origin display, sms_messages.metadata). | 2026-06-09 |
| **Local axios 1.17 sync after merge** | infra/process | Prod gets 1.17.0 via Vercel npm ci, but local os/client/node_modules pinned at 1.15.0 via the worktree junction. Run `npm install --prefix client` in os when no build is running. | 2026-06-09 |
| **Pre-existing paypal_url rows audit (grandfathered data cleanup)** | staff-portal/payments | Deliberately deferred; read-side defense was added but a one-time prod audit/cleanup never happened. | 2026-05-08 |
| **Rotate local Postgres password ([REDACTED — see commit 885b074])** | infra/process | Leaked in pre-rebase commit 885b074, scrubbed from history. Rotation is cheap insurance; never confirmed done. | 2026-05-14 |
| **C1 admin sidebar not responsive (biggest pending mobile remediation)** | redesign | adminos Sidebar.js + Header.js are fixed 220px static columns with no hamburger, crushing every admin page on phones. Batch 4 in the remediation plan, not started. Highest blast radius left. | 2026-05-19 |
| **Phase 3 + Phase 4 of staff payment system not started** | staff-portal/payments | Phases 1+2 fully shipped. Phase 3 (staff My Pay page) and Phase 4 (notifications, 1099) have no plan and no code. Fresh worktree work. | 2026-05-27 |
| **BEO project: 33-task plan written, zero code** | staff-portal/payments | Spec went through 7 rounds of fleet review; plan ready. Was tagged as next-up project. | 2026-05-27 |
| **cc-import v2 corrective rebuild not started** | cc-import | v1 produced client-facing errors (wrong invoice amounts). v2 specced but never started as a worktree; design docs still uncommitted in the worktree itself. | 2026-06-01 |
| **Office box Ubuntu 24.04 install incomplete** | infra/process | Foundation for self-hosted Cal.com + Thumbtack email harvester + calendar-entry enrichment. Install started, walkthrough not finished. | 2026-05-27 |
| **Stale worktrees to clear (cc-import has its only-copy spec+plan inside)** | infra/process | client-portal-editing, comms, cal-com cleanly removable; cc-import has uncommitted importer spec+plan that vanish if you `worktree:rm` it. | 2026-06-08 |
| **Sent-messages log feature (spec'd + plan-reviewed, worktree ready)** | comms | Committed to message-log worktree with kickoff prompt prepared; execution intended in a separate window — verify it actually ran. | 2026-06-05 |

---

## staff-portal / payments

### OPEN

- **[loose-end] Last-minute staffing parity gap in Stripe full-payment webhook** — `checkout.session.completed` 'full' branch settles paid-in-full but does NOT fire last_minute_hold + notifyLastMinuteBooking; admin link for <72h event leaves staff uncovered. You skipped fixing in the deploy push. (2026-06-08, 2026-05-31_b22d68eb)
- **[loose-end] stripe.js needs deliberate split (1,720 lines)** — overdue for `server/routes/stripe/` per-concern split. Webhook handler extraction now owns the deferred PI balance-branch guard hardening + real webhook amount_paid test harness; audit found Batch 3a additions will be blocked by the ratchet so this is load-bearing. (2026-06-08, 2026-05-31_b22d68eb / 2026-06-05_8568c5f4)
- **[loose-end] mergeClients ships unwired** — when a route adopts it, MUST be admin-gated + activity-logged + confirmation-guarded. (2026-06-08, 2026-05-31_b22d68eb)
- **[deferral] amount_paid vs captured-amount check (pre-existing)** — Stripe webhook sets `amount_paid = total_price` on settle without checking `session.amount_total` matches. Assigned to the price-increase plan doc, not yet fixed. (2026-06-08, 2026-05-31_b22d68eb)
- **[deferral] Status demotion covers balance_paid but not confirmed (price-increase)** — only handles `balance_paid → deposit_paid`; revisit if a confirmed proposal can be price-raised. Note: client-portal #5 / Decision A means confirmed bookings stay confirmed on over-paid edits, which partly closes this but doesn't address all paths. (2026-06-08, 2026-05-31_b22d68eb)
- **[loose-end] unsubscribePush placeholder ships unused (Web Push v1)** — wire a 'remove this device' action or delete next ticket. (2026-06-08, 2026-05-31_b22d68eb)
- **[idea] PWA manifest needs 192/512 icons + notificationclick startsWith** — Web Push polish, not blocking. (2026-06-08, 2026-05-31_b22d68eb)
- **[deferral] Payouts LIMIT + /ytd endpoint deferred** — 18-months-out scale issue on a money path; database-review rated query clean today. (2026-06-04, 2026-06-01_16edd9ce)
- **[deferral] Staff portal dedup refactors (shared isOnFile, copyToClipboard, icons)** — pure cleanup deserves its own focused pass. (2026-06-04, 2026-06-01_16edd9ce)
- **[loose-end] Phase 3 + Phase 4 of staff payment system not started** — Phase 3 (staff My Pay page) and Phase 4 (notifications, paystub PDF — DONE separately, 1099) have no plan and no code. (2026-05-27, 2026-05-27_d2b4f1a2)
- **[loose-end] BEO project: 33-task plan ready, zero code** — `beo` worktree has 9 documentation commits + 7 rounds of fleet review. (2026-05-27, 2026-05-27_d2b4f1a2)
- **[loose-end] BEO worktree still has unmerged staff-portal/payment work (Phases 6-8)** — 16 unmerged commits in beo; Phases 9/10/11 still ahead. Only worktree with genuinely unfinished work. (2026-06-01, 2026-06-01_dcf105f4)
- **[deferral] 1099 generation deferred from staff payment v1** — ledger keeps YTD totals exportable; 1099 output earns its own pass. (2026-05-22, 2026-05-22_2ebac561)
- **[open-question] Contractor agreement v3 re-sign decision** — staff payment changes pay terms in Field Guide/PaydayProtocols, but signed contractor-agreement-v2 lags. Materially-changing pay terms means v3 + decision on whether already-signed contractors must re-acknowledge. (2026-05-22, 2026-05-22_2ebac561)
- **[loose-end] Pre-existing paypal_url rows audit** — backwards-compat read-side defense added; one-time prod audit/cleanup never run. (2026-05-08, 2026-05-08_a88989b6)
- **[loose-end] Split server/routes/admin/users.js (817 lines, over soft cap)** — natural cleavage points: per-contractor tip routes, seniority routes, user CRUD. (2026-05-08, 2026-05-08_a88989b6)
- **[loose-end] Shift #31 (Ketan event) still open after past event date** — surfaced during Wave 3 refunds verification; unrelated to books but a real past unstaffed open shift in admin. (2026-05-17, 2026-05-17_387c83ef)
- **[loose-end] Ketan Patel manual repair scripts to run post-deploy** — `backfillProposal54DepositInvoice.js` + `repairProposal54Balance.sql`. Run-once, idempotent, guarded; never confirmed run. (2026-05-18, 2026-05-18_ac26410e)
- **[open-question] Deposit invoice gap — first-post-cutover bookings skip createInvoiceOnSend** — Ketan's symptom; open question whether other early bookings have the same shape. (2026-05-17, 2026-05-17_e4ded85d)
- **[loose-end] Pre-hire email-conflict edge case** — pre-hire who already has an account hits the application gate; workaround is admin Hire button. Documented as accepted compromise. (2026-05-12, 2026-05-12_7f5a8111)
- **[open-question] Auto-claim on /onboarding is silent (no confirmation UI / activity_log)** — phishing link to /onboarding auto-flips any logged-in user's pre_hired=true with no confirmation. Real harm small; suggested but out of scope. (2026-05-12, 2026-05-12_7f5a8111)
- **[loose-end] Onboarding manual verification checklist for optional tip handles** — needs hands-on app verification (Check payout no handles finishes, Venmo payout blank still blocks, Direct deposit + optional Venmo tip handle works, /my-tip-page Cash App save). (2026-05-17, 2026-05-17_ad227221)
- **[deferral] Two Phase 2 known-gap follow-ups** — late-tip roll-forward to a frozen period (spec 6.5), and refunded/disputed tip after paid (spec 11) admin-alert design. (2026-05-22, 2026-05-22_2ebac561)
- **[loose-end] Multi-admin mark-paid race could stick period in 'processing'** — fix is in Phase 2 plan (lock parent period row); verify it actually landed in execution. (2026-05-22, 2026-05-22_2ebac561)
- **[deferral] M3 tip-assign admin ownership tightening** — admin can assign tip to any shift; tightening to 'only target_user_id approved' would be UX regression. Deferred for product discussion. (2026-05-26, 2026-05-26_bc9f3743)
- **[deferral] L9 findOpenPeriodForDate non-locking race** — low race window, non-blocker. (2026-05-26, 2026-05-26_bc9f3743)
- **[loose-end] Specialty alcohol addons mislabeled applies_to:'all' for BYOB** — fixed in commit dab99b2, but pre-dated the extras-redesign; worth knowing other applies_to drift may exist. (2026-05-22, 2026-05-22_0e969edb)
- **[loose-end] Dev pay_period stuck in 'processing' makes 5 payrollAccrual tests skip** — refactor test to manage its own pay_period rather than depend on shared dev DB state. (2026-05-27, 2026-05-27_f308cf0a)

### TRACKED / LIKELY-DONE
- Partial refunds feature (Wave 1+2+3) shipped 2026-05-17 — Ketan's prod data reconciled
- Payment-failed throttle changed to per-proposal (commit #16) 2026-05-22
- Last-minute booking policy SHIPPED (memory says STALE-deferred but code is on main)
- Refund-status reconciliation fix dd88e72 (clears autopay_enrolled only on balance_paid→deposit_paid)
- Paystub PDF pipeline SHIPPED 2026-06-05 (memory)
- Checkout gratuity Project B shipped to main/prod 2026-06-05 (memory)
- Manager-toggle permissions framework — Dan floated as future, idea-only (2026-06-09)
- Lateness policy, cash/Venmo/CashApp honor-system, Stripe fees pass-through to staff, payday = 'second working day of week', mark-paid binary, late-tip roll-forward/clawback, dispute-won admin email — all decisions LIKELY-DONE in Phase 2 plan (2026-05-22)
- Stripe webhook deposit branch missing payment_type='deposit' — fixed e04b48a
- Stale payment-link not deactivated on window shift — fixed e04b48a
- Payment-link button bypassed booking-window policy — fixed 2026-06-03
- Sentry A and 2 intentionally not-fixed
- Class packages exempt from 1:100 charge (bf7793f)
- Pre-existing W11 race fix (FOR UPDATE + locked-row dispatch)

---

## comms

### OPEN

- **[open-question] D1: email-harvest also covers CC-import placeholders** — Batch 5 decision point; Claude leans 'both' (Thumbtack-only is the alternative). (2026-06-09, 2026-06-09_8b5b0547)
- **[open-question] D2/D3: drop notifications_opt_in + thumbs-up Bucket 2 wirings** — drop signup checkbox that lies; thumbs-up on equipment_required picker, gratuity_rate_change_origin display, sms_messages.metadata, old duplicate agreement columns. (2026-06-09, 2026-06-09_8b5b0547)
- **[deferral] Sent-messages log feature (spec'd + plan-reviewed, message-log worktree)** — execution intended in a separate window; verify it ran. v1 stores Resend message id for later Delivered/Bounced/Opened retrofit. (2026-06-05, 2026-06-05_355a91af)
- **[loose-end] Dispatcher near 1000-line cap; planned split** — scheduledMessageDispatcher.js at ~998 lines after Fix 3. (2026-06-01, 2026-06-01_e07fc331)
- **[loose-end] qLostValue accounting filter for auto-archival** — metricsQueries.js will start counting archive_reason='event_completed' as lost revenue once auto-archival ships; needs the filter at that time. (2026-05-25, 2026-05-25_e0f7109d)
- **[loose-end] Smoke tests for new SMS hooks never executed end-to-end** — 2a/2b/Phase 2/Phase 3 dispatcher heartbeat, sign+pay orientation, .ics open, drink-plan submit, STOP/START, CONFIRM/CANT, duplicate MessageSid idempotency, prod Twilio signature. (2026-05-25, 2026-05-25_e0f7109d)
- **[open-question] Stripe-Dashboard-refund coverage gap (no client email)** — dashboard refunds reconcile but never send client email. Spec-scope call. (2026-05-21, 2026-05-20_a8733f2c)
- **[loose-end] Plan 2a hard-coded 60-min orientation setup time** — flagged as V1 simplification; logged for follow-up. (2026-05-21, 2026-05-21_a59e141c)
- **[deferral] Self-service comm-preferences page** — Section 12 open item, low-stakes, no blocker. (2026-05-26, 2026-05-26_57029519)
- **[deferral] Phase 5/6 comms blocked on infra** — Cal.com webhook (partially unblocked now), Thumbtack auto-proposal + Playwright harvester, BEO finalized notif, staff review-forward, AI responder routing. (2026-05-26, 2026-05-26_57029519)
- **[deferral] M5 markPhoneStatusFromSmsResult unwired** — future-ready util for Phase 4c Twilio status-callback work. (2026-05-26, 2026-05-26_bc9f3743)
- **[idea] AI responder for staff SMS** — would replace today's Phase 2 admin-email route. (2026-05-25, 2026-05-25_568104a2)
- **[idea] Google Reviews monitoring + staff review-forward** — backlog. (2026-05-25, 2026-05-25_568104a2)
- **[idea] Newsletter + seasonal marketing campaigns** — backlog. (2026-05-25, 2026-05-25_568104a2)
- **[loose-end] Comms spec §11 backlog (12 deferred workstreams) intact** — BEO, staff payment (partly done), Cal.com self-hosted, Thumbtack harvester, office box, Google Reviews, multi-bartender tipping, referral, admin permissions, AI staff SMS responder, marketing campaigns, contractor onboarding audit; plus §12 still-open design questions (AI responder timing, multi-bartender tip handling, self-service preferences UX). (2026-05-21, 2026-05-21_c20b59fb)
- **[loose-end] Pre-existing unsafe ROLLBACK pattern in routes outside the fix batch** — H3 sweep found additional cases; left to avoid scope creep. (2026-05-26, 2026-05-26_bc9f3743)
- **[loose-end] Resend transactional emails not DB-logged** — only marketing `email_sends` is keyed by lead_id; audit needs Resend dashboard. (2026-05-31, 2026-06-01_5b956a5c)
- **[open-question] Twilio + Resend dashboards needed to identify what burned the quota** — DB tables nearly empty during the burn; the culprits live outside DB-tracked send paths. (2026-05-27, 2026-05-27_f308cf0a)

### Phase 5/6 / Stage 4 design decisions captured but not yet built

These are LOCKED design decisions, mostly in comms spec / Plan 1, that still need implementation:

- **[decision] Last-minute bartender confirmation notification** — only for <72h bookings; one-shot, no auto-update on swaps. (2026-05-17)
- **[decision] Sentiment-routed post-event review (mirrors tip QR flow)** — T+2 page mirrors tip-flow sentiment split; copy must NOT telegraph branching. (2026-05-17)
- **[decision] Retention nudge restricted to repeat-likely event types** — holiday/birthday/corporate/anniversary only; not weddings, etc. (2026-05-17)
- **[decision] New Year far-future retention message** — for bookings made calendar year prior with event ≥60 days after Jan 1. (2026-05-17)
- **[decision] Stale Thumbtack lead archive policy** — auto-archive past-event with no signed proposal, or admin click. Daily cron. (2026-05-17)
- **[decision] Cancellation/unassignment notice = admin-discretion toggle** — sometimes Dan wants to call personally. (2026-05-17)
- **[decision] Reschedule flow (separate from cancellation)** — moves event_date, balance_due_date, scheduled messages forward. (2026-05-17)
- **[decision] Time zones — every event gets event_timezone field** — schedule in event TZ, convert to UTC for scheduler. (2026-05-17)
- **[decision] Notification overlap priority ladder + 1/channel/client/day max** — lower-priority touches push 1 day. (2026-05-17)
- **[decision] Communication preferences self-service page** — orientation email footer carries link; defaults both on. (2026-05-17)
- **[decision] Delivery failure fallback rules** — hard bounce → flag bad, fall back to SMS, alert admin; both bad → admin alert. (2026-05-17)
- **[decision] STOP keyword TCPA compliance gap** — promoted in-scope; both client + staff senders; communication_preferences.sms_enabled. (2026-05-17)
- **[decision] Drip cadence 5-touch from Check Cherry** — +1d, +7d, +10d, +14d, +21d hybrid email/SMS. (2026-05-17)
- **[decision] Voice convention — SMS opens 'Hi, Dallas here'; email closes 'Cheers, Dallas'** — staff messages use system-style voice. (2026-05-17)
- **[decision] Setup time language: loose for clients (30-90 min), exact for staff** — staff get scheduled time, no wiggle room. (2026-05-17)
- **[decision] Response codes CONFIRM/CANT only for staff SMS** — extensible to HELP/ETA later. (2026-05-17)
- **[decision] Inbound client replies forward to Dan's inbox** — urgent / real-time admin notification. (2026-05-17)
- **[decision] Drink plan nudge suppression: selections OR consult_filled_at IS NOT NULL** — mechanism exists today, no new schema needed. (2026-05-17)

### TRACKED / LIKELY-DONE
- All Phase 1, 2a-d, two-way SMS, Phase 3 client SMS, Phase 4a staff SMS, Phase 4b infra — memory says merged in main as of 2026-05-25
- Two-way SMS inbound turned on in prod 2026-06-08 (memory)
- SMS phone routing hardening (memory)
- Dispute-email-retry-bailout shipped during Round-4 review
- Email reply-to → ADMIN_EMAIL default across client-facing mail
- Channel fallback rule (opted-out → use other channel)
- Status enum 'cancelled' → 'archived' with archive_reason
- Unified scheduled_messages table keyed per-recipient-channel
- Touch 2.2 last-minute staffing notification (shipped via last-minute-staffing worktree)
- Codex finding deferral: payrollLateTip skip-target on mixed shifts — merged 2026-05-28
- Email-quota dispatcher 3c re-enqueue moot (skipped 2026-06-01)
- Four dead 'SUPPRESS:' gates folded in (2026-06-01)
- L2 self-DoS dispute-email bailout shipped
- Resend Pro upgrade (TRACKED in memory project-resend-quota.md)

---

## client-portal

### OPEN

- **[loose-end] Client portal v2 #1 money-flow reskin not done** — InvoiceDropdown `--ok-h`/`--danger-h` HSL tokens scoped to staff-v2 may not resolve on public dashboard; #1 invoice-skin reconcile against design handoff still pending. (2026-06-05, 2026-06-05_366899f6)
- **[deferral] Client portal v2 #4 Day-of brief slot pending** — decisions captured (preferred name + headshot + 'subject to change', no phone/messaging, 30-90 min generic arrival), build pending. (2026-06-05, 2026-06-05_366899f6)
- **[deferral] Client portal v2 deferred sub-projects #7/#8/#9** — multi-event switcher, quote-resume, in-portal sign/pay/lab actions. Track in client-portal-v2-project.md. (2026-06-04, 2026-06-01_3faa8c4c)
- **[deferral] Embed potion-lab in portal tab (vs link-out)** — follow-on; potion lab is the only non-money action that could reasonably be brought in sooner. (2026-06-04, 2026-06-01_3faa8c4c)
- **[deferral] Archive list LIMIT not added (no client history truncation)** — open question: at what point does over-long archive justify LIMIT + pagination? (2026-06-04, 2026-06-01_3faa8c4c)
- **[loose-end] ProposalPricingBreakdown's hardcoded `#sign-pay-section` scroll button** — works around by NOT reusing it in Prescription tab, but the surface-coupled assumption remains. (2026-06-04, 2026-06-01_3faa8c4c)
- **[idea] PortalHome could prefetch detail to extend dedup** — missed optimization, not a regression. (2026-06-05, 2026-06-05_6b8e530b)
- **[idea] Client portal Menu + Messages advertised but don't exist** — login page advertises Proposal/Menu/Payments/Messages; Menu (Potion Lab) and Messages aren't there. Natural expansion slots. (2026-06-01, 2026-06-01_cd160002)
- **[idea] Proposal detail endpoint returns more than dashboard shows** — richer dashboard or in-portal view needs almost no new backend. (2026-06-01, 2026-06-01_cd160002)
- **[deferral] Full SyrupPicker reskin moves to client portal project** — wizard reuses existing SyrupPicker as-is in new tile. (2026-05-22, 2026-05-22_0e969edb)
- **[loose-end] Client portal Case Files redesign — 4 tab stubs need real design passes** — only shell + Case Files list + Overview tab designed; Prescription, Potion Plan, Big Experiment, Receipts, Account are stubs. (2026-05-22, 2026-05-22_371cd714)
- **[open-question] Two converging redesign tracks (portal vs money-flow reskin)** — portal wraps existing surfaces while money-flow reskin independently restyles them. Open: which ships first, replace/embed/link. (2026-05-22, 2026-05-22_371cd714)
- **[idea] 'The Big Experiment' tab — only genuinely new portal surface** — day-of brief (bartender, arrival, load-in). (2026-05-22, 2026-05-22_371cd714)
- **[loose-end] Client portal dashboard mobile audit limited to manual QA** — /my-proposals can't be runtime-audited without storage-state handover. (2026-05-19, 2026-05-15_e1a4b66a)
- **[open-question] Improve client contract language via Claude Cowork** — text extracted from ProposalPricingBreakdown.js:81-157 for Cowork redraft; pending swap-back into JSX. (2026-05-15, 2026-05-15_8b1167a4)
- **[loose-end] client-portal-design-refs.md untracked working artifact** — won't be swept into a commit unless staged explicitly. (2026-05-22, 2026-05-22_371cd714)
- **[loose-end] Pre-existing 'accepted before charge' sequencing bug** — sign/accept fires before Stripe confirmPayment, so declined card still produces 'accepted' toast and signed proposal. Real product issue. (2026-05-15, 2026-05-15_7013cf3b)

### TRACKED / LIKELY-DONE
- v1 foundation + #5 editing model SHIPPED 2026-06-05 (memory)
- Decision A: confirmed booking stays confirmed on over-paid edit (memory)
- Editing model trajectory: v2 = one-click apply, v3 = self-serve option A (decision locked 2026-06-05)
- Date + venue moved to structured client edits (2026-06-05)
- Drink-plan LEFT JOIN → LATERAL fan-out safety
- Procedure timeline kept in v1 (not deferred)
- Signature history table deliberately not built (model B is the consent record)
- Token = bearer credential decision; no revoke for v1
- Money units: proposals dollars / invoices+payments cents — captured to memory
- Status taxonomy 'cancelled' → 'archived' + archive_reason — captured to memory
- Task 14 InvoiceDropdown moot after Task-12 cutover

---

## redesign

### OPEN

- **[loose-end] C1 admin sidebar not responsive (biggest pending mobile remediation)** — fixed 220px columns, no hamburger; crushes admin pages to ~140-194px on phones. Batch 4 not started. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] Mobile remediation Batches 5-8 not started** — tablet-band 768-1024 collapse (5), 4 standalone Highs (6), post-C1 residual mobile (7), Med/Low cleanup (8). (2026-05-19, 2026-05-15_e1a4b66a)
- **[deferral] C2e settings dark-theme contrast** — SettingsDashboard has dozens of inline var() calls that inline-beats-CSS makes hard to fix. Most structurally sprawling. (2026-05-19, 2026-05-15_e1a4b66a)
- **[open-question] Three out-of-scope contrast findings logged** — House Lights muted (~4.22) + danger (~2.56), adminos-dark `--ink-4` labels (~2.78), `.btn-success` 'On' (~1.19) on dark. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] House Lights muted/danger button polish parked** — ~4.22 muted, ~2.56 danger; needs polish pass to bump light `--ink-3` ≥4.5. (2026-05-19, 2026-05-15_e1a4b66a)
- **[deferral] Resume-banner gating deferred** — logic change to draft/resume flow, not cosmetic. (2026-05-19, 2026-05-15_e1a4b66a)
- **[deferral] Drink plans 'All18' chip spacing deferred** — chip render isn't in DrinkPlansDashboard. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] Staff portal mobile audit blocked** — needs valid local staff creds + staff.localhost host-spoof, or manual on real staff subdomain. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] ui-ux-review agent maxTurns:25 blocks multi-viewport runs** — needs manual bump before next ui-ux-review run. (2026-05-19, 2026-05-15_e1a4b66a)
- **[open-question] Settings page: lean-honest vs integrations status board** — two-card (Auto-Assign + Calendar Feed) vs read-only Integrations status board with green/yellow/red dots. Direction not locked. (2026-05-20, 2026-05-20_ecbf59b4)
- **[idea] Cocktail Menu page needs its own redesign** — 933-line CocktailMenuDashboard nearing cap, double-mounted, 90% duplicate code between Cocktails/Mocktails. Pull out of Settings entirely. (2026-05-20, 2026-05-20_ecbf59b4)
- **[idea] Auto-assign weights UX wart** — two number inputs with 'should sum to 1.0' is math homework; natural shape is single slider. (2026-05-20, 2026-05-20_ecbf59b4)
- **[idea] Editable env-shaped settings** — deposit amount, admin SMS phone, notification email. Net-new backend (settings table). (2026-05-20, 2026-05-20_ecbf59b4)
- **[deferral] Standard Menu auto-generation carve-out** — 8x10 PDF/preview, logo upload, IM Fell font embedded. Follow-up project after planner reskin. (2026-05-20, 2026-05-19_b327b5ad)
- **[deferral] Hosted package alignment carve-out** — hosted-package copy/queues are placeholder; needs dedicated brainstorm. (2026-05-20, 2026-05-19_b327b5ad)
- **[loose-end] Apothecary redesign surface backlog** — fully-old: ClientShoppingList, ConfirmationStep, ShoppingListModal; palette-correct no structural pass: BlogPost, QuoteWizard step files, ClassWizard, PotionPlanningLab, SignAndPaySection. (2026-05-17, 2026-05-17_1eff3abf)
- **[deferral] Apothecary contrast + toggle touch-targets for design pass** — low-contrast muted labels, 56px toggle touch-targets; deferred to design pass. (2026-06-04, 2026-06-01_16edd9ce)
- **[idea] Extras step apothecary reskin (extras-design worktree)** — visual polish only on `.wz-addon-*`. Open at session end. (2026-05-22, 2026-05-22_9e8c2caa)
- **[loose-end] Manual proposal overhaul: crud.js split candidate** — 946 lines; safeAddonQty triplicated across crud.js/public.js/metadata.js; PATCH /:id lacks strip/validate gate. (2026-05-20, 2026-05-20_43d3671d)
- **[loose-end] Manual proposal overhaul: addon_ids numeric coercion follow-up** — string id silently drops the addon; fail-safe today. (2026-05-20, 2026-05-20_43d3671d)
- **[loose-end] Edit-form quantity parity: lift to shared AddonControls** — keeps create + edit forms from drifting. (2026-05-20, 2026-05-20_43d3671d)
- **[loose-end] Deferred QuoteWizard live-preview perf optimizations (W1/W2/W3)** — memoize stable args, useRef for inflight controller, derived-state hoist. (2026-05-26, 2026-05-26_bc9f3743)
- **[loose-end] BundlePicker hardcodes 'popular' to 'the-foundation'** — make data-driven later. (2026-05-26, 2026-05-26_bc9f3743)
- **[idea] --amber CSS token is actually teal** — `--amber` set to `#1D8C89` ('Deep Apothecary Teal'); rename or comment so design sessions don't go orange. (2026-06-01, 2026-06-01_cd160002)
- **[idea] No admin UI to edit service_addons descriptions** — live copy historically set via ungated schema.sql UPDATEs. Latent feature gap. (2026-06-09, 2026-06-09_c215ef12)

### TRACKED / LIKELY-DONE
- Per-surface redesign prompt pattern formalized — captured to memory
- Manual proposal overhaul shipped via batched review push (2026-05-20)
- ShoppingListModal + PDF + client page redesign shipped (c0eee58)
- Catch-all 'anything else?' card on Confirmation step
- After-submit roadmap footer copy
- 'Standard Menu' renamed (rejected 'House Style'); 8x10 portrait spec for Claude Design
- Beer/wine uses category labels not brand names
- Logo upload corporate-appeal feature decision
- Potion Planner reskin (commit batch)
- Pre-booking drink plan removal SHIPPED via drink-plan post-booking refactor
- CocktailMenuDashboard 'unrouted'-not-actually — renders as Settings → Drink Menu tab (2026-06-09)

---

## infra / process

### OPEN

- **[loose-end] Audit batch plan saved as local untracked doc** — commit `docs/superpowers/plans/2026-06-09-audit-findings-batch-plan.md` before it's lost. (2026-06-09, 2026-06-09_8b5b0547)
- **[loose-end] Local axios 1.17 sync after merge** — `npm install --prefix client` in os when no build is running. (2026-06-09, 2026-06-09_8b5b0547)
- **[decision] Vite migration as its own project** — locked but not started; currently accept-and-document 15-16 CRA-tied HIGH advisories. (2026-06-09, 2026-06-09_8b5b0547)
- **[idea] Manager-toggle permissions framework** — Dan: 'one day i will want a few different manager toggles for different things.' Not scoped. (2026-06-09, 2026-06-09_8b5b0547)
- **[open-question] Two-step destructive DROP COLUMN safety** — code-stops-using-first, sit a day, drop. Confirmation never captured for the Batch 5 drops. (2026-06-09, 2026-06-09_8b5b0547)
- **[loose-end] Pre-push agent budget exhaustion pattern** — consistency-check / database-review / plan-fidelity / plan-feasibility return narration instead of verdicts on big batches. Memory captures workaround; worth a durable fix. (2026-06-09, 2026-06-09_8b5b0547)
- **[loose-end] Codex CLI --base + prompt incompatibility** — full-audit skill ships an invocation broken on codex-cli 0.135.0; arch sweeps errored. (2026-06-09, 2026-06-09_8b5b0547)
- **[open-question] backup/os-stale-merge — drop when beo settles** — deliberate safety branch; Dan's call. (2026-06-09, 2026-06-09_2e97a91f)
- **[idea] Thread-mining harvest of 136 transcripts** — Dan greenlit enthusiastically; this is the deliverable. (2026-06-09, 2026-06-09_2e97a91f)
- **[idea] /capture command to stop the bleed** — distill a wrapped thread's decisions/deferrals into the ledger in one keystroke; floated, not yet built. (2026-06-09, 2026-06-09_2e97a91f)
- **[loose-end] Stale worktrees still to clear** — client-portal-editing, comms (4 untracked), cal-com cleanly removable; cc-import has uncommitted spec+plan (worth rescuing); beo stays. (2026-06-08, 2026-06-08_55127c54)
- **[loose-end] Two os-root scratch handoffs (handoff.md, handoff.beo.md)** — preserved off main; delete-or-leave question never closed. (2026-06-05, 2026-06-05_8568c5f4)
- **[loose-end] Office box Ubuntu install in progress** — SSH and foundation walkthrough not finished. Blocks self-hosted Cal.com + Thumbtack harvester + calendar-entry enrichment. (2026-05-27, 2026-05-27_311e09bc)
- **[deferral] Office-box trio (Cal.com self-hosted, Thumbtack email harvester, always-on box)** — bundle deferred until hardware setup. (2026-05-25, 2026-05-25_568104a2)
- **[loose-end] Rotate local Postgres password ([REDACTED — see commit 885b074])** — leaked in pre-rebase commit 885b074, never confirmed rotated. (2026-05-14, 2026-05-14_1a9d7e07)
- **[open-question] Self-modification permission classifier blocked editing settings.local.json** — workaround required user manually editing. Edits to permission files are blocked even when reducing scope. (2026-05-14, 2026-05-14_1a9d7e07)
- **[loose-end] Codex CLI cannot combine --base with custom prompt** — `--uncommitted` is the only mode that accepts steering prompts; committed-batch cross-LLM reviews lose steering. (2026-05-08, 2026-05-08_a88989b6)
- **[loose-end] Recover lost lab-rat tester bug submissions** — email/SMS the testers to recover anything they remember. Never executed. (2026-05-10, 2026-05-10_c34d81ef)
- **[idea] Optional admin_audit_log (actor_user_id, created_at DESC) index** — for an 'actions by admin X' view. (2026-05-10, 2026-05-10_c34d81ef)
- **[deferral] Tighter screenshot host allowlist meaningful only once uploader exists** — `LABRAT_SCREENSHOT_ALLOWED_HOSTS` is defense-in-depth. (2026-05-10, 2026-05-10_c34d81ef)
- **[open-question] consistency-check agent stalls mid-investigation on large batches** — recurring; reliable on big diffs. (Memory captures workaround; structural fix open.) (2026-05-22, 2026-05-22_08830059)
- **[loose-end] Dev nodemon stuck on Windows — needs manual node respawn** — recurring annoyance, not a one-off. (2026-05-14, 2026-05-14_c9f58dad)
- **[loose-end] nodemon watches repo root — temp .js scripts trigger restarts** — narrow watch path or always use gitignored subdir. (2026-06-01, 2026-06-01_6324be3c)
- **[loose-end] eslint.config.mjs reaches into client/node_modules** — forces every worktree to junction client/node_modules. Fragile coupling. (2026-05-21, 2026-05-21_9bc0d7f2)
- **[loose-end] worktree-workflow-handoff.md left untracked after cutover** — prep doc no longer needed. (2026-05-21, 2026-05-21_9bc0d7f2)
- **[loose-end] cc-import spec + plan docs in worktree never committed** — 2026-05-25 design + 2026-05-26 plan; never merged. (2026-05-27, 2026-05-27_456d4d91)
- **[deferral] Cal.com rate limiter placement vs express.raw middleware** — limiter after raw means attacker can buffer to body-cap before 429. Bandwidth-only. (2026-05-27, 2026-05-27_456d4d91)
- **[open-question] Cal.com trust proxy setting needs verification** — `app.set('trust proxy', 1)` if behind multi-IP LB; otherwise rate limiter becomes global. (2026-05-27, 2026-05-27_456d4d91)
- **[open-question] Prod Neon checks: source enum + email partial UNIQUE** — verify out-of-enum source values won't abort next VALIDATE CONSTRAINT; confirm partial UNIQUE on clients(LOWER(email)) exists. (2026-05-27, 2026-05-27_456d4d91)
- **[deferral] handleCreated Cal.com tenant-scope sock-puppet defer** — non-blocking, admin-loop mitigated. (2026-05-27, 2026-05-27_456d4d91)
- **[deferral] Pool max=10 bump + parallelize handleCreated reads + breadcrumb on orphan-consult INSERT** — non-blocking. (2026-05-27, 2026-05-27_456d4d91)
- **[deferral] Reschedule UPDATE consolidation + parallelize SELECTs in notify** — non-blocking; skipped to ship Touch 2.2 cleanly. (2026-05-27, 2026-05-27_456d4d91)
- **[idea] Optional RUN_SCHEDULERS=true env var on Render** — defense-in-depth so misconfigured NODE_ENV can't silently disable schedulers. (2026-05-27, 2026-05-27_f308cf0a)
- **[loose-end] crud.test.js not parallel-safe (global COUNT)** — needs `--test-concurrency=1` for node --test across DB-touching files. (2026-05-22, 2026-05-22_08830059)
- **[loose-end] PowerShell deny rule has subagent gap** — exploration subagent tripped policy warning by using PowerShell cmdlets via Bash. (2026-05-22, 2026-05-22_2ebac561)
- **[loose-end] File-size soft-cap files needing real refactor** — emailTemplates.js (974), QuoteWizard.js (796). (2026-05-25, 2026-05-25_e0f7109d)
- **[open-question] Stray Neon project 'round-tooth-34649976' needs identifying** — confirm yours (rename/keep) or stray to delete. (2026-05-25, 2026-05-25_e0f7109d)
- **[loose-end] GOOGLE_PLACES_API_KEY missing from local .env** — degrades venue search to plain text input locally. (2026-05-25, 2026-05-25_e0f7109d)
- **[loose-end] Pre-existing proposals_status_check quadruple-definition** — 4 non-transactional CONSTRAINT definitions; rare 1-in-16 dispatcher-test flake. (2026-05-21, 2026-05-20_a8733f2c)
- **[open-question] Bash auto-backgrounding breaks long-running test commands** — recurs; hand-off pattern needed. (2026-05-26, 2026-05-25_e0f7109d)
- **[loose-end] Foreign committed files in working tree from parallel sessions** — surfaced during C2c + plan-doc; workflow safeguard needed against silent sweep. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] Audit folder commit decision pending** — `.claude/mobile-audit-2026-05-15/` untracked. (2026-05-19, 2026-05-15_e1a4b66a)
- **[loose-end] Restore Neon branch br-morning-union-ad26nq4r still live** — kept as safety net post-Check Cherry scrub; awaiting explicit delete cue. (2026-05-16, 2026-05-15_ecc34c2b)

### TRACKED / LIKELY-DONE
- Per-suite test isolation is the real signal (vs full-suite green)
- schema.sql initDb() runs on every server boot — constraint widenings go live in dev immediately
- Workflow change: os window can drive worktrees directly (memory)
- /codex-review risk-areas preset added
- Money/auth = Gemini AND Codex by habit
- Subagents always use opus (memory)
- Schedulers gated on NODE_ENV=production (Resend burn fix)
- Codex on Windows: sandbox bypass + base origin/main + patience (memory + 2026-05-27_f308cf0a)
- Gemini --yolo mode wrote unauthorized code → use --approval-mode plan
- Pre-push hook (Option B): real CI=true react-scripts build when client/ changes (da2c38c)
- 100 commits unpushed on local main pre-worktree cutover — likely shipped in giant push
- Big-batch agent review ceiling: ~25-30 mixed-scope clean, ~50 workable, 150+ only if tightly scoped
- Linux dev box migration (TRACKED in memory)
- Where-am-I banner via SessionStart hook landed
- Tiered review scheme Tier 0/1/2 for subagent execution
- Plan-execution review cadence scaled by task complexity (memory)
- 'os' window can drive worktrees decision (memory)
- File-size ratchet shipped (commit + old shell .husky/check-file-size.sh removed)
- Coordination pattern for parallel money projects (rollup → refunds → recon)
- ultracode vs max effort distinction clarified
- Resend Pro upgrade pending (memory)
- Cal.com webhook secret sanity check post-deploy
- Stale empty worktree folders locked by Windows (memory)
- Computation-throw test design: pool-level mock too fragile
- fe9b701 commingled commit accepted as cosmetic
- consistency-check verdict-failure pattern persisted to memory
- Statusline only loads at session start
- Self-modification permission classifier behavior recorded
- 4 parallel-session Sentry fix commits (SERVER-Z/10/R, CLIENT-4) rode along on push — Dan never asked for post-hoc skim

---

## cc-import

### OPEN

- **[loose-end] cc-import v2 corrective rebuild not started** — v1 produced client-facing errors; v2 specced (untracked in worktree). (2026-06-01, 2026-06-01_dcf105f4)
- **[loose-end] cc-import importer spec + plan only in worktree** — `docs/superpowers/specs/2026-05-25-checkcherry-import-design.md` + `plans/2026-05-26-checkcherry-import.md` uncommitted + untracked `2026-05-30-cc-importer-v2-design.md` loose in os. Delete the worktree and they're gone. (2026-06-08, 2026-06-09_2e97a91f)
- **[open-question] Phase 0: download W9s/resumes from Wix before sunset** — tax-record insurance; ~10 min of work; not yet run. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] Backup CC event Gallery URLs + Video URLs before sunset** — Wix-side storage 404s when CC sunsets. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] Drink plans for upcoming Confirmed CC events recreated manually** — ~30-60 future events being promoted; you recreate in DRB OS per event. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] Per-event line items lost for past, recreate for upcoming** — accepted loss for past; recreate inside DRB OS for upcoming. (2026-05-25, 2026-05-24_494fcdc2)
- **[decision] Staff role auto-derive from CC payout history** — bartender/server/barback. Not yet implemented. (2026-05-25, 2026-05-24_494fcdc2)
- **[decision] Staff active/inactive heuristic at import, manual cleanup** — recent Wix submission = active. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] Staff hourly rates entered post-import** — blank/default at import, you fill inside DRB OS. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] Wix-to-CC staff matching imperfect for pre-form contractors** — anyone in payouts but not Wix forms imports as legacy contractor with name + payout only. (2026-05-25, 2026-05-24_494fcdc2)
- **[loose-end] ClientDrawer/ClientDetail/ClientsDashboard SOURCE maps include 'instagram'** — display-only drift; not in server enum or schema CHECK; would be rejected at write. (2026-05-27, 2026-05-27_456d4d91)

### TRACKED / LIKELY-DONE
- Three event buckets locked: Confirmed+future native, Confirmed+past completed-suppressed, Proposal/Cancelled/Expired archive table only
- Wrap-up comms: bulk action page (Q1.b)
- Dedup: email-only normalized (Q2.a)
- Skip weird admin-entry events Inventory/MGM/Bartending Services (Q3.a)
- Accepted data losses: refund reasons, comms history, signed contract PDFs, drink plans, per-event tip breakdown
- Twilio history dump + Gmail signature scrape — both moot once report (9) found phones
- Per-event staff assignment history mostly lost

---

## thumbtack

### OPEN

- **[idea] Thumbtack auto-draft: fully automate one day** — architected so scheduler can flip auto-draft to auto-send without rewriting money path. (2026-06-05, 2026-06-05_a2148f89)
- **[deferral] Playwright email-harvester on Linux box** — server-side state machine + `/email-harvested` endpoint + manual paste/text-back ready to build now; scraper later. (2026-06-09, 2026-06-09_8b5b0547)
- **[loose-end] Capture Thumbtack login session before going headless** — log in once in visible browser so Playwright saves session to auth.json; sessions expire and need periodic re-capture. (2026-06-09, 2026-06-09_8b5b0547)
- **[idea] Thumbtack auto-proposal email harvester (Playwright)** — designed local browser-automation harvester (the office-box-blocked version). (2026-05-17, 2026-05-17_55541813)

### TRACKED / LIKELY-DONE
- Auto-draft project merged + live 2026-06-05 (memory); 4 post-launch fixes on thumbtack-autodraft branch awaiting re-merge
- Send-without-email confirm guard (2026-06-05)
- Shared insertProposalRecord builder (2026-06-05)

---

## gratuity

### OPEN

- **[idea] Lift gratuity floor literal 50 to a shared constant** — client `50 * staff * hours` duplicates server `GRATUITY_FLOOR_RATE = 50`. Future-hygiene. (2026-06-09, 2026-06-09_2e97a91f)
- **[open-question] Bartender pooled tips problem (not solved)** — bartenders pool tips; honor system easy in person but hard when tips arrive days later. (2026-05-17, 2026-05-17_55541813)
- **[idea] Pre-tip bartender prompt (review-email + earlier)** — ask clients to pre-tip at booking / planner stage; review email offers one last chance. Single-bartender events only for now. (2026-05-17, 2026-05-17_55541813)
- **[deferral] Multi-bartender post-event tipping pipeline** — real problem when team can't huddle; tips through DRB OS distributed via staff payment pipeline. Post-event review currently drops handles line for multi-bartender events. (2026-05-17, 2026-05-17_55541813)

### TRACKED / LIKELY-DONE
- Checkout gratuity Project B SHIPPED 2026-06-05 (memory)
- Forced 'Shared Gratuity' relabel: snapshot the label at compute time (Project B)
- Class packages use 'instructor' staff noun
- Tip-jar UX terminology: tip-jar yes/no + add gratuity now
- Gratuity payment policy: paid before event or no work; pooled across bartenders
- Wildlight redaction: no max gratuity rate; refund typos manually
- Payroll fee-netting is intended; not absorbed (memory, locked 2026-06-09)
- Drop 100% hint chip inside parchment frame (2026-06-09)
- Existing pricing demotion gap (price-up only) — Project B extends to confirmed
- Staffing sync gap (positions_needed not updated) — in-scope for client-portal #5

---

## general

### OPEN

- **[loose-end] QuoteWizard.js over 700-line soft cap** — 808 lines after venue-search merge; later 891. Per-step extraction into existing quoteWizard/ folder. (2026-05-22, 2026-05-22_42d116e5)
- **[loose-end] Soft-cap file size warnings: crud.js, emailTemplates.js, shifts.js** — crud.js 781, emailTemplates.js 756, shifts.js 727 after B+C commits. (2026-05-17, 2026-05-17_5a71640d)
- **[loose-end] ProposalCreate.js stuck at 1067 lines via claude-allow-large-file marker** — added to unblock hosted-bartender money-math commit; needs real split. (2026-05-14, 2026-05-14_12d1a8bd)
- **[deferral] Systemic .card > * stacking-context bug across ~6-8 modals** — ConsultationForm, InterviewScheduleModal, PackageIncludesModal, RejectModal, AssignToEventModal, AdminUserDetail backdrop. Separate broader sweep needed. (2026-05-17, 2026-05-17_ad9ee1fe)
- **[deferral] publicTip.js getSignedUrl dedupe** — extracted helper parked rather than refactor battle-tested money-adjacent path. (2026-05-17, 2026-05-17_ad9ee1fe)
- **[deferral] cocktailMenu.js dead static + drinkUpgrades.js/syrups.js inert last-word keys** — soft-disabling via DB UPDATE was sufficient; hygiene chore. (2026-05-17, 2026-05-17_ad9ee1fe)
- **[loose-end] Three unmodified step files retain dead `phase` prop** — orphaned CSS `.exploration-summary-item`. Outside drink-plan post-booking scope. (2026-05-17, 2026-05-17_ea859463)
- **[loose-end] Kebab comm-links — real-browser OS hand-off verification** — unit test can't actually launch a mail/phone/SMS app. (2026-05-17, 2026-05-17_ea859463)
- **[idea] AssignToEventModal should move to components/adminos/ once it has 3+ consumers** — currently 2. (2026-05-14, 2026-05-14_00ba45ae)
- **[idea] Memoize per-row kebab items in Clients/Staff when datasets grow >500 rows** — copy EventsDashboard pattern. (2026-05-14, 2026-05-14_00ba45ae)
- **[deferral] Notification bell in Header is dead — unwired affordance** — no onClick, unused unreadCount prop. (2026-05-14, 2026-05-14_00ba45ae)
- **[idea] ProposalsDashboard has inline icon buttons (no kebab)** — same goes for BlogDashboard. Not in kebab sweep scope. (2026-05-14, 2026-05-14_00ba45ae)
- **[deferral] Manual events editing limitation — packageless edit branch deferred** — both editors hard-require a package; legacy proposal_id IS NULL shifts conditional backfill parked. (2026-05-17, 2026-05-17_5a71640d)
- **[open-question] Decision: autopay must require client_signed_at** — setup_future_usage='off_session' could later charge off-session against unsigned contract. Underlying audit gap may still exist for non-draft paths. (2026-05-14, 2026-05-14_c9f58dad)
- **[loose-end] Drawer.js `crumb` prop confusingly named** — drawer's title slot, not nav trail. Rename future polish. (2026-05-17, 2026-05-17_a5a33587)
- **[deferral] Stale /cocktail-menu nav item left for later** — `nav.js` still has Cocktail Menu item; route is `<Navigate to="/settings">`. (2026-05-17, 2026-05-17_a5a33587)
- **[loose-end] Drink-plan time-format legacy backfill (prod)** — optional one-time UPDATE for legacy 12h event_start_time rows; SQL drafted, deliberately held. (2026-05-16, 2026-05-16_e9431e6c)
- **[loose-end] Dashboard delta 'new' badge (prior=0)** — recorded as deferred optional rather than re-touch reviewed money endpoint. (2026-05-17, 2026-05-17_20054203)
- **[loose-end] Setup-time plan execution — reconciled** — committed and integrated. (Verify if any rough edges remain.) (2026-05-17)
- **[loose-end] Pre-existing missions.test.js crash** — unrelated to beo; never investigated. (2026-05-30, 2026-05-30_7dfb2402)
- **[loose-end] Shopping-list copy: ConsultationForm still mentions ginger ale** — `ConsultationForm.jsx:32` lists 'cola, ginger ale, tonic, juices, etc.' Casual copy, awaiting decision. (2026-06-05, 2026-06-05_65c98f78)
- **[loose-end] INGREDIENT_MAP substring-match fragility** — `.includes()` ordering works but is order-fragile ('ginger beer'.includes('gin') is the trap). (2026-06-05, 2026-06-05_6b8e530b)
- **[loose-end] publicToken GET UUID guard same class of fix** — inline UUID check runs after publicLimiter (pre-existing, same class as POST fix). (2026-06-05, 2026-06-05_6b8e530b)
- **[loose-end] 5-way duplication of client source list is DRY landmine** — canonical util, server allow-list, two schema CHECKs, two badge maps. Future DRY consolidation. (2026-06-01, 2026-06-01_6324be3c)
- **[loose-end] Google Cloud project has extra 'Agent Platform' APIs enabled accidentally** — cruft worth disabling later. (2026-05-22, 2026-05-22_42d116e5)
- **[loose-end] Live Google Places dropdown never verified in browser locally** — prod fine; local needs key in os/.env. (2026-05-22, 2026-05-22_42d116e5)
- **[loose-end] Stripe Dashboard refunds don't send client email** — wired only into in-app admin refund route. Spec-scope call. (2026-05-21, 2026-05-20_a8733f2c)
- **[idea] Bucket 2 wirings: equipment picker, gratuity origin display, SMS metadata** — backend done, last-mile UI missing for shifts.equipment_required, gratuity_rate_change_origin, sms_messages.metadata. (2026-06-09, 2026-06-09_8b5b0547)
- **[loose-end] Plan doc for admin-ui-fixes left uncommitted** — `docs/superpowers/plans/2026-06-01-admin-ui-fixes.md` untracked. (2026-06-01, 2026-06-01_6324be3c)

### Backlog (Dan's candidate list of 18 next-projects, untouched-or-mostly-untouched)

Listed for inventory; pick-and-prioritize when ready:

- **[idea] Referral program** — bachelor/bachelorette territory, separate workstream. (2026-05-25)
- **[idea] Admin permissions refactor (manager toggle expansion)** — informs other things. (2026-05-17 / 2026-05-25)
- **[idea] Contractor onboarding flow audit** — no scope yet. (2026-05-25)
- **[idea] Always-on office box (remote-only PC)** — hosts harvester + Cal.com self-hosted. (2026-05-17)
- **[decision] Cal.com self-hosted for consult scheduling** — on office box; webhook to drb os fires SMS. Dan accepted reluctantly. (2026-05-17)

### TRACKED / LIKELY-DONE
- Kebab race-condition root cause (mousedown vs setTimeout(0)) fixed
- Disabled anchor kebab items stay open on misclick (intentional)
- Open Full Profile in Staff kebab duplicates row-click (intentional)
- Status-driven isFullyPaid replaced with money-driven across paid-flag surfaces
- Out-of-spec headshot wiring on QR card reverted (decision precedent)
- Lemonade 1G left unchanged in pars
- Event identity helpers (getEventTypeLabel)
- ARCHITECTURE.md inline schema dup at schema.sql:780 missing calcom — fixed during admin-ui-fixes Task 1
- Public quote-wizard email-match phone-hijack vulnerability — fixed
- Server-side proxy over client-side Google widget for venue search
- Google Places API key restriction trust over rotation
- PWA manifest skip (internal tool)
- BEO system as next project decision (TRACKED — beo plan written, code not started)

---

## booking / cal

### OPEN

- *(All booking/cal items consolidated under other projects.)*

### TRACKED / LIKELY-DONE
- Drop street address from quote wizard (decision)
- Avoid touching dev server backend except via Claude
- ADMIN_PHONE env var (decision)
- SMS exception for urgent/rare path
- Admin-created bookings NOT gated by last-minute policy
- No tz/per-venue logic in booking-window math (accepted edge)
- Last-minute booking policy SHIPPED (memory)

---

## quote-wizard / lab

### OPEN

- **[open-question] Pre-fill venue address city/state from quote wizard** — wizard collects venue name/city/state but not street/zip, so `isVenueComplete` is never true and clients re-type. Two options floated, decision pending. (2026-05-17, 2026-05-17_2a4635e9)
- **[loose-end] Quote-wizard Extras UI fixes not eyeballed in prod** — 8 shipped via merge; 4 schema.sql copy changes become visible only on deploy. (2026-06-09, 2026-06-09_c215ef12)

### TRACKED / LIKELY-DONE
- Tiered review scheme baked into manual-proposal-overhaul plan

---

## design-stage review fleet

### TRACKED / LIKELY-DONE
- /review-spec + /review-plan (3 agents each) SHIPPED 2026-05-25 (memory)
- Explicit-only, not auto-after-write (decision)
- 3 agents per artifact (decision — option #2 of three shapes)
- Codex as second-opinion reviewer pattern

---

## Top-level notes for triage

1. **Three of your most-recent OPEN items are about Stripe webhook safety** (parity gap, stripe.js split, amount_paid check). These cluster — when you do the stripe.js extraction, you can clear all three plus the audit's defense-in-depth accepted_at stamp at once.
2. **`mergeClients` shipping unwired** is the highest single-item correctness risk. Make sure the very first route to consume it is gated.
3. **cc-import worktree** holds only-copies of the v1 spec, v1 plan, and v2 design that exist nowhere on main. Before `worktree:rm cc-import`, rescue all three docs.
4. **C1 admin sidebar mobile remediation** has been the largest open item since 2026-05-19. It's the only Critical-rated mobile finding still completely untouched.
5. **Memory MEMORY.md is mostly current.** Items 22 ('Last-minute booking deferred') and 35 ('Comms STALE') already say STALE — they're not actively misleading. The biggest gap I found between memory and reality is that **Phase 3+4 of staff payment system are completely missing from memory** — the project_staff_payment_system entry treats it as ongoing but doesn't enumerate the unbuilt phases. Worth a memory edit.
6. **Backlog of 18 next-projects** (BEO chosen, office-box trio next): five of those are untouched from 2026-05-17. Worth re-prioritizing now that you've shipped a lot of the dependencies.
7. **Comms Phase 5/6 decisions are LOCKED but unbuilt** (20+ ready-to-implement design items including reschedule flow, time zones, STOP keyword, drip cadence, sentiment-routed review). When/if you pick comms back up, that section reads like a ready-to-execute plan stub.

---

## Follow-ups logged during work

- **Split `server/routes/drinkPlans.js` (1179 lines, 179 over the 1000-line hard cap).** (2026-06-11, from the uuid-token-guard sweep.) The sweep added its 5 `/t/:token` UUID guards via `git commit --no-verify` (branch `uuid-token-guards`, commit `9423a01`) because the 1-line `requireUuidToken` import grew the already-over-cap file — eslint + all tests passed, only the file-size ratchet was bypassed. Split it (e.g. extract the logo upload/get handlers, ~lines 580-700, to a sibling `drinkPlanLogo.js`) so it drops back under cap and future edits land on a clean ratchet.
