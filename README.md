# Dr. Bartender

A full-stack platform for Dr. Bartender's bartending service business. Handles contractor onboarding, client event planning, service proposals with dynamic pricing, Stripe payments, and admin management.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 18+ / Express 4.18 |
| Frontend | React 18 (Create React App) / React Router 6 |
| Database | PostgreSQL (raw SQL via `pg`, no ORM) |
| Auth | JWT + bcryptjs |
| File Storage | Cloudflare R2 (AWS SDK v3) |
| Payments | Stripe (Elements + webhooks) |
| Email | Resend |
| SMS | Twilio |
| Booking / Scheduling | Cal.com (webhook integration; self-hosted target for V2) |
| Rich Text Editor | TipTap (ProseMirror-based WYSIWYG, blog admin) |
| HTML Sanitization | DOMPurify + jsdom (server-side) |
| CSV parsing | `csv-parse` (Check Cherry import pipeline) |
| Styling | Vanilla CSS |
| Error Tracking (server) | `@sentry/node` |
| Error Tracking (client) | `@sentry/react` |

## Prerequisites

- **Node.js** 18+
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
| `RUN_SCHEDULERS` | No | Schedulers fire only when `NODE_ENV=production` (Render's default). In any other environment they default to OFF, so a local dev server never burns Resend/Twilio allotments by iterating the shared Neon DB. Set `RUN_SCHEDULERS=true` to force-on locally (testing a handler against a scratch row). Set `RUN_SCHEDULERS=false` on a secondary prod instance to prevent duplicate runs. |
| `RUN_AUTOPAY_SCHEDULER` / `RUN_AUTOCOMPLETE_SCHEDULER` / `RUN_AUTO_ASSIGN_SCHEDULER` / `RUN_SEQUENCE_SCHEDULER` / `RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER` / `RUN_LABRAT_PURGE_SCHEDULER` | No | Per-scheduler disable. Set to `false` to disable that specific scheduler. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_MESSAGE_DISPATCHER_SCHEDULER` | No | Set to `false` to disable the scheduled-message dispatcher (balance reminders, plus future drip / event-week handlers). Defaults on. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
| `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` | No | Set to `false` to disable the hourly `webhook_events` 30-day prune. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
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
| `CAL_WEBHOOK_SECRET` | For Cal.com | HMAC-SHA256 signing secret for the Cal.com webhook. Required in prod; webhook returns 503 if unset. |
| `CAL_BOOKING_URL` | For Cal.com | Public Cal.com booking page URL. Surfaced in three client comms touches (drink-plan nudge email + SMS, six-months-out marketing). Optional; templates omit the consult line when unset. |
| `GOOGLE_PLACES_API_KEY` | For venue search | Google Places API (New) key for venue-name search. Server-only. When unset, venue search degrades to a plain text input. |
| `SENTRY_DSN_SERVER` | For error tracking | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | For error tracking | Client-side Sentry DSN (optional in dev; required in prod) |
| `ADMIN_EMAIL` | For seed | Admin account email. Used for the seed account and as the default Reply-To on client-facing emails. |
| `ADMIN_PASSWORD` | For seed | Admin account password |

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
│   │   │   ├── users.js        # /users CRUD + status + profile + permissions + seniority + /active-staff + /users/:id/stub-co-participated-proposals (cc-import unstub auditing)
│   │   │   ├── applications.js # /applications + /notes + interview scheduling + scorecard + reject/restore/move/reminder
│   │   │   ├── hiring.js       # /hiring/summary (KPIs) + /hiring/search (cross-state applicant search)
│   │   │   ├── managers.js     # /managers CRUD
│   │   │   ├── blog.js         # /blog admin endpoints
│   │   │   ├── settings.js     # /settings + /test-email + /backfill-geocodes + /badge-counts (incl. open_tester_bugs)
│   │   │   ├── labratBugs.js   # /tester-bugs (list + PATCH triage state for the LabRatBugsPage)
│   │   │   ├── search.js       # /search — global record search across clients/proposals/events/staff
│   │   │   └── ccImport/       # Check Cherry import admin endpoints
│   │   │       ├── index.js            # Composition router mounted at /api/admin/cc-import
│   │   │       ├── wrapUp.js           # Bucket B wrap-up worklist + preview + enqueue (Task 18)
│   │   │       ├── review.js           # Review-page GET (7 sections) + 8 action endpoints (Task 19)
│   │   │       ├── phase0.js           # Phase 0 give-up endpoints (extracted to keep review.js under cap)
│   │   │       ├── search.js           # Review-page proposal + user typeahead pickers + link-preview
│   │   │       └── proposalActions.js  # Mounted at /api/admin (not under /cc-import/) — re-enroll drink-plan nudge + re-accrue payout (Task 21)
│   │   ├── agreement.js        # Contractor agreement + digital signature
│   │   ├── application.js      # Contractor application form
│   │   ├── auth.js             # POST /register, POST /login, GET /me
│   │   ├── beo.js              # Banquet Event Order — staff-authenticated GET BEO + logo proxy + POST acknowledge
│   │   ├── blog.js             # Blog post endpoints
│   │   ├── calcom.js           # Cal.com webhook receiver (HMAC-SHA256 signed, public); handles booking created/cancelled/rescheduled/no-show events
│   │   ├── calendar.js         # Calendar/scheduling endpoints
│   │   ├── clientAuth.js       # Client authentication (separate from staff auth)
│   │   ├── clientPortal.js     # Client portal endpoints
│   │   ├── clients.js          # Client CRUD
│   │   ├── cocktails.js        # Cocktail menu CRUD
│   │   ├── contractor.js       # Contractor profile + file uploads
│   │   ├── drinkPlans.js       # Client event planning questionnaire
│   │   ├── drinkPlanConsult.js # Admin consult-form routes (alternate input source for shopping lists)
│   │   ├── messages.js         # SMS messaging to staff
│   │   ├── mocktails.js        # Mocktail menu CRUD
│   │   ├── payment.js          # Payment method + W-9 upload
│   │   ├── progress.js         # Onboarding step tracking
│   │   ├── proposals/          # Service proposals (publicToken/public/metadata/lifecycle/crud sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── publicToken.js  # /t/:token view + sign
│   │   │   ├── public.js       # /public/* — packages, addons, calculate, capture-lead, quote-draft, submit
│   │   │   ├── metadata.js     # /packages, /addons, /calculate, /financials, /dashboard-stats
│   │   │   ├── lifecycle.js    # Proposal status state machine (PATCH /:id/status)
│   │   │   └── crud.js         # admin CRUD + notes/create-shift/balance-due-date/send-reminder/record-payment
│   │   ├── shifts.js           # Shift scheduling
│   │   ├── sms.js              # Twilio inbound-SMS webhook + admin thread API
│   │   ├── stripe.js           # Payment intents, payment links, webhooks
│   │   ├── emailMarketing.js   # Email marketing leads, campaigns, sequences, conversations
│   │   ├── emailMarketingWebhook.js  # Resend webhook receiver (email tracking events)
│   │   ├── invoices.js         # Invoice CRUD, public token view, client portal
│   │   ├── me.js               # Authenticated self endpoints (tip page settings, my-tips listing)
│   │   ├── publicReviews.js    # Public cached endpoint for Thumbtack reviews on homepage
│   │   ├── publicTip.js        # Public tip-page lookup + post-tip feedback (token-gated)
│   │   ├── publicFeedback.js   # Post-event feedback router (5-star sentiment routing)
│   │   ├── testFeedback.js     # Receives Lab Rat bug reports — INSERTs into `tester_bugs` (durable) AND fire-and-forget emails `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` (notification)
│   │   ├── thumbtack.js        # Thumbtack webhook endpoints (leads, messages, reviews)
│   │   └── venues.js           # Google Places venue search proxy
│   ├── utils/
│   │   ├── adminAuditLog.js    # logAdminAction(...) — durable record of admin actions (rotate-token, regenerate-stripe). Best-effort; failures go to Sentry, never block the underlying op
│   │   ├── adminNotifications.js # notifyAdminCategory(...) — multi-admin notification fan-out by category (joins users.notification_preferences + contractor_profiles for SMS)
│   │   ├── agreementPdf.js     # PDFKit renderer for signed contractor agreements
│   │   ├── autoAssign.js       # Auto-assign algorithm (seniority + geo + equipment scoring)
│   │   ├── autoAssignScheduler.js # Scheduled auto-assign runner (hourly)
│   │   ├── balanceReminderScheduling.js # Balance-reminder ladder scheduling (extracted from stripe.js)
│   │   ├── balanceScheduler.js # Autopay balance charge scheduler
│   │   ├── balanceSmsHandlers.js # Non-autopay balance reminder SMS handlers (due-today, late t1/t3)
│   │   ├── beoFinalize.js      # BEO Finalize/Unfinalize route registrars + ensureNotFinalized guard (mounted into drinkPlans router)
│   │   ├── beoHandlers.js      # BEO dispatcher handler (`beo_unack_nudge_sms`) + scheduling/suppression/reanchor helpers
│   │   ├── bookingWindow.js    # Pure booking-window math (last-minute ≤14-day full-payment-required predicate)
│   │   ├── calcomWebhookHelpers.js # Pure Cal.com webhook helpers (HMAC signature verification, payload normalization) consumed by `server/routes/calcom.js`
│   │   ├── ccWrapUpEmailTemplate.js # cc-import: wrap-up email subject + html + text renderer
│   │   ├── ccWrapUpHandler.js  # cc-import: post_event_wrap_up_email dispatcher handler (registered at boot in server/index.js)
│   │   ├── payrollGuards.js    # cc-import: isLegacyCcParticipant (per-proposal stub check) + isLegacyCcStubUser (per-user stub check) — money-path skip gates
│   │   ├── channelFallback.js  # Channel-substitution decision for single-channel operational touches (picks the live channel when the registered one's status is 'bad')
│   │   ├── clientAutomationSuspension.js # Suspends a client's remaining automation when both email_status and phone_status are 'bad' (sets clients.automation_suspended_at, cancels pending scheduled_messages)
│   │   ├── consultRecap.js     # Formats saved consult selections into the post-consult email recap
│   │   ├── drinkPlanAccess.js  # Pure post-booking drink-plan access guard (fail-safe pre-booking allowlist)
│   │   ├── drinkPlanNudge.js   # Drink-plan / Potion Planner nudge: email + SMS touch and scheduling
│   │   ├── dripSmsHandlers.js  # Unsigned-proposal drip SMS handlers (touches 1, 3, 5-sms)
│   │   ├── email.js            # Resend email wrapper (send + batch)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js   # Email template helpers (transactional + marketing)
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
│   │   ├── invoiceHelpers.js   # Invoice auto-generation, line items, locking
│   │   ├── lastMinuteAlert.js  # Last-minute (<72h) booking SMS alert dispatch (admin + broad staff blast, idempotent)
│   │   ├── lastMinuteStaffingConfirmation.js  # Touch 2.2: bartender-list renderer + notify fn + atomic-flip trigger
│   │   ├── lifecycleEmailTemplates.js # Lifecycle email templates split out of emailTemplates.js
│   │   ├── messageScheduling.js # scheduleMessage(...): idempotent insert of a future touch into the scheduled_messages table
│   │   ├── messageSuppression.js # shouldSendImmediate(...): shared archive / comm-prefs / bad-contact gate for immediate-send paths
│   │   ├── refundHelpers.js    # Partial-refund planner (planRefund) + idempotent reconciliation (applyRefundReconciliation, incl. status⟷money + autopay-disarm)
│   │   ├── metricsQueries.js   # Pure metrics filter parsing + SQL builders (resolveFilters, dateClause, qMoney, qWinRate, etc.)
│   │   ├── orientationData.js  # Assembles the booking/receipt/planner payload for the orientation email
│   │   ├── phone.js            # Save-time phone validation (10 digits, strips country code 1)
│   │   ├── pricingEngine.js    # Pure pricing calculation engine
│   │   ├── proposalRules.js     # Server twin of client proposalRules.js + validateProposalRules (authoritative bundle/addon/guardrail gate)
│   │   ├── scheduledMessageDispatcher.js # 5-minute scheduler: drains pending scheduled_messages rows, applies suppression, invokes per-message-type handlers
│   │   ├── sendProposalSentEmail.js # Post-commit best-effort client email when a proposal enters the 'sent' state (never throws)
│   │   ├── setupTime.js        # Pure back-of-house setup-time math (parse/subtract, effectiveSetupMinutes); client twin
│   │   ├── shoppingList.js     # Shopping-list generator (mirrors client generateShoppingList.js); also includes consult-mode branch + buildGeneratorInputFromConsult translator
│   │   ├── shoppingListAddonCoverage.js # Maps active BYOB-support add-on slugs to the shopping-list items those add-ons cover (computeStripSet); generateShoppingList strips that set
│   │   ├── shoppingListGen.js  # Shared helpers: resolveCocktailIds, buildPlannerGeneratorInput, buildConsultGeneratorInput, autoGenerateShoppingList
│   │   ├── sms.js              # Twilio SMS wrapper
│   │   ├── smsDeliveryStatus.js # Twilio delivery-failure handler — flags bad phone numbers (sets clients.phone_status='bad') on hard SMS failures
│   │   ├── smsInbound.js       # Inbound-SMS processing: keyword/response-code detection, sender lookup, orchestrator
│   │   ├── smsTemplates.js     # Client-facing automated SMS body templates
│   │   ├── staffShiftHandlers.js # Staff-shift SMS: day-before reminder, post-event thank-you, schedule-change/cancel notices
│   │   ├── storage.js          # Cloudflare R2 upload + signed URL helpers
│   │   ├── stripeClient.js     # Central Stripe client factory (test-mode toggle, fail-closed)
│   │   ├── tipHandleValidation.js # Validates + normalizes venmo/cashapp handles + paypal.me URLs before persist
│   │   ├── tipPageLifecycle.js # Tip page activate/deactivate transitions on hire/onboarding/offboard
│   │   ├── tipPaymentLinks.js  # Creates/regenerates Stripe Payment Links for bartender tip pages
│   │   ├── urls.js             # Canonical PUBLIC_SITE_URL / ADMIN_URL / STAFF_URL / API_URL resolvers
│   │   ├── venueAddress.js     # Compose/validate structured venue address; derives event_location & shifts.location
│   │   └── webhookEventsPruneScheduler.js # Hourly prune of `webhook_events` to a 30-day window (gated by RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER)
│   └── scripts/
│       ├── backfillTipPages.js # One-shot backfill: ensure every active bartender has a tip page row + Stripe link
│       └── archive/               # One-time migrations (already run, kept for history)
│           ├── importBlogPosts.js
│           ├── migrateBlogBodies.js
│           └── migrate-to-gcs.js
├── client/
│   ├── src/
│   │   ├── App.js              # All routes, auth guards (ProtectedRoute, RequireHired, etc.)
│   │   ├── context/
│   │   │   ├── AuthContext.js       # Staff/admin auth state (login, logout, user)
│   │   │   ├── ClientAuthContext.js # Client auth state
│   │   │   ├── ToastContext.js      # ToastProvider + useToast() hook
│   │   │   └── UserPrefsContext.js  # Per-user admin OS prefs (skin/density/sidebar) — strips on logout
│   │   ├── utils/
│   │   │   ├── api.js          # Axios instance with JWT interceptor
│   │   │   ├── buildTipDeepLink.js # Builds Venmo/CashApp deep links + Stripe fallback URL for tip pages
│   │   │   ├── clientSources.js # Canonical client source list (mirrors schema CHECK + server VALID_SOURCES)
│   │   │   ├── constants.js    # App-wide constants
│   │   │   ├── eventTypes.js   # Event type id→label resolver (mirrors server)
│   │   │   ├── formatPhone.js  # Phone number formatting
│   │   │   ├── leadSources.js  # Lead source enum (mirrors schema CHECK + server validator)
│   │   │   ├── proposalRules.js # Shared client proposal business rules (bundle/addon/guardrail logic); CJS twin at server/utils/proposalRules.js
│   │   │   ├── setupTime.js    # Back-of-house setup-time formatting (twin of server/utils/setupTime.js)
│   │   │   ├── timeOptions.js  # Time option generator + 12h formatter + input parser
│   │   │   └── tipCardMarks.js # Derives printable QR-card payment marks from saved handles (Stripe link + handles → mark list)
│   │   ├── components/         # AdminLayout, StaffLayout, Layout, PublicLayout,
│   │   │                       # InvoiceDropdown, SignaturePad, FileUpload, DrinkPlanCard,
│   │   │                       # PricingBreakdown, RichTextEditor, LeadImportModal, MenuSamplesModal,
│   │   │                       # AudienceSelector, SequenceStepEditor, CampaignMetricsBar, SyrupPicker,
│   │   │                       # TimePicker, NumberStepper, Toast, FormBanner, FieldError, ScrollToTop, SessionExpiryHandler,
│   │   │                       # VenueAddressFields (structured venue address — sign+pay gate & admin edit),
│   │   │                       # VenueSearchInput (venue-name typeahead (Google Places)),
│   │   │                       # ClickableRow (table <tr> wrapper: plain click navigates, drag selects/copies text),
│   │   │                       # AddonControls (shared add-on UI controls: quantity stepper + greyed bundle badge, used by ProposalCreate + ProposalDetailEditForm),
│   │   │                       # admin/LegacyCcPaymentsPanel (admin-only panel on ProposalDetail that surfaces CC-imported Stripe charges and warns the operator that the DRB OS Refund button cannot reach them),
│   │   │                       # admin/CcImportBadge (small "Imported from CC" badge rendered next to titles on admin proposals/clients/events pages when cc_id is set)
│   │   │   ├── adminos/        # Admin OS shell + primitives (Sidebar, Header, CommandPalette, Drawer,
│   │   │   │                   # StatusChip, StaffPills, AreaChart, Sparkline, Toolbar, Icon, KebabMenu, AddressLink,
│   │   │   │                   # InterviewScheduleModal, PackageIncludesModal, MetricsFilterBar,
│   │   │   │                   # format, nav, shifts; drawers/{ClientDrawer,InvoicesDrawer,ShiftDrawer})
│   │   │   ├── ShoppingList/   # Shopping list generator (PDF export, ConsultationForm admin-input modal)
│   │   │   └── MenuPNG/        # Standard Menu PNG export (html2canvas-driven, lazy-loaded; renders hidden MenuPreview at print scale 768x960 and downloads as 2304x2880 PNG)
│   │   ├── data/               # Shared data (addonCategories, eventTypes, menuSamples, packages, syrups)
│   │   ├── hooks/              # Custom hooks (useDebounce, useDrawerParam, useFormValidation, useWizardHistory, useMetricsFilter)
│   │   ├── pages/
│   │   │   ├── (auth)          # Login, Register, ForgotPassword, ResetPassword
│   │   │   ├── (onboarding)    # Welcome, FieldGuide, Agreement, ContractorProfile, PaydayProtocols, Completion
│   │   │   ├── (staff)         # Application, ApplicationStatus, HiringLanding, PreHireOnboarding (open pre-hire URL)
│   │   │   ├── (admin)         # AdminDashboard (AdminUserDetail moved into admin/userDetail/, AdminApplicationDetail moved into admin/applicationDetail/)
│   │   │   ├── admin/          # Dashboard sub-pages (proposals, clients, events, EventDetailPage, shifts, staff, menus, hiring, blog, email marketing, Messages admin SMS conversation/thread page, TipsAdmin tip overview, LabRatBugsPage tester-bug triage, userDetail/tabs/TipPageTab admin tip-page controls, applicationDetail/, NotificationSettings per-user notification-subscription toggles, CcImportWrapUpPage Bucket B wrap-up email worklist, CcImportReviewPage 7-section import-reconciliation triage)
│   │   │   ├── staff/          # Staff portal (StaffDashboard, StaffShifts, StaffSchedule, StaffEvents, StaffResources, StaffProfile, MyTipPage tip-page settings, PrintTipCard printable QR card with PrintTipCard.layouts.jsx + PrintTipCard.css)
│   │   │   ├── plan/           # PotionPlanningLab, public post-booking event questionnaire (single flow, created only after deposit; with steps/, components/, data/; components/ScopeBanner + components/WelcomeRoadmap + components/MenuPreview + components/LogoUploadField = apothecary-reskin + Standard Menu shared UI; steps/HostedGuestPrefsStep.js = compact hosted-package guest-preferences step; data/packageGaps.js = hosted-package gap helpers, packageGaps.test.js = Jest test; data/menuSections.js = Standard Menu section extractor with menuSections.test.js Jest unit suite)
│   │   │   ├── invoice/        # InvoicePage — public token-gated invoice view + payment
│   │   │   ├── proposal/       # ProposalView (public client-facing) — split into proposalView/ folder (parent + ProposalHeader + ProposalPricingBreakdown + SignAndPaySection + PaymentForm + helpers + styles)
│   │   │   ├── public/         # Client portal (ClientLogin, ClientDashboard, ClientShoppingList, Blog, BlogPost) + tip flow (TipPage with TipPage.atoms.jsx + TipPage.css, TipPageThanks post-tip feedback)
│   │   │   └── website/        # Public website (HomePage, ServicesPage, MethodPage, AboutPage, FaqPage, QuotePage, ClassWizard, quoteWizard/ — split QuoteWizard with steps/extras/ (AddonTile + BundlePicker + AddonAccordion) for the Extras step redesign)
│   │   ├── images/             # Brand assets
│   │   └── index.css           # Global styles
│   ├── vercel.json             # SPA rewrite rule for Vercel
│   └── package.json            # React deps, proxy: localhost:5000
├── scripts/                    # Build + workflow scripts (build-testing-guide.js, check-file-size.js, optimize-assets.js, worktree-new.js, worktree-rm.js)
│   ├── cc-import.js             # Check Cherry importer CLI entrypoint — dispatches to per-phase modules via --phase=N
│   └── cc-import/               # 7-phase Check Cherry import pipeline (Phase 0 attachments → Phase 6 leads/invoices archive)
│       ├── lib/                 # Shared utilities: csv, money, dateFmt, duration, timeFormat, fuzzyName, buckets, db, runLog, httpFetch, r2, email, cli
│       └── phases/              # phase0.js through phase6.js — one file per import phase, each with a co-located *.test.js
├── .claude/agents/             # Claude Code review agents (7 agents)
├── .husky/pre-commit           # Pre-commit hook (docs-drift check + file-size ratchet + lint-staged)
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
| `npm run audit:check` | Check for known dependency vulnerabilities |
| `npm run check:filesize` | Report every source file by line-count zone (RED over 1000, YELLOW 700-1000) |
| `npm run build:testing-guide` | Build `client/public/testing-guide.html` from `TESTING.md` via `scripts/build-testing-guide.js` |
| `npm run optimize:assets` | One-shot asset optimization (PNG→WebP at tile size, TTF→WOFF2). Idempotent — skips already-converted outputs. |
| `npm run worktree:new -- <name>` | Create a parallel-dev worktree at `../worktrees/<name>` on a new branch off `main`, with `node_modules` + husky junctions wired up |
| `npm run worktree:rm -- <name>` | Tear down a worktree: remove its junctions, the worktree, then the branch (`--force` to discard an unmerged branch) |
| `npm run cc-import` | One-shot Check Cherry import run using the default config (runs all 7 phases sequentially) |
| `npm run cc-import:all` | Explicit "run all phases" alias of `cc-import` |
| `npm run cc-import:phase0` ... `:phase6` | Single-phase run (`--phase=N`): Phase 0 attachments, Phase 1 leads-as-clients, Phase 2 clients, Phase 3 proposals/events, Phase 4 payments/refunds, Phase 5 payouts, Phase 6 leads + invoices archive |

## Key Features

### Contractor Application & Onboarding
- Multi-step application form with file uploads (resume, headshot, BASSET cert)
- Admin review workflow with interview notes and status transitions
- 6-step onboarding flow for hired contractors: Welcome → Field Guide → Agreement (digital signature) → Profile → Payment Setup (W-9) → Complete
- Progress tracking across steps

### Service Proposal System
- 12 service packages across BYOB and Hosted categories
- 18 add-on services with per-guest, per-hour, flat, and timed billing
- Dynamic pricing engine that calculates staffing, bar rental, and add-on costs
- Client-facing proposal view via UUID token URL
- Combined contract signing + payment on a single screen
- Payment options: pay $100 deposit or pay in full
- Autopay enrollment: clients can opt to have their remaining balance auto-charged on the due date (default: 14 days before event)
- Admin-overridable balance due dates
- Hourly autopay scheduler charges saved payment methods when balance is due

### Event Planning (Potion Planning Lab)
- Public questionnaire sent to clients via unique token link
- Clients select cocktails, mocktails, and serving preferences
- Admin review dashboard
- **Shopping List Generator**: On any drink plan with a generated list, admin clicks "Shopping List" to open an editable modal pre-populated with scaled quantities (100-guest pars × actual guest count). Add/remove items, change quantities, then download a branded PDF. Signature cocktail ingredients are automatically merged into the list. Cocktail ingredients are managed in the Drink Menu admin.
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

### Check Cherry import (one-time, operator-triggered)
Imports legacy proposals, events, payments, refunds, payouts, leads, and invoices from Check Cherry CSV exports into DRB OS. The 7-phase pipeline (Phase 0 attachments staged to R2, Phase 1 leads-as-clients, Phase 2 clients with email-case dedup, Phase 3 proposals + shifts, Phase 4 payments + refunds via the full `refundHelpers` Approach A mirror, Phase 5 historical payouts, Phase 6 leads + invoices archive) runs via `npm run cc-import` and writes verbatim to `legacy_cc_raw_imports` before promoting to production tables. Suspected duplicates, orphan payments, unmatched payees, and Phase 0 fetch failures surface on `/admin/cc-import/review` for operator triage with 8 in-page action endpoints. Bucket B (past-event) wrap-up emails enqueue from `/admin/cc-import/wrap-up`. Imported proposals/clients/users carry a `cc_id` that drives a small "Imported from CC" badge across admin lists and details.

### Admin Dashboard
- **Global Search**: A `Cmd/Ctrl+K` command palette on every admin page searches clients, proposals, events, and staff by partial name, phone number, or email, and jumps straight to the matching record.
- **Staffing**: Application review, hire/reject, interview notes, user management, SMS messaging (compose, recipient picker, shift invitation templates, grouped message history)
- **Proposals**: Create, price, send, track views/signatures — paid proposals automatically move to Events
- **Partial Refunds**: Admin partial refunds via Stripe — Approach-A `total_price` correction + audit ledger (`proposal_refunds`), idempotent `charge.refunded` webhook-backstopped
- **Clients**: CRM with source tracking (direct, Thumbtack, referral, website)
- **Drink Plans**: Auto-created when proposals become events; accessed from event detail page; client receives email with questionnaire link
- **Drink Menu**: Manage 25 cocktails + 16 mocktails across categories
- **Events**: Paid proposals become events; list view shows scannable cards, detail view is a full dashboard with staffing management, equipment config, auto-assign, payment, and drink plan
- **Financials / Settings**: Placeholder tabs ready for expansion

### Tip QR Pages
- Each onboarded bartender gets a public token-gated tip page (`/tip/:token`) with their photo, name, and tip buttons
- Tip buttons deep-link to Venmo and Cash App when the bartender has those handles set, plus a Stripe Payment Link fallback that flows to the bartender's Stripe Express account
- Stripe Payment Links are auto-provisioned (and regenerated on demand) via `server/utils/tipPaymentLinks.js`; tip flow is recorded in the `tips` table on `checkout.session.completed` (branched by `metadata.kind = 'tip'`)
- After tipping, guests land on a thank-you page that nudges a Google review and offers an optional bartender feedback form (`tip_page_feedback` table; admin reviews in TipsAdmin)
- Bartenders manage their tip page from the staff portal (`MyTipPage`) and can print a QR card (`PrintTipCard`) for events
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

### Cal.com Consult Booking Integration
- **Cal.com consult booking integration**: webhook receiver auto-creates clients on first booking, flips consult status on form-submit, surfaces public booking URL in client comms.

### BEO (Banquet Event Order)
- Admin Finalizes a reviewed drink plan via the DrinkPlanCard, locking every mutation route on the plan (status, notes, shopping list, logo, consult, source flip, delete) until Unfinalize.
- On Finalize, BEO nudge rows are scheduled to fire 3 days before the event for every approved staffer on every non-cancelled shift; a late assignment after Finalize back-fills its own nudge via `scheduleStaffShiftMessages`.
- Each staffer opens the BEO from the staff portal, sees event details + drink menu + add-ons + logistics + custom-menu logo + special notes, and confirms read-receipt with one tap (`POST /api/beo/:proposalId/acknowledge` stamps `shift_requests.beo_acknowledged_at`).
- Per-staffer "Confirmed [time]" pills surface on the admin EventDetailPage so the operator knows at a glance who has read the BEO.
- Reschedule, cancellation, denial, and re-assignment all cascade into the nudge queue: pending rows are reanchored, suppressed, or recreated as needed, with a NOT EXISTS guard so a staffer covered on multiple shifts keeps their nudge.

### Shifts & Profile
- View available shifts and request assignments
- Profile and notification management

## Deployment

### Backend — Render
The `render.yaml` blueprint defines the web service and PostgreSQL database. Push to `main` auto-deploys.

### Frontend — Vercel
The React app is deployed separately on Vercel. `client/vercel.json` handles SPA routing. The build-time `REACT_APP_API_URL` points to the Render backend.

### Database
Schema is auto-initialized on server start via `server/db/index.js`, which runs `schema.sql`. All DDL is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Operational Runbook

### Weekly dispute-email-bailout sweep

The dispute-won email notification (fires on Stripe `charge.dispute.funds_reinstated`) auto-abandons after 3 failed send attempts. The DB column `tips.dispute_email_failed_at` is the canonical "needs manual reconciliation" marker; the accompanying Sentry alert is best-effort.

**Weekly:** run the sweep query documented in `ARCHITECTURE.md` ("Weekly dispute-email-bailout sweep") to catch any abandonment whose Sentry alert was lost. The spec at `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md` carries the recovery runbook.
