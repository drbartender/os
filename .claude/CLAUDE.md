# Dr. Bartender — Claude Code Instructions

## Tech Stack

- **Backend**: Node.js 18+ / Express 4.18
- **Frontend**: React 18 (Create React App) / React Router 6
- **Database**: Neon PostgreSQL (via `pg` driver, raw SQL — no ORM)
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **File Storage**: Cloudflare R2 (AWS SDK v3)
- **Payments**: Stripe (server SDK + React Elements)
- **Email**: Resend
- **SMS**: Twilio
- **Styling**: Vanilla CSS (no Tailwind, no preprocessors)
- **Dev tools**: nodemon, concurrently

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js              # Express entry point, middleware, route mounting
│   ├── db/
│   │   ├── index.js          # PostgreSQL pool + schema init
│   │   ├── schema.sql        # Full DDL (tables, triggers, seed data)
│   │   └── seed.js           # Admin account seeder
│   ├── middleware/
│   │   └── auth.js           # JWT verification, role guards
│   ├── routes/
│   │   ├── admin.js           # Admin management endpoints
│   │   ├── agreement.js       # Staff agreement/contract signing
│   │   ├── application.js     # Staff application submission
│   │   ├── auth.js            # Login, register, JWT refresh
│   │   ├── clients.js         # Client CRM endpoints
│   │   ├── cocktails.js       # Cocktail menu management
│   │   ├── contractor.js      # Contractor profile endpoints
│   │   ├── drinkPlans.js      # Public drink plan (Potion Planning Lab)
│   │   ├── mocktails.js       # Mocktail menu management
│   │   ├── payment.js         # Payment tracking
│   │   ├── progress.js        # Onboarding progress tracking
│   │   ├── proposals.js       # Proposal CRUD + public token view
│   │   ├── shifts.js          # Shift management
│   │   └── stripe.js          # Stripe checkout + webhooks
│   └── utils/
│       ├── balanceScheduler.js # Scheduled balance/payment tasks
│       ├── email.js           # Resend wrapper
│       ├── eventCreation.js   # Event creation helpers
│       ├── fileValidation.js  # Magic-byte validation
│       ├── pricingEngine.js   # Pure pricing calculation functions
│       ├── sms.js             # Twilio wrapper
│       └── storage.js         # R2 upload/signed-URL helpers
├── client/
│   ├── src/
│   │   ├── App.js            # All routes + auth guards
│   │   ├── context/AuthContext.js
│   │   ├── utils/api.js      # Axios instance with JWT interceptor
│   │   ├── components/
│   │   │   ├── AdminLayout.js     # Admin sidebar + header layout
│   │   │   ├── BrandLogo.js       # Dr. Bartender logo component
│   │   │   ├── ErrorBoundary.js   # React error boundary
│   │   │   ├── FileUpload.js      # Drag-and-drop file upload
│   │   │   ├── Layout.js          # Staff-facing layout wrapper
│   │   │   ├── LocationInput.js   # Nominatim address autocomplete
│   │   │   ├── PricingBreakdown.js # Proposal pricing display
│   │   │   ├── SignaturePad.js    # E-signature canvas
│   │   │   └── W9Form.js         # W-9 tax form component
│   │   ├── pages/
│   │   │   ├── admin/
│   │   │   │   ├── ClientDetail.js
│   │   │   │   ├── ClientsDashboard.js
│   │   │   │   ├── CocktailMenuDashboard.js
│   │   │   │   ├── DrinkPlanDetail.js
│   │   │   │   ├── DrinkPlansDashboard.js
│   │   │   │   ├── EventsDashboard.js
│   │   │   │   ├── FinancialsDashboard.js
│   │   │   │   ├── ProposalCreate.js
│   │   │   │   ├── ProposalDetail.js
│   │   │   │   ├── ProposalsDashboard.js
│   │   │   │   └── SettingsDashboard.js
│   │   │   ├── plan/         # PotionPlanningLab (public questionnaire)
│   │   │   └── proposal/     # ProposalView (public client-facing)
│   │   └── index.css         # Global styles
│   ├── package.json          # proxy: localhost:5000
│   └── vercel.json           # SPA rewrite for Vercel deployment
├── .env / .env.example
├── package.json              # Root (server deps + scripts)
└── render.yaml               # Render blueprint
```

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Token signing key |
| `CLIENT_URL` | Frontend origin (CORS) |
| `R2_*` | Cloudflare R2 credentials |
| `RESEND_API_KEY` | Resend email |
| `TWILIO_*` | Twilio SMS |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe payments |
| `STRIPE_DEPOSIT_AMOUNT` | Deposit in cents (default 10000 = $100) |
| `REACT_APP_API_URL` | Client-side API base URL (set in client/.env.production) |

## Running Locally

```bash
npm run install:all   # Install server + client deps
cp .env.example .env  # Fill in DATABASE_URL (Neon connection string) + other values
npm run seed          # Seed admin account
npm run dev           # Express on :5000, React on :3000
```

## Deployment

- **Backend**: Render (auto-deploys from `main` via render.yaml)
- **Frontend**: Vercel (SPA rewrite in client/vercel.json)
- **Database**: Neon PostgreSQL (connection string in Render env vars)
- Push to `main` triggers automatic deployment. No manual deploy step needed.

## Coding Patterns & Conventions

- **No ORM** — use raw SQL via `pool.query()` with parameterized queries (`$1`, `$2`, etc.). Never concatenate user input into SQL.
- **Route files** export an Express Router. One file per resource under `server/routes/`.
- **Auth middleware** — import `{ auth }` for protected routes; check `req.user.role` for admin/manager guards.
- **File uploads** use `express-fileupload` → validated with magic bytes → uploaded to R2 → URL stored in DB.
- **Public token-gated routes** (drink plans, proposals) use UUID tokens in the URL instead of auth.
- **Frontend API calls** go through `client/src/utils/api.js` (axios with auto-attached JWT).
- **Schema changes** go in `schema.sql` using idempotent statements (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- **Pricing logic** lives in `server/utils/pricingEngine.js` — pure functions, no DB calls.
- **CSS** — vanilla CSS in `index.css`. No CSS modules, no utility frameworks.
- **Naming**: camelCase for JS variables/functions, snake_case for DB columns and API JSON keys.

## Cross-Cutting Consistency

When modifying any entity, always check and update **all** related entities too. Never leave one part of the system out of sync with another. Examples:

- **Proposal price changes** → re-evaluate payment status. If the new total exceeds `amount_paid`, remove or correct any "Paid in Full" flag. Never leave a proposal marked paid when it isn't.
- **Proposal event detail changes** (date, time, location, guest count) → check and update linked shifts accordingly.
- **Phone number / formatting changes** → update every component, route, and display that touches that field.
- **Schema column changes** → update every route (SELECT, INSERT, UPDATE), every component that reads/writes that field, and every place that displays it.
- **New feature data shape** → ensure every consumer of that data (backend endpoints, frontend components, PDF templates) is updated in the same PR.

The rule: **if you change X, search the codebase for everything that depends on X and update it too.**

## Mandatory Documentation Updates

After any significant change (new feature, new route, schema change, new integration), update:
1. **README.md** — reflect new features, env vars, or setup steps
2. **ARCHITECTURE.md** — reflect new routes, schema tables, integrations, or deployment changes

---

## Code Verification System

This project is vibe-coded — the author relies on Claude to catch issues. Verification is split into three tiers to balance thoroughness with cost.

### Tier 1: Inline Self-Check (Every Change — Free)

Before presenting ANY code change, silently verify:

**Security**
- All SQL uses parameterized queries (`$1`, `$2`) — never string concatenation
- All non-public routes have `auth` middleware; admin routes check `req.user.role`
- Endpoints filter by `req.user.id` to prevent accessing other users' data (IDOR)
- No secrets hardcoded — everything from `process.env`
- User input validated on server side (type, length, format)
- File uploads validated with magic bytes via `fileValidation.js`
- Error responses never leak stack traces, SQL, or internals

**Data Integrity**
- Multi-table writes wrapped in `BEGIN/COMMIT/ROLLBACK`
- Schema changes are idempotent (`IF NOT EXISTS`)
- Money stored as integer cents, never floats
- Changed columns updated in ALL routes that touch that table

**Frontend**
- Async ops have loading, error, and empty states
- API calls go through `utils/api.js` — never raw fetch/axios
- New routes added to `App.js` with correct auth guards
- Client-side validation matches server-side rules

**Logic**
- Null/undefined handled for DB results, API responses, optional fields
- Date ranges and pagination boundaries correct
- No race conditions on payment/mutation endpoints

### Tier 2: Automatic Lightweight Agents (After Completing a Feature)

After finishing a feature or significant change (new route, new page, schema change), automatically launch these **in parallel** using the haiku model to keep costs low:

**Security Scan Agent** — Grep the changed files for:
- String concatenation in SQL queries
- Missing `auth` middleware on route files
- `dangerouslySetInnerHTML` usage
- Hardcoded strings that look like keys/tokens
- Missing ownership checks (`req.user.id`) on data access
Report only confirmed issues, not style nits.

**Consistency Agent** — For each changed file, verify:
- If a DB column was added/changed: grep all routes that SELECT/INSERT/UPDATE that table — are they all updated?
- If a route was added: is it mounted in `index.js`? Does `App.js` have a corresponding frontend route?
- If pricing logic changed: do all consumers (`ProposalCreate`, `ProposalDetail`, `PricingBreakdown`) reflect it?
- If an API response shape changed: do all frontend consumers handle the new shape?
Report only actual mismatches found.

**Error Handling Agent** — Scan changed code for:
- `async` functions missing try/catch
- `.query()` calls without error handling
- API calls in React without `.catch()` or error state
- Unhandled promise rejections
Report only missing error handling, not style.

### Tier 3: Deep Review Agents (On-Demand Only — Expensive)

Only run when the user explicitly asks (e.g., "review security", "full review", "review before deploy"):

**Full Security Audit** — Scan the ENTIRE codebase for OWASP Top 10 vulnerabilities, auth bypass paths, missing rate limiting, insecure token handling, CORS misconfig.

**Full Code Quality Review** — Dead code, duplicated logic, functions over 50 lines, unused imports, console.logs left in production, naming inconsistencies.

**UI/UX Review** — Use the ui-ux-reviewer agent to screenshot key pages, check mobile responsiveness, accessibility, visual consistency.

**Database Review** — Analyze schema for missing indexes, N+1 query patterns, unprotected cascading deletes, missing foreign keys.

**Full Pre-Deploy Review** — Run ALL of the above. Reserve for deploy prep only.
