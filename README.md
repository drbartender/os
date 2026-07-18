# Dr. Bartender

A full-stack platform for Dr. Bartender's bartending service business. Handles contractor onboarding, client event planning, service proposals with dynamic pricing, Stripe payments, and admin management.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node 26 (pinned via `.node-version`) / Express 4.18 |
| Frontend | React 18 (Create React App) / React Router 6 |
| Database | PostgreSQL (raw SQL via `pg`, no ORM) |
| Auth | JWT + bcryptjs |
| File Storage | Cloudflare R2 (AWS SDK v3) |
| Payments | Stripe (Elements + webhooks) |
| Email | Resend |
| SMS | Twilio |
| VA calling (Zul) | Telegram Bot API (raw HTTPS trigger) + Twilio Programmable Voice callback bridge |
| Web Push | `web-push` (VAPID) for staff-portal notifications |
| Booking / Scheduling | Cal.com (webhook integration; self-hosted target for V2) |
| Rich Text Editor | TipTap (ProseMirror-based WYSIWYG, blog admin) |
| HTML Sanitization | DOMPurify + jsdom (server-side) |
| CSV parsing | `csv-parse` (Check Cherry import pipeline) |
| Styling | Vanilla CSS |
| Error Tracking (server) | `@sentry/node` |
| Error Tracking (client) | `@sentry/react` |

## Prerequisites

- **Node.js** 26 (pinned via `.node-version`; matches what Render runs in prod today). The planned LTS-alignment decision lives in `docs/audit-2026-07-13/migration-plan.yaml` (`def-node-lts`).
- **PostgreSQL** (local instance or remote connection string)
- **Stripe**, **Resend**, **Twilio**, and **Cloudflare R2** accounts (for full functionality — the app runs without them but those features won't work)

## Local Development Setup

```bash
# 1. Install dependencies (server + client)
npm run install:all

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, and service API keys

# 3. Create the database
createdb dr_bartender

# 4. Seed the admin account
npm run seed

# 5. Start dev servers (Express on :5000, React on :3000)
npm run dev
```

The React dev server proxies `/api` requests to `localhost:5000` automatically.

## Environment Variables

Copy `.env.example` and fill in values. All variables:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 5000) |
| `NODE_ENV` | No | `development` or `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Long random string for signing tokens |
| `UNSUBSCRIBE_SECRET` | No | Separate signing key for unsubscribe/marketing-link JWTs. Falls back to `JWT_SECRET` if unset. |
| `ENCRYPTION_KEY` | For bank PII | 64-hex-char (32-byte) AES-256-GCM key for bank-account fields at rest (`server/utils/encryption.js`). Fails closed in prod when unset. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `RUN_SCHEDULERS` | No | Schedulers fire only when `NODE_ENV=production` (Render's default). In any other environment they default to OFF, so a local dev server never burns Resend/Twilio allotments by iterating the shared Neon DB. Set `RUN_SCHEDULERS=true` to force-on locally (testing a handler against a scratch row). Set `RUN_SCHEDULERS=false` on a secondary prod instance to prevent duplicate runs. |
| `SEND_NOTIFICATIONS` | No | Real outbound email (Resend) + SMS (Twilio) fire only when `NODE_ENV=production` by default — same philosophy as `RUN_SCHEDULERS` — so a local dev server never burns provider allotments against the shared Neon DB. Set `SEND_NOTIFICATIONS=true` to force real sends locally (testing a real send to a scratch row). Set `SEND_NOTIFICATIONS=false` to force off anywhere. When gated off, `sendEmail`/`sendSMS` take their existing log-and-skip path. |
| `RUN_AUTOPAY_SCHEDULER` / `RUN_AUTOCOMPLETE_SCHEDULER` / `RUN_AUTO_ASSIGN_SCHEDULER` / `RUN_SEQUENCE_SCHEDULER` / `RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER` | No | Per-scheduler disable. Set to `false` to disable that specific scheduler. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_MESSAGE_DISPATCHER_SCHEDULER` | No | Set to `false` to disable the scheduled-message dispatcher (balance reminders, plus future drip / event-week handlers). Defaults on. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` | No | Set to `false` to disable the hourly `webhook_events` 30-day prune. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_PENDING_EMAIL_CLEANUP_SCHEDULER` | No | Set to `false` to disable the daily `pending_email_changes` 7-day purge. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER` | No | Set to `false` to disable the daily Stripe payout mirror sweep (webhook-miss heal, pending bucket, re-match). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_REFUND_PENDING_SWEEP_SCHEDULER` | No | Set to `false` to disable the 15-minute stale-pending-refund sweep (reconciles `proposal_refunds` rows stuck `pending` >30 min against `stripe.refunds.list`: adopts the real refund or marks it failed). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `CLIENT_URL` | Yes | Admin/staff frontend URL for CORS + admin dashboard links in emails (e.g., `http://localhost:3000` in dev, `https://admin.drbartender.com` in prod) |
| `PUBLIC_SITE_URL` | Yes | Public marketing site URL used in client-facing token links — proposals, drink plans, invoices, shopping lists (e.g., `http://localhost:3000` in dev, `https://drbartender.com` in prod) |
| `STAFF_URL` | No | Staff portal origin used in hire-confirmation emails (e.g., `http://localhost:3000` in dev, `https://staff.drbartender.com` in prod). Falls back to the prod URL if unset. |
| `API_URL` | No | Backend origin for server-rendered email links (unsubscribe). Defaults to `RENDER_EXTERNAL_URL` in prod, `http://localhost:5000` in dev. |
| `MAX_FILE_SIZE` | No | Upload limit in bytes (default: 10MB) |
| `R2_ACCOUNT_ID` | For uploads | Cloudflare R2 account ID |
| `R2_BUCKET_NAME` | For uploads | R2 bucket name |
| `R2_ACCESS_KEY_ID` | For uploads | R2 access key |
| `R2_SECRET_ACCESS_KEY` | For uploads | R2 secret key |
| `RESEND_API_KEY` | For email | Resend API key |
| `RESEND_WEBHOOK_SECRET` | For email tracking | Resend webhook signing secret (svix) |
| `TWILIO_ACCOUNT_SID` | For SMS | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | For SMS | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | For SMS | Twilio sender number |
| `STRIPE_SECRET_KEY` | For payments | Stripe live secret key |
| `STRIPE_PUBLISHABLE_KEY` | For payments | Stripe live publishable key (served to the client via `/api/stripe/publishable-key`) |
| `STRIPE_WEBHOOK_SECRET` | For payments | Stripe live webhook signing secret |
| `STRIPE_DEPOSIT_AMOUNT` | No | Deposit in cents (default: 10000 = $100) |
| `STRIPE_SECRET_KEY_TEST` | For test mode | Stripe test secret key (used while `STRIPE_TEST_MODE_UNTIL` is in the future) |
| `STRIPE_PUBLISHABLE_KEY_TEST` | For test mode | Stripe test publishable key |
| `STRIPE_WEBHOOK_SECRET_TEST` | For test mode | Stripe test webhook signing secret |
| `STRIPE_TEST_MODE_UNTIL` | Optional | ISO 8601 cutoff date. While set and in the future, every Stripe call uses the `*_TEST` credentials; after the cutoff, the next request automatically reverts to the live credentials with no redeploy. Example: `2026-04-21T23:59:59-07:00` |
| `PUBLIC_GOOGLE_REVIEW_URL` | For tip pages | Server-side Google review URL surfaced from the tip thank-you flow |
| `REACT_APP_GOOGLE_REVIEW_URL` | For tip pages | Client build-time Google review URL (same value as `PUBLIC_GOOGLE_REVIEW_URL`) |
| `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` | For tip pages | Inbox that receives bartender feedback from the tip thank-you flow (default: `contact@drbartender.com`) |
| `THUMBTACK_WEBHOOK_SECRET` | For Thumbtack | Shared secret for Thumbtack webhook auth |
| `THUMBTACK_AGENT_SECRET` | For harvester | Shared secret for the email-harvester agent + admin-paste routes; fails closed when unset |
| `HARVESTER_ENABLED` | Optional | `false` idles the harvester (server returns `[]`, agent idles). Default on |
| `CAL_WEBHOOK_SECRET` | For Cal.com | HMAC-SHA256 signing secret for the Cal.com webhook. Required in prod; webhook returns 503 if unset. |
| `CAL_BOOKING_URL` | For Cal.com | Public Cal.com booking page URL. Surfaced in three client comms touches (drink-plan nudge email + SMS, six-months-out marketing). Optional; templates omit the consult line when unset. |
| `GOOGLE_PLACES_API_KEY` | For venue search | Google Places API (New) key for venue-name search. Server-only. When unset, venue search degrades to a plain text input. |
| `SENTRY_DSN_SERVER` | For error tracking | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | For error tracking | Client-side Sentry DSN (optional in dev; required in prod) |
| `VAPID_PUBLIC_KEY` | For staff push | Web Push (VAPID) public key. Generate with `npx web-push generate-vapid-keys`. |
| `VAPID_PRIVATE_KEY` | For staff push | Web Push (VAPID) private key. Server-only. Unset → push fails closed (`vapid_unset`), server still boots. |
| `REACT_APP_VAPID_PUBLIC_KEY` | For staff push | Client-side copy of `VAPID_PUBLIC_KEY` (same value); lets the staff portal subscribe to push. |
| `VAPID_CONTACT_EMAIL` | For staff push | Contact email in the VAPID JWT (`mailto:`). Defaults to `contact@drbartender.com`. |
| `ADMIN_EMAIL` | For seed | Admin account email. Used for the seed account and as the default Reply-To on client-facing emails. |
| `ADMIN_PASSWORD` | For seed | Admin account password |
| `TELEGRAM_BOT_TOKEN` | For VA calling | Telegram Bot API token (@BotFather). Unset → Telegram helpers no-op and outbound calling is dead. |
| `TELEGRAM_WEBHOOK_SECRET` | For VA calling | Secret URL path segment (`/api/telegram/<secret>`) AND the `X-Telegram-Bot-Api-Secret-Token` header value (constant-time compared). Set the same value at `setWebhook`. |
| `TELEGRAM_ALLOWED_USER_ID` | Bootstrap | Numeric Telegram user id of Zul. Leave UNSET on first deploy for bootstrap mode (webhook echoes the sender's id, dials nothing); then set + redeploy. |
| `VOICE_CALLER_ID` | For VA calling | The 224 US voice line in strict E.164 (`+12242220082`) — outbound caller ID + inbound number. |
| `VA_CELL` | For VA calling | Zul's cell, strict E.164 (`+63…`), the bridge target. Never normalized, never committed. |
| `RUN_VA_CALLING_SCHEDULER` | No | `false` disables the VA-calling prune + Telegram webhook-heartbeat scheduler. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_PRESENCE_SCHEDULER` | No | `false` disables the presence stale-desk nudge / auto-flip sweep (15 min). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `VA_CALL_DAILY_CAP` | No | Max calls placed per rolling 24h (default 40, DB-backed via `call_audit`). |
| `VA_CALL_PER_MIN_CAP` | No | Max triggers accepted per minute (default 5). |
| `VA_CALL_TIME_LIMIT_SEC` | No | Per-call hard `timeLimit` on both legs (default 1800 = 30 min). |
| `PENDING_CALL_TTL_SEC` | No | Confirm-before-dial pending-record TTL in seconds (default 120). |
| `LEAD_CALL_ENABLED` | No | Lead call bridge kill switch: `false` disables the new-lead auto-call trigger entirely (redeploy-free). Default on. |
| `LEAD_CALL_DAILY_CAP` | No | Max lead-call attempt chains opened per rolling 24h (default 25; toll-fraud backstop). |

The frontend uses one build-time variable set in `client/.env.production`:
- `REACT_APP_API_URL` — absolute URL to the backend (e.g., `https://os-g7oa.onrender.com`)

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js                # Express app setup, middleware, route mounting
│   ├── data/
│   │   └── contractorAgreement.js # Versioned v2 legal text (clauses, acknowledgments, effective date)
│   ├── db/
│   │   ├── index.js            # PostgreSQL pool connection + schema initialization
│   │   ├── schema.sql          # Full DDL: tables, triggers, constraints, seed data
│   │   ├── seed.js             # Admin account seeder script
│   │   └── seedTestData.js     # Test data seeder (staff, clients, proposals)
│   ├── middleware/
│   │   ├── asyncHandler.js     # 3-line wrapper that funnels async-handler rejections to the global error middleware
│   │   ├── auth.js             # JWT verification + role guards (auth, adminOnly)
│   │   └── rateLimiters.js     # Shared express-rate-limit instances (publicLimiter, signLimiter, adminWriteLimiter for admin proposal writes, etc.)
│   ├── routes/
│   │   ├── admin/              # Admin endpoints (users/applications/hiring/managers/blog/settings sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── users.js        # /users CRUD + onboarding state machine + /active-staff + seniority
│   │   │   ├── contractorTipPage.js # /contractors/:userId/tip-page admin actions (patch/rotate-token/generate-stripe/regenerate-stripe/activate/deactivate) + /tips + /tip-feedback review
│   │   │   ├── applications.js # /applications + /notes + interview scheduling + scorecard + reject/restore/move/reminder
│   │   │   ├── hiring.js       # /hiring/summary (KPIs) + /hiring/search (cross-state applicant search)
│   │   │   ├── managers.js     # /managers CRUD
│   │   │   ├── blog.js         # /blog admin endpoints
│   │   │   ├── settings.js     # /settings + /test-email + /backfill-geocodes + /badge-counts
│   │   │   ├── search.js       # /search — global record search across clients/proposals/events/staff
│   │   │   ├── payroll.js      # /payroll — contractor payouts, pay periods, paystub data
│   │   │   ├── payrollTax.js   # /payroll/contractors/:id/payment-history + /payroll/tax-totals + /payroll/tax-totals/:id/exclude — imported-ledger blends + 1099 year totals (read-only + one boolean PATCH)
│   │   │   ├── presence.js     # /presence + /presence/state + /presence/leads + /presence/log — time-clock strip + history
│   │   │   ├── leadCalls.js    # /lead-call-attention — open lead-call bridge attention rows (missed/failed/skipped chains on still-new TT leads, 7-day window) for the overview Sales tab
│   │   │   └── ccImport/       # Live CC re-trigger endpoints (v1 import/review admin UI removed 2026-07-07)
│   │   ├── agreement.js        # Contractor agreement + digital signature
│   │   ├── application.js      # Contractor application form
│   │   ├── auth.js             # POST /register, POST /login, GET /me
│   │   ├── beo.js              # Banquet Event Order — staff-authenticated GET BEO + logo proxy + POST acknowledge
│   │   ├── blog.js             # Blog post endpoints
│   │   ├── calcom.js           # Cal.com webhook receiver (HMAC-SHA256 signed, public); handles booking created/cancelled/rescheduled/no-show events
│   │   ├── calendar.js         # Calendar/scheduling endpoints
│   │   ├── clientAuth.js       # Client authentication (separate from staff auth)
│   │   ├── clientPortal.js     # Client portal endpoints
│   │   ├── clientPortal/       # Per-concern subrouters mounted under /api/client-portal
│   │   │   ├── summary.js      # Shared summary-column helpers (not a router)
│   │   │   └── changeRequests.js # Client change-request endpoints (calculate, create, list, cancel)
│   │   ├── clients.js          # Client CRUD
│   │   ├── cocktails.js        # Cocktail menu CRUD
│   │   ├── comms.js            # Compose-and-confirm client sends for the comms registry (POST /preview + /send; recipient resolved server-side)
│   │   ├── contractor.js       # Contractor profile + file uploads
│   │   ├── drinkPlans.js       # Client event planning questionnaire
│   │   ├── drinkPlans/
│   │   │   ├── regenerate.js   # POST /:id/shopping-list/regenerate (fresh list from live par catalog; returns, never saves)
│   │   │   ├── shoppingList.js # Shopping-list routes extracted from drinkPlans.js (public token view + admin get/save/approve; approve delegates to the comms action, kept for API compat)
│   │   │   └── submit.js       # PUT /t/:token submit handler (extracted); creates the "Drink Plan Extras" invoice at submit
│   │   ├── drinkPlanConsult.js # Admin consult-form routes (alternate input source for shopping lists)
│   │   ├── messages.js         # SMS messaging to staff
│   │   ├── mocktails.js        # Mocktail menu CRUD
│   │   ├── payment.js          # Payment method + W-9 upload
│   │   ├── potions.js          # Potions bar-program API: par-catalog CRUD/reorder/preview + shared recipe-row validator
│   │   ├── progress.js         # Onboarding step tracking
│   │   ├── proposals/          # Service proposals (publicToken/compareGroup/public/metadata/lifecycle/crud/getOne/actions/changeRequests/groups/metricsSplit sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── publicToken.js  # /t/:token view + sign
│   │   │   ├── public.js       # /public/* — packages, addons, calculate, capture-lead, quote-draft, submit
│   │   │   ├── metadata.js     # /packages, /addons, /calculate, /financials, /dashboard-stats
│   │   │   ├── metricsSplit.js # GET /metrics-split — funnel sent/accepted math split by source or event_type (native-only sibling of dashboard-stats)
│   │   │   ├── lifecycle.js    # Proposal status state machine (PATCH /:id/status)
│   │   │   ├── crud.js         # admin CRUD (list / create / update / archive)
│   │   │   ├── getOne.js       # GET /:id single-proposal read (carved out of crud.js; greedy `/:id`, mounted last)
│   │   │   ├── actions.js      # Per-proposal admin actions: notes, create-shift, balance-due-date, send-reminder, record-payment (carved out of crud.js)
│   │   │   ├── cancel.js       # Cancel booked events (fix #7): /:id/cancel/preview, /:id/cancel, /:id/cancel/refund — archive + shift-cancel + comms-delete + invoice-void + idempotent tip clawback + agreement refund
│   │   │   └── changeRequests.js # Admin change-request endpoints (queue, per-proposal list, decline)
│   │   ├── shifts.js           # Shift scheduling
│   │   ├── shifts.queries.js   # Extracted SQL projections/queries for shifts.js
│   │   ├── shifts.approval.js  # Request/assign/approve handlers + position-resolution money seam (extracted from shifts.js)
│   │   ├── shifts.handlers.js  # Shift-lifecycle mutation handlers (update, cancel-or-unassign) extracted from shifts.js
│   │   ├── staffShiftActions.js # Drop / Cover shift marketplace (drop, request-cover, claim-cover, emergency-drop, withdraw) under /api/shifts
│   │   ├── adminCoverSwaps.js  # Admin cover-swap approval endpoints (mounted under /api/admin)
│   │   ├── sms.js              # Twilio inbound-SMS webhook + admin thread API
│   │   ├── telegram.js         # Zul VA-calling OUTBOUND trigger: POST /api/telegram/:secret (secret path + secret_token header + user_id allowlist), NANP validation, confirm-before-dial (YES), claim-then-call bridge
│   │   ├── stripe.js           # Payment intents, payment links, webhooks
│   │   ├── stripeWebhook.js    # Webhook signature verification + per-event dispatch (handlers live in stripeWebhookHandlers/)
│   │   ├── stripeWebhookHandlers/ # Per-event webhook handler modules (extracted verbatim from stripeWebhook.js)
│   │   │   ├── paymentIntentSucceeded.js # deposit/full/balance/invoice/drink-plan settlement + group commit + invoice links
│   │   │   ├── checkoutSessionCompleted.js # tip-page sessions + Payment-Link deposit/full settlement
│   │   │   ├── chargeRefunded.js  # refund reconciliation + tip clawback
│   │   │   ├── paymentIntentFailed.js # failure recording (monotonic guard) + notifications
│   │   │   ├── disputes.js        # dispute funds withdrawn/reinstated
│   │   │   └── payout.js          # payout mirror sync (live-only)
│   │   ├── stripeCreateIntent.js # POST /api/stripe/create-intent/:token (extracted from stripe.js)
│   │   ├── stripePayouts.js    # GET/POST /api/stripe-payouts — DB-only payout mirror list/detail + rate-limited sweep trigger (read-side; admin/manager)
│   │   ├── emailChange.js      # Unauthenticated POST /api/me/confirm-email-change — email-link token proves intent, bumps token_version to invalidate old JWTs (mounted at /api/me before me.js)
│   │   ├── emailMarketing.js   # Email marketing leads, campaigns, sequences, conversations
│   │   ├── emailMarketingWebhook.js  # Resend webhook receiver (email tracking events)
│   │   ├── invoices.js         # Invoice CRUD, public token view, client portal
│   │   ├── me.js               # Authenticated self endpoints (tip page settings, my-tips listing)
│   │   ├── staffPortal.js      # Staff portal v2 /api/me/* composite + account-mgmt endpoints (staff-home, tip-card-order, profile, ui-preferences, staff-notifications, push-subscriptions, documents/:doc_type/replace, request-email-change, cancel-pending-email-change); mounts the per-concern subrouters below
│   │   ├── staffPortal/        # Per-concern subrouters mounted by staffPortal.js
│   │   │   ├── paymentMethods.js   # GET/PATCH /payment-methods + PUT /preferred-payment-method (bank PII via encryption.js)
│   │   │   ├── payouts.js          # GET /payouts (history) + /payouts/:periodId (detail) + /payouts/:periodId/paystub (lazy-gen PDF download) + /payment-history (imported pre-OS ledger + blended all-time total, platform-only)
│   │   │   └── accountReads.js     # GET /profile, /calendar-settings, /documents — AccountPage hydration reads
│   │   ├── publicReviews.js    # Public cached endpoint for Thumbtack reviews on homepage
│   │   ├── publicTip.js        # Public tip-page lookup + post-tip feedback (token-gated)
│   │   ├── publicFeedback.js   # Post-event feedback router (5-star sentiment routing)
│   │   ├── thumbtack.js        # Thumbtack webhook endpoints (leads, messages, reviews)
│   │   ├── thumbtackAgent.js   # Thumbtack email-harvester API (/api/admin/thumbtack): pending-harvest, email-harvested, harvest-failed, rearm. Driven by the box-only agent in thumbtack-agent/
│   │   ├── venues.js           # Google Places venue search proxy
│   │   ├── voice.js            # Zul VA-calling Twilio Voice webhooks: POST /inbound (forward 224 → VA_CELL), /bridge (look up target by CallSid → Dial 224→target), /status (failed-leg → Telegram notice). Signature gate via utils/twilioSignature + text/xml
│   │   └── voiceLeadCall.js    # Lead call bridge Twilio webhooks (/api/voice/lead): /answer (Gather-wrapped spoken briefing), /digit (press-1 → Dial lead from the 224, press-9 replay), /status (claim-guarded chain advance). Signature FAIL-CLOSED in every env
│   ├── utils/
│   │   ├── adminAuditLog.js    # logAdminAction(...) — durable record of admin actions (rotate-token, regenerate-stripe). Best-effort; failures go to Sentry, never block the underlying op
│   │   ├── adminNotifications.js # notifyAdminCategory(...) — multi-admin notification fan-out by category (joins users.notification_preferences + contractor_profiles for SMS)
│   │   ├── agreementPdf.js     # PDFKit renderer for signed contractor agreements
│   │   ├── agreementVersions.js # Allowlist + current/legacy version constants for the proposal Service Agreement
│   │   ├── paystubData.js      # Assembles paystub render data (payout + events + YTD) per (contractor, period)
│   │   ├── paystubPdf.js       # PDFKit renderer for staff paystubs (mirrors agreementPdf.js)
│   │   ├── autoAssign.js       # Auto-assign algorithm (seniority + geo + equipment scoring)
│   │   ├── autoAssignScheduler.js # Scheduled auto-assign runner (hourly)
│   │   ├── balanceReminderScheduling.js # Balance-reminder ladder scheduling (extracted from stripe.js); anchors 10am event-local
│   │   ├── businessTime.js     # Canonical business-time primitives: eventLocalToUtc (DST-aware) + chicagoTodayYmd
│   │   ├── autopayDurableCharge.js # Durable autopay charge record + stale-reclaim double-charge guard (F1)
│   │   ├── balanceScheduler.js # Autopay balance charge scheduler
│   │   ├── balanceReminderHandlers.js # Balance reminder EMAIL handlers (autopay/non-autopay T-3, due-today, late t1/t3); registered by the dispatcher at module init (registerBalanceReminderHandlers)
│   │   ├── balanceSmsHandlers.js # Non-autopay balance reminder SMS handlers (due-today, late t1/t3)
│   │   ├── beoFinalize.js      # BEO Finalize/Unfinalize route registrars + ensureNotFinalized guard (mounted into drinkPlans router)
│   │   ├── beoHandlers.js      # BEO dispatcher handler (`beo_unack_nudge_sms`) + scheduling/suppression/reanchor helpers
│   │   ├── bookingWindow.js    # Pure booking-window math (last-minute ≤14-day full-payment-required predicate)
│   │   ├── calcomWebhookHelpers.js # Pure Cal.com webhook helpers (HMAC signature verification, payload normalization) consumed by `server/routes/calcom.js`
│   │   ├── ccWrapUpEmailTemplate.js # wrap-up email subject + html + text renderer (v1 importer deleted; template retained for the drain-only handler below)
│   │   ├── ccWrapUpHandler.js  # post_event_wrap_up_email dispatcher handler, registered at boot in server/index.js (enqueue endpoint deleted with v1; retained to drain scheduled rows)
│   │   ├── payrollGuards.js    # isLegacyCcParticipant (per-proposal stub check, used by payrollAccrual); isLegacyCcStubUser kept for parity
│   │   ├── payrollDeferredRetry.js # Re-runs placement for tips that deferred while the open pay period was frozen (single-flight, attempt-capped); fired off the response path after a successful accrual and from the admin Retry button
│   │   ├── changeRequests.js   # Client-portal change-request helpers: edit-window classifier, field allowlist, proposed-state preview + diff + price preview, and the reaper that auto-cancels pending requests on archive/complete
│   │   ├── changeRequestNotifications.js # Admin alert (new request) + client decision (approved/declined) email + SMS sends
│   │   ├── channelFallback.js  # Channel-substitution decision for single-channel operational touches (picks the live channel when the registered one's status is 'bad')
│   │   ├── clientAutomationSuspension.js # Suspends a client's remaining automation when both email_status and phone_status are 'bad' (sets clients.automation_suspended_at, cancels pending scheduled_messages)
│   │   ├── clientDedup.js      # Find-or-create a client de-duped on email OR phone (name-guarded, backfill-only); the single intake find-or-create
│   │   ├── comms/              # Compose-first client-send registry (backs POST /api/comms)
│   │   │   ├── registry.js     # Auto-discovers actions/*.js at require time; defines + enforces the action contract (resolveRecipient/buildMessages/ensureSideEffects/dispatch)
│   │   │   ├── render.js       # renderPartsEmail: HTML-escapes the editable subject/body prose into the branded email shell (fixed heading + cta)
│   │   │   └── actions/
│   │   │       └── shoppingListApprove.js # shopping_list_approve action: idempotent approve + approved-snapshot side effect, then per-channel dispatch that owns its message_log writes
│   │   ├── consultRecap.js     # Formats saved consult selections into the post-consult email recap
│   │   ├── drinkPlanAccess.js  # Pure post-booking drink-plan access guard (fail-safe pre-booking allowlist)
│   │   ├── drinkPlanNudge.js   # Drink-plan / Potion Planner nudge: email + SMS touch and scheduling
│   │   ├── dripSmsHandlers.js  # Unsigned-proposal drip SMS handlers (touches 1, 3, 5-sms)
│   │   ├── email.js            # Resend email wrapper (send + batch)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js   # Email template helpers (transactional + marketing)
│   │   ├── emailValidation.js  # Warn-only typo-domain heuristic (flags a domain one edit from a common TLD/provider); client twin kept in manual sync
│   │   ├── icsCalendar.js      # iCalendar VEVENT renderer for booking-confirmation .ics attachments
│   │   ├── encryption.js       # AES-256-GCM wrapper for bank PII at rest (fails closed in prod)
│   │   ├── errors.js           # AppError class hierarchy (ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError, PaymentError)
│   │   ├── eventCreation.js    # Auto-create shifts from paid proposals
│   │   ├── eventEveSms.js      # Event-eve SMS touch (T-24h from event start) and timing helper
│   │   ├── eventTypes.js       # Event type id→label resolver (mirrors client)
│   │   ├── fileValidation.js   # Magic-byte file type validation
│   │   ├── geocode.js          # Nominatim geocoding (address → lat/lng)
│   │   ├── globalSearch.js     # Global record search query engine (clients/proposals/events/staff)
│   │   ├── googlePlaces.js     # Google Places venue-search proxy
│   │   ├── drinkPlanExtras.js  # Shared pay-now extras amount helper (computeExtrasBreakdown; mirrors create-intent math)
│   │   ├── invoiceHelpers.js   # FACADE re-exporting the invoice helper siblings below (public interface unchanged)
│   │   ├── invoiceShared.js    # Shared invoice internals (toCents, pool fallback)
│   │   ├── invoiceLineItems.js # Line-item building/writing (generateLineItemsFromProposal, writeLineItems)
│   │   ├── invoiceLifecycle.js # Invoice creation + balance lifecycle (createInvoiceOnSend, createBalanceInvoice, locking, refresh)
│   │   ├── invoiceLinking.js   # Payment->invoice linking (linkPaymentToInvoice: status guard, cap, Sentry breadcrumbs)
│   │   ├── invoiceExtras.js    # "Drink Plan Extras" invoice create/find/refresh/void-reconcile
│   │   ├── lastMinuteAlert.js  # Last-minute (<72h) booking SMS alert dispatch (admin + broad staff blast, idempotent)
│   │   ├── lastMinuteStaffingConfirmation.js  # Touch 2.2: bartender-list renderer + notify fn + atomic-flip trigger
│   │   ├── lifecycleEmailTemplates.js # Lifecycle email templates split out of emailTemplates.js
│   │   ├── staffHiringEmailTemplates.js # Staff/hiring/application email templates split out of emailTemplates.js (re-exported by it for backwards compat)
│   │   ├── messageLog.js      # Append-only client-message ledger: pure builders + logClientMessage (fire-and-forget, never throws) + getMessageLogForProposal; written at the sendEmail/sendSMS choke points, read on GET /proposals/:id
│   │   ├── onboardingProgress.js # ensureOnboardingProgress — lazy progress-row seed for legacy accounts (step writes are UPDATE-only)
│   │   ├── messageScheduling.js # scheduleMessage(...): idempotent insert of a future touch into the scheduled_messages table
│   │   ├── messageSuppression.js # shouldSendImmediate(...): shared archive / comm-prefs / bad-contact gate for immediate-send paths
│   │   ├── refundHelpers.js    # Partial-refund planner (planRefund) + idempotent reconciliation (applyRefundReconciliation, incl. status⟷money + autopay-disarm)
│   │   ├── refundExecute.js    # Shared one-charge refund orchestration (pending row → stripe.refunds.create → applyRefundReconciliation → cleanup); used by the admin refund route AND the cancel-event refund endpoint — the only place stripe.refunds.create is called. Ambiguous Stripe errors (connection/API) leave the row `pending` (not `failed`) so the sweeper can reconcile it against Stripe
│   │   ├── refundSweepScheduler.js # Stale-pending-refund reconciler (sweepStalePendingRefunds): rows `pending` >30 min w/ NULL stripe_refund_id are matched against stripe.refunds.list (by metadata row-id, then unique amount) → adopt via applyRefundReconciliation, or mark failed if the refund never reached Stripe (gated by RUN_REFUND_PENDING_SWEEP_SCHEDULER)
│   │   ├── shiftReap.js        # reapShiftsForProposal: soft-cancels a proposal's shifts, denies open shift_requests, suppresses shift-level pending scheduled_messages + BEO nudges, returns per-shift approved/bartender user ids. Extracted from the cancel flow; shared by cancel AND the archive endpoint (M-1 refund-reap)
│   │   ├── cancellationMath.js # Pure cancellation-refund math (computeCancellationRefund; all CENTS): >14d excess-less-5%-fee + full gratuity, <=14d gratuity-only, DRB full refund
│   │   ├── leadCallBriefing.js # Pure spoken-briefing builder for the lead call bridge (buildLeadBriefing: name/category/Chicago date/guests/city, TTS-friendly, escaping owned by the TwiML layer)
│   │   ├── leadCallTrigger.js  # Lead call bridge trigger + chain driver: triggerLeadCall (webhook post-commit tail: window/config/phone-validation/atomic-24h-cap gates, never throws), advanceChain (claim-then-call ring order ADMIN_PHONE → VA_CELL), sendChainEmail (one lead_call admin email per chain)
│   │   ├── metricsQueries.js   # Pure metrics filter parsing + SQL builders (resolveFilters, dateClause, qMoney, qWinRate, etc.)
│   │   ├── orientationData.js  # Assembles the booking/receipt/planner payload for the orientation email
│   │   ├── pendingCall.js      # VA-calling DB helpers: upsertPending, claimForDial (conditional UPDATE claim-then-call), attachCallSid, lookupTargetByCallSid, countPlacedSince (daily/per-min cap), recordAudit, pruneVaCallingRows
│   │   ├── phone.js            # Save-time phone validation (10 digits, strips country code 1)
│   │   ├── pricingEngine.js    # Pure pricing calculation engine (stamps pricing_snapshot._version)
│   │   ├── pricingSnapshot.js  # PRICING_SNAPSHOT_VERSION + readSnapshot(): tolerant versioned reader every server pricing_snapshot consumer routes through (legacy=v1 tolerated, unknown future version throws)
│   │   ├── proposalInsert.js    # Shared proposals-row + addons INSERT builder (insertProposalRecord); single source of the proposal INSERT shape, used by the manual create route and the Thumbtack auto-draft util
│   │   ├── proposalMoneyShared.js # Shared safeAddonQty + CONTRACT_LABELS (single source; consumed by proposals routes, changeRequests, payrollAccrual, refundHelpers)
│   │   ├── clientSources.js    # Canonical CLIENT_SOURCES / LEAD_SOURCES vocabularies (schema CHECKs + client mirrors point here)
│   │   ├── proposalRules.js     # Server twin of client proposalRules.js + validateProposalRules (authoritative bundle/addon/guardrail gate)
│   │   ├── pushDispatch.js     # Push-channel dispatch (dispatchPushRow): sends Web Push outside any DB transaction, prunes 410/404-dead subs in a short separate transaction (SERVER-17 fix)
│   │   ├── dispatcherDeadLetters.js # Critical-path dead-letter re-resolve sweep (resolveCriticalDeadLetters) split out of scheduledMessageDispatcher.js; called once per tick
│   │   ├── scheduledMessageDispatcher.js # 5-minute scheduler: drains pending scheduled_messages rows, applies suppression, invokes per-message-type handlers
│   │   ├── sendProposalSentEmail.js # Post-commit best-effort client email when a proposal enters the 'sent' state (never throws)
│   │   ├── setupTime.js        # Pure back-of-house setup-time math (parse/subtract, effectiveSetupMinutes); client twin
│   │   ├── potionCatalog.js    # Pure par-catalog slices + ingredient alias resolution (Potions); parity-gated by potionCatalog.test.js
│   │   ├── shoppingList.js     # Shopping-list generator (the ONE generator; consumes potionCatalog slices, legacy-constant fallback); consult-mode branch + buildGeneratorInputFromConsult translator
│   │   ├── shoppingListAddonCoverage.js # Maps active BYOB-support add-on slugs to the shopping-list items those add-ons cover (computeStripSet); generateShoppingList strips that set
│   │   ├── shoppingListGen.js  # Shared helpers: loadCatalog, resolveDrinkIds, matchCustomNames, buildPlannerGeneratorInput, buildConsultGeneratorInput, autoGenerateShoppingList
│   │   ├── sms.js              # Twilio SMS wrapper
│   │   ├── smsDeliveryStatus.js # Twilio delivery-failure handler — flags bad phone numbers (sets clients.phone_status='bad') on hard SMS failures
│   │   ├── smsEventDate.js     # Shared SMS event-date formatter (Date or string to "June 12", null when missing)
│   │   ├── smsInbound.js       # Inbound-SMS processing: keyword/response-code detection, sender lookup, orchestrator
│   │   ├── smsTemplates.js     # Client-facing automated SMS body templates
│   │   ├── staffShiftHandlers.js # Staff-shift SMS: day-before reminder, post-event thank-you, schedule-change/cancel notices
│   │   ├── storage.js          # Cloudflare R2 upload + signed URL helpers
│   │   ├── stripeClient.js     # Central Stripe client factory (test-mode toggle, fail-closed)
│   │   ├── stripePayoutSync.js # Read-side Stripe payout mirror sync: idempotent syncPayout/syncPendingTransactions upserts, matchLine reconciliation, sweep (bootstrap + heal + re-match), atomic failed-payout alert (spec 2026-07-01)
│   │   ├── telegram.js         # Telegram Bot API wrapper (VA calling): sendTelegramMessage/setTelegramWebhook/getTelegramWebhookInfo (raw fetch, no dep), verifyTelegramSecret (constant-time), isNewUpdate (update_id de-dupe)
│   │   ├── thumbtackProposalDraft.js # Thumbtack auto-draft builder (createDraftProposalFromLead) + pure field mappers (event-type keyword map, ET date/time split, admin-notes block)
│   │   ├── tipHandleValidation.js # Validates + normalizes venmo/cashapp handles + paypal.me URLs before persist
│   │   ├── tipPageLifecycle.js # Tip page activate/deactivate transitions on hire/onboarding/offboard
│   │   ├── presence.js         # Pure presence helpers: lead-pointer derivation, taking-leads transition matrix, nudge/flip predicates, Central-time bucketing
│   │   ├── presenceActivity.js # In-memory sign-of-life map + throttled presence_last_seen_at flush (stamped by the auth middleware for tracked users)
│   │   ├── presenceNotify.js   # Dibs-edge ping (fire-and-forget): Telegram/SMS to the user the lead pointer moved off/onto when the fallback owner grabs or releases
│   │   ├── presenceScheduler.js # Presence sweep (15 min): stale-desk nudge (Telegram/SMS, nudged_at stamped only on confirmed send) + race-safe auto-flip to away (RUN_PRESENCE_SCHEDULER)
│   │   ├── presenceStore.js    # Presence DB layer: strip payload + lead pointer, transactional transitions/toggle, log totals, id-scoped applyAutoFlip, stampByNudgePhone
│   │   ├── tipPaymentLinks.js  # Creates/regenerates Stripe Payment Links for bartender tip pages
│   │   ├── tokens.js           # Canonical public-token shape validation: UUID_RE, isUuid, requireUuidToken(param, message) middleware (404s a non-UUID :token before the DB so it can't cast-throw 22P02 -> 500)
│   │   ├── twilioSignature.js  # Shared isValidTwilioRequest (Twilio webhook signature check); policy on failure stays per-router (voice.js dev-allows, voiceLeadCall.js fails closed everywhere)
│   │   ├── urls.js             # Canonical PUBLIC_SITE_URL / ADMIN_URL / STAFF_URL / API_URL resolvers
│   │   ├── usPhone.js          # US/NANP phone validation: toUsE164, isUsE164 (normalizePhone + strict +1 NANP gate, rejects intl + 900/976) — primary VA-calling toll-fraud control
│   │   ├── vaCallingScheduler.js # VA-calling scheduler body: pruneVaCallingRows + checkTelegramWebhookHealth (re-runs setTelegramWebhook + emails admin when the webhook is unset or recently errored)
│   │   ├── venueAddress.js     # Compose/validate structured venue address; derives event_location & shifts.location
│   │   ├── webhookEventsPruneScheduler.js # Hourly prune of `webhook_events` to a 30-day window (gated by RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER)
│   │   └── xmlEscape.js        # Shared TwiML XML escaper (& < >); used by the SMS + voice routes
│   └── scripts/
│       ├── backfillExtrasInvoices.js # One-off: create the "Drink Plan Extras" invoice for an abandoned pay-now PI + cancel stale PIs (idempotent, --dry-run)
│       ├── backfillStripePayouts.js # One-off: full Stripe payout history into the read-side mirror via sweep() (idempotent; aborts in test mode)
│       ├── backfillTipPages.js # One-shot backfill: ensure every active bartender has a tip page row + Stripe link
│       ├── staffPaymentImport/   # Offline one-off pipeline (never imported by the server): parse Venmo/CashApp/Zelle/PayPal exports → classify/cluster → build a human review sheet → single-transaction import into staff_payment_history. Data files live on the share only, never committed (config.js, staging.js, parsers/, dictionary.js, classify.js, eventMatch.js, exportKnownPeople.js, ccReports.js, buildReviewSheet.js; importFromSheet.js/reconcile.js/verifyImport.js land with the import lane)
│       └── archive/               # One-time migrations (already run, kept for history)
│           ├── importBlogPosts.js
│           └── migrateBlogBodies.js
├── client/
│   ├── src/
│   │   ├── App.js              # All routes, auth guards (ProtectedRoute, RequireHired, etc.)
│   │   ├── context/
│   │   │   ├── AuthContext.js       # Staff/admin auth state (login, logout, user)
│   │   │   ├── ClientAuthContext.js # Client auth state
│   │   │   ├── PaletteContext.js    # openPalette() for any admin surface; provided by AdminLayout
│   │   │   ├── ToastContext.js      # ToastProvider + useToast() hook
│   │   │   └── UserPrefsContext.js  # Per-user admin OS prefs (skin/density/sidebar) — strips on logout
│   │   ├── utils/
│   │   │   ├── api.js          # Axios instance with JWT interceptor
│   │   │   ├── buildTipDeepLink.js # Builds Venmo/CashApp deep links + Stripe fallback URL for tip pages
│   │   │   ├── clientSources.js # Canonical client source list (mirrors schema CHECK + server VALID_SOURCES)
│   │   │   ├── constants.js    # App-wide constants
│   │   │   ├── emailValidation.js # Warn-only typo-domain heuristic (manual-sync mirror of server/utils/emailValidation.js)
│   │   │   ├── eventTypes.js   # Event type id→label resolver (mirrors server)
│   │   │   ├── formatDelta.js  # Shared change-request dollar-delta formatter (admin queue/card + public portal form)
│   │   │   ├── formatMoney.js  # Integer-cents → human dollar string (e.g. `1234` → `$12.34`, `123456` → `$1,234.56`); canonical client-side money formatter for staff portal Pay surfaces
│   │   │   ├── proposalStatusMap.js # Shared proposal status → {label, kind} map (single source for admin status chips)
│   │   │   ├── drinkPlanStatusMap.js # Shared drink-plan status → {label, kind} map
│   │   │   ├── formatPhone.js  # Phone number formatting
│   │   │   ├── leadSources.js  # Lead source enum (mirrors schema CHECK + server validator)
│   │   │   ├── messageTypes.js # Display-only message_log label map (messageTypeLabel) for the event-detail Messages card; falls back to the stored subject for untagged sends
│   │   │   ├── proposalRules.js # Shared client proposal business rules (bundle/addon/guardrail logic); CJS twin at server/utils/proposalRules.js
│   │   │   ├── servingLabels.js # Serving-type display labels (SERVING_LABEL + servingLabel); shared by DrinkPlansDashboard + Potions PlansDrawer
│   │   │   ├── setupTime.js    # Back-of-house setup-time formatting (twin of server/utils/setupTime.js)
│   │   │   ├── timeOptions.js  # Time option generator + 12h formatter + input parser
│   │   │   └── tipCardMarks.js # Derives printable QR-card payment marks from saved handles (Stripe link + handles → mark list)
│   │   ├── components/         # AdminLayout, Layout, PublicLayout,
│   │   │                       # InvoiceDropdown, SignaturePad, FileUpload, DrinkPlanCard,
│   │   │                       # PricingBreakdown, RichTextEditor, LeadImportModal, MenuSamplesModal,
│   │   │                       # AudienceSelector, SequenceStepEditor, CampaignMetricsBar, SyrupPicker,
│   │   │                       # TimePicker, NumberStepper, Toast, FormBanner, FieldError, ScrollToTop, SessionExpiryHandler,
│   │   │                       # VenueAddressFields (structured venue address — sign+pay gate & admin edit),
│   │   │                       # VenueSearchInput (venue-name typeahead (Google Places)),
│   │   │                       # ClickableRow (table <tr> wrapper: plain click navigates, drag selects/copies text),
│   │   │                       # RowLink (real-anchor wrapper for a ClickableRow's primary cell: ctrl/cmd/middle-click opens a new tab natively),
│   │   │                       # EntityLink (quiet inline entity reference: real anchor, inherits color, hover underline; nullish `to` renders children unlinked),
│   │   │                       # AddonControls (shared add-on UI controls: quantity stepper + greyed bundle badge, used by ProposalCreate + ProposalDetailEditForm),
│   │   │                       # admin/SourceBadge (small "Thumbtack" origin badge next to a proposal's client name when source='thumbtack'),
│   │   │                       # StaffShell + StaffShellWithThemeWiring (staff portal v2 layout shell — bottom tab bar + user pill, outlet for routed pages),
│   │   │                       # StaffUserPillMenu (account-pill dropdown rendered by StaffShell)
│   │   │   ├── staff/          # Staff portal redesign shared components (Placeholder; ShiftCard; TeamRosterCard; DropCoverModal; BeoSections; PayoutEventRow; LogisticsTag; RoleRankPicker; RequestSheet)
│   │   │   ├── adminos/        # Admin OS shell + primitives (Sidebar, Header, CommandPalette, Drawer,
│   │   │   │                   # GlobalSearchButton (search-bar-shaped button that opens the ⌘K command palette; header + toolbar),
│   │   │   │                   # StatusChip, StaffPills, RainbowDefs, Toolbar, Icon, KebabMenu, SortableTh (clickable sort headers), AddressLink,
│   │   │   │                   # InterviewScheduleModal, PackageIncludesModal, DocumentPreviewModal (in-app lightbox for staff docs — W-9/BASSET/resume/headshot), MetricsFilterBar,
│   │   │   │                   # format, nav, shifts, PresenceStrip (sidebar time-clock strip);
│   │   │   │                   # drawers/{InvoicesDrawer,ShiftDrawer,PresenceDrawer})
│   │   │   ├── SendModal/      # Shared compose-and-confirm modal for the comms registry (previews server-resolved recipient + channels, admin edits subject/body, sends with honest per-channel results); used by ShoppingListModal approve
│   │   │   ├── ShoppingList/   # Shopping list editor modal + PDF export + ConsultationForm (generation is server-side via the regenerate endpoint) + NeedsRecipeSection (client-requested-drink recipe drawer: reuse-before-create, inline fold-in via regenerate, unresolved-ingredients warning)
│   │   │   ├── potions/        # RecipeEditor: shared structured-recipe editor (Recipes tab detail pane + shopping-list Add-recipe drawer; draft name editing, inline add-par, forwardRef flush)
│   │   │   └── MenuPNG/        # Standard Menu PNG export (html2canvas-driven, lazy-loaded; renders hidden MenuPreview at print scale 768x960 and downloads as 2304x2880 PNG)
│   │   ├── data/               # Shared data (addonCategories, eventServicesAgreement, eventTypes, menuSamples, packages, syrups)
│   │   ├── hooks/              # Custom hooks (useDebounce, useDrawerParam + drawerHref, useFormValidation, useWizardHistory, useMetricsFilter, useUrlListState (URL-backed list/tab/filter view state))
│   │   ├── pages/
│   │   │   ├── (auth)          # Login, Register, ForgotPassword, ResetPassword
│   │   │   ├── (onboarding)    # Welcome, FieldGuide, Agreement, ContractorProfile, PaydayProtocols, Completion
│   │   │   ├── (staff)         # Application, ApplicationStatus, HiringLanding, PreHireOnboarding (open pre-hire URL)
│   │   │   ├── (admin)         # AdminDashboard (AdminUserDetail moved into admin/userDetail/, AdminApplicationDetail moved into admin/applicationDetail/)
│   │   │   ├── admin/          # Dashboard sub-pages (PotionsPage bar-program home at /potions with potions/ RecipesTab + PantryParsTab + PlansDrawer siblings, proposals (ProposalCreate cockpit split into proposalCreate/ with ClientSection + EventSection + PackageSection + AddonSection + shared helpers.js Lbl), clients, events, EventDetailPage, shifts, staff, menus, hiring, blog, email marketing, Messages admin SMS conversation/thread page, TipsAdmin tip overview, userDetail/tabs/TipPageTab admin tip-page controls, applicationDetail/, NotificationSettings per-user notification-subscription toggles, ProposalChangeRequestCard client-portal change-request review card on Proposal Detail (diff, preview, apply-in-editor, decline), AlternativesPanel option-group manager on Proposal Detail (add/remove alternatives, Send options, copy compare link), ChangeRequestsDashboard admin pending-requests queue at /change-requests, eventDetail/MessageLogCard newest-first client message log (email + SMS, sent/failed) on EventDetailPage, payroll/PayRunView open-period pay-run queue (stat strip + period cards with process/reopen) + payroll/PayPanel per-payout generate-gated method-aware pay panel (replaced PayQRModal + MarkPaidAction + PayrollHeader, all three deleted), payroll/DeferredTipsPanel admin list + Retry button for tips/clawbacks that deferred while the open pay period was frozen, StripePayoutsTab Stripe payout reconciliation tab on the Overview Payouts tab, payroll/TaxTotalsTab 1099 calendar-year totals tab with per-person include/exclude toggle + CSV export, userDetail/tabs/PayoutsTab imported payment-history section + blended all-time total, CancelEventDialog 3-step cancel-booked-event modal on Proposal Detail + Event Detail: mode radio → server-computed preview → typed-last-name arm + suppress toggles, then a distinct Issue-refund action)
│   │   │   │   └── overview/    # Overview money board (Dashboard + Financials merged into one surface at /dashboard; /financials and /financials?tab=payouts redirect here). OverviewPage composes the Band 1 live triage (NeedsYouStrip = the tabbed Needs-attention card: Staffing / Prep / Clients / Money tabs plus a conditional Sales tab, headers carrying count + worst-priority dot; PayrollStatus is the Money tab's absorbed payroll status block, admin-only; PipelineCard sits beside the card; the upcoming-events card was scrapped 2026-07-13, /events covers it) and the Band 2 filtered analysis (MoneyTiles = expandable stat tiles Close rate / Collected / Outstanding / Avg event / Lead spend; RevenueChartCard; FunnelCard with the Split control; LeadSpendCard; RangeTables = proposals + payments in range). queueItems builds the staffing/clients/sales/payouts items + tab assembly (pure, unit-tested); PrepQueue builds the drink-plan queue items.
│   │   │   ├── staff/          # Staff portal — the live v2 portal, mounted at root on staff.drbartender.com (HomePage, ShiftsPage + ShiftDetail, PayPage + PayoutDetail, TipCardPage, EmailVerifyPage email-change confirm) + PrintTipCard printable QR card (PrintTipCard.jsx + PrintTipCard.layouts.jsx + PrintTipCard.css)
│   │   │   │   └── account/    # AccountPage shell + sub-nav with ProfileSection, PaymentMethodsSection (+ PaymentMethodRows + AddMethodModal), CalendarSyncSection, NotificationsSection (+ IOSCoachmark + PushPermissionBanner), DocumentsSection (+ ReplaceConfirmModal)
│   │   │   ├── plan/           # PotionPlanningLab, public post-booking event questionnaire (single flow, created only after deposit; with steps/, components/, data/; components/ScopeBanner + components/WelcomeRoadmap + components/MenuPreview + components/LogoUploadField = apothecary-reskin + Standard Menu shared UI; steps/HostedGuestPrefsStep.js = compact hosted-package guest-preferences step; data/packageGaps.js = hosted-package gap helpers, packageGaps.test.js = Jest test; data/menuSections.js = Standard Menu section extractor with menuSections.test.js Jest unit suite)
│   │   │   ├── invoice/        # InvoicePage — public token-gated invoice view + payment
│   │   │   ├── proposal/       # ProposalView (public client-facing) — split into proposalView/ folder (parent + ProposalHeader + ProposalPricingBreakdown + SignAndPaySection + PaymentForm + AgreementText markdown-lite renderer + helpers + styles) + compare/ (ProposalCompare thin wrapper for the option-group page at /compare/:token + PackageMatrix aligned live-priced compare grid, also exported as ExplorePackagesSection = the in-proposal "explore packages for your event" section)
│   │   │   ├── public/         # Client portal (ClientLogin, ClientShoppingList, Blog, BlogPost) + tip flow (TipPage with TipPage.atoms.jsx + TipPage.css, TipPageThanks post-tip feedback)
│   │   │   │   └── portal/     # Client Portal v2 — PortalHome (landing), EventCommandCenter (focus shell), OverviewWidgets, ArchiveList, ShareButton, EmptyStates, ChangeRequestForm (request-a-change form with live price preview), money/nextUp/constants helpers + tabs/ (OverviewTab, PrescriptionTab, PotionTab, ReceiptsTab, ChangeRequestBanner pending/decided status banner on the Prescription tab)
│   │   │   └── website/        # Public website (HomePage, ServicesPage, PackagesPage, MethodPage, AboutPage, FaqPage, QuotePage, ClassWizard, quoteWizard/ — split QuoteWizard with steps/extras/ (AddonTile + BundlePicker + AddonAccordion) for the Extras step redesign)
│   │   ├── images/             # Brand assets
│   │   └── index.css           # Global styles
│   ├── vercel.json             # SPA rewrite rule for Vercel
│   └── package.json            # React deps, proxy: localhost:5000
├── scripts/                    # Build + workflow scripts (check-file-size.js, optimize-assets.js, worktree-new.js, worktree-rm.js)
│   │                           # think-on-main/build-in-lanes tooling (each with a co-located *.test.js where noted):
│   │                           #   guard-os-main.sh (+ .test.js)   : pre-commit os-stays-on-main guard
│   │                           #   merge-lane.sh (+ .test.js)      : flock'd squash-merge wrapper
│   │                           #   board-write.sh (+ .test.js)     : atomic build-board writer with PII denylist
│   │                           #   lane-status.js (+ .test.js)     : open-lane listing + stale-lane detection (npm run lane:status)
│   │                           #   sensitive-paths.txt             : the one sensitive-path list (review/conflict/auto-pull trigger)
│   │                           #   sensitive-match.js (+ .test.js) : matcher that reads sensitive-paths.txt
│   │                           #   testdb-smoke.js                 : pre-push money-smoke gate (npm run test:smoke); resets Neon ci-smoke + runs the money suites (see README > Test gate)
│   │                           #   money-smoke-list.txt            : the money-path suite list testdb-smoke.js runs
│   │                           #   check-claudemd-invariants.sh    : paired keyword/regex coverage check over CLAUDE.md
│   │                           #   claudemd-invariants.txt         : the invariant manifest it checks
│   │                           # one-time CheckCherry migration operator scripts (phases 1-3, each with co-located tests):
│   │                           #   cc-clients-import.js            : 187 CC clients (dry-run default, cc_id idempotency)
│   │                           #   cc-ledger-import.js             : frozen CC-era ledger load (P&L penny-tie gates, double-count guard, transfer skip)
│   │                           #   cc-transfer-events.js           : future CC events -> native proposals (manifest-driven, born-confirmed, comms-guarded, --resume)
├── docs/                       # Project docs: build-board.md (Claude-maintained ready/in-flight/shipped index), ops-runbook.md, tech-debt.md,
│                               # client-portal-v2-project.md, staff-portal-beo-project.md, open-threads.md, superpowers/{specs,plans}/
├── .claude/agents/             # Claude Code review agents (7 agents)
├── .husky/pre-commit           # Pre-commit hook, four steps: docs-drift check + file-size ratchet + lint-staged + os-stays-on-main guard (scripts/guard-os-main.sh)
├── .env.example                # Environment variable template
├── eslint.config.mjs           # ESLint flat config + security plugin
├── package.json                # Server deps + npm scripts
└── render.yaml                 # Render deployment blueprint
```

## NPM Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Express (nodemon) + React dev server concurrently |
| `npm start` | Start Express in production mode |
| `npm run build` | Build React frontend to `client/build/` |
| `npm run install:all` | Install both server and client dependencies |
| `npm run seed` | Create admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD` |
| `npm run admin:create` | Promote an existing user to admin (or create one) from `ADMIN_EMAIL`/`ADMIN_PASSWORD` |
| `npm run lint` | Run ESLint on all server code |
| `npm run lint:fix` | Run ESLint with auto-fix on server code |
| `npm run test:smoke` | Run the pre-push money-path smoke gate manually (`scripts/testdb-smoke.js`): reset the isolated Neon `ci-smoke` branch, apply the schema, and run the money suites serially. No `NEON_API_KEY` → prints a loud SKIP banner and exits 0. See [Test gate](#test-gate). |
| `npm run audit:check` | Check for known dependency vulnerabilities |
| `npm run check:filesize` | Report every source file by line-count zone (RED over 1000, YELLOW 700-1000) |
| `npm run mobile:check` | Dev-only phone-viewport (390x844) screenshot + overflow probe of every client-facing surface (`scripts/mobile-capture.js`); merge gate for the mobile-fixes lanes. EXPECTED to stay red on main until the mobile-sweep lane lands: the baseline failures are the audited P0s, not regressions |
| `npm run optimize:assets` | One-shot asset optimization (PNG→WebP at tile size, TTF→WOFF2). Idempotent — skips already-converted outputs. |
| `npm run worktree:new -- <name>` | Create a parallel-dev worktree at `../worktrees/<name>` on a new branch off `main`, with `node_modules` + husky symlinks wired up |
| `npm run worktree:rm -- <name>` | Tear down a worktree: remove its symlinks, the worktree, then the branch (`--force` to discard an unmerged branch) |
| `npm run lane:status` | List open lanes (worktrees) and flag stale ones (48h no-commit, 15+ main commits since cut, or a sensitive path landed on main since cut); run at session start and in the push sweep |

## Key Features

### Potions (Bar Program)
- One admin home at `/potions` for the drink program: Menu (published catalog), Recipes (structured per-serving formulas per drink), Pars (the single par catalog with per-item call-on conditions), plus a client-plans review drawer
- The shopping-list generator reads the live par catalog and recipes; generic recipe ingredients ("vodka") resolve to recommended purchasables ("Tito's Vodka") through catalog aliases
- Client custom drink requests match recipes by normalized-exact name; unmatched requests surface as "recipe needed" and admins grow the catalog by adding off-menu recipes

### Contractor Application & Onboarding
- Multi-step application form with file uploads (resume, headshot, BASSET cert)
- Admin review workflow with interview notes and status transitions
- 6-step onboarding flow for hired contractors: Welcome → Field Guide → Agreement (digital signature) → Profile → Payment Setup (W-9) → Complete
- Progress tracking across steps

### Service Proposal System
- Public packages/pricing page at `/packages` (marketing nav beside Services): renders every active non-class package from the live `/api/proposals/public/packages` endpoint, grouped as BYOB, Hosted Beer & Wine, Hosted Full Bar, and Hosted Mocktail, with a "from $X" price per package and slug-keyed included sections from `client/src/data/packages.js` (a package missing from that catalog renders name + description only). States the hosted 25-guest / $550 minimum once; Services + FAQ pricing copy point here to kill price drift
- 12 service packages across BYOB and Hosted categories
- 18 add-on services with per-guest, per-hour, flat, and timed billing
- Dynamic pricing engine that calculates staffing, bar rental, and add-on costs
- Client-facing proposal view via UUID token URL
- Combined contract signing + payment on a single screen
- Payment options: pay $100 deposit or pay in full
- Checkout gratuity: clients choose a tip jar and optional pre-paid gratuity at sign-and-pay (admins can preset it on a proposal); it scales with crew and hours and flows to staff through payroll
- Autopay enrollment: clients can opt to have their remaining balance auto-charged on the due date (default: 14 days before event)
- Admin-overridable balance due dates
- Hourly autopay scheduler charges saved payment methods when balance is due
- Proposal options / compare: admin sends a client 2-3 alternative proposals (say, BYOB next to Hosted) behind ONE `/compare/:token` link with side-by-side package contents; the client chooses and signs/pays on that option's normal page; the first settled payment locks the winner (first-writer-wins), archives the other options, and voids their unpaid invoices. Grouped sends go out as a single "Compare your options" email with per-option comms suppressed and invoicing deferred to the winner's payment. The compare view is an aligned matrix (rows = price for this event, deposit, hosted-minimum note, catalog sections; columns = packages) that renders each option's STORED total/deposit and snapshot floor fields (an option's stored total includes addons, adjustments, and overrides: the number the client actually pays), collapsing to stacked cards under 640px. Any single pre-booking proposal NOT in an option group can also open an "explore packages for your event" matrix of every active non-class package priced live at its own guests/hours via `POST /public/calculate` ("I want this one" opens a prefilled email, never a silent swap); a booked client can request a package swap through the change-request form (priced through the existing change-request pipeline, with the admin review card resolving package ids to names).
- Automatic alternative cleanup: a client's FIRST settled payment also archives their other open, unpaid proposals (loose ungrouped alternatives, not just formal comparisons) as `option_not_chosen`; later balance/extras payments never touch them. Admin can archive manually from Proposal Detail, with a scope popup (just this proposal, or the client's whole open set) when other open proposals exist.

### Event Planning (Potion Planning Lab)
- Public questionnaire sent to clients via unique token link
- Clients select cocktails, mocktails, and serving preferences
- Admin review dashboard
- **Shopping List Generator**: On any drink plan with a generated list, admin clicks "Shopping List" to open an editable modal pre-populated with scaled quantities (100-guest pars × actual guest count). Add/remove items, change quantities, then download a branded PDF. Signature cocktail ingredients are automatically merged into the list. Cocktail ingredients are managed in the Drink Menu admin. The client-facing shopping-list page (`/shopping-list/:token`) offers the same branded PDF as a download (identical generator, lazy-loaded), so clients can save it or forward it to whoever is doing the shopping.
- **Consultation Form (admin input path)**: When a client gives drink-plan info via phone or email instead of filling out the planner, admin clicks "Input from consult" on the drink plan detail page to open an abbreviated form: bar type, spirits chip grid, sigs picker + custom drinks, optional mocktails, beer y/n, wine red/white/sparkling, mixers (full / matching / none), notes. Submitting generates a real shopping list — same approve+email+public-token flow as a planner submission. When both planner and consult data exist on the same plan, a source toggle on the detail page picks which one feeds the generator.

### Proposal → Event Pipeline
- When a client signs the contract and pays (deposit or full), a shift is automatically created
- Shift is populated from proposal data (event type, date, time, duration, location, bartenders needed)
- Staff can immediately see and request the shift
- Admin can also manually trigger shift creation via `POST /api/proposals/:id/create-shift`
- Once paid, proposals automatically transition out of the Proposals dashboard and into the Events dashboard
- Events dashboard shows clean, scannable event cards with staffing fill status; click to open event detail
- Event detail page is a control-panel-style dashboard with: event overview (date with day of week, service time with end time, location, guests, client), full staffing management (equipment config, auto-assign, shift requests with approve/deny/reset), package & pricing, payment status, drink plan, and activity log

### Auto-Assign Staffing
- Intelligent shift auto-assignment based on seniority (events worked + tenure), geographic proximity, and equipment match
- Admin can click "Auto-Assign" on any shift to preview ranked candidates with scores, then confirm to approve
- Per-shift configuration: required equipment (portable bar, cooler, table) and scheduled auto-assign days before event
- Scheduled auto-assign runs hourly for shifts approaching their event date
- Seniority scores are adjustable per staff member (admin can boost/reduce via manual adjustment)
- Geocoding via Nominatim: staff addresses and event locations are automatically geocoded for distance calculations
- Equipment constraint: at least one approved staff member must have required equipment or be willing to pick up from storage
- Configurable algorithm weights and max distance in Settings > Auto-Assign

### Admin Dashboard
- **Global Search**: A `Cmd/Ctrl+K` command palette on every admin page searches clients, proposals, events, and staff by partial name, phone number, or email, and jumps straight to the matching record.
- **Presence tracker**: Desk/available/away strip at the top of the sidebar with a derived "Leads →" pointer (who answers the next lead), an admin-only time-clock drawer with weekly/monthly totals, and a stale-desk nudge (Telegram for Zul, SMS for Dallas) that auto-flips ignored desks to away so totals stay honest.
- **Staffing**: Application review, hire/reject, interview notes, user management, SMS messaging (compose, recipient picker, shift invitation templates, grouped message history)
- **Proposals**: Create, price, send, track views/signatures — paid proposals automatically move to Events
- **Partial Refunds**: Admin partial refunds via Stripe — Approach-A `total_price` correction + audit ledger (`proposal_refunds`), idempotent `charge.refunded` webhook-backstopped
- **Clients**: CRM with source tracking (direct, Thumbtack, referral, website)
- **Drink Plans**: Auto-created when proposals become events; accessed from event detail page; client receives email with questionnaire link
- **Drink Menu**: Manage 25 cocktails + 16 mocktails across categories
- **Events**: Paid proposals become events; list view shows scannable cards, detail view is a full dashboard with staffing management, equipment config, auto-assign, payment, and drink plan
- **Messages log**: Every client-facing email and SMS is recorded at the `sendEmail`/`sendSMS` choke points and shown newest-first on the event detail page, with sent/failed status so a silent send failure is visible
- **Overview money board**: Dashboard + Financials merged into one surface at `/dashboard` (nav label "Overview"); `/financials` redirects here. Band 1 live triage (Needs-you, upcoming events, pipeline) plus Band 2 filtered analysis (stat tiles, revenue chart, funnel, lead spend, proposals/payments in range) where every number links out with pre-applied filters or expands in place. **Settings**: Placeholder tab ready for expansion
- **Stripe payout tracking**: bank-level reconciliation tab on the Overview Payouts tab (read-side mirror of Stripe payouts + balance-transaction lines, in-transit bucket, fee rollups, failed-payout email alert)
- **Payroll pay run**: the Payroll page leads with a queue of every unpaid period (process/reopen lifecycle per card) and a per-payout, generate-gated pay panel: QR codes for Venmo/Cash App, a prefilled PayPal link, chase.com plus copy affordances for Zelle/bank/check, with the amount locked at generate (server drift guard) and an optional payment reference recorded at mark-paid

### Client Portal Editing Model
- Clients request booking changes from the portal (guest count, hours, package, add-ons, event date, venue) via a form with a live price preview powered by `POST /api/client-portal/proposals/:token/calculate`.
- Submitting a request writes a pending row to `proposal_change_requests` (the consent contract: snapshot of requested changes, baseline, computed edit window, acknowledged total, IP + user agent); admin is notified by email + SMS via `notifyAdminCategory`.
- A pending/decided banner on the Prescription tab tracks the request; clients can withdraw a pending request from the portal.
- Admin reviews pending requests in a queue at `/change-requests` and on a card on Proposal Detail (`ProposalChangeRequestCard`) showing the diff, price preview, and an "Apply in editor" affordance that round-trips through the existing proposal editor.
- Applying is atomic: `PATCH /api/proposals/:id` accepts an optional `change_request_id` that stamps the linked request `approved` in the same transaction as the edit, suppresses the standard admin edit email (the decision email covers the client), and runs the existing money + status reconciliation.
- Admin can decline with a required reason; the client gets an emailed decision (approved or declined) with the note.
- Archive or complete on a proposal auto-cancels any open pending request via the reaper in `server/utils/changeRequests.js`.
- Self-serve never moves money: the client action is a request, not an edit; admin keeps the only path to the editor and to refunds.

### Cancel Booked Events
- Admin-only, from the Proposal Detail / Event Detail action menu on booked events (`deposit_paid` / `balance_paid` / `confirmed`). Three-step `CancelEventDialog`: who cancelled (client vs Dr. Bartender), a server-computed consequence preview, then a typed-last-name arm with per-cancellation suppress toggles.
- Agreement math (`server/utils/cancellationMath.js`, all CENTS from invoice/payment rows): client cancel >14 days refunds the non-retainer excess less a 5% fee plus the full gratuity paid; client cancel ≤14 days refunds gratuity only; Dr. Bartender cancel refunds everything paid including the retainer.
- One transaction archives the proposal (`archive_reason` `client_cancelled`/`we_cancelled`, `cancelled_at`/`cancelled_by`/`cancellation_note`), cancels linked shifts, deletes pending scheduled comms, and voids unpaid invoices. A cancel-time tip clawback runs idempotently (marker-coordinated with the `charge.refunded` webhook so a later refund can't double-claw); frozen pay periods defer the clawback.
- The refund is a separate explicit action (`POST /api/proposals/:id/cancel/refund`), looping the shared `refundExecute` per charge largest-first (deposit + balance) with per-row `gratuity_cents` attribution. Refunded money is not income (the standard reconciliation nets it out); the original contract total is preserved in the audit note.

### Tip QR Pages
- Each onboarded bartender gets a public token-gated tip page (`/tip/:token`) with their photo, name, and tip buttons
- Tip buttons deep-link to Venmo and Cash App when the bartender has those handles set, plus a Stripe Payment Link fallback that flows to the bartender's Stripe Express account
- Stripe Payment Links are auto-provisioned (and regenerated on demand) via `server/utils/tipPaymentLinks.js`; tip flow is recorded in the `tips` table on `checkout.session.completed` (branched by `metadata.kind = 'tip'`)
- After tipping, guests land on a thank-you page that nudges a Google review and offers an optional bartender feedback form (`tip_page_feedback` table; admin reviews in TipsAdmin)
- Bartenders manage their tip page from the staff portal Tip Card tab (`TipCardPage`) and can print a QR card (`PrintTipCard`) for events
- Admins audit tip pages, regenerate Stripe links, and review tip activity from `TipsAdmin` and the `TipPageTab` on the user detail page
- Tip page lifecycle (activate on hire, deactivate on offboard) is centralized in `server/utils/tipPageLifecycle.js`; `server/scripts/backfillTipPages.js` ensures every active bartender has a row + Stripe link

### SMS Messaging
- Send SMS to one or more staff members from the admin dashboard
- Shift-based invitation templates for quick event staffing outreach
- Grouped message history with per-recipient delivery tracking
- Per-user message history on individual staff profiles
- Filters by SMS consent — only staff who opted in are eligible
- Two-way SMS: Twilio inbound webhook, STOP/START opt-out, staff CONFIRM/CANT response codes, admin Messages thread UI
- Client-facing automated SMS: initial-proposal, sign+pay confirmation, unsigned-proposal drip (touches 1/3/5), drink-plan nudge, balance due-today and late-balance reminders, payment-failure alert, event-eve reminder, and reschedule notification, sent via Twilio and logged to sms_messages.
- Notification infrastructure: per-channel daily overlap prevention, delivery-failure channel fallback, multi-admin notification subscriptions.

### Compose-and-Confirm Client Sends
- Admin-triggered client sends (starting with shopping-list approval) route through a shared compose-and-confirm modal. The admin reviews the server-resolved recipient and available channels, edits the subject and body before anything goes out, then cancels or sends. A Cancel never touches the client record. On send, each channel returns an honest result (for example email sent, SMS failed) instead of one all-or-nothing status, and every attempt writes a `message_log` row recording the sending admin (`sent_by`) and whether the copy was hand-edited (`body_edited`).

### Lead Call Bridge (real-time first-ring)
- A new in-window (8am-9pm Chicago) Thumbtack lead auto-rings Dallas from the 888 with a spoken briefing (name, event, date/time, guests, city); press 1 bridges to the lead from the 224, press 9 replays, no answer fails over to Zul
- Missed/failed chains email the `lead_call` category and land in the follow-up log (`lead_call_attempts`); a 20-second bridge floor keeps relay refusals from marking a lead contacted
- Kill switch `LEAD_CALL_ENABLED=false`; rolling-24h `LEAD_CALL_DAILY_CAP`; lead legs only ever dial `toUsE164`-validated US numbers; overnight leads log only (the auto-draft proposal already answered in-platform)

### Cal.com Consult Booking Integration
- **Cal.com consult booking integration**: webhook receiver auto-creates clients on first booking, flips consult status on form-submit, surfaces public booking URL in client comms.

### BEO (Banquet Event Order)
- Admin Finalizes a reviewed drink plan via the DrinkPlanCard, locking every mutation route on the plan (status, notes, shopping list, logo, consult, source flip, delete) until Unfinalize.
- On Finalize, BEO nudge rows are scheduled to fire 3 days before the event for every approved staffer on every non-cancelled shift; a late assignment after Finalize back-fills its own nudge via `scheduleStaffShiftMessages`.
- Each staffer opens the BEO from the staff portal, sees event details + drink menu + add-ons + logistics + custom-menu logo + special notes, and confirms read-receipt with one tap (`POST /api/beo/:proposalId/acknowledge` stamps `shift_requests.beo_acknowledged_at`).
- Per-staffer "Confirmed [time]" pills surface on the admin EventDetailPage so the operator knows at a glance who has read the BEO.
- Reschedule, cancellation, denial, and re-assignment all cascade into the nudge queue: pending rows are reanchored, suppressed, or recreated as needed, with a NOT EXISTS guard so a staffer covered on multiple shifts keeps their nudge.

### Shifts & Profile
- View available shifts and request assignments. Each shift derives a per-role roster (bartenders + banquet servers + barbacks) from the paid proposal; the staff feed shows per-role fill ("Bartender 2/2 · Banquet Server 0/1") with an "Available" vs "All" tab split.
- Ranked role requests: a staffer picks and orders the roles they can work; the canonical role is resolved and written at admin approval (never silently defaulted to Bartender). A request whose ranked roles are all full is a computed waitlist (self-serve "Leave waitlist"), with a low-key waitlist-join email sent once on the transition in.
- Logistics gating: each shift shows a green "Bar Kit Only" tag or an equipment/supply warning; a transport-required shift (gear haul or supply run) makes the staffer acknowledge the requirement before requesting, and admins edit equipment + supply-run per shift.
- Profile and notification management

## Deployment

### Backend — Render
The `render.yaml` blueprint defines the web service and PostgreSQL database. Push to `main` auto-deploys.

### Frontend — Vercel
The React app is deployed separately on Vercel. `client/vercel.json` handles SPA routing. The build-time `REACT_APP_API_URL` points to the Render backend.

### Database
Schema is auto-initialized on server start via `server/db/index.js`, which runs `schema.sql`. All DDL is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

### Test gate

Because a push to `main` **is** the deploy, `.husky/pre-push` is the only place that can actually block a bad deploy. Two mechanical gates run there:

- **Money smoke** (when the push touches `server/` or `scripts/money-smoke-list.txt`) — runs first. It resets the isolated Neon `ci-smoke` branch (a prod-parented copy) to its parent, fetches its connection URI, runs `initDb` against it (which also validates any `schema.sql` change *before* prod boot replays it), then runs the money-path suites in `scripts/money-smoke-list.txt` serially (payroll accrual/clawback/late-tip, autopay durable trio, Stripe webhook guards + last-minute checkout, refunds/invoice lifecycle — ~60s total). Any failure blocks the push. Slow, rate-limiter-bound suites are deliberately excluded.
- **Client build** (when the push touches `client/`) — the exact `CI=true react-scripts build` Vercel runs, catching CI-fatal ESLint warnings.

Server-only or docs-only pushes skip the client build; client-only or docs-only pushes skip the money smoke.

**Credential — `NEON_API_KEY`.** The money smoke reads the key from `process.env.NEON_API_KEY` or `~/.secrets/neon_api_key` (trimmed). **Until the key exists the gate prints a loud red "MONEY SMOKE SKIPPED — not yet blocking" banner and allows the push** (fail-open, so pushes are not bricked before setup). The gate must run from a checkout with `.env` at the repo root (several suites need `JWT_SECRET` + Stripe test creds); pushes happen from `os`, which always has one. Once the key is present the gate is **hard and fail-closed**: any error in the reset / URI / `initDb` step, or any failing suite, blocks the push. To set it up:

1. `console.neon.tech` → account settings → **API keys** → **Create API key**.
2. Save it: `mkdir -p ~/.secrets && printf '%s' '<key>' > ~/.secrets/neon_api_key && chmod 600 ~/.secrets/neon_api_key` (no trailing newline needed — the runner trims). Never commit it.

The connection URI and the API key are never printed (masked in every error). Run it manually any time with `npm run test:smoke`.

**Emergency escape:** `git push --no-verify` bypasses both gates (deliberate, per-push, visible) — same as the client build gate.

## Operational Runbook

### Weekly dispute-email-bailout sweep

The dispute-won email notification (fires on Stripe `charge.dispute.funds_reinstated`) auto-abandons after 3 failed send attempts. The DB column `tips.dispute_email_failed_at` is the canonical "needs manual reconciliation" marker; the accompanying Sentry alert is best-effort.

**Weekly:** run the sweep query documented in `ARCHITECTURE.md` ("Weekly dispute-email-bailout sweep") to catch any abandonment whose Sentry alert was lost. The spec at `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md` carries the recovery runbook.
