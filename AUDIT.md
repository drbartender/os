# Dr. Bartender OS — Security and Money-Path Audit

Date: 2026-11-05
Scope: production app at commit `d88b1c7` (`main`). Reviewed in the order Money → Access → Foundations, depth over breadth. Only things that could cause wrong money, broken flows, data leaks or outages are reported. No style notes.

How to read this: every finding has an ID, a severity, a confidence (confirmed = traced in code end to end; likely = code path confirmed, trigger not fully confirmed; possible = plausible but needs a precondition I could not verify), a `file:line` location, what is wrong, the real-world impact, and a fix specific enough to hand to another engineer.

---

## 1. Codebase map

Stack: React 18 (`client/`), Express 4 on Node (`server/`), Neon PostgreSQL via raw `pg` SQL (`server/db/schema.sql`, idempotent migrations in place). Stripe for client money and tips, Resend for email, Twilio for SMS/voice, Cloudflare R2 for files. Deploy: Render (API) + Vercel (client).

### Money

| Area | Files | Routes | Tables |
|---|---|---|---|
| Stripe webhook dispatcher | `server/index.js:234` (raw body mount), `server/routes/stripeWebhook.js` | `POST /api/stripe/webhook` | `webhook_events` (event-id ledger for `payment_failed` / `processing`) |
| Webhook handlers | `server/routes/stripeWebhookHandlers/{paymentIntentSucceeded,paymentIntentProcessing,paymentIntentFailed,checkoutSessionCompleted,refundCreated,chargeRefunded,disputes,payout}.js` | (internal) | `proposal_payments`, `stripe_sessions`, `invoices`, `invoice_payments`, `tips`, `tips_orphaned`, `proposal_activity_log` |
| Client checkout (proposal) | `server/routes/stripeCreateIntent.js`, `server/utils/paymentInFlight.js`, `server/utils/stripeRouteHelpers.js`, `server/utils/stripeClient.js` | `POST /api/stripe/create-intent/:token` | `proposals`, `stripe_sessions` |
| Client checkout (invoice, drink-plan extras, admin payment link, manual balance charge, refunds) | `server/routes/stripe.js` | `POST /api/stripe/create-intent-for-invoice/:token`, `POST /api/stripe/create-drink-plan-intent/:token`, `POST /api/stripe/payment-link/:id`, `POST /api/stripe/charge-balance/:id`, `POST /api/stripe/refund/:id`, `GET /api/stripe/refunds/:id` | `invoices`, `stripe_sessions`, `proposal_refunds` |
| Autopay (balance charge scheduler) | `server/utils/balanceScheduler.js`, `server/utils/autopayDurableCharge.js`, `server/index.js:514` | hourly scheduler | `proposals.autopay_*`, `stripe_sessions` |
| Refund accounting | `server/utils/refundExecute.js`, `server/utils/refundHelpers.js`, `server/utils/refundSweepScheduler.js`, `server/routes/proposals/cancel.js`, `server/utils/cancellationMath.js`, `server/routes/proposals/cancelLineItem.js` | `POST /api/proposals/:id/cancel`, `POST /api/proposals/:id/cancel/refund` | `proposal_refunds`, `invoice_payments` (negative reversal rows) |
| Pricing engine | `server/utils/pricingEngine.js` (pure), `server/utils/proposalRules.js`, `server/utils/addonQuantity.js`, `server/utils/proposalExtrasFold.js`, `server/utils/drinkPlanExtras.js`, `server/utils/gratuityMandate.js` | — | `service_packages`, `service_addons`, `proposals.pricing_snapshot` |
| Quote wizard / proposal writes | `server/routes/proposals/{public,crud,publicToken,publicSwitch,publicOptions,optionsPricingShared,patchGuards,lifecycle,actions}.js` | `POST /api/proposals/public/{calculate,submit,capture-lead}`, `POST /api/proposals/t/:token/{sign,switch,options}`, `POST/PATCH /api/proposals[/:id]`, `POST /api/proposals/:id/record-payment` | `proposals`, `proposal_addons`, `proposal_groups`, `quote_drafts` |
| Drink plan / Potion Planning Lab extras | `server/routes/drinkPlans/{submit,submitSanitize,lab,coverageContext}.js`, `server/utils/invoiceExtras.js` | `PUT /api/drink-plans/t/:token`, `PUT /api/drink-plans/t/:token/lab` | `drink_plans`, `proposal_addons`, `invoices` ("Drink Plan Extras") |
| Invoices | `server/routes/invoices.js`, `server/utils/invoiceLifecycle.js`, `server/utils/invoiceLinking.js`, `server/utils/invoiceHelpers.js`, `server/utils/invoiceVoid.js` | `GET /api/invoices/t/:token`, admin `POST/PATCH /api/invoices/...` | `invoices`, `invoice_line_items`, `invoice_payments` |
| Service extensions (on-site "more time") | `server/routes/serviceExtensions/{create,publicAccept,admin}.js`, `server/utils/serviceExtension{Pricing,Settle,Payroll}.js` | `POST /api/service-extensions`, `POST /api/service-extensions/t/:token/accept` | `service_extensions`, `invoices` ("Service Extension", off-ledger) |
| Payroll (pay-run) | `server/routes/admin/payroll.js`, `server/routes/admin/payrollDuty.js`, `server/utils/payroll{Accrual,Processing,Math,Tips,Clawback,LateTip,Periods,Guards,DeferredRetry}.js`, `server/utils/dutyLines.js` | `/api/admin/payroll/periods/:id/{process,reopen}`, `/api/admin/payroll/payouts/:id/{mark-paid,toggle-draw}`, `PATCH /api/admin/payroll/payout-events/:id`, `PATCH /api/admin/payroll/tips/:id/assign` | `pay_periods`, `payouts`, `payout_events`, `payout_duty_lines`, `duty_attributions`, `tips` |
| Staff-facing pay | `server/routes/staffPortal/payouts.js`, `server/utils/paystub{Data,Pdf}.js` | `GET /api/me/payouts[/:periodId[/paystub]]`, `GET /api/me/payment-history` | `payouts`, `payout_events`, `staff_payment_history` |
| Tips (QR tip page) | `server/routes/publicTip.js`, `server/utils/tipPaymentLinks.js`, `server/routes/payment.js`, `server/routes/me.js` | `GET /api/public/tip/:token`, `POST /api/payment`, `GET/PATCH /api/me/tip-page` | `payment_profiles` (bank PII encrypted), `tips` |
| Stripe payout mirror | `server/routes/stripePayouts.js`, `server/utils/stripePayoutSync.js` | admin read | `stripe_payouts`, `stripe_payout_lines` |

### Access

| Area | Files | Notes |
|---|---|---|
| Staff/admin JWT auth | `server/middleware/auth.js` (`auth`, `adminOnly`, `requireAdminOrManager`, `requireOnboarded`, `clientAuth`) | 7-day JWT, `users.token_version` revocation; status gates for staff/manager |
| Password login, register, reset | `server/routes/auth.js` | public `/register` mints a live staff JWT (`onboarding_status='in_progress'`) |
| Passkey unlock (phone admin) | `server/routes/webauthn.js` | only minting site for the 12h token |
| Client OTP | `server/routes/clientAuth.js` | 6-digit, bcrypt-hashed, 15-min, 5 attempts |
| Client portal | `server/routes/clientPortal.js`, `server/routes/clientPortal/{summary,changeRequests}.js` | all scoped by `client_id = req.user.id` |
| Staff portal | `server/routes/staffPortal.js`, `server/routes/staffPortal/*.js`, `server/routes/me.js`, `server/routes/contractor.js`, `server/routes/agreement.js` | mounted at `/api/me`; `router.use(auth)` |
| Shifts and rosters | `server/routes/shifts.js`, `shifts.handlers.js`, `shifts.queries.js`, `staffShiftActions.js`, `eventDetails.js`, `server/utils/eventDetailsPayload.js` | `requireStaffing` (admin or manager with `can_staff`) on every roster write |
| Admin | `server/routes/admin/*.js` (`users.js` permissions, `managers.js`) | role writes are `adminOnly`; admin role immutable |
| E-sign (client) | `server/routes/proposals/publicToken.js` `/t/:token/sign` | one-shot UPDATE with `client_signed_at IS NULL` gate |
| E-sign (contractor agreement) | `server/routes/agreement.js`, `server/data/contractorAgreement.js`, `server/utils/agreementPdf.js` | one row per user in `agreements` |
| Public token surfaces | proposal `/t/:token`, invoice `/t/:token`, drink plan `/t/:token`, tip `/tip/:token`, calendar `/feed/:token`, cover-swap `/cover-swaps/:swapToken` (JWT) | all gated by `requireUuidToken` or a signed JWT |

### Foundations

- Rate limits: `server/middleware/rateLimiters.js`. Webhook verification: `server/utils/twilioSignature.js`, `server/utils/calcomWebhookHelpers.js`, `server/routes/emailMarketingWebhook.js` (svix), `server/routes/thumbtack.js`, `server/routes/telegram.js`.
- Error envelope and process guards: `server/index.js:27-37` (unhandledRejection/uncaughtException to Sentry), `server/index.js:447-485` (global handler; no stack leakage), `server/utils/errors.js`.
- Secrets: `.env.example` only; `render.yaml` uses `sync: false`; `JWT_SECRET` length enforced at boot (`server/index.js:59`); bank PII through `server/utils/encryption.js`.
- Schedulers: `server/utils/schedulerHealth.js` (heartbeat + Sentry on throw), `server/utils/balanceInvoiceMonitor.js` (alert-only money monitor).
- Tests: `npm test` = `node --test "server/**/*.test.js"`, 479 files. 83 pass standalone; 396 need a live Postgres (see §5).

---

## 2. Executive summary: top 5 risks in plain English

1. **A chargeback on a client's deposit or balance is invisible to the OS.** Only tip disputes are handled. If a client disputes a $2,000 payment and wins, the proposal still reads "paid", the event stays staffed, and payroll pays out the gratuity as if the money were there. You would only know from Stripe's own email. (H1)
2. **A repeat client who has two separate events quoted loses the second one the moment they pay the first.** The "same-client sweep" archives every other open proposal for that client regardless of event date, voids its invoice, and the client's link to it starts returning "no longer available". (M2)
3. **A declined autopay card is retried every hour until the event.** The scheduler re-selects `failed` rows, the Stripe idempotency key only suppresses that for 24 hours, and after that each hour is a fresh real charge attempt on the client's card. The admin alert is throttled to once a day so the loop is quiet. (M1)
4. **A client can end up booked and paid with no signed agreement.** Checkout does not require the signature, the payment intent is minted before the signature is posted, and once the proposal is paid the sign endpoint refuses to record one. (M4)
5. **Anyone who self-registers (no approval needed) can read the staff home feed**: upcoming open events with client names, venue addresses and guest counts, plus other staffers' email addresses from cover requests. The shifts list fixed this with `requireOnboarded`; the home feed did not get the same gate. (M5)

Overall posture: the money code is unusually well defended for a solo-built app. Webhooks verify signatures on the raw body and are idempotent per payment, prices are recomputed server-side on every public path, refunds are capped under row locks, and payroll has real double-pay protection. The findings below are mostly gaps between subsystems (disputes, cross-proposal side effects, retry policy) rather than tampering holes.

---

## 3. Findings

### High

#### H1 — Stripe disputes on client payments are not handled; only tip disputes are
- **Severity / confidence:** High / confirmed
- **Location:** `server/routes/stripeWebhook.js:137-145`, `server/routes/stripeWebhookHandlers/disputes.js:9-12`, `server/utils/payrollClawback.js:284-292`
- **What's wrong:** The only dispute events handled are `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`, and both route straight to `clawbackTipByPaymentIntent`, which returns without doing anything when the PaymentIntent is not in `tips` (`payrollClawback.js:290`). `charge.dispute.created` and `charge.dispute.closed` are not handled at all. A dispute on a deposit, balance, full, invoice or drink-plan payment therefore writes nothing: no `proposal_activity_log` row, no change to `proposals.amount_paid`, no `proposal_refunds` row, no admin notification.
- **Impact:** Client disputes a payment → Stripe debits the money (plus the dispute fee) from your balance → the proposal still shows paid, the Balance invoice stays "paid", autopay stays satisfied, staff get scheduled, and if the event completes `payrollAccrual.js:313-321` treats the gratuity pool as funded (`amount_paid >= total_price`) and pays it out. If the dispute is lost there is no record in the OS to reconcile against. The refund reconciler (`refundCreated.js`) does not cover this because a dispute is not a Refund object.
- **Fix:**
  1. Handle `charge.dispute.created`: look up `proposal_payments` by `payment_intent`, write `proposal_activity_log` action `dispute_opened` with amount/reason/evidence-due date, send `notifyAdminCategory('payment_failure', ...)`, and set a flag (`proposals.dispute_open_at`) that the admin payment panel shows and that `cancel.js` and the autopay scheduler refuse on.
  2. Handle `charge.dispute.closed` with `status === 'lost'`: run the same money correction as a dashboard refund (`applyRefundReconciliation` with `stripeRefundId = dispute.id`, `totalScope = 'contract'`), so `amount_paid` drops, the status ladder re-derives and autopay re-arms correctly; on `won`, clear the flag.
  3. In `disputes.js`, keep the tip clawback but also route non-tip PaymentIntents to the step above instead of silently returning.
  4. Confirm in the Stripe dashboard that the webhook endpoint subscribes to `charge.dispute.*` (see §5).

### Medium

#### M1 — Autopay re-charges a declined card every hour, forever
- **Severity / confidence:** Medium / confirmed
- **Location:** `server/utils/balanceScheduler.js:56-60` (claim WHERE includes `autopay_status = 'failed'`), `:135-146` (comment says the opposite), `server/routes/stripe.js:308-312` (same predicate on the manual button), `server/index.js:514-516` (hourly)
- **What's wrong:** The claim query re-selects rows whose `autopay_status` is `'failed'`. On a decline the catch block sets `autopay_status = 'failed'` again, so the row is picked up on the next hourly tick. The Stripe idempotency key is `autopay-balance-<id>-<due date>` (`:86-89`); Stripe replays the first response for that key (the decline) for 24 hours, then the key expires and every hourly tick is a new live authorization attempt against the saved card until the event passes or the card pays. The admin email is throttled to once per 24 h (`:161-196`) and the client email fires once per proposal (`idx_proposal_activity_payment_failed_client`), so nothing reflects the volume. Each attempt also writes a `proposal_payments` row with status `failed` and an activity row via the `payment_intent.payment_failed` webhook.
- **Impact:** Dozens to hundreds of hard declines on one client's card (issuer fraud flags, Stripe Radar risk score, a card that later has funds being charged at a random hour with no warning), noisy ledger, and an admin who believes the retry stopped because the code comment says so.
- **Fix:** Add `autopay_attempt_count` (or reuse `proposal_activity_log` `autopay_failed` rows) and change the claim predicate to `autopay_status IS NULL OR (autopay_status = 'failed' AND attempt_count < 3 AND autopay_attempted_at < NOW() - INTERVAL '24 hours')`. After the cap, leave the row `failed`, send the admin a final "autopay gave up" email, and let `POST /api/stripe/charge-balance/:id` be the explicit retry. Update the comment at `:135` to match whatever policy you pick.

#### M2 — First payment archives every other open proposal for the same client, regardless of event
- **Severity / confidence:** Medium / confirmed
- **Location:** `server/utils/proposalGroupCommit.js:91-128` (`sweepClientAlternatives`), called from `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js:164-167`, `checkoutSessionCompleted.js:252-255`, `server/routes/proposals/actions.js:212-215`
- **What's wrong:** On a client's first deposit/full payment (or an admin record-payment with nothing previously paid), every other proposal with the same `client_id` in `draft/sent/viewed/modified/accepted` and `amount_paid = 0` is set to `archived` with reason `option_not_chosen`, its unpaid invoice is voided, and post-commit the marketing drip and change requests are cancelled. There is no event-date, package or group predicate. The public proposal page 404s archived rows (`publicToken.js:221`), so the client's other link dies.
- **Impact:** A corporate client with a holiday party and a summer picnic both quoted, or a couple with a rehearsal dinner and a wedding, pays one deposit and silently loses the other booking. Nothing alerts the admin; recovery is manual (`archived → draft`, re-send, re-invoice). This is the one money-adjacent flow that can lose revenue by design.
- **Fix:** Scope the sweep to genuine alternatives: same `event_date` (or within one day) and no signature, or only proposals created within N days of the winner. Anything outside that window should be left alone and reported in the admin "payment received" email as "this client has N other open quotes" instead of archived. Keep the formal `proposal_groups` behaviour as is.

#### M3 — Pay-now drink-plan extras are priced differently from the contract fold for non-per-guest add-ons
- **Severity / confidence:** Medium / likely
- **Location:** `server/utils/drinkPlanExtras.js:47-54` (anything not `per_guest` is charged `rate` once), vs `server/routes/drinkPlans/submit.js:384-391` (same add-on priced with `calculateAddonCost` into `total_price`), `submit.js:578-590` (pay-now path skips `refreshUnlockedInvoices` and `createAdditionalInvoiceIfNeeded`), `submit.js:263` (any client-sent slug is honoured)
- **What's wrong:** `computeExtrasBreakdown` is documented as the single source of truth for what pay-now extras cost, but it only knows `per_guest` and "everything else is flat". `mocktail-bar` is `per_guest_timed` ($7.50/guest + $2/guest/extra hour), `barback` and `banquet-server` are `per_hour` with a 4-hour minimum. For those, the Stripe charge and the "Drink Plan Extras" invoice are one unit ($7.50 or $75) while the fold raises `total_price` by the real amount (100 guests × $7.50 = $750; 4 h × $75 = $300). Because the pay-now branch deliberately does not refresh the Balance invoice or mint an Additional Services invoice, the difference sits as an un-invoiced balance. The v1 planner (`client/src/pages/plan/PotionPlanningLab.js:368`) is the only sender of `paid_separately`, and the server honours any active slug the client enables, so the exposure depends on which cards that UI offers (not verified) or on a scripted request.
- **Impact:** Client under-charged at checkout, proposal shows a surprise balance later, or (on a fully paid event with locked invoices) a balance that no invoice ever bills.
- **Fix:** Make `computeExtrasBreakdown` price add-ons with `calculateAddonCost(addon, guestCount, contractHours, totalStaff, 1)` using the same inputs `submit.js:389` uses, and reject (400) any slug whose billing type it cannot price identically. Alternatively restrict the pay-now path server-side to `per_guest` and `flat` slugs.

#### M4 — A proposal can be paid without being signed, and then can never be signed
- **Severity / confidence:** Medium / likely
- **Location:** `server/routes/stripeCreateIntent.js:54-59` (payable statuses `sent/viewed/accepted`, no `client_signed_at` check), `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js:283-288, 380-385` (credit does not require a signature), `server/routes/proposals/publicToken.js:543-545` (sign refuses `deposit_paid/balance_paid`), `client/src/pages/proposal/proposalView/ProposalView.js:320` (intent minted on page load) vs `:524` (sign posted on click)
- **What's wrong:** The PaymentIntent and its `client_secret` exist in the browser before the signature request is sent. If the Stripe confirmation completes while `/sign` fails or is skipped (double submit, a `TOTAL_CHANGED` 409 after the card was already confirmed, a stale tab, or a scripted client), the webhook credits the proposal and moves it to `deposit_paid`. The sign endpoint then returns `ALREADY_ACCEPTED` because the status is no longer signable, so the signature can never be recorded.
- **Impact:** A booked, paid event with `client_signed_at = NULL`: no agreement, no document version, no signature IP for a later dispute or cancellation-terms argument. The `sign_failed` breadcrumb (`publicToken.js:582-596`) is the only trace.
- **Fix:** Either (a) require `client_signed_at IS NOT NULL` (or `status = 'accepted'`) in `create-intent` for `deposit`/`full` so the intent cannot be minted before the signature, or (b) let `/t/:token/sign` record a signature on a paid row when `client_signed_at IS NULL` (drop the status exclusion for that case, keep the `IS NULL` gate), and add a Sentry warning plus admin email when a payment lands on an unsigned proposal.

#### M5 — Any self-registered account can read the staff home feed (client names, venues, staff emails)
- **Severity / confidence:** Medium / confirmed
- **Location:** `server/routes/staffPortal.js:45` (`router.use(auth)` only), `:76-233` (`GET /api/me/staff-home`), `:134-162` (cover broadcasts select `u.email AS requester_email`), `:198-211` (open-shift teaser with `client_name`, `location`, `guest_count`); contrast `server/routes/shifts.js:128` (`requireOnboarded`); `server/routes/auth.js:49-85` (public register mints a live JWT)
- **What's wrong:** `POST /api/auth/register` is public and returns a working staff JWT for an `in_progress` account. `middleware/auth.js:94-113` exists precisely because "authenticated does not mean a real staffer", and the shifts list uses it. The staff home composite does not, so the open-shifts teaser, the count, and the cover-broadcast list (with other contractors' emails and the shift's client name and address) are readable by anyone who registers.
- **Impact:** Client names, venue addresses, guest counts and staff email addresses exposed to unvetted accounts; a competitor can watch your upcoming events.
- **Fix:** Add `requireOnboarded` to `/staff-home` (and to any other staff-data read under `/api/me` that is not strictly own-row data). Consider whether `requester_email` is needed on the broadcast at all; `requester_preferred_name` is already there.

#### M6 — Contractor agreement re-sign overwrites the only signature record
- **Severity / confidence:** Medium / confirmed
- **Location:** `server/routes/agreement.js:62-169` (POST upserts), `:112-135` (UPDATE replaces `full_name`, `email`, `signature_data`, `signature_method`, `signature_ip`, `signature_user_agent`, `signature_document_version`, `signed_at` in place), `:209-217` (`pdf_storage_key` overwritten; old PDF left unreferenced in R2), `:90` (IP from `x-forwarded-for` first entry)
- **What's wrong:** `agreements` holds one row per user and every signing rewrites it. There is no history table and no activity-log row. A contractor can re-sign at any time with a different legal name or email and the original record is gone from the database. The IP recorded is the client-forgeable `X-Forwarded-For` entry rather than `req.ip` (the proposal sign route gets this right at `publicToken.js:476`). The admin can only reconstruct the past from orphaned PDFs in R2 if someone knows to look.
- **Impact:** In a non-solicitation, damage-recoupment or independent-contractor-status dispute you cannot prove which text and which identity were agreed to at which time.
- **Fix:** Insert an immutable `agreement_signatures` row per signing (user_id, version, full_name, email, signature_data, method, `req.ip`, UA, signed_at, pdf_storage_key) and keep `agreements` as the "latest" pointer; never UPDATE a prior signature row. Use `req.ip`.

#### M7 — Payroll can accrue a second wage line for the same shift when a completed event's date moves into a new open period
- **Severity / confidence:** Medium / possible
- **Location:** `server/utils/payrollAccrual.js:188-204` (period chosen from the proposal's current `event_date`), `:412-421` (prior line looked up by `contractor:shift` across all periods), `:462` (`ensurePayout` for the new period), `:472-496` (INSERT keyed on `(payout_id, shift_id)`, so a different period's payout never conflicts), `:545-570` (orphan sweep scoped to the new period only); `server/routes/proposals/crud.js:325` (PATCH has no status guard for `completed`)
- **What's wrong:** If an admin edits `event_date` on a completed, already-paid event (a typo fix) and anything re-runs accrual (a late card tip matching the shift via `payrollTips.js:109-114`, an admin tip assign `payroll.js:800-804`, an extension settle, `maybeReaccrueForDuty`), accrual resolves the new date's open period, finds the old line only to copy hours/rate from it, and inserts a brand-new wage line in the new period. The paid line in the old period is untouched.
- **Impact:** Bartender paid twice for one shift (full wage + gratuity share).
- **Fix:** In `accruePayoutsForProposal`, when `existing` holds a line for `(contractor, shift)` whose `pay_period_id` differs from the resolved period and that period is not `open`, skip the worker with a Sentry warning instead of inserting. Separately, refuse `event_date` edits on `completed` proposals in `crud.js` unless forced.

### Low

#### L1 — Manual "Charge balance" retry inside 24 h replays the cached decline
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/stripe.js:347-352, 392-402`, `server/utils/balanceScheduler.js:82-89`
- **What's wrong:** The idempotency key is stable per (proposal, due date). Stripe returns the stored first response for a reused key, including a card decline, for 24 hours. The admin message says "retry after fixing the card", but a retry within the window returns the same error without contacting the issuer.
- **Impact:** Confusing admin retries; no money loss.
- **Fix:** Add an attempt counter to the key (`autopay-balance-<id>-<due>-<n>`) or append `autopay_attempted_at` truncated to the hour; keep `priorBalanceChargeSettling` as the double-charge guard.

#### L2 — Login leaks account existence by timing and logs the email on failure
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/auth.js:322-339`
- **What's wrong:** An unknown email returns before `bcrypt.compare`, a known one after (~100 ms+), which is a user-enumeration oracle; the per-account lockout only starts after the lookup (the comment acknowledges this). Each failed login also logs the raw email and IP with `console.warn`.
- **Impact:** Enumeration of staff accounts; email addresses in Render logs.
- **Fix:** Compare against a fixed dummy hash when the user is not found; log a hashed or truncated email.

#### L3 — Audit IPs taken from the forgeable `X-Forwarded-For` entry
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/clientPortal/changeRequests.js:127`, `server/routes/agreement.js:90`
- **What's wrong:** `app.set('trust proxy', 1)` is configured, so `req.ip` is the proxy-validated address; these two sites read the raw header first. The proposal sign and switch routes already use `req.ip`.
- **Impact:** A client or contractor can write any IP into the audit trail.
- **Fix:** Use `req.ip` with the same `::ffff:` strip the other routes use.

#### L4 — Events that are not fully paid never auto-complete, so wages do not accrue
- **Severity / confidence:** Low / confirmed
- **Location:** `server/utils/balanceScheduler.js:216-242` (`(total_price - amount_paid) <= 0` required), `server/utils/payrollAccrual.js:149-151` (accrual only on `completed`)
- **What's wrong:** Wages are documented as never gated on payment, but completion is. An event whose client still owes a balance after it ended stays `balance_paid`/`confirmed` until an admin completes it by hand; `balanceInvoiceMonitor` alerts about the owed balance but nothing says "this event ended and its staff have not been accrued".
- **Impact:** Staff pay for that event silently misses the pay period unless the admin remembers.
- **Fix:** Add an "ended but not completed" check to the hourly monitor (events past end instant, not completed, with approved staff) that emails `routine_finance`, or decouple wage accrual from completion.

#### L5 — Public quote endpoints accept malformed numeric inputs and 500 instead of 400
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/proposals/public.js:252` (`guest_count < 1` lets `1.5` through to an INTEGER column), `:393-394` (a negative or zero `event_duration_hours` falls to `calculateBaseCost` which throws a bare `Error`, `pricingEngine.js:120-125`)
- **Impact:** 500s on the public wizard (Sentry noise, no money impact; prices still come from the server).
- **Fix:** Coerce with `Number.isInteger` / bounds checks and throw `ValidationError`.

#### L6 — Admin tip assignment does not check the tip's bartender is on the target shift
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/admin/payroll.js:762-812`
- **What's wrong:** `PATCH /payroll/tips/:id/assign` accepts any `shift_id`; the tip pool is then split among that shift's bartenders even if the tipped bartender was not on it.
- **Impact:** Admin-only mis-assignment pays a tip to the wrong crew.
- **Fix:** Require the tip's `target_user_id` to hold an approved request on `shift_id` unless `force: true` is sent.

#### L7 — OTP request endpoint can be used to flood a client's inbox
- **Severity / confidence:** Low / confirmed
- **Location:** `server/routes/clientAuth.js:15-21, 24-73`
- **What's wrong:** Rate limit is 10 per 15 minutes per IP and there is no per-email limit; every request sends a new email. An IP-rotating caller can send a client unlimited "your code" emails.
- **Impact:** Harassment / sender-reputation damage; no auth bypass.
- **Fix:** Add a per-email limiter (3 per 15 min) and do not regenerate a code that is less than 60 seconds old.

---

## 4. Checked and looks solid

Money
- **Webhook ingestion:** raw body mounted before `express.json` (`index.js:234`); signature verified against live and test secrets; test-mode events dropped outside a test window using which secret verified them, not the payload (`stripeWebhook.js:58-85`); handler exceptions propagate to a 5xx so Stripe retries (`paymentIntentSucceeded.js:647-658`).
- **Idempotency and ordering:** `proposal_payments` partial unique index on `stripe_payment_intent_id` is the first write in each settle transaction; duplicates skip all mutations and side effects. `payment_failed` and `processing` dedupe on the Stripe event id via `webhook_events`. A stale `payment_failed` after a success is ignored (`paymentIntentFailed.js:45-52`). Processing → failed → processing ordering is resolved by asking Stripe (`paymentIntentProcessing.js:32-58`).
- **Credits are additive and status is derived**, never `= total_price`; lifecycle states are never rewound; the gratuity election and the deposit-to-full invoice upgrade run inside SAVEPOINTs so they can never block the payment record.
- **Checkout tampering:** `create-intent` reads the total from the row; the only client inputs are `payment_option`, `autopay`, `tip_jar`, `gratuity_total`, and the gratuity is validated against the floor/mandate and sanity cap. Deposit amount is server-constant. Full-payment-inside-14-days is enforced server-side. The sign route asserts `ABS(total_price - acknowledged_total) < 0.005` in the UPDATE itself. The package-switch and change-request paths compare acknowledged totals in integer cents and price from the locked row. Discounts, overrides and setup fields are admin-only (`changeRequests.js:14-19`). Syrup ids are allowlisted and de-duplicated; add-on quantities are clamped.
- **Pricing engine:** integer-cent rounding at every seam, hosted 1:100 bartender rule and class exception, 25-guest hosted floor, bundle/mixer mutexes and `requires_addon_slug` dependencies re-validated on every server path, adjustments floored at zero, remainder-safe gratuity split.
- **Bank-debit-in-flight guard** (`paymentInFlight.js`) fails closed on a Stripe outage and blocks every rail that could double-collect.
- **Refunds:** admin-only; pending row written before the Stripe call; ambiguous Stripe errors leave the row pending for the sweeper rather than re-opening headroom; overpayment cap re-asserted under the proposals row lock; reconciliation idempotent by refund id and serialized on the row; `refund.created` reconciles dashboard refunds and fails the delivery (for retry) when the payment row has not landed yet.
- **Cancellation math** is pure integer cents with a lifetime cap recorded at cancel time, an advisory lock per proposal, and pre-denial roster capture for tip clawback.
- **Autopay claim** is a single atomic UPDATE with a 72 h TTL, a durable intent record, and a Stripe-side check for a prior settling intent before any new charge.
- **Payroll:** every admin payroll route is `adminOnly`; `mark-paid` runs under `FOR UPDATE OF po, pp` with a drift guard against the total the pay panel generated; periods move `open → processing → paid` with `reopened` as the only correction path; `recomputePayoutTotal` is the single writer and clamps at zero; `splitEvenly` distributes remainders deterministically; tip clawback is idempotent via a cumulative marker and defers on frozen periods; dispute-won rewinds the counter exactly once; staff payout reads are hard-scoped to `req.user.id` with no id parameter.
- **Tips:** tip PaymentIntents carry `kind: tip` and no `proposal_id`, so they can never credit a proposal; malformed tip sessions are recorded in `tips_orphaned` before acking.

Access
- **OTP:** `crypto.randomInt`, bcrypt(12) hash, 15-minute expiry, 5 attempts then invalidation, neutral responses on every failure, cleared on success, IP limiter on both endpoints.
- **JWT:** `JWT_SECRET` length enforced at boot; `token_version` revocation for staff and clients; passkey unlock uses single-use DB challenges, user-handle cross-check, counter-regression detection and a 12 h token; revoking a passkey bumps `token_version`.
- **Roles:** role changes are `adminOnly` and can only produce `staff`/`manager`; the admin role is immutable through the API; roster writes require admin or a manager with `can_staff`; refunds, payroll and cancellation refunds are admin-only.
- **IDOR:** client portal reads are scoped by `client_id = req.user.id` with a defensive sub-select; staff payouts, tips, profile, documents and calendar token are own-row only; `GET /shifts/user/:userId/events` checks ownership; event details hide the client phone unless the viewer is assigned; `/api/files` is admin/manager only with `path.basename`.
- **Client e-sign:** one-shot UPDATE gated on `client_signed_at IS NULL`, document version allowlisted, IP from `req.ip`, UA recorded, `sign_failed` breadcrumbs.
- **Public token routes:** UUID format gate before any DB work, archived proposals 404, explicit column allowlists that strip Stripe ids, admin notes, signature IP/UA and overrides; drink-plan logo proxy pinned to its R2 prefix; selections sanitizer drops internal keys.

Foundations
- **SQL:** every query is parameterized; the handful of template interpolations are constants, allowlists or helper-generated fragments (`statusList`, `ALIAS_TABLES`, filter builders that push params).
- **Secrets:** no live keys in tracked files or git history (`sk_live_`, `whsec_`, `AKIA`, private keys all searched); `render.yaml` uses `sync: false`; bank PII encrypted at rest and masked on read.
- **Webhooks:** Resend (svix) and Thumbtack fail closed in production when the secret is unset; Twilio signature checked on SMS/voice with 403 in production; Cal.com HMAC returns 503 when unset; Telegram requires both the secret path and header.
- **Error handling:** global handler never emits stack traces; `unhandledRejection`/`uncaughtException` go to Sentry; schedulers are wrapped with heartbeats and Sentry capture; a failed scheduler does not kill the timer.

---

## 5. Couldn't assess

- **Database-backed tests.** `npm test` was run: 479 test files, 83 pass standalone, 396 fail with `ECONNREFUSED 127.0.0.1:5432` because they integration-test against Postgres. No Postgres is available in this environment and I did not use the Neon `ci-smoke` branch. No failures unrelated to the missing database were found.
- **Stripe dashboard configuration.** Whether the webhook endpoint subscribes to `charge.dispute.*`, `refund.created`, `payment_intent.processing`, `payout.*`; the API version pinned on the endpoint; Radar rules. H1 assumes the dispute events reach the endpoint at all.
- **Render / Vercel environment.** Values of `STRIPE_TEST_MODE_UNTIL`, `RESEND_WEBHOOK_SECRET`, `THUMBTACK_WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `RUN_*` flags. Several fail-closed guards depend on `NODE_ENV=production` being set in Render (it is in `render.yaml`).
- **Runtime behaviour of the React client** (no browser run). M4 relies on the order of calls read from `ProposalView.js`; M3 relies on which add-on cards the v1 planner offers, which I did not trace through the UI.
- **Onboarding flow and Potion Planning Lab** beyond their money paths (only `submit.js`, `lab.js` pricing, `payment.js`, `contractor.js` and `agreement.js` were read).
- **CheckCherry legacy import, voice/Telegram/VA calling, marketing send, Inbox AI read.** Out of scope for Tier 1 to 3 and not reviewed.
- **Payroll duty lines** (`dutyLines.js`, `payrollDuty.js`) beyond confirming they flow through the single total writer.
