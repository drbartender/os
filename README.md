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
| Rich Text Editor | TipTap (ProseMirror-based WYSIWYG, blog admin) |
| HTML Sanitization | DOMPurify + jsdom (server-side) |
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
| `CLIENT_URL` | Yes | Frontend URL for CORS (e.g., `http://localhost:3000`) |
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
| `THUMBTACK_WEBHOOK_SECRET` | For Thumbtack | Shared secret for Thumbtack webhook auth |
| `SENTRY_DSN_SERVER` | For error tracking | Server-side Sentry DSN (optional in dev; required in prod) |
| `REACT_APP_SENTRY_DSN_CLIENT` | For error tracking | Client-side Sentry DSN (optional in dev; required in prod) |
| `ADMIN_EMAIL` | For seed | Admin account email |
| `ADMIN_PASSWORD` | For seed | Admin account password |

The frontend uses one build-time variable set in `client/.env.production`:
- `REACT_APP_API_URL` — absolute URL to the backend (e.g., `https://os-g7oa.onrender.com`)

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js                # Express app setup, middleware, route mounting
│   ├── db/
│   │   ├── index.js            # PostgreSQL pool connection + schema initialization
│   │   ├── schema.sql          # Full DDL: tables, triggers, constraints, seed data
│   │   ├── seed.js             # Admin account seeder script
│   │   └── seedTestData.js     # Test data seeder (staff, clients, proposals)
│   ├── middleware/
│   │   ├── asyncHandler.js     # 3-line wrapper that funnels async-handler rejections to the global error middleware
│   │   └── auth.js             # JWT verification + role guards (auth, adminOnly)
│   ├── routes/
│   │   ├── admin.js            # Admin user management, status changes
│   │   ├── agreement.js        # Contractor agreement + digital signature
│   │   ├── application.js      # Contractor application form
│   │   ├── auth.js             # POST /register, POST /login, GET /me
│   │   ├── blog.js             # Blog post endpoints
│   │   ├── calendar.js         # Calendar/scheduling endpoints
│   │   ├── clientAuth.js       # Client authentication (separate from staff auth)
│   │   ├── clientPortal.js     # Client portal endpoints
│   │   ├── clients.js          # Client CRUD
│   │   ├── cocktails.js        # Cocktail menu CRUD
│   │   ├── contractor.js       # Contractor profile + file uploads
│   │   ├── drinkPlans.js       # Client event planning questionnaire
│   │   ├── messages.js         # SMS messaging to staff
│   │   ├── mocktails.js        # Mocktail menu CRUD
│   │   ├── payment.js          # Payment method + W-9 upload
│   │   ├── progress.js         # Onboarding step tracking
│   │   ├── proposals.js        # Service proposals + pricing calculator
│   │   ├── shifts.js           # Shift scheduling
│   │   ├── stripe.js           # Payment intents, payment links, webhooks
│   │   ├── emailMarketing.js   # Email marketing leads, campaigns, sequences, conversations
│   │   ├── emailMarketingWebhook.js  # Resend webhook receiver (email tracking events)
│   │   ├── invoices.js         # Invoice CRUD, public token view, client portal
│   │   ├── publicReviews.js    # Public cached endpoint for Thumbtack reviews on homepage
│   │   └── thumbtack.js        # Thumbtack webhook endpoints (leads, messages, reviews)
│   ├── utils/
│   │   ├── autoAssign.js       # Auto-assign algorithm (seniority + geo + equipment scoring)
│   │   ├── autoAssignScheduler.js # Scheduled auto-assign runner (hourly)
│   │   ├── balanceScheduler.js # Autopay balance charge scheduler
│   │   ├── email.js            # Resend email wrapper (send + batch)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js   # Email template helpers (transactional + marketing)
│   │   ├── errors.js           # AppError class hierarchy (ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError)
│   │   ├── eventCreation.js    # Auto-create shifts from paid proposals
│   │   ├── eventTypes.js       # Event type id→label resolver (mirrors client)
│   │   ├── fileValidation.js   # Magic-byte file type validation
│   │   ├── geocode.js          # Nominatim geocoding (address → lat/lng)
│   │   ├── invoiceHelpers.js   # Invoice auto-generation, line items, locking
│   │   ├── pricingEngine.js    # Pure pricing calculation engine
│   │   ├── sms.js              # Twilio SMS wrapper
│   │   └── storage.js          # Cloudflare R2 upload + signed URL helpers
│   └── scripts/
│       ├── importBlogPosts.js     # Blog post import script (legacy)
│       ├── migrateBlogBodies.js  # One-time: convert blog blocks → HTML
│       └── migrate-to-gcs.js   # Storage migration script
├── client/
│   ├── src/
│   │   ├── App.js              # All routes, auth guards (ProtectedRoute, RequireHired, etc.)
│   │   ├── context/
│   │   │   ├── AuthContext.js       # Staff/admin auth state (login, logout, user)
│   │   │   ├── ClientAuthContext.js # Client auth state
│   │   │   └── ToastContext.js      # ToastProvider + useToast() hook
│   │   ├── utils/
│   │   │   ├── api.js          # Axios instance with JWT interceptor
│   │   │   ├── constants.js    # App-wide constants
│   │   │   ├── eventTypes.js   # Event type id→label resolver (mirrors server)
│   │   │   └── formatPhone.js  # Phone number formatting
│   │   ├── components/         # Layout, InvoiceDropdown, SignaturePad, ClickableRow, FileUpload,
│   │   │                       # PricingBreakdown, RichTextEditor, LeadImportModal, AudienceSelector,
│   │   │                       # SequenceStepEditor, CampaignMetricsBar, SyrupPicker, Toast,
│   │   │                       # FormBanner, FieldError, SessionExpiryHandler
│   │   │   └── ShoppingList/   # Shopping list generator (PDF export)
│   │   ├── data/               # Shared data (addonCategories, eventTypes, packages, syrups)
│   │   ├── hooks/              # Custom hooks (useFormValidation)
│   │   ├── pages/
│   │   │   ├── (auth)          # Login, Register, ForgotPassword, ResetPassword
│   │   │   ├── (onboarding)    # Welcome, FieldGuide, Agreement, ContractorProfile, PaydayProtocols, Completion
│   │   │   ├── (staff)         # Application, ApplicationStatus, StaffPortal
│   │   │   ├── (admin)         # AdminDashboard, AdminApplicationDetail, AdminUserDetail
│   │   │   ├── admin/          # Dashboard sub-pages (proposals, clients, events, menus, hiring, blog, email marketing)
│   │   │   ├── plan/           # PotionPlanningLab — public event questionnaire (with steps/ and data/)
│   │   │   ├── invoice/        # InvoicePage — public token-gated invoice view + payment
│   │   │   ├── proposal/       # ProposalView — public client-facing proposal
│   │   │   ├── public/         # Client portal (ClientLogin, ClientDashboard, Blog, BlogPost)
│   │   │   └── website/        # Public website (Website, HomePage, QuoteWizard, QuotePage, FaqPage, ClassWizard)
│   │   ├── images/             # Brand assets
│   │   └── index.css           # Global styles
│   ├── vercel.json             # SPA rewrite rule for Vercel
│   └── package.json            # React deps, proxy: localhost:5000
├── scripts/                    # Build scripts (build-testing-guide.js, testing-guide-template.html)
├── .claude/agents/             # Claude Code review agents (7 agents)
├── .husky/pre-commit           # Pre-commit hook (lint-staged)
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
| `npm run lint` | Run ESLint on all server code |
| `npm run lint:fix` | Run ESLint with auto-fix on server code |
| `npm run audit:check` | Check for known dependency vulnerabilities |
| `npm run build:testing-guide` | Build `client/public/testing-guide.html` from `TESTING.md` via `scripts/build-testing-guide.js` |

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
- **Shopping List Generator**: On any submitted/reviewed drink plan, admin clicks "Shopping List" to open an editable modal pre-populated with scaled quantities (100-guest pars × actual guest count). Add/remove items, change quantities, then download a branded PDF. Signature cocktail ingredients are automatically merged into the list. Cocktail ingredients are managed in the Drink Menu admin.

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
- **Staffing**: Application review, hire/reject, interview notes, user management, SMS messaging (compose, recipient picker, shift invitation templates, grouped message history)
- **Proposals**: Create, price, send, track views/signatures — paid proposals automatically move to Events
- **Clients**: CRM with source tracking (direct, Thumbtack, referral, website)
- **Drink Plans**: Auto-created when proposals become events; accessed from event detail page; client receives email with questionnaire link
- **Drink Menu**: Manage 25 cocktails + 16 mocktails across categories
- **Events**: Paid proposals become events; list view shows scannable cards, detail view is a full dashboard with staffing management, equipment config, auto-assign, payment, and drink plan
- **Financials / Settings**: Placeholder tabs ready for expansion

### SMS Messaging
- Send SMS to one or more staff members from the admin dashboard
- Shift-based invitation templates for quick event staffing outreach
- Grouped message history with per-recipient delivery tracking
- Per-user message history on individual staff profiles
- Filters by SMS consent — only staff who opted in are eligible

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
