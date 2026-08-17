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
| WebAuthn | `@simplewebauthn/server` + `@simplewebauthn/browser` for phone-admin passkey unlock (12h device session) |
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
| `RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER` | No | Set to `false` to disable the 60-second service-extension expiry sweep (expires a pending request past its grace window, voids its invoice, sends the staff decline; also heals settled-but-unfinalized rows). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_SHIFT_CLOSURE_SWEEP_SCHEDULER` | No | Set to `false` to disable the hourly shift-closure sweep: closes a shift to `completed` once the SHIFT's end instant has passed and its proposal is `completed`. Never writes `cancelled`. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `RUN_BALANCE_INVOICE_MONITOR` | No | Set to `false` to disable the hourly balance-invoice monitor (alerts when a client is billed more than they owe, or owes a balance with no payable invoice). Alert-only. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
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
| `RESEND_DAILY_CAP` | No | Resend daily sending allowance (default 100). Shown as the Overview send budget; counts campaign sends only, so it is an upper bound. |
| `MARKETING_SEND_GAP_MS` | No | Milliseconds between recipients in a campaign send (default 600). The send is paced serially; a burst that trips Resend's rate limit fails an arbitrary subset. |
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
| `WEBAUTHN_RP_ID` | Optional | WebAuthn RP ID override. Defaults: `admin.drbartender.com` in prod, `localhost` in dev. Never a bare domain (one bundle serves four hosts). |
| `WEBAUTHN_ORIGIN` | Optional | WebAuthn expected origin override. Defaults: `https://admin.drbartender.com` in prod; localhost origins in dev. |
| `VAPID_CONTACT_EMAIL` | For staff push | Contact email in the VAPID JWT (`mailto:`). Defaults to `contact@drbartender.com`. |
| `ADMIN_EMAIL` | For seed | Admin account email. Used for the seed account and as the default Reply-To on client-facing emails. |
| `ADMIN_PASSWORD` | For seed | Admin account password |
| `TELEGRAM_BOT_TOKEN` | For VA calling | Telegram Bot API token (@BotFather). Unset → Telegram helpers no-op and outbound calling is dead. |
| `TELEGRAM_WEBHOOK_SECRET` | For VA calling | Secret URL path segment (`/api/telegram/<secret>`) AND the `X-Telegram-Bot-Api-Secret-Token` header value (constant-time compared). Set the same value at `setWebhook`. |
| `TELEGRAM_ALLOWED_USER_ID` | Bootstrap | Numeric Telegram user id of Zul. Leave UNSET on first deploy for bootstrap mode (webhook echoes the sender's id, dials nothing); then set + redeploy. |
| `VOICE_CALLER_ID` | For VA calling | The 224 US voice line in strict E.164 (`+12242220082`) — outbound caller ID + inbound number. |
| `VA_CELL` | For VA calling | Zul's cell, strict E.164 (`+63…`), the bridge target. Never normalized, never committed. |
| `RUN_VA_CALLING_SCHEDULER` | No | `false` disables the VA-calling prune, the undelivered-voicemail redelivery sweep, and the Telegram webhook-heartbeat scheduler. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. Note the sweep is the ONLY retry for a voicemail stranded between claim and upload. |
| `RUN_PRESENCE_SCHEDULER` | No | `false` disables the presence stale-desk nudge / auto-flip sweep (15 min). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
| `VA_CALL_DAILY_CAP` | No | Max calls placed per rolling 24h (default 40, DB-backed via `call_audit`). |
| `VA_CALL_PER_MIN_CAP` | No | Max triggers accepted per minute (default 5). |
| `VA_CALL_TIME_LIMIT_SEC` | No | Per-call hard `timeLimit` on both legs (default 1800 = 30 min). |
| `PENDING_CALL_TTL_SEC` | No | Confirm-before-dial pending-record TTL in seconds (default 120). |
| `LEAD_CALL_ENABLED` | No | Lead call bridge kill switch: `false` disables the new-lead auto-call trigger entirely (redeploy-free). Default on. |
| `LEAD_CALL_DAILY_CAP` | No | Max lead-call attempt chains opened per rolling 24h (default 25; toll-fraud backstop). `0` is treated as unset and falls back to 25 — the only off switch is `LEAD_CALL_ENABLED=false`. |
| `VOICEMAIL_ENABLED` | No | 224-inbound voicemail master switch. **Default OFF**; only `'true'` enables. Off restores pre-feature behavior exactly (no ping, no recording). |
| `VM_MAX_LENGTH_SEC` | No | Max voicemail recording length in seconds (default 120, clamped 30..300). |
| `VM_DAILY_CAP` | No | Max voicemail-path calls per rolling 24h (default 50, counted from `voicemail_delivery`). Inbound analog of `VA_CALL_DAILY_CAP`. |
| `VM_PRIMARY_DIAL_TARGET` | Yes* | What the primary line (+12242221922) dials to reach Dallas, strict E.164 (the 312 GV number). Unset → primary calls are apologized away (Sentry-paged, throttled). *Required once the 1922's voice webhook points at us. |
| `VM_PRIMARY_RING_SEC` | No | Primary-line ring seconds before a miss (default 18, clamped 5..30; deliberately under a carrier voicemail pickup). |
| `VM_TEXT_DESTINATION` | Yes* | Where a primary-line voicemail is texted (the 312), strict E.164. Unset/malformed silently disables primary delivery (rows stay retryable; startup warning + per-call log only). |
| `VM_LISTEN_LINK_ENABLED` | No | Listen-link kill switch, **default ON**. TWO-SIDED: off closes `GET /api/voice/vm/:token` AND drops the link line from the alert SMS. Links expire at 30 days; revoke one with `UPDATE voicemail_delivery SET listen_token = gen_random_uuid() WHERE call_sid = $1`. |
| `VM_GREETING_URL_PRIMARY` | No | Dallas's greeting; same contract as `VM_GREETING_URL` for the primary line. Unset → synthetic Dallas text, never Zul's recording. |
| `VM_ESCALATION_ENABLED` | No | Press-1 escalation master switch, **default OFF**. Off → no `<Gather>` on either line; the zul document is byte-identical to pre-feature production (golden-pinned). |
| `VM_ESCALATION_DAILY_CAP` | No | Max escalation legs per rolling 24h (default 25), a HARD serialized bound. Billed leg; international on the primary line. |
| `VM_ESCALATION_QUIET_ZUL` / `VM_ESCALATION_QUIET_PRIMARY` | No | Quiet hours for the escalation TARGET, strict `HH:MM-HH:MM` (`24:00`/en-dash invalid → warned, no window). May wrap midnight. |
| `VM_ESCALATION_TZ_ZUL` / `VM_ESCALATION_TZ_PRIMARY` | No | IANA zone overrides for the quiet windows (defaults Asia/Manila, America/Chicago). A bad zone silently disables the window. |
| `VM_ESCALATION_PROMPT` | No | `none` once a greeting recording announces press-1 itself; default speaks a short synthetic prompt. |
| `VA_INBOUND_PER_MIN_CAP` | No | Inbound flood cap per minute (default 30 per line) on `POST /api/voice/inbound` AND `/inbound/primary`, separate buckets, behind the signature gate. The voicemail/escalation webhooks have their own per-`CallSid` limiter that does not read this. |
| `TT_AUTOREPLY_ENABLED` | No | TT auto first-reply master switch, default OFF (`'true'` enables): quick replies via the harvester box, day-lead calls fire respond-then-ring. Does NOT gate the fallback sweep. |
| `FIRST_REPLY_FALLBACK_MINUTES` | No | Unconfirmed day reply falls back to the call past this (default 3). |
| `FIRST_REPLY_CALL_MAX_AGE_MINUTES` | No | Freshness bound on callback/sweep calls (default 240; the call promise expires). |
| `RUN_FIRST_REPLY_FALLBACK_SCHEDULER` | No | `false` disables the 60s first-reply sweep. Default on; `RUN_SCHEDULERS` wins. |
| `MAX_FIRST_REPLY_ATTEMPTS` | No | Offer-side attempts cap before a reply flips to `failed` (default 3). |
| `FIRST_REPLY_COOLDOWN_INTERVAL` | No | Reply lease re-offer interval (default `'10 minutes'`). |
| `FIRST_REPLY_CALL_DELAY_SECONDS` | No | Delay between the first-reply outcome and the promised lead call (default 60; 0 = immediate; clamped 0-600; sweep backstops restarts without preempting the room). |
| `FIRST_REPLY_NIGHT_JITTER_START_HOUR` / `_END_HOUR` | No | Chicago dead-hours window `[start, end)` where night replies get the 2-14 min jitter (defaults 2, 8; may wrap midnight); outside it night replies are immediate. |

The frontend uses one build-time variable set in `client/.env.production`:
- `REACT_APP_API_URL` — absolute URL to the backend (e.g., `https://os-g7oa.onrender.com`)

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js                # Express app setup, middleware, route mounting
│   ├── assets/                 # Static bundled assets served to third parties (voicemail-greeting.mp3 → Twilio <Play> via GET /api/voice/greeting.mp3)
│   ├── data/
│   │   ├── contractorAgreement.js # Versioned v2 legal text (clauses, acknowledgments, effective date)
│   │   ├── extensionTermsCopy.js # Versioned client-facing coverage terms for an on-site service extension, keyed by the terms_version stamped on the service_extensions row so the audit trail reproduces exactly what the client agreed to; getExtensionTerms THROWS on an unknown version (stronger than smsConsentCopy's null)
│   │   └── smsConsentCopy.js   # Canonical client SMS consent sentence keyed by version (A2P 10DLC). Append-only: an old version stays forever so historical sms_consent_log rows keep resolving. Mirrored by client/src/constants/smsConsent.js; utils/smsConsent.test.js fails on drift
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
│   │   │   ├── nameNotices.js  # /name-notices list + /:userId/ack — unreviewed preferred-name changes for the needs-attention strip
│   │   │   ├── managers.js     # /managers CRUD
│   │   │   ├── blog.js         # /blog admin endpoints
│   │   │   ├── settings.js     # /settings + /test-email + /backfill-geocodes + /badge-counts
│   │   │   ├── search.js       # /search — global record search across clients/proposals/events/staff
│   │   │   ├── payroll.js      # /payroll — contractor payouts, pay periods, paystub data
│   │   │   ├── payrollDuty.js  # Duty-line admin API (spec 2026-08-06): manual create / edit / remove / restore, attribution set/move, unattributed-duties list backing the Process gate
│   │   │   ├── staffReviews.js # Staff review money (spec 2026-08-06 §7): review log CRUD + confirm/dismiss; settleBounty is the ONE door for the $10 bounty (revive system tombstone or materialize, gated confirmed+5-star)
│   │   │   ├── staffReviewsContest.js # Quarterly review contest: leaderboard (events clamped at today, server-computed winners/shares) + $100 award (in-progress quarter needs force). Mounted BEFORE staffReviews.js
│   │   │   ├── payrollTax.js   # /payroll/contractors/:id/payment-history + /payroll/tax-totals + /payroll/tax-totals/:id/exclude — imported-ledger blends + 1099 year totals (read-only + one boolean PATCH)
│   │   │   ├── presence.js     # /presence + /presence/state + /presence/leads + /presence/log — time-clock strip + history
│   │   │   ├── leadCalls.js    # /lead-call-attention — lead-call bridge FAULT rows only (failed / misconfigured chains on still-new TT leads, 7-day window) for the overview Sales tab; missed + after-hours are deliberate non-items (2026-07-20)
│   │   │   └── ccImport/       # Live CC re-trigger endpoints (v1 import/review admin UI removed 2026-07-07)
│   │   ├── agreement.js        # Contractor agreement + digital signature
│   │   ├── application.js      # Contractor application form
│   │   ├── auth.js             # POST /register, POST /login, GET /me
│   │   ├── webauthn.js         # Passkey unlock under /api/auth/webauthn (register/assert/credentials; the ONLY 12h-mint site; SENSITIVE-LISTED)
│   │   ├── beo.js              # Event details (proposal-keyed) — GET payload + logo proxy + POST acknowledge
│   │   ├── eventDetails.js     # Event details (shift-keyed) — staff page payload + bar-menu print download
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
│   │   │   ├── coverageContext.js # Hosted-coverage loader (planner v2): package eligible-item union + class map + classify per drink; pool-or-held-client handle
│   │   │   ├── lab.js          # Enhancement Lab (planner v2): GET/PUT /t/:token/lab shelves + additions reconcile; folds additions into the proposal balance (proposalExtrasFold), Balance invoice absorbs; refreshes the shopping list post-commit
│   │   │   ├── labHelpers.js   # Lab shared layer (extracted from lab.js): window/state, display pricing, line items, PUT sanitizers
│   │   │   ├── labListRefresh.js # Post-commit shopping-list rebuild after a lab change (extracted from lab.js)
│   │   │   ├── regenerate.js   # POST /:id/shopping-list/regenerate (fresh list from live par catalog; returns, never saves)
│   │   │   ├── shoppingList.js # Shopping-list routes extracted from drinkPlans.js (public token view + admin get/save/approve; approve delegates to the comms action, kept for API compat)
│   │   │   ├── submit.js       # PUT /t/:token submit handler (extracted); creates the "Drink Plan Extras" invoice at submit
│   │   │   ├── submitNotify.js # Post-commit submit comms (extracted from submit.js): confirmation emails, admin heads-up, lab follow-up scheduling
│   │   │   └── submitSanitize.js # Selections allow-list + sanitizer for the public submit PUT (extracted from submit.js)
│   │   ├── drinkPlanConsult.js # Admin consult-form routes (alternate input source for shopping lists)
│   │   ├── messages.js         # SMS messaging to staff
│   │   ├── mocktails.js        # Mocktail menu CRUD
│   │   ├── payment.js          # Payment method + W-9 upload
│   │   ├── packages.js         # Admin package-model API (planner v2): package_items contents CRUD, slots, makeability preview, directional margin
│   │   ├── potions.js          # Potions bar-program API: par-catalog CRUD/reorder/preview + shared recipe-row + dossier-field validators
│   │   ├── progress.js         # Onboarding step tracking
│   │   ├── proposals/          # Service proposals (publicToken/publicOptions/compareGroup/public/metadata/lifecycle/crud/getOne/actions/changeRequests/groups/metricsSplit sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── publicToken.js  # /t/:token view + sign
│   │   │   ├── public.js       # /public/* — packages, addons, calculate, capture-lead, quote-draft, submit
│   │   │   ├── metadata.js     # /packages, /addons, /calculate, /financials, /dashboard-stats
│   │   │   ├── metricsSplit.js # GET /metrics-split — funnel sent/accepted math split by source or event_type (native-only sibling of dashboard-stats)
│   │   │   ├── lifecycle.js    # Proposal status state machine (PATCH /:id/status)
│   │   │   ├── crud.js         # admin CRUD (list / create / update / archive)
│   │   │   ├── getOne.js       # GET /:id single-proposal read (carved out of crud.js; greedy `/:id`, mounted last)
│   │   │   ├── menuPrint.js    # Bar-menu print file admin CRUD (upload/replace, no-menu flag, remove) — R2 menu-print/<proposalId>/
│   │   │   ├── notifyPreflight.js # POST /:id/notify-preflight — read-only: which client notices a pending edit would trigger + the drafted message
│   │   │   ├── actions.js      # Per-proposal admin actions: notes, create-shift, balance-due-date, send-reminder, record-payment (carved out of crud.js)
│   │   │   ├── cancel.js       # Cancel booked events (fix #7): /:id/cancel/preview, /:id/cancel, /:id/cancel/refund — archive + shift-cancel + comms-delete + invoice-void + idempotent tip clawback + agreement refund
│   │   │   ├── cancelLineItem.js # Cancel line item: /:id/cancel-line/targets|preview|(execute) — one-motion removal + post-commit overpayment-scoped refunds (mounted before getOne)
│   │   │   ├── remoteStaffing.js # Remote Staffing Fee support for the admin send surfaces: /:id/remote-staffing-check (venue distance, active-staff counts, server-derived suggestion, on-demand venue geocode) + /:id/remote-fee-prompt-answered (asks once). Carved out of crud.js at the size ratchet; mounted before getOne
│   │   │   └── changeRequests.js # Admin change-request endpoints (queue, per-proposal list, decline)
│   │   ├── serviceExtensions/  # On-site service extension (staff-requested added bar time), mounted at /api/service-extensions
│   │   │   ├── index.js        # Composition router; auth differs per file so it is applied inside each one (publicAccept mounted first)
│   │   │   ├── create.js       # Staff surface: GET /eligibility/:shiftId + POST / (assigned-approved-not-dropped predicate, locked in-transaction reprice, one-pending 409, mints the 'Service Extension' invoice, texts/emails the client the invoice link); no response here ever contains a price
│   │   │   ├── publicAccept.js # PUBLIC POST /t/:token/accept, invoice-token gated (requireUuidToken): records the terms-acceptance artifact (timestamp/IP/UA, idempotent); a zero-delta extension settles on acceptance alone
│   │   │   └── admin.js        # Admin/Manager: GET /proposal/:proposalId list + POST /:id/override (grant the time, VOID the invoice) + POST /:id/cancel
│   │   ├── shifts.js           # Shift scheduling
│   │   ├── shifts.queries.js   # Extracted SQL projections/queries for shifts.js
│   │   ├── shifts.approval.js  # Request/assign/approve handlers + position-resolution money seam (extracted from shifts.js)
│   │   ├── shifts.handlers.js  # Shift-lifecycle mutation handlers (update, cancel-or-unassign) extracted from shifts.js
│   │   ├── staffShiftActions.js # Drop / Cover shift marketplace (drop, request-cover, claim-cover, emergency-drop, withdraw) under /api/shifts
│   │   ├── adminCoverSwaps.js  # Admin cover-swap approval endpoints (mounted under /api/admin)
│   │   ├── sms.js              # Twilio inbound-SMS webhook + admin thread API
│   │   ├── smsOptIn.js         # POST /api/sms/opt-in — public standalone SMS consent form (the /sms page); checkbox OPTIONAL (Twilio forced-consent rule), number required only when ticked; ticked records consent via utils/smsConsent.js, unticked upserts email_leads only and never touches clients
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
│   │   ├── emailMarketing/     # Composition router for /api/email-marketing/* (was one 987-line file at the hard cap)
│   │   │   ├── index.js        # Mount order mirrors the original file order and is load-bearing: designer.js (/campaigns/:id/test) and sequences.js (/campaigns/:id/steps) are more specific than campaigns.js's /campaigns/:id
│   │   │   ├── leads.js        # Lead CRUD + CSV import
│   │   │   ├── campaigns.js    # Campaign CRUD. Blast send + schedule RETIRED in lane mkt-f: their audience read email_leads only and so could not honor clients.marketing_excluded
│   │   │   ├── designer.js     # Image upload, live preview, single-address test send
│   │   │   ├── sequences.js    # Sequence steps, activate/pause
│   │   │   ├── enrollment.js   # Enroll leads into a sequence, read enrollments
│   │   │   ├── analytics.js    # Aggregate analytics
│   │   │   ├── conversations.js # Two-way lead threads, replies, read/replied state
│   │   │   ├── unsubscribe.js  # PUBLIC unsubscribe, no auth by design (the JWT is the credential). GET renders a confirmation and changes NOTHING; POST performs the flip and is also the RFC 8058 one-click target. Mail scanners GET every link in an email, so a mutating GET silently unsubscribed people
│   │   │   └── shared.js       # compileEmailDesign, used by campaigns + designer
│   │   ├── emailMarketingWebhook.js  # Resend webhook receiver (email tracking events)
│   │   ├── marketingContacts.js # Marketing tags + do-not-contact + the audience/contact read routes (admin ONLY, stricter than emailMarketing/, which allows managers)
│   │   ├── marketingOverview.js # Overview + Sent (admin only). Moments (rule and window in CODE, words in DATA), the year-honestly numbers, the Needs-You queue, the reachable base, today's send budget; and Sent with 30-day booked attribution
│   │   ├── marketingSend.js    # The campaign send (admin only). Takes client_ids, re-checks mailability at send time, dedupes by address, claims each recipient in email_sends BEFORE calling Resend (partial unique index = send-once), paces serially, and treats a quota 429 as a resumable stop rather than N failures
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
│   │   ├── thumbtackAgent.js   # Thumbtack box-agent API (/api/admin/thumbtack): email-harvest queue (pending-harvest/email-harvested/harvest-failed/rearm) + auto first-reply queue (pending-first-replies/first-reply-sent/first-reply-failed). Driven by the box-only agent in thumbtack-agent/ (one loop, 10s reply tick, wall-clock ~5-min harvest pass)
│   │   ├── venues.js           # Google Places venue search proxy
│   │   ├── voice.js            # Two-line Twilio Voice webhooks: POST /inbound (forward 0082 → VA_CELL, stamps line=zul), /inbound/primary (forward 1922 → VM_PRIMARY_DIAL_TARGET, stamps line=primary), /bridge (look up target by CallSid → Dial 224→target), /status (failed-leg → Telegram notice), /inbound/missed (shared <Dial> action, per-line greeting + optional press-1 <Gather> + <Record>, interception canary), /inbound/voicemail (recordingStatusCallback: per-line delivery via utils/voicemail), GET /greeting.mp3 (PUBLIC: the bundled zul greeting; overridable via VM_GREETING_URL). /inbound, /inbound/primary, and both voicemail routes fail CLOSED on signature in every environment; the two FORWARD routes run signature BEFORE the limiter (the voicemail webhooks keep their per-CallSid limiter first, deliberately: junk sids collapse to one bucket no real callback lands in)
│   │   ├── voicemailListen.js  # The voicemail listen link (2026-08-10): PUBLIC token-gated GET /api/voice/vm/:token streams the retained primary recording. The recording SID comes from the ROW, never the request (that is the line between a listen link and an open Twilio proxy); Range/206 support because iOS will not play without it; one identical 404 for every miss; 30-day age bound in its own SQL; VM_LISTEN_LINK_ENABLED kill switch
│   │   ├── voiceEscalate.js    # Press-1 escalation webhooks (/api/voice/escalate, mounted before /api/voice): POST / (digit handler: kill switch → target → quiet window → hard-capped claim → billed <Dial> to the OTHER person), /whisper (keypress screen played to the answerer; carrier voicemail can never bridge), /accept (marks the PARENT call accepted), /done (branches on acceptance state, NEVER DialCallStatus; fallback = <Record>). All fail CLOSED on signature
│   │   └── voiceLeadCall.js    # Lead call bridge Twilio webhooks (/api/voice/lead): /answer (Gather-wrapped spoken briefing), /digit (press-1 → Dial lead from the 224, press-9 replay), /status (claim-guarded chain advance). Signature FAIL-CLOSED in every env
│   ├── utils/
│   │   ├── addonQuantity.js    # The ONE sanctioned server conversion between proposal_addons.quantity (the engine's OUTPUT display quantity) and an add-on's INPUT unit count; manual twin of the admin editor's recoverAddonQuantities
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
│   │   ├── labFollowupHandler.js # lab_followup dispatcher handler (planner v2): +36h post-submit Enhancement Lab nudge; every cancel condition checked at fire time (additions made, window closed, event <72h, marketing opt-out); registered at boot in server/index.js
│   │   ├── proposalExtrasFold.js # Contract-safe extras fold (extracted verbatim from the submit financial path): override moves by catalog delta, snapshot reprice, total/override write, paid-in-full re-eval; shared by drink-plan submit + the Enhancement Lab
│   │   ├── dutyLines.js        # Contractor duty pay (spec 2026-08-06): kind labels, pure triggers (funded gate + bar/parking/equipment/hosted/menu/out-of-area), derive-never-increment reconcile, attribution helpers, review bounty/contest materializers + catch-up pass
│   │   ├── serviceArea.js      # Out-of-Area service-area geometry (spec 2026-08-06 §6): HOME_BASE (Pilsen), the suggestion bands (SERVER-ONLY per the published-ambiguity rule), distance helpers, the bonus lock stamp/release pair shared by every approval + roster-removal path, its own 1 req/sec Nominatim queue, and the post-commit duty re-accrue hook
│   │   ├── payrollGuards.js    # isLegacyCcParticipant (per-proposal stub check, used by payrollAccrual); isLegacyCcStubUser kept for parity
│   │   ├── payrollDeferredRetry.js # Re-runs placement for tips that deferred while the open pay period was frozen (single-flight, attempt-capped); fired off the response path after a successful accrual and from the admin Retry button
│   │   ├── changeRequests.js   # Client-portal change-request helpers: edit-window classifier, field allowlist, proposed-state preview + diff + price preview, and the reaper that auto-cancels pending requests on archive/complete
│   │   ├── changeRequestNotifications.js # Admin alert (new request) + client decision (approved/declined) email + SMS sends
│   │   ├── channelFallback.js  # Channel-substitution decision for single-channel operational touches (picks the live channel when the registered one's status is 'bad')
│   │   ├── clientAutomationSuspension.js # Suspends a client's remaining automation when both email_status and phone_status are 'bad' (sets clients.automation_suspended_at, cancels pending scheduled_messages)
│   │   ├── clientDedup.js      # Find-or-create a client de-duped on email OR phone (name-guarded, backfill-only); the single intake find-or-create
│   │   ├── clientNotices.js    # Notify-client contract: notice detection (event_details_changed) + notify-list validation shared by PATCH and preflight
│   │   ├── comms/              # Compose-first client-send registry (backs POST /api/comms)
│   │   │   ├── registry.js     # Auto-discovers actions/*.js at require time; defines + enforces the action contract (resolveRecipient/buildMessages/ensureSideEffects/dispatch)
│   │   │   ├── render.js       # renderPartsEmail: HTML-escapes the editable subject/body prose into the branded email shell (fixed heading + cta)
│   │   │   └── actions/
│   │   │       ├── shoppingListApprove.js # shopping_list_approve action: idempotent approve + approved-snapshot side effect, then per-channel dispatch that owns its message_log writes
│   │   │       ├── proposalSend.js # proposal_send action (compose-first INITIAL send): row-locked draft-to-sent flip + invoice in one transaction, drip enroll post-commit; recipient/messages/dispatch delegated to proposal_resend
│   │   │       ├── proposalResend.js # proposal_resend action: re-send the proposalSent email + initial-proposal SMS with no status change (validate-only RESENDABLE guard); dispatch owns its message_log writes
│   │   │       ├── proposalSendGroup.js # proposal_send_group action: EMAIL-ONLY compare send (one proposalOptionsSent link), AB-BA-safe FOR UPDATE draft-to-sent flip with no per-option invoice or comms; idempotent
│   │   │       ├── portalInvite.js # portal_invite action: email the client their OTP portal link (nothing minted, no token in the link), email default / SMS off by default; no state side effect
│   │   │       ├── paymentReminder.js # payment_reminder action: balance-due reminder (balance = total_price minus amount_paid, no money written), NO_BALANCE_DUE guard; email + SMS
│   │   │       ├── drinkPlanNudgeReenroll.js # drink_plan_nudge_reenroll action (minRole admin): clears durable nudge suppression + reschedules the T-21 nudges, and dispatches an immediate drink-plan nudge; planner CTA uses the drink-plan token
│   │   │       ├── drinkPlanNudge.js   # drink_plan_nudge action: admin manual resend of the Potion Planner link (email + SMS), entityId = drink-plan id; backs the deprecated POST /:id/resend-nudge
│   │   │       ├── consultRecap.js     # consult_recap action: post-consult client recap email (email only), fired from the consult-save flow; live-resolves recipient (fixes the stale dp.client_email bug)
│   │   │       └── invoiceSend.js      # invoice_send action: draft->sent status flip + invoice-ready email (entityId = invoice id), email only
│   │   ├── consultRecap.js     # Formats saved consult selections into the post-consult email recap
│   │   ├── drinkPlanAccess.js  # Pure post-booking drink-plan access guard (fail-safe pre-booking allowlist)
│   │   ├── drinkPlanNudge.js   # Drink-plan / Potion Planner nudge: email + SMS touch and scheduling
│   │   ├── dripSmsHandlers.js  # Unsigned-proposal drip SMS handlers (touches 1, 3, 5-sms)
│   │   ├── email.js            # Resend email wrapper (send + batch)
│   │   ├── emailBlockRenderer.js # Designed-email block → email-safe HTML renderer (tables + inline styles; single source of truth for how a designed campaign looks)
│   │   ├── emailDesign.js      # Design compiler: sanitizes block rich-text + renders design_json → html_body/text_body
│   │   ├── emailSanitize.js    # Shared allowlist DOMPurify sanitizer for admin-authored email HTML (extracted from emailMarketing)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js   # Email template helpers (transactional + marketing)
│   │   ├── emailValidation.js  # Warn-only typo-domain heuristic (flags a domain one edit from a common TLD/provider); client twin kept in manual sync
│   │   ├── firstName.js        # firstNameOf: the name to greet someone by; single source for every "Hi ..." across all templates (title-aware, couple-aware, idempotent)
│   │   ├── icsCalendar.js      # iCalendar VEVENT renderer for booking-confirmation .ics attachments
│   │   ├── encryption.js       # AES-256-GCM wrapper for bank PII at rest (fails closed in prod)
│   │   ├── errors.js           # AppError class hierarchy (ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError, PaymentError)
│   │   ├── eventCreation.js    # Auto-create shifts from paid proposals
│   │   ├── eventEndInstant.js  # Timezone-correct event start/end instants: event_date + free-text event_start_time + duration composed inside event_timezone by Postgres (the balanceScheduler completion-gate precedent, parameterized on duration); powers the extension request window + expires_at; unparseable time returns null, never throws
│   │   ├── eventEveSms.js      # Event-eve SMS touch (T-24h from event start) and timing helper
│   │   ├── contactMessageHistory.js # Everything one contact actually received. message_log is primary (automated derived from sent_by); scheduled_messages is anti-joined as a safety net so a dispatcher send is not listed twice; email_sends joined in lane mkt-g
│   │   ├── eventTypes.js       # Event type id→label resolver (mirrors client)
│   │   ├── marketingAudience.js # THE single definition of who may receive marketing: MAILABLE_SQL, HELD_BACK_SQL, the JS predicate, and the seven audience rules (all three legs pinned against each other by test)
│   │   ├── marketingSuggestions.js # Tag suggestions with reasoning; never auto-applies (the email-domain shortcut measured as a coin flip)
│   │   ├── marketingMoments.js # Marketing MOMENTS: the rule and window are CODE (audience id, occurrenceKey, isOpen), only the words are DATA. Also the single AUTOMATIONS list both Overview and Sent render — add a marketing handler, add it here
│   │   ├── marketingTags.js    # Marketing tag vocabulary (mirrors client + the client_tags CHECK; Corporate is never inferred)
│   │   ├── outstandingDocuments.js # Which onboarding documents a worker still owes (one predicate, two surfaces)
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
│   │   ├── onboardingPromotion.js # promoteOnboardingIfEligible — the onboarding_status -> 'approved' gate (in_progress needs an applications row; pre_hired is not evidence)
│   │   ├── onboardingProgress.js # ensureOnboardingProgress — lazy progress-row seed for legacy accounts (step writes are UPDATE-only)
│   │   ├── eventDetailsPayload.js # Shared staff event-details payload builder + read auth (any staffer on a staffable event; contact fields redacted unless assigned)
│   │   ├── messageScheduling.js # scheduleMessage(...): idempotent insert of a future touch into the scheduled_messages table
│   │   ├── messageSuppression.js # shouldSendImmediate(...): shared archive / comm-prefs / bad-contact gate for immediate-send paths
│   │   ├── refundHelpers.js    # Partial-refund planner (planRefund) + idempotent reconciliation (applyRefundReconciliation, incl. status⟷money + autopay-disarm)
│   │   ├── refundExecute.js    # Shared one-charge refund orchestration (pending row → stripe.refunds.create → applyRefundReconciliation → cleanup); used by the admin refund route AND the cancel-event refund endpoint — the only place stripe.refunds.create is called. Ambiguous Stripe errors (connection/API) leave the row `pending` (not `failed`) so the sweeper can reconcile it against Stripe
│   │   ├── lineItemCancel.js   # Cancel-line core: target registry (addon/bar/syrup/extra-bartender/adjustment/gratuity), applyLineItemCancel (per-kind mutation → fold → invoice refresh/delta-reconcile → shift sync), preview = same core in a rolled-back tx
│   │   ├── gratuityStaffNotice.js # Mandatory staff "you can set out a tip jar" email on gratuity removal/below-floor shrink (approved non-dropped roster; email-only by cost rule)
│   │   ├── gratuityMandate.js  # Admin gratuity mandate (spec 2026-08-10): PATCH resolution for gratuity_mandate_total (set/clear/carry, signed+paid lock, presence = floor > 0) + the staffing-notice origin resolver moved out of crud.js
│   │   ├── lineItemRemovedNotify.js # Client notice for a no-refund line-item removal (notify-toggle gated; mirrors refundClientNotify gates)
│   │   ├── balanceInvoiceMonitor.js # Hourly ALERT-ONLY watch on the invoice invariant Σ(open invoice remaining) ≤ owed: reports clients billed MORE than they owe (never legitimate) and clients owing a balance with no payable invoice. Reads proposals/invoices, writes only proposal_activity_log (the row doubles as a 24h-per-proposal notify throttle), Sentry warning + one batched admin email per run. NEVER creates/edits/voids an invoice (gated by RUN_BALANCE_INVOICE_MONITOR)
│   │   ├── refundSweepScheduler.js # Stale-pending-refund reconciler (sweepStalePendingRefunds): rows `pending` >30 min w/ NULL stripe_refund_id are matched against stripe.refunds.list (by metadata row-id, then unique amount) → adopt via applyRefundReconciliation, or mark failed if the refund never reached Stripe (gated by RUN_REFUND_PENDING_SWEEP_SCHEDULER)
│   │   ├── serviceCurfew.js       # The 2:00 AM service curfew as an INSURANCE WARRANTY (liquor liability app PK810225: "no operations past 2:00 AM"; a breach can void coverage). checkContractCurfew (existing proposal) + checkCurfewForStart (create paths, also normalizes a pg Date event_date) + the one shared client-facing sentence. Policy differs by surface: client paths (public quote builder, client change requests) refuse outright; the admin proposal POST and PATCH refuse by default but accept `acknowledge_past_curfew` and audit it; settle refuses with no override. Wall-clock by design, so the event timezone is deliberately unused
│   │   ├── serviceExtensionPricing.js # Extension price = the pricing engine's delta between the two durations, both legs priced at CATALOG (override nulled) and the SERVICE portion differenced (never .total); MAX_EXTENSION_HOURS = 3 in 30-minute steps, further capped by the 2:00 AM curfew via allowedAdditionalHours (the picker is built from the same number, so it can never offer a step the validator rejects); read-only, the caller persists
│   │   ├── serviceExtensionSettle.js  # settleExtension/closeExtension: the ONE contract write (proposals.event_duration_hours + the single shift's denormalized duration/end_time); the claim UPDATE (WHERE status='pending') is the race gate shared by settle/expiry/override/cancel; re-checks the 2:00 AM curfew under the lock BEFORE the claim (an admin can move event_date/start_time under a pending request) so a refusal leaves the row pending for the sweep rather than settled-but-unmoved; never sends messages, never touches payroll
│   │   ├── serviceExtensionPayroll.js # applyExtensionHours re-seeds payout_events hours from the new duration ONLY when hours = contracted_hours (admin-edited lines and frozen periods are reported, never overwritten) + finalizeExtension stamp + maybeAlertPayroll admin alert
│   │   ├── serviceExtensionNotify.js  # Every extension send (client request SMS/email, staff greenlight/decline, admin alerts): immediate direct sends honoring the queued path's channel gates; never call inside a transaction (helpers take their own pooled connections)
│   │   ├── serviceExtensionSweep.js   # 60-second expiry sweep (expires pending rows past expires_at: voids the invoice, cancels open intents, sends the staff decline) + healUnfinalizedExtensions crash recovery for settled rows whose post-settle side effects never ran; gated by RUN_SERVICE_EXTENSION_SWEEP_SCHEDULER
│   │   ├── shiftEndInstant.js  # THE definition of when a shift is over: shiftEndInstantSql / shiftNotFinishedSql / shiftFinishedSql, one SQL fragment imported by every shift-visibility surface and by closure. end_time parsed in the proposal's event_timezone (Chicago fallback); no usable end_time -> end of that calendar day, fail-safe toward VISIBLE; overnight ends (8pm-1am) roll to the next day
│   │   ├── shiftClosureSweep.js # Hourly sweep closing shifts whose end instant has passed on a 'completed' proposal -> 'completed', NEVER 'cancelled' (an EVENT-cancelled signal). Not a hook on the completion doors: those fire once per proposal and had no later pass for a still-upcoming shift (RUN_SHIFT_CLOSURE_SWEEP_SCHEDULER)
│   │   ├── shiftReap.js        # reapShiftsForProposal: soft-cancels a proposal's shifts, denies open shift_requests, suppresses shift-level pending scheduled_messages + BEO nudges, returns per-shift approved/bartender user ids. Extracted from the cancel flow; shared by cancel AND the archive endpoint (M-1 refund-reap)
│   │   ├── cancellationMath.js # Pure cancellation-refund math (computeCancellationRefund; all CENTS): >14d excess-less-5%-fee + full gratuity, <=14d gratuity-only, DRB full refund
│   │   ├── leadCallBriefing.js # Pure spoken-briefing builder for the lead call bridge (buildLeadBriefing: name/category/Chicago date/guests/city, TTS-friendly, escaping owned by the TwiML layer)
│   │   ├── leadCallTrigger.js  # Lead call bridge trigger + chain driver: triggerLeadCall (window/config/phone-validation/atomic-24h-cap gates, never throws; skipWindowCheck for reply-callback/sweep call sites), enqueueFirstReply (auto first-reply queue: gate-order template decision, winner-only skip rows, throw falls back to the direct call), advanceChain (claim-then-call ring order ADMIN_PHONE → VA_CELL), sendChainEmail (one lead_call admin email per chain)
│   │   ├── firstReplySweepScheduler.js # 60s first-reply sweep: Arm A day-call fallback (+3 min, LIMIT 3, any reply state with no attempt row), Arm B retirement (stale pending → failed, both templates) + reply_stale fault rows + enqueue-crash heal (60 min, flag-gated)
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
│   │   ├── coverageEngine.js   # Pure drink-vs-package coverage: classify (covered/fenced/unmakeable/no_recipe) + mocktailAddonFor (the Jack rule)
│   │   ├── quantityEngine.js   # Pure demand model: computeDemand (drinkers x hours x pace; profile nudges default split max ±10 pts)
│   │   ├── shoppingList.js     # Shopping-list generator (the ONE generator; consumes potionCatalog slices, legacy-constant fallback); consult-mode branch + buildGeneratorInputFromConsult translator
│   │   ├── shoppingListAddonCoverage.js # Maps active BYOB-support add-on slugs to the shopping-list items those add-ons cover (computeStripSet); generateShoppingList strips that set
│   │   ├── refreshDisplayName.js # Recompute + persist contractor_profiles.display_name for one user (explicit pg handle required — no pool default; IS DISTINCT FROM guarded)
│   │   ├── shoppingListGen.js  # Shared helpers: loadCatalog, resolveDrinkIds, matchCustomNames, buildPlannerGeneratorInput, buildConsultGeneratorInput, autoGenerateShoppingList
│   │   ├── sms.js              # Twilio SMS wrapper
│   │   ├── smsDeliveryStatus.js # Twilio delivery-failure handler — flags bad phone numbers (sets clients.phone_status='bad') on hard SMS failures
│   │   ├── smsEventDate.js     # Shared SMS event-date formatter (Date or string to "June 12", null when missing)
│   │   ├── smsConsent.js      # recordSmsConsent(...) — client SMS consent capture (A2P 10DLC): flips clients.communication_preferences.sms_enabled + stamps sms_opt_in/out_at, appends the append-only sms_consent_log proof row. Writes ONLY to a client row the same submit created (public form, unauthenticated); never lifts a prior STOP
│   │   ├── smsInbound.js       # Inbound-SMS processing: keyword/response-code detection, sender lookup, orchestrator
│   │   ├── smsTemplates.js     # Client-facing automated SMS body templates
│   │   ├── staffDisplayName.js # computeDisplayName: "Preferred L." derivation (preferred name + legal-surname initial), single source for every display surface
│   │   ├── staffDisplayName.validate.js # Preferred-name format rules + validatePreferredNameChange (grandfathers unchanged legacy values)
│   │   ├── staffShiftHandlers.js # Staff-shift SMS: day-before reminder, post-event thank-you, schedule-change/cancel notices
│   │   ├── storage.js          # Cloudflare R2 upload + signed URL helpers
│   │   ├── stripeClient.js     # Central Stripe client factory (test-mode toggle, fail-closed)
│   │   ├── stripePayoutSync.js # Read-side Stripe payout mirror sync: idempotent syncPayout/syncPendingTransactions upserts, matchLine reconciliation, sweep (bootstrap + heal + re-match), atomic failed-payout alert (spec 2026-07-01)
│   │   ├── telegram.js         # Telegram Bot API wrapper (VA calling): sendTelegramMessage/setTelegramWebhook/getTelegramWebhookInfo (raw fetch, no dep), verifyTelegramSecret (constant-time), isNewUpdate (update_id de-dupe), sendTelegramAudio (multipart voicemail mp3 upload, 120s timeout vs 8s for messages)
│   │   ├── thumbtackProposalDraft.js # Thumbtack auto-draft builder (createDraftProposalFromLead) + pure field mappers (event-type keyword map, ET date/time split, admin-notes block)
│   │   ├── tipHandleValidation.js # Validates + normalizes venmo/cashapp handles + paypal.me URLs before persist
│   │   ├── tipMethods.js       # Shared tip-method derivation for /api/me/tip-page + /api/public/tip/:token: read-side handle re-validation (drops unnormalizable stored values, Sentry-warns), availability, then saved-order resolution. One derivation so a downloadable printed sign can't advertise a method the post-scan chooser page refuses to render
│   │   ├── tipPageLifecycle.js # Tip page activate/deactivate transitions on hire/onboarding/offboard
│   │   ├── presence.js         # Pure presence helpers: lead-pointer derivation, taking-leads transition matrix, nudge/flip predicates, Central-time bucketing
│   │   ├── presenceActivity.js # In-memory sign-of-life map + throttled presence_last_seen_at flush (stamped by the auth middleware for tracked users)
│   │   ├── presenceNotify.js   # Dibs-edge ping (fire-and-forget): Telegram/SMS to the user the lead pointer moved off/onto when the fallback owner grabs or releases
│   │   ├── presenceScheduler.js # Presence sweep (15 min): stale-desk nudge (Telegram/SMS, nudged_at stamped only on confirmed send) + race-safe auto-flip to away (RUN_PRESENCE_SCHEDULER)
│   │   ├── presenceStore.js    # Presence DB layer: strip payload + lead pointer, transactional transitions/toggle, log totals, id-scoped applyAutoFlip, stampByNudgePhone
│   │   ├── tipPaymentLinks.js  # Creates/regenerates Stripe Payment Links for bartender tip pages
│   │   ├── tokens.js           # Canonical public-token shape validation: UUID_RE, isUuid, requireUuidToken(param, message) middleware (404s a non-UUID :token before the DB so it can't cast-throw 22P02 -> 500)
│   │   ├── twilioSignature.js  # Shared isValidTwilioRequest (Twilio webhook signature check); policy on failure stays per-router (fail-closed everywhere except voice.js's /bridge and /status, which keep the dev warn-and-allow)
│   │   ├── urls.js             # Canonical PUBLIC_SITE_URL / ADMIN_URL / STAFF_URL / API_URL resolvers
│   │   ├── usPhone.js          # US/NANP phone validation: toUsE164, isUsE164 (normalizePhone + strict +1 NANP gate, rejects intl + 900/976) — primary VA-calling toll-fraud control
│   │   ├── vaCallingScheduler.js # VA-calling scheduler body: pruneVaCallingRows + reapUndeliveredVoicemails (redelivers a voicemail stuck between claim and upload; Twilio never retries a 2xx'd recording callback) + checkTelegramWebhookHealth (re-runs setTelegramWebhook + emails admin when the webhook is unset or recently errored)
│   │   ├── voicemail.js        # Two-line voicemail: voicemail_delivery ledger (claimMissedCall/claimDelivery carry `line`, markDelivery, countVoicemailsSince = VM_DAILY_CAP window), per-line delivery (zul → Telegram audio + delete; primary → SMS to VM_TEXT_DESTINATION, recording RETAINED until 1b's R2 copy), line-aware alertOperator, Twilio media (recordingMediaUrl CONSTRUCTED from account SID + a ^RE[0-9a-f]{32}$ SID, never the webhook body's RecordingUrl)
│   │   ├── sentryScrub.js      # Telemetry redaction for BOTH Sentry pipelines (beforeSend is error-only; transactions carry the URL in OpenTelemetry span attributes). Extracted from index.js so it is testable — a hook that can only be eyeballed is a hook that ships a token leak
│   │   ├── voicemailLine.js    # Per-line routing policy (pure): resolveLine enum + E164_RE, escalationTargetFor (env-only), quiet windows (strict HH:MM-HH:MM, IANA tz), primaryRingSec clamp, interception canary
│   │   ├── voicemailTwiml.js   # Shared TwiML fragments (one owner for voice.js + voiceEscalate.js): per-line greeting verb, escalation prompt, <Record> verb, vmMaxLengthSec clamp, VM_ESCALATION_ENABLED switch
│   │   ├── voicemailEscalation.js # Press-1 escalation DB half: claimEscalationUnderCap (advisory-lock serialized cap+claim = a HARD daily bound), acceptance state (markEscalationAccepted/wasEscalationAccepted, fail-closed), outcome ledger (first-writer-wins)
│   │   ├── venueAddress.js     # Compose/validate structured venue address; derives event_location & shifts.location; resolvePendingLocation shared by the PATCH + notify-preflight
│   │   ├── webhookEventsPruneScheduler.js # Hourly prune of `webhook_events` to a 30-day window (gated by RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER)
│   │   └── xmlEscape.js        # Shared TwiML XML escaper (& < >); used by the SMS + voice routes
│   └── scripts/
│       ├── applyPackageLineup2026.js # One-time: apply the owner-decided 2026-07-18 package lineup (spec §5) as CONTENT — service_packages flags/slots, package_items rows, missing branded par_items, ingredient_class_addons map. Snapshots prior state for rollback; idempotent; --dry-run. NOT boot-path.
│       ├── migrateDrinkMeta.js # One-time: fold hardcoded client drink metadata (drinkUpgrades.js enhancements, DRINK_SYRUP_MAP) into cocktails/mocktails dossier columns. Skips drinks with existing dossier data unless --force; --dry-run. NOT boot-path.
│       ├── backfillExtrasInvoices.js # One-off: create the "Drink Plan Extras" invoice for an abandoned pay-now PI + cancel stale PIs (idempotent, --dry-run)
│       ├── backfillStripePayouts.js # One-off: full Stripe payout history into the read-side mirror via sweep() (idempotent; aborts in test mode)
│       ├── backfillShiftClosures.js # One-off: close shifts stranded 'open'/'filled' on completed proposals — same predicate as the hourly sweep, ALWAYS -> completed, never 'cancelled'. Its real value is the DRY RUN: a per-row plan plus a ROSTER GAP block naming paid events with nobody recorded. Dry-run default; --apply to write (the scheduler drains the same rows on its own)
│       ├── backfillTipPages.js # One-shot backfill: ensure every active bartender has a tip page row + Stripe link
│       ├── refreshDisplayNames.js # display_name backfill + drift audit (--check FAILs on drift or zero rows; --stamp-existing double-run-guarded) — safe to re-run any time
│       ├── verify-marketing-schema.js # Asserts client_tags + do-not-contact tables/constraints/columns/indexes actually installed (initDb swallows 42710/42P16, so a failed constraint boots clean and absent) — run after any deploy that replays schema.sql
│       ├── staffPaymentImport/   # Offline one-off CheckCherry→OS backfill pipeline (never imported by the server), sharing one name-clustering dictionary. Payments: parse Venmo/CashApp/Zelle/PayPal exports → classify/cluster → build a human review sheet → single-transaction import into staff_payment_history. Seniority: CC contacts → a human-reviewed mapping → dry-run-default apply of hire_date + historical_events_worked. Data files live on the share only, never committed (config.js, staging.js, parsers/, dictionary.js, classify.js, eventMatch.js, exportKnownPeople.js, ccReports.js, buildReviewSheet.js, importValidation.js, importFromSheet.js, reconcile.js, verifyImport.js; generateSeniorityMapping.js read-only CC→OS hire-date/event-count mapping for human review, applySeniorityBackfill.js dry-run-default apply of the approved mapping)
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
│   │   │   ├── MobileViewContext.js # isPhone (the ONE 700px fork) + per-screen Desktop-view overrides; provided by AdminLayout (mobile-admin spec section 3)
│   │   │   ├── ToastContext.js      # ToastProvider + useToast() hook
│   │   │   └── UserPrefsContext.js  # Per-user admin OS prefs (skin/density/sidebar) — strips on logout
│   │   ├── constants/
│   │   │   └── smsConsent.js   # The SMS consent sentence, split LEAD + TAIL so the checkbox can link the tail while /privacy renders it as prose. Single source for the wizard checkbox AND the privacy page
│   │   ├── utils/
│   │   │   ├── addonRateLabel.js # The ONE qualified label for a per_guest_timed add-on rate ("$8/guest (4hr) + $2/guest/hr after"). That rate column is the FOUR-HOUR price, so every surface that prints it (quote wizard, proposal compare panel, both admin add-on pickers) routes through this instead of hand-rolling the qualifier. Keys on the billing type, never on a bundle slug.
│   │   │   ├── api.js          # Axios instance with JWT interceptor
│   │   │   ├── buildTipDeepLink.js # Builds Venmo/CashApp deep links + Stripe fallback URL for tip pages
│   │   │   ├── clientSources.js # Canonical client source list (mirrors schema CHECK + server VALID_SOURCES)
│   │   │   ├── constants.js    # App-wide constants. VOICE and TEXT are now two different numbers: COMPANY_PHONE* = the 1922 for CALLS, COMPANY_TEXT_PHONE* = the 888 for TEXTS (the 224s have no approved A2P campaign until Phase 2 reunites them). Do not collapse the pairs.
│   │   │   ├── emailValidation.js # Warn-only typo-domain heuristic (manual-sync mirror of server/utils/emailValidation.js)
│   │   │   ├── eventTypes.js   # Event type id→label resolver (mirrors server)
│   │   │   ├── marketingTags.js # Marketing tag vocabulary + derived-state labels (manual-sync mirror of server/utils/marketingTags.js)
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
│   │   │   ├── isPlaceholderEmail.js # Mirror of server emailValidation.isPlaceholderEmail (CC-import .invalid = no email; keep in sync)
│   │   │   ├── timeOptions.js  # Time option generator + 12h formatter + input parser
│   │   │   ├── uploadLimits.js # Upload size cap + per-kind extension allowlist (mirrors fileValidation.js)
│   │   │   ├── downscaleImage.js # Browser-side photo downscaler run before upload
│   │   │   ├── downloadFilename.js # Sanitizes a name into a safe download filename (strips reserved chars and trailing dots; shared by DownloadTipSign + MenuPNG)
│   │   │   ├── installAdminPwaMeta.js  # Admin PWA metas behind the admin host gate (SENSITIVE-LISTED filename; staff injector untouched)
│   │   │   ├── adminSw.js           # Admin SW register + message protocol (announce user namespace, purgeMobileAdminState on logout)
│   │   │   ├── mobileLock.js        # Phone lock model (30-min background + expired-JWT decisions, enrolled/nudge flags, 401-claim handler registry; keys purge on logout)
│   │   │   ├── webauthnClient.js    # Passkey client (@simplewebauthn/browser wrap: registerPasskey, unlockWithPasskey, isPasskeySupported)
│   │   │   ├── installPrompt.js     # beforeinstallprompt capture for the explicit More > Install app row
│   │   │   ├── staleTime.js         # "as of 2:14 PM" staleness formatting (device-local by design)
│   │   │   ├── desktopViewStore.js  # Desktop-view override persistence for the phone admin (read + persist; MobileViewContext owns the merge)
│   │   │   ├── screenKey.js         # Route -> screen-key mapping + phone header titles (mobile admin)
│   │   │   ├── routeRestore.js      # Resume-last-route record/consume with once-per-launch guard (mobile admin)
│   │   │   └── tipCardMarks.js # Maps the server's computed tip-method tokens to payment marks, in two per-surface orders (sign/phone cap 5, card cap 8; a generic network mark always yields to a real P2P handle; zelle → none)
│   │   ├── components/         # AdminLayout, Layout, PublicLayout,
│   │   │                       # mobile/ (phone admin chrome: MobileTabBar bottom tabs with needs-you + neutral badges, MobileHeader brand-chip/back-arrow top bar with search + Desktop-view escape,
│   │   │                       #   MobileLockScreen full-screen biometric lock in two mounts: ProtectedRoute gate for the expired-JWT cold launch + AdminLayout overlay for the 30-min background lock and claimed phone 401s,
│   │   │                       #   PasskeyEnrollNudge one-time post-login enrollment banner, MoreSecurityRow the More tab's Security section),
│   │   │                       # comms/NotifyConfirmModal (confirm-before-messaging popup: edit saves quiet-primary, receipts send-primary),
│   │   │                       # InvoiceDropdown, SignaturePad, FileUpload, DrinkPlanCard,
│   │   │                       # PricingBreakdown, RichTextEditor, LeadImportModal, MenuSamplesModal,
│   │   │                       # AudienceSelector, SequenceStepEditor, CampaignMetricsBar, SyrupPicker,
│   │   │                       # emailBuilder/ (drag-and-drop designed-email builder: EmailBlockBuilder canvas + BlockCard + BlockSettings + EmailPreviewModal (server-rendered preview) + CampaignBlastEditor (draft-blast edit/preview/test-send) + blockCatalog + starterTemplates),
│   │   │                       # TimePicker, NumberStepper, Toast, FormBanner, FieldError, ScrollToTop, SessionExpiryHandler,
│   │   │                       # VenueAddressFields (structured venue address — sign+pay gate & admin edit),
│   │   │                       # VenueSearchInput (venue-name typeahead (Google Places)),
│   │   │                       # ClickableRow (table <tr> wrapper: plain click navigates, drag selects/copies text),
│   │   │                       # RowLink (real-anchor wrapper for a ClickableRow's primary cell: ctrl/cmd/middle-click opens a new tab natively),
│   │   │                       # EntityLink (quiet inline entity reference: real anchor, inherits color, hover underline; nullish `to` renders children unlinked),
│   │   │                       # ClientConversation (shared SMS thread + reply pane: used by the Messages inbox and the client detail page),
│   │   │                       # AddonControls (shared add-on UI controls: quantity stepper + greyed bundle badge, used by ProposalCreate + the shared proposalEditor/),
│   │   │                       # AdminMenuPrintBlock (bar-menu print file card on Event Detail: upload/replace/remove, or mark "no menu needed"; staff download and print it from their event details page),
│   │   │                       # admin/SourceBadge (small "Thumbtack" origin badge next to a proposal's client name when source='thumbtack'),
│   │   │                       # StaffShell + StaffShellWithThemeWiring (staff portal v2 layout shell — bottom tab bar + user pill, outlet for routed pages),
│   │   │                       # StaffUserPillMenu (account-pill dropdown rendered by StaffShell)
│   │   │   ├── staff/          # Staff portal redesign shared components (Placeholder; ShiftCard; TeamRosterCard; DropCoverModal; BeoSections; EventActionArea; PayoutEventRow; LogisticsTag; RoleRankPicker; RequestSheet)
│   │   │   ├── adminos/        # Admin OS shell + primitives (Sidebar, Header, CommandPalette, Drawer,
│   │   │   │                   # GlobalSearchButton (search-bar-shaped button that opens the ⌘K command palette; header + toolbar),
│   │   │   │                   # StatusChip, StaffingCell (events-list staffing column: confirmed/needed with a red shortfall, plus a requests-vs-waitlist chip), RainbowDefs, Toolbar, Icon, KebabMenu, SortableTh (clickable sort headers), AddressLink,
│   │   │   │                   # InterviewScheduleModal, PackageIncludesModal, DocumentPreviewModal (in-app lightbox for staff docs — W-9/BASSET/resume/headshot), MetricsFilterBar,
│   │   │   │                   # ServiceExtensionPanel (service-extension requests card on EventDetailPage: status chips, money, acceptance stamp, override with required reason, cancel; money IS shown here, unlike every staff surface),
│   │   │   │                   # format, nav, shifts (shift-row helpers for admin surfaces: positions/approved counts, remainingByRole, eventStatusChip,
│   │   │   │                   #   and isCancelledEvent/selectUpcoming — the single definition of "cancelled" and "upcoming" for surfaces reading the
│   │   │   │                   #   deliberately-unfiltered GET /shifts feed, so a cancelled event cannot leak back into an upcoming/needs-staff list; shifts.test.js guards it),
│   │   │   │                   # PresenceStrip (sidebar time-clock strip);
│   │   │   │                   # drawers/{InvoicesDrawer,ShiftDrawer,PresenceDrawer})
│   │   │   ├── SendModal/      # Shared compose-and-confirm modal for the comms registry (previews server-resolved recipient + channels, admin edits subject/body, sends with honest per-channel results; sendResult.js exports describeSendResult for per-channel toast copy); used by ShoppingListModal approve + proposal-side sends (initial creation send, resend, compare link, portal invite, balance reminder, drink-plan nudge re-enroll)
│   │   │   ├── ShoppingList/   # Shopping list editor modal + PDF export + ConsultationForm (generation is server-side via the regenerate endpoint) + NeedsRecipeSection (client-requested-drink recipe drawer: reuse-before-create, inline fold-in via regenerate, unresolved-ingredients warning) + DerivationStrip (planner-v2 demand "how we got here" strip + Client-view preview)
│   │   │   ├── potions/        # RecipeEditor: shared structured-recipe editor (Recipes tab detail pane + shopping-list Add-recipe drawer; draft name editing, inline add-par, forwardRef flush) + RecipeEditorSections (dossier tab sections: enhancements, syrup pairing, flags)
│   │   │   └── MenuPNG/        # Standard Menu PNG export (html2canvas-driven, lazy-loaded; renders hidden MenuPreview at print scale 768x960 and downloads as 2304x2880 PNG)
│   │   ├── data/               # Shared data (addonCategories, eventServicesAgreement, eventTypes, menuSamples, packages, syrups)
│   │   ├── hooks/              # Custom hooks (useDebounce, useDrawerParam + drawerHref, useFormValidation, useWizardHistory, useMetricsFilter, useUrlListState (URL-backed list/tab/filter view state), useFormDraft (server-side autosave for the long onboarding forms), useIsPhone (the single 700px phone-fork breakpoint for the mobile admin))
│   │   ├── pages/
│   │   │   ├── (auth)          # Login, Register, ForgotPassword, ResetPassword
│   │   │   ├── (onboarding)    # Welcome, FieldGuide, Agreement, ContractorProfile, PaydayProtocols, Completion
│   │   │   ├── (staff)         # Application, ApplicationStatus, HiringLanding, PreHireOnboarding (open pre-hire URL)
│   │   │   ├── (admin)         # AdminDashboard (AdminUserDetail moved into admin/userDetail/, AdminApplicationDetail moved into admin/applicationDetail/)
│   │   │   ├── mobile/         # Phone-first admin pages (MorePage: the More tab, every non-tab surface as tap rows with the adminOnly filter + the deliberate Payroll row)
│   │   │   ├── admin/          # Dashboard sub-pages (PotionsPage bar-program home at /potions with potions/ RecipesTab + PantryParsTab + PackagesTab/PackageDetail/MakeabilityPanel (planner-v2 package model: contents, slots, live margin, makeability) + PlansDrawer siblings, proposals (ProposalCreate cockpit split into proposalCreate/ with ClientSection + EventSection + PackageSection + AddonSection + shared helpers.js Lbl), clients, events, EventDetailPage, proposalEditor/ (shared proposal/event editor mounted by Proposal Detail AND Event Detail: ProposalEditorForm + PackageSection + formState seed/recovery helpers + single patchBody payload builder + repriceSummary/RepriceConfirmModal booked-event reprice confirmation; replaced ProposalDetailEditForm + EventEditForm), shifts, staff, menus, hiring, blog, email marketing, Messages admin SMS conversation/thread page, TipsAdmin tip overview, userDetail/tabs/TipPageTab admin tip-page controls, applicationDetail/, NotificationSettings per-user notification-subscription toggles, SecuritySettings passkey list + revoke on the /settings Security tab (revoke = global logout by design), ProposalChangeRequestCard client-portal change-request review card on Proposal Detail (diff, preview, apply-in-editor, decline), AlternativesPanel option-group manager on Proposal Detail (add/remove alternatives, Send options, copy compare link), ChangeRequestsDashboard admin pending-requests queue at /change-requests, eventDetail/MessageLogCard newest-first client message log (email + SMS, sent/failed) on EventDetailPage, payroll/PayRunView open-period pay-run queue (stat strip + period cards with process/reopen) + payroll/PayPanel per-payout generate-gated method-aware pay panel (replaced PayQRModal + MarkPaidAction + PayrollHeader, all three deleted), payroll/DeferredTipsPanel admin list + Retry button for tips/clawbacks that deferred while the open pay period was frozen, StripePayoutsTab Stripe payout reconciliation tab on the Overview Payouts tab, payroll/TaxTotalsTab 1099 calendar-year totals tab with per-person include/exclude toggle + CSV export, userDetail/tabs/PayoutsTab imported payment-history section + blended all-time total, CancelEventDialog 3-step cancel-booked-event modal on Proposal Detail + Event Detail: mode radio → server-computed preview → typed-last-name arm + suppress toggles, then a distinct Issue-refund action, CancelLineDialog per-line-item removal + refund modal on Proposal Detail + Event Detail: server targets enumeration → rolled-back-preview → two-step confirm with notify-client chaining; package row hands off to CancelEventDialog, StaffReviews review log + quarterly contest at /reviews, payroll/DutyLineRow + payroll/AttributionModal duty-pay editing + run-payroll attribution on PayRunView + payroll/dutyKinds.js manual-add duty-kind catalog (labels + per-kind default cents; EVENT kinds minus out_of_area, review kinds never manual), OutOfAreaKnob Out-of-Area Bonus control on the Event Detail staffing card (dollars in / cents out, server-supplied suggestion + venue distance, locked badge, unlocked-money warning; the $250 cap and the bands stay server-side), RemoteStaffingFeePrompt pre-send Remote Staffing Fee popup shared by ProposalCreate's first send and ProposalDetail's send + resend: self-checks and auto-proceeds when there is nothing to ask, otherwise offers add-suggested / custom / send-without and writes the surcharge through the existing editor PATCH builder)
│   │   │   │   └── overview/    # Overview money board (Dashboard + Financials merged into one surface at /dashboard; /financials and /financials?tab=payouts redirect here). OverviewPage composes the Band 1 live triage (NeedsYouStrip = the tabbed Needs-attention card: Staffing / Prep / Clients tabs plus a conditional Sales tab, headers carrying count + worst-priority dot; beside it a right rail of standing cards, PipelineCard then PayrollStatus (admin-only); the upcoming-events card was scrapped 2026-07-13, /events covers it) and the Band 2 filtered analysis (MoneyTiles = expandable stat tiles Close rate / Collected / Outstanding / Avg event / Lead spend; RevenueChartCard; FunnelCard with the Split control; LeadSpendCard; RangeTables = proposals + payments in range). queueItems builds the staffing/clients/sales items + tab assembly (pure, unit-tested); PrepQueue builds the drink-plan queue items. The Money tab was removed 2026-08-17: unmatched Stripe payouts are the Band 2 Payouts button's badge, and payroll became its own rail card. Dated Staffing rows are capped at a 14-day horizon (`STAFFING_HORIZON_DAYS`) so the tab stays actionable; /events remains the full forward view.
│   │   │   │   └── marketing/   # Marketing redesign at /marketing (OverviewTab moments/numbers/needs-you as the LANDING tab, SentTab with booked attribution, ComposeTab write/recipients/send + RecipientPicker mailable-only selection, MarketingLayout tabs + AudiencesTab audience picker, ContactTable contact base with inline TagCell tagging, DoNotContactControl reason-gated house suppression, ContactDrawer event + message history, HeldBackPanel who-cannot-be-emailed breakdown, all four tabs are real; MarketingPlaceholder was deleted in lane mkt-h). The legacy /email-marketing surface is untouched and still owns Leads.
│   │   │   ├── staff/          # Staff portal — the live v2 portal, mounted at root on staff.drbartender.com (HomePage, ShiftsPage + ShiftDetail (+ RequestMoreTime, the lazy-loaded request-more-time card ShiftDetail opens mid-event: 30-minute end-time picker, hosted product-confirmation checkbox, request-sent confirmation; no price ever shown to staff), PayPage + PayoutDetail, TipCardPage, EmailVerifyPage email-change confirm) + DownloadTipSign, the standalone page a bartender opens to download their bar sign (DownloadTipSign.jsx + .css) drawing tipCard/ (sizes.js canvas table + the PER-SURFACE capture scale, since the sign is authored at 150 DPI and captured at 2x while the card is native 300 and captured at 1x; PaymentMarks.jsx shared pieces + design-token import; typeFit.js shared canvas name-measurement + the font-ready re-measure hook; SignLayout.jsx the 5x7 bar sign, exactly 5x7 with no bleed because a photo counter prints at a named size and never trims (one size: a QR wants ~1/10 its scan distance plus 20-30% in low light, and a bar is low light); BizCardLayout.jsx the two-sided hand-out card, PORTRAIT 2x3.5in on a 675x1125 bleed artboard because it does go to a press that trims; PhoneSignLayout.jsx the display-mode layout at the device's own 9:19.5 proportions; renderToFile.js the single html2canvas capture feeding JPG/PNG/PDF)
│   │   │   │   └── account/    # AccountPage shell + sub-nav with ProfileSection, PaymentMethodsSection (+ PaymentMethodRows + AddMethodModal), CalendarSyncSection, NotificationsSection (+ IOSCoachmark + PushPermissionBanner), DocumentsSection (+ ReplaceConfirmModal)
│   │   │   ├── plan/               # PlannerRouter (planner_version switch) -> legacy PotionPlanningLab (v1 wizard, steps/ components/ data/ intact for in-flight drafts) OR v2/ (planner v2: PlannerV2 orchestrator, queue.js, steps/ x11 — no payment UI, hosted three-shape picker, crowd questions); lab/ (Enhancement Lab page at /plan/:token/lab: EnhancementLab orchestrator + LabShelves + LabLedger, invoice-only additions)
│   │   │   ├── invoice/        # InvoicePage — public token-gated invoice view + payment
│   │   │   ├── proposal/       # ProposalView (public client-facing) — split into proposalView/ folder (parent + ProposalHeader + ProposalPricingBreakdown + SignAndPaySection + PaymentForm + AgreementText markdown-lite renderer + helpers + styles) + compare/ (ProposalCompare thin wrapper for the option-group page at /compare/:token + PackageMatrix aligned live-priced compare grid; its ExplorePackagesSection export is superseded by otherOptions/ and no longer referenced) + otherOptions/ (OtherOptionsPanel browse + pin-to-compare + CompareTable difference-marked matrix + ExtrasPanel, the in-proposal "see other options" surface) + catalogBuckets.js (shared package-contents bucketing)
│   │   │   ├── public/         # Client portal (ClientLogin, ClientShoppingList, Blog, BlogPost) + tip flow (TipPage with TipPage.atoms.jsx + TipPage.css, TipPageThanks post-tip feedback, TipSignDisplay full-screen bar-top display mode at /tip/:token/display: public and token-gated so a venue tablet needs no login, fetches ?view=sign which carries no payment handles, renders PhoneSignLayout at the device's own proportions rather than scaling the 5x7 sheet, holds a screen wake lock re-acquired on visibility change)
│   │   │   │   └── portal/     # Client Portal v2 — PortalHome (landing), EventCommandCenter (focus shell), OverviewWidgets, ArchiveList, ShareButton, EmptyStates, ChangeRequestForm (request-a-change form with live price preview), money/nextUp/constants helpers + tabs/ (OverviewTab, PrescriptionTab, PotionTab, ReceiptsTab, ChangeRequestBanner pending/decided status banner on the Prescription tab)
│   │   │   └── website/        # Public website (HomePage, ServicesPage, PackagesPage, MethodPage, AboutPage, FaqPage, QuotePage, ClassWizard, quoteWizard/ — split QuoteWizard with steps/extras/ (AddonTile + BundlePicker + AddonAccordion) for the Extras step redesign; legal/ — LegalLayout + PrivacyPage + TermsPage at /privacy + /terms, the URLs submitted for Twilio A2P campaign review; SmsOptInPage at /sms — the standalone SMS opt-in form, also submitted for A2P review, whose path is referenced by the campaign and must not be renamed casually)
│   │   ├── images/             # Brand assets. images/marketing/ holds the 8 public-website photos, kept under src/ (NOT public/) on purpose: webpack content-hashes them into /static/media/, which Vercel already serves `s-maxage=31536000, immutable`. Anything hand-placed in public/ ships without a hash and Vercel then serves it `max-age=0, must-revalidate`, so every repeat visitor re-validates it. Reference them with an `import`, never a `/images/...` string
│   │   └── index.css           # Global styles
│   ├── scripts/                # Client build-time scripts (not app code)
│   │   └── scope-admin-os-css.js    # Rewrites a CSS file so its rules only apply under html[data-app="admin-os"]
│   ├── vercel.json             # Host-gated redirects (admin/staff/public split) + the SPA rewrite. Deliberately carries NO `headers` cache rule: the SPA catch-all rewrites any missing path to index.html with a 200, so a cache rule on an asset prefix would also cache a typo'd URL's index.html for the full TTL. Content-hashed /static/ assets need no rule
│   └── package.json            # React deps, proxy: localhost:5000. `build` = plain `react-scripts build` and must stay a single command: scripts/push-gate.js runClientGate spawns `npx react-scripts build` directly, so any extra step chained here would never be exercised by the local gate that claims to run what Vercel runs
├── scripts/                    # Build + workflow scripts (check-file-size.js, check-css-palette-scope.js, optimize-assets.js, worktree-new.js, worktree-rm.js, backfill-duty-lines.js duty-pay ship/period-open re-derive, make-admin-icon.js admin PWA placeholder icon set)
│   │                           # think-on-main/build-in-lanes tooling (each with a co-located *.test.js where noted):
│   │                           #   guard-os-main.sh (+ .test.js)   : pre-commit os-stays-on-main guard
│   │                           #   merge-lane.sh (+ .test.js)      : flock'd squash-merge wrapper
│   │                           #   board-write.sh (+ .test.js)     : atomic build-board writer with PII denylist
│   │                           #   lane-status.js (+ .test.js)     : open-lane listing + stale-lane detection (npm run lane:status)
│   │                           #   sensitive-paths.txt             : the one sensitive-path list (review/conflict/auto-pull trigger)
│   │                           #   sensitive-match.js (+ .test.js) : matcher that reads sensitive-paths.txt
│   │                           #   testdb-smoke.js                 : pre-push money-smoke gate (npm run test:smoke); resets Neon ci-smoke + runs the money suites (see README > Test gate)
│   │                           #   money-smoke-list.txt            : the money-path suite list testdb-smoke.js runs
│   │                           #   push-gate.js (+ .test.js)       : owns BOTH pre-push gates + the receipt (npm run gate); the hook calls it and skips only when HEAD, every dirty file's CONTENT, and the pushed sha all match what was gated
│   │                           #   check-claudemd-invariants.sh    : paired keyword/regex coverage check over CLAUDE.md
│   │                           #   claudemd-invariants.txt         : the invariant manifest it checks
│   │                           # one-time CheckCherry migration operator scripts (phases 1-3, each with co-located tests):
│   │                           #   cc-clients-import.js            : 187 CC clients (dry-run default, cc_id idempotency)
│   │                           #   cc-ledger-import.js             : frozen CC-era ledger load (P&L penny-tie gates, double-count guard, transfer skip)
│   │                           #   cc-transfer-events.js           : future CC events -> native proposals (manifest-driven, born-confirmed, comms-guarded, --resume)
│   │                           # other one-off operator scripts (dry-run default, --apply to write):
│   │                           #   reset-unpaid-gratuity.js (+ .test.js) : strip pre-election self-elected gratuity from UNPAID proposals (column- OR snapshot-carried); refuses any paid row
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
| `npm run gate` | Run BOTH pre-push gates now (money smoke + Vercel client build, whichever the diff needs) and write a receipt, so the push itself is instant. Strongly recommended before any push: `git push` opens its connection before running the hook, so an 8-minute hook makes GitHub close that connection and the push fails *after* passing everything. The hook re-runs the full gate whenever the receipt is missing, expired (>12h), for a different HEAD, for changed file contents, or for a pushed sha that is not HEAD, so this never weakens the gate. See [Test gate](#test-gate). |
| `npm run audit:check` | Check for known dependency vulnerabilities |
| `npm run check:filesize` | Report every source file by line-count zone (RED over 1000, YELLOW 700-1000) |
| `npm run check:css-scope` | Assert the legacy Apothecary palette stays out of the Admin OS shell (`scripts/check-css-palette-scope.js`): no unscoped bare-element rule painting an Apothecary token (`inherit`/`currentColor`/a non-palette literal are fine; `@keyframes` steps are out of scope), and no admin-reachable class rule painting an Apothecary `:root` token below 3:1 in a skin that has no skin-aware admin override. Exits non-zero on a finding, so it can gate CI. Also runs on pre-commit whenever `client/src/index.css` is staged, but **warn-only there on purpose** while the parser burns in — it prints and never blocks the commit, because a false positive on the repo's largest file would cost you `--no-verify`, which also skips `check-file-size`, lint-staged and `guard-os-main`. |
| `npm run test:css-scope` | Test the palette-scope checker itself (`scripts/check-css-palette-scope.test.js`): asserts index.css is clean today, and re-arms the trap in memory to prove the checker still goes red. Separate from `npm test` on purpose — that glob is `server/**` and those suites share the dev database, while this one is pure text analysis. |
| `npm run mobile:check` | Dev-only phone-viewport (390x844) screenshot + overflow probe of every client-facing surface (`scripts/mobile-capture.js`); merge gate for the mobile-fixes lanes. EXPECTED to stay red on main until the mobile-sweep lane lands: the baseline failures are the audited P0s, not regressions |
| `npm run optimize:assets` | One-shot asset optimization (PNG→WebP at tile size, TTF→WOFF2). Idempotent — skips already-converted outputs. |
| `npm run worktree:new -- <name>` | Create a parallel-dev worktree at `../worktrees/<name>` on a new branch off `main`, with `node_modules`, husky, and BOTH env files (`.env` + `client/.env`) symlinked in. `client/.env` matters for running, not just committing: it carries `REACT_APP_API_URL`, and without it CRA bakes an empty API base into the bundle and every call 500s against the dev server |
| `npm run worktree:rm -- <name>` | Tear down a worktree: remove its symlinks, the worktree, then the branch (`--force` to discard an unmerged branch) |
| `npm run lane:status` | List open lanes (worktrees) and flag stale ones (48h no-commit, 15+ main commits since cut, or a sensitive path landed on main since cut); run at session start and in the push sweep |

## Key Features

### Shift lifecycle: "has it finished", not "what day is it" (2026-08-14)
- Every shift-visibility surface asks whether the shift's **end instant** has passed, not whether its date is today or later. One definition, `server/utils/shiftEndInstant.js`, imported by all eleven consumers — a COUNT and the LIST it counts share the expression, because two copies is exactly how they silently diverged before
- Why it changed: SQL `CURRENT_DATE` resolves in the session timezone, which is GMT, so from 19:00 Chicago tonight's shift vanished from the staff Available tab, the admin assign modal, the staffer's own next-shift card and the SMS responder — five hours before the bar opened. Widening it to the Chicago calendar day fixed the disappearance and created a worse bug, where a shift that ended this morning stayed "upcoming" and a CANT text dropped the wrong one
- An unknown end is **assumed** (booked length plus an overrun grace), never deferred to midnight, and an unparseable time falls back toward visible. Hiding a shift while people are still behind the bar is the failure this exists to prevent
- Shifts now actually close: an hourly sweep (`shiftClosureSweep.js`, `RUN_SHIFT_CLOSURE_SWEEP_SCHEDULER`) flips a finished shift on a completed proposal to `completed`. It never writes `cancelled` — that value is read as an EVENT-cancelled signal by the Events dashboard and the iCal feed. `server/scripts/backfillShiftClosures.js` (dry-run by default) heals the existing stranded rows and loudly reports any paid event with nobody on its roster

### 2:00 AM Service Curfew (2026-08-06)
- Bar service past 2:00 AM local is refused on every path that can set a duration, because the liquor liability application (PK810225-GLLL230810) warrants no operations past 2:00 AM and a warranty breach can void coverage for the claim
- Who is acting decides how hard the refusal is: the public quote wizard and client portal change requests refuse outright; admin proposal create/edit refuses by default but proceeds on an explicit acknowledge-and-record confirm (audit-logged); extension settles refuse with no override, before claiming the row
- The staff request-more-time picker is built from the same curfew math, so it can never offer an end time the validator would reject; a booking ending exactly at 2:00 AM is legal

### On-Site Service Extension (2026-08-03)
- Mid-event "more time?" flow: an assigned bartender opens Request more time on their shift page once the event has started, picks a new end time (30-minute steps, up to 3 extra hours), and the client is texted and emailed a link to their invoice page (suppression preferences respected; an unreachable client alerts admins to relay the link). Staff never see a price on any surface of this flow
- The client reviews versioned coverage terms on the invoice page (same team, same agreement, same liquor liability coverage; acceptance is recorded server-side with timestamp, IP, and user agent, and payment is blocked until it is) and pays right there. An extension whose price delta is zero settles on acceptance alone; hosted per-guest packages also require the bartender to confirm they have product for the extra time
- The price is the pricing engine's catalog delta between the contracted and requested durations, so duration-priced components (hourly bartenders, per-hour and timed add-ons) move and everything else cancels
- Extension money is side money: it lives on its own invoice under the off-ledger 'Service Extension' label, and total_price, amount_paid, and pricing_snapshot never move. The only contract change is event_duration_hours plus the single shift's end time
- On settle, payroll hours re-seed from the new duration (only when the admin has not hand-edited the line), the extension's gratuity delta joins the payroll pool, and the bartender gets the greenlight message. A 60-second sweep expires unanswered requests past their grace window: invoice voided, staff told service ends at the contracted time
- Admins see every request in a panel on Event Detail (with money, unlike staff) and can override (grant the time, void the invoice) or cancel a pending request

### Designed-Email Builder (2026-08-03)
- Marketing campaign send at `/marketing/compose` (admin only): write a subject and body, pick recipients from an audience or by search, and send. Four guards, each tested: mailability is RE-CHECKED at send time (the picker's list is a snapshot, and whoever was excluded in between must not receive it), recipients are deduped by lowercased address, each recipient is CLAIMED in `email_sends` before Resend is called so a double-click or two operators are arbitrated by the database, and the run is paced serially because a burst that trips Resend's rate limit fails an arbitrary subset. A quota 429 stops the run resumably rather than marking everyone failed. One run per campaign at a time, claimed as an `email_campaigns.status = 'sending'` row (NOT an advisory lock, which is a no-op against the PgBouncer pooler).
- Marketing contact base at `/marketing` (admin only): seven prebuilt audiences with live emailable counts, a contact table with inline marketing tagging, evidence-backed tag suggestions a human must accept (Corporate is never inferred), a reason-gated do-not-contact rule that takes a confirmation to clear, a contact drawer showing event history plus every message sent with automated sends marked, and a held-back panel breaking out who cannot be emailed and why. One server-side resolver (`server/utils/marketingAudience.js`) owns mailability; nothing else restates it.
- Mailchimp-style block designer inside the Marketing campaign composer (`client/src/components/emailBuilder/`): heading, text, image, button, hero, two-column, divider, and spacer blocks with drag-to-reorder (@dnd-kit), per-block settings, and starter templates
- The design (`email_campaigns.design_json`) is the source of truth: `html_body`/`text_body` are server-rendered from it (`emailBlockRenderer.js` → table + inline-style email-safe HTML) and never trusted from the client; block rich text passes the shared allowlist sanitizer (`emailSanitize.js`), and button/image URLs are scheme-checked (http/https/mailto/tel)
- Draft blasts get the full designer plus an exactly-as-sent server-rendered preview (desktop/mobile) and a one-address test send; the SEQUENCE pipeline is unchanged; the blast send was retired in lane mkt-f and replaced by the marketing campaign send described below
- Campaign images upload through `POST /api/email-marketing/upload-image` (admin+manager): sharp re-encode bounds width at 1088px, strips metadata, and derives the stored extension from the decoded format

### Public Legal Pages + Client SMS Consent (2026-07-22)
- `/privacy` and `/terms` are real pages with real footer links; both are submitted to Twilio for A2P 10DLC campaign review alongside the `/sms` opt-in page, and `/privacy` quotes the consent sentence verbatim from the same constant the checkboxes render
- Terms governs USE OF THE SITE only. Booking, cancellation, and refund terms live in the signed Event Services Agreement, which controls on conflict, so the public page can never drift into contradicting an executed contract
- The quote wizard carries an SMS consent checkbox, unchecked by default and never a condition of booking. Consent is never persisted in a saved draft, so a restored quote can never come back pre-ticked
- `/sms` (added 2026-07-30) is a standalone one-screen opt-in form carrying the same checkbox, built after the campaign was rejected twice (30909, then 30896) because a reviewer opening `/quote` never reaches step 2. It is the URL the campaign now submits as its opt-in page, it is footer-linked from every public page, and its field order (mobile number, then the checkbox, then name and email) is what keeps the checkbox in the first screen on a phone. A THIRD rejection (forced consent, 2026-08-03) made the box optional there and the number required only when it is ticked: an un-ticked submit is an email-only signup that upserts `email_leads` and never touches `clients`, so it neither records a decline nor blocks a later opt-in
- Every *recorded* answer writes an append-only `sms_consent_log` row (timestamp, the exact text agreed to, source form, IP) alongside the existing `communication_preferences` flag. That log is the artifact handed to a carrier or a claimant. An un-ticked box on `/sms` is deliberately not an answer and records nothing: a decline there would stamp the hard `sms_opt_out_at` that blocks every future opt-in
- The public form may only write to a client row the same submit created, and never lifts an inbound STOP for that row or for any row sharing the number. Existing clients keep whatever preference they already had
- Event-eve reminders are now an SMS + email pair, so a client who declines texts still gets the day-before bartender, arrival window, and location

### Notify-Client Confirmation (2026-07-22)
- Admin edits and recorded payments no longer message the client on their own: a confirmation names exactly what would go out (recipient, channels, the drafted old-vs-new message, and the projected auto-charge/balance-due date when a date move shifts it)
- Quiet is the default on event edits (the usual case is a personal reply already sent); Send-receipt is the default on recorded payments; refund notices follow in a later lane
- Reviewed text is what sends (WYSIWYG through the shared parts renderer); per-channel truth comes back on the response, and failures plus real skips surface as toasts (a clean send stays quiet behind the normal success toast)
- Suppression prefs, hard bounces, and CC-import placeholder addresses win over an explicit Send, reported as skipped, never silently dropped

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
- Checkout gratuity: clients choose a tip jar or a pre-paid gratuity at sign-and-pay, and the election persists ONLY when payment succeeds (it rides the PaymentIntent metadata and is applied by the Stripe webhook), so an abandoned checkout leaves the quote service-only and an unpaid proposal never carries a self-elected gratuity; post-payment removal goes through cancel-line-item. It scales with crew and hours and flows to staff through payroll
- Admin gratuity mandate (2026-08-10): for events where the host must prepay the gratuity (corporate, kids-centered), admin sets a required gratuity on the quote from the proposal editor; it shows in the total immediately, floors the client's checkout election on both jar answers (replacing the $50 no-jar floor, never stacking), rescales with staffing at a canonical rate, and locks once the client signs or pays
- Autopay enrollment: clients can opt to have their remaining balance auto-charged on the due date (default: 14 days before event)
- Admin-overridable balance due dates
- Hourly autopay scheduler charges saved payment methods when balance is due
- Proposal options / compare: admin sends a client 2-3 alternative proposals (say, BYOB next to Hosted) behind ONE `/compare/:token` link with side-by-side package contents; the client chooses and signs/pays on that option's normal page; the first settled payment locks the winner (first-writer-wins), archives the other options, and voids their unpaid invoices. Grouped sends go out as a single "Compare your options" email with per-option comms suppressed and invoicing deferred to the winner's payment. The compare view is an aligned matrix (rows = price for this event, deposit, hosted-minimum note, catalog sections; columns = packages) that renders each option's STORED total/deposit and snapshot floor fields (an option's stored total includes addons, adjustments, and overrides: the number the client actually pays), collapsing to stacked cards under 640px. That explore-matrix section on the proposal page is superseded by the "see other options" surface below (the option-group gate that used to suppress it is gone); a booked client can request a package swap through the change-request form (priced through the existing change-request pipeline, with the admin review card resolving package ids to names).
- **See other options (on the proposal page):** an opt-in panel under any unsigned, non-custom-priced proposal showing EVERY bar we could run for that event — each hosted package plus BYOB as a real configuration (The Core Reaction with a support tier, so it stops showing as a bare bar-service fee next to hosted columns) — priced for the proposal's own guests/hours/bars. The client pins up to three and compares them in an aligned matrix that MARKS DIFFERENCES ("only on this one" / "on all of them") rather than printing two comma-run-on lists; extras toggle across every pinned option at once so the comparison stays apples-to-apples. All pricing comes from ONE request (`POST /t/:token/options`, on its own token-keyed limiter) through `priceProposedState`, the same function a commit would use, so the quote matches the stored total exactly — including admin bartender overrides and add-on quantities, which the current option must reproduce to the penny. Read-only: browsing, re-tiering, and toggling extras write nothing, and choosing an option currently hands off to Dallas (self-serve sign-and-book is the follow-on lane).
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

### Cancel Line Item
- Admin-only ✕ on each line of the pricing breakdown, on both Proposal Detail and Event Detail. Removes the line AND settles the money in one act, closing the old gap where a refund returned money but left the item on the contract (and the client owing it again).
- Every client-visible line is a target: add-ons (with a "remove how many?" picker), portable bars, syrups, over-ratio bartenders, adjustments, and gratuity. The package line hands off to the cancel-event flow.
- Two-step confirm. The preview is server-computed by running the SAME core inside a rolled-back transaction, so the button restates exactly what will happen ("Remove and refund $225.00"), and a fingerprint rejects a stale preview if anything moved.
- The removal commits first; refunds fire after, so a Stripe failure leaves the removal standing with the overpaid flag and the payment panel as the retry. Money paid outside Stripe is called out as a manual return, never auto-refunded.
- Removing or lowering a gratuity below the $50 no-jar floor flips the tip jar on and emails the assigned staff that they can set one out. Removing a lab-added item also strips it from the client's drink plan so the Enhancement Lab cannot re-add it.

### Tip QR Pages
- Each onboarded bartender gets a public token-gated tip page (`/tip/:token`) with their photo, name, and tip buttons
- Tip buttons deep-link to Venmo and Cash App when the bartender has those handles set, plus a Stripe Payment Link fallback that flows to the bartender's Stripe Express account
- Stripe Payment Links are auto-provisioned (and regenerated on demand) via `server/utils/tipPaymentLinks.js`; tip flow is recorded in the `tips` table on `checkout.session.completed` (branched by `metadata.kind = 'tip'`)
- After tipping, guests land on a thank-you page that nudges a Google review and offers an optional bartender feedback form (`tip_page_feedback` table; admin reviews in TipsAdmin)
- Bartenders manage their tip page from the staff portal Tip Card tab (`TipCardPage`) and download a bar sign from `DownloadTipSign`: a 5x7 as JPG, PNG, or PDF for a photo counter, plus a two-sided hand-out card as a print-shop PDF. Every format lands at 300 DPI off one html2canvas capture, at the scale that surface is authored for. The sign is dark chalkboard with a large cream QR plate so the plate is the brightest thing on the sheet; the brand lockup leads it at real size, and it carries the bartender's name, an ask and a reason, plus up to five untiled payment-brand marks in each brand's own dark-background artwork (recognition is the mechanism: a credit-card emblem on a tip tray measurably raised tips). The sign ships with no bleed and a content inset instead, because a photo counter prints an image at a named size and never trims to marks; the card keeps its bleed, because a press does. Both surfaces are built against a design artifact vendored under `docs/design-artifacts/`, whose README records every deliberate departure and why
- Display mode (`TipSignDisplay`) shows the sign full screen on a propped-up phone or tablet in its OWN native 9:19.5 layout rather than a scaled-down 5x7 (fitting a 5:7 sheet onto a phone letterboxes away most of the screen and shrinks the QR, which is backwards), kept awake by the Screen Wake Lock API and re-acquired whenever the tab comes back to the foreground
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
- Admin-triggered client sends (shopping-list approval plus the proposal-side sends: initial creation send, resend, compare link, portal invite, balance reminder, and drink-plan nudge re-enroll) route through a shared compose-and-confirm modal. The admin reviews the server-resolved recipient and available channels, edits the subject and body before anything goes out, then cancels or sends. A Cancel never touches the client record. The proposal creation cockpit composes the initial send the same way: it always saves the proposal as a draft first, and the modal's confirm performs the draft-to-sent flip plus invoice in one transaction (the `proposal_send` action), so cancelling simply leaves a clean draft. On send, each channel returns an honest result (for example email sent, SMS failed) instead of one all-or-nothing status, and every attempt writes a `message_log` row recording the sending admin (`sent_by`) and whether the copy was hand-edited (`body_edited`).

### Lead Call Bridge (real-time first-ring)
- A new in-window (8am-9pm Chicago) Thumbtack lead auto-rings Dallas from the 888 with a spoken briefing (name, event, date/time, guests, city); press 1 bridges to the lead from the 224, press 9 replays, no answer fails over to Zul
- Only chain FAILURES alert (email via the `lead_call` category + Sales-tab item); missed and after-hours chains log quietly in `lead_call_attempts` (the moment has passed; follow-up rides the normal email/SMS pipeline). A 20-second bridge floor keeps relay refusals from marking a lead contacted
- Auto first-reply (`TT_AUTOREPLY_ENABLED`, default off): every lead gets the saved `day`/`night` Thumbtack quick reply sent through the harvester box within ~30s; day replies promise the call and the phone chain fires only after the reply is confirmed (respond-then-ring), with a 3-minute fallback so a stuck browser never loses a lead; night and after-hours leads get an on-platform reply too, so the TT response rate covers 100% of leads
- Kill switch `LEAD_CALL_ENABLED=false`; rolling-24h `LEAD_CALL_DAILY_CAP`; lead legs only ever dial `toUsE164`-validated US numbers; overnight leads get the night quick reply (auto first-reply) and log without a call

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

### Team Manual (`/vibes`)
- The vibe-coding manual for the team, served as a standalone static page at `admin.drbartender.com/vibes` (no login). Source lives at `client/public/vibes/index.html`: one self-contained file, no bundle involvement, carrying the OS design tokens inline so it renders in both After Hours and House Lights with a skin toggle (persisted to `localStorage`), plus expand/collapse-all over its collapsible sections.
- The pretty URL comes from a host-scoped rewrite in `client/vercel.json` (`/vibes` → `/vibes/index.html` on the admin host); the file itself is a static asset, so `/vibes/` also resolves on the other hosts.
- Carries `noindex, nofollow` — the page is unlisted, not gated. Keep it that way: it is public to anyone with the URL, so it deliberately holds no client names, no infrastructure addresses, and no credentials.
- Authored in a claude.ai/design project and converted; the prose master is the guide markdown Dallas keeps in win-share.

## Deployment

### Backend — Render
The `render.yaml` blueprint defines the web service and PostgreSQL database. Push to `main` auto-deploys.

### Frontend — Vercel
The React app is deployed separately on Vercel. `client/vercel.json` handles SPA routing. The build-time `REACT_APP_API_URL` points to the Render backend.

### Database
Schema is auto-initialized on server start via `server/db/index.js`, which runs `schema.sql`. All DDL is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

### Test gate

Because a push to `main` **is** the deploy, `.husky/pre-push` is the only place that can actually block a bad deploy. Two mechanical gates run there:

- **Money smoke** (when the push touches `server/`, `scripts/money-smoke-list.txt`, `scripts/testdb-smoke.js`, `scripts/push-gate.js`, `package.json`, or `package-lock.json` — the gate's own machinery and dependency set count, because changing them changes what the gate does) — runs first. It resets the isolated Neon `ci-smoke` branch (a prod-parented copy) to its parent, fetches its connection URI, runs `initDb` against it (which also validates any `schema.sql` change *before* prod boot replays it), then runs the money-path suites in `scripts/money-smoke-list.txt` serially (payroll accrual/clawback/late-tip, autopay durable trio, Stripe webhook guards + last-minute checkout, refunds/invoice lifecycle — ~60s total). Any failure blocks the push. Slow, rate-limiter-bound suites are deliberately excluded.
- **Client build** (when the push touches `client/`) — the exact `CI=true react-scripts build` Vercel runs, catching CI-fatal ESLint warnings.

Server-only pushes skip the client build; client-only pushes skip the money smoke. A *docs-only* push skips both, but note "docs-only" means exactly that: a `package-lock.json` bump or an edit to the gate scripts triggers the money smoke even with no `server/` change.

**Run `npm run gate` before pushing.** Both gates live in `scripts/push-gate.js`; the hook calls it and skips instantly when a receipt covers this exact tree. Without that, an ~8 minute hook leaves the SSH connection idle until GitHub closes it and the push fails *after* passing everything. The receipt is keyed on HEAD plus the sha256 content of every modified and untracked file, and is only valid when the sha being pushed IS HEAD (the gates test your working tree, so they cannot vouch for another commit). Missing, expired past 12h, different bytes, different HEAD, or a foreign pushed sha, and the hook runs the full gate itself. A money smoke that SKIPPED for want of a key is never recorded as passed.

**Credential — `NEON_API_KEY`.** The money smoke reads the key from `process.env.NEON_API_KEY` or `~/.secrets/neon_api_key` (trimmed). **Until the key exists the gate prints a loud red "MONEY SMOKE SKIPPED — not yet blocking" banner and allows the push** (fail-open, so pushes are not bricked before setup). The gate must run from a checkout with `.env` at the repo root (several suites need `JWT_SECRET` + Stripe test creds); pushes happen from `os`, which always has one. Once the key is present the gate is **hard and fail-closed**: any error in the reset / URI / `initDb` step, or any failing suite, blocks the push. To set it up:

1. `console.neon.tech` → account settings → **API keys** → **Create API key**.
2. Save it: `mkdir -p ~/.secrets && printf '%s' '<key>' > ~/.secrets/neon_api_key && chmod 600 ~/.secrets/neon_api_key` (no trailing newline needed — the runner trims). Never commit it.

The connection URI and the API key are never printed (masked in every error). Run it manually any time with `npm run test:smoke`.

**Emergency escape:** `git push --no-verify` bypasses both gates (deliberate, per-push, visible) — same as the client build gate.

## Operational Runbook

### Weekly dispute-email-bailout sweep

The dispute-won email notification (fires on Stripe `charge.dispute.funds_reinstated`) auto-abandons after 3 failed send attempts. The DB column `tips.dispute_email_failed_at` is the canonical "needs manual reconciliation" marker; the accompanying Sentry alert is best-effort.

**Weekly:** run the sweep query documented in `ARCHITECTURE.md` ("Weekly dispute-email-bailout sweep") to catch any abandonment whose Sentry alert was lost. The spec at `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md` carries the recovery runbook.
