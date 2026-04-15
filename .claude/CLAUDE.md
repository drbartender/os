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
- **Rich Text Editor**: TipTap (ProseMirror-based WYSIWYG) for blog admin
- **HTML Sanitization**: DOMPurify + jsdom (server-side, for blog post bodies)
- **Styling**: Vanilla CSS (no Tailwind, no preprocessors)
- **Dev tools**: nodemon, concurrently, ESLint + eslint-plugin-security, husky + lint-staged

## Folder Structure

```
dr-bartender/
├── server/
│   ├── index.js              # Express entry point, middleware, route mounting
│   ├── db/
│   │   ├── index.js          # PostgreSQL pool + schema init
│   │   ├── schema.sql        # Full DDL (tables, triggers, seed data)
│   │   ├── seed.js           # Admin account seeder
│   │   └── seedTestData.js   # Test data seeder (staff, clients, proposals)
│   ├── middleware/
│   │   └── auth.js           # JWT verification, role guards
│   ├── routes/
│   │   ├── admin.js           # Admin management endpoints
│   │   ├── agreement.js       # Staff agreement/contract signing
│   │   ├── application.js     # Staff application submission
│   │   ├── auth.js            # Login, register, JWT refresh
│   │   ├── blog.js            # Blog post endpoints
│   │   ├── calendar.js        # Calendar/scheduling endpoints
│   │   ├── clientAuth.js      # Client authentication (separate from staff auth)
│   │   ├── clientPortal.js    # Client portal endpoints
│   │   ├── clients.js         # Client CRM endpoints
│   │   ├── cocktails.js       # Cocktail menu management
│   │   ├── contractor.js      # Contractor profile endpoints
│   │   ├── drinkPlans.js      # Public drink plan (Potion Planning Lab)
│   │   ├── messages.js        # SMS messaging to staff
│   │   ├── mocktails.js       # Mocktail menu management
│   │   ├── payment.js         # Payment tracking
│   │   ├── progress.js        # Onboarding progress tracking
│   │   ├── proposals.js       # Proposal CRUD + public token view
│   │   ├── shifts.js          # Shift management
│   │   ├── stripe.js          # Stripe checkout + webhooks
│   │   ├── emailMarketing.js  # Email marketing (leads, campaigns, sequences, conversations)
│   │   ├── emailMarketingWebhook.js # Resend webhook receiver (tracking events)
│   │   └── thumbtack.js       # Thumbtack webhook endpoints (leads, messages, reviews)
│   ├── utils/
│   │   ├── autoAssign.js      # Auto-assign algorithm (seniority + geo + equipment)
│   │   ├── autoAssignScheduler.js # Scheduled auto-assign runner (hourly)
│   │   ├── balanceScheduler.js # Scheduled balance/payment tasks
│   │   ├── email.js           # Resend wrapper (send + batch)
│   │   ├── emailSequenceScheduler.js # Drip sequence step processor (every 15 min)
│   │   ├── emailTemplates.js  # Email template helpers (transactional + marketing)
│   │   ├── eventCreation.js   # Event creation helpers
│   │   ├── fileValidation.js  # Magic-byte validation
│   │   ├── geocode.js         # Nominatim geocoding (address → lat/lng)
│   │   ├── pricingEngine.js   # Pure pricing calculation functions
│   │   ├── sms.js             # Twilio wrapper
│   │   └── storage.js         # R2 upload/signed-URL helpers
│   └── scripts/
│       ├── importBlogPosts.js     # Blog post import script (legacy)
│       ├── migrateBlogBodies.js  # One-time: convert blog blocks → HTML
│       └── migrate-to-gcs.js    # Storage migration script
├── client/
│   ├── src/
│   │   ├── App.js            # All routes + auth guards
│   │   ├── context/
│   │   │   ├── AuthContext.js      # Staff/admin auth state
│   │   │   └── ClientAuthContext.js # Client auth state
│   │   ├── utils/
│   │   │   ├── api.js             # Axios instance with JWT interceptor
│   │   │   ├── constants.js       # App-wide constants
│   │   │   └── formatPhone.js     # Phone number formatting
│   │   ├── components/
│   │   │   ├── AdminLayout.js     # Admin sidebar + header layout
│   │   │   ├── BrandLogo.js       # Dr. Bartender logo component
│   │   │   ├── ConfirmModal.js    # Confirmation dialog component
│   │   │   ├── DrinkPlanSelections.js # Drink plan selection display
│   │   │   ├── ErrorBoundary.js   # React error boundary
│   │   │   ├── FileUpload.js      # Drag-and-drop file upload
│   │   │   ├── Layout.js          # Staff-facing layout wrapper
│   │   │   ├── LocationInput.js   # Nominatim address autocomplete
│   │   │   ├── PricingBreakdown.js # Proposal pricing display
│   │   │   ├── PublicLayout.js    # Public-facing layout wrapper
│   │   │   ├── RichTextEditor.js  # TipTap WYSIWYG editor (blog + email marketing)
│   │   │   ├── SignaturePad.js    # E-signature canvas
│   │   │   ├── W9Form.js         # W-9 tax form component
│   │   │   ├── LeadImportModal.js # CSV lead import modal
│   │   │   ├── AudienceSelector.js # Campaign audience filter/selector
│   │   │   ├── SequenceStepEditor.js # Drip sequence step editor
│   │   │   ├── CampaignMetricsBar.js # Campaign performance metrics bar
│   │   │   ├── SyrupPicker.js    # Syrup add-on selection component
│   │   │   └── ShoppingList/     # Shopping list generator
│   │   │       ├── ShoppingListButton.jsx
│   │   │       ├── ShoppingListModal.jsx
│   │   │       ├── ShoppingListPDF.jsx
│   │   │       ├── generateShoppingList.js
│   │   │       ├── logoBase64.js
│   │   │       └── shoppingListPars.js
│   │   ├── data/
│   │   │   ├── addonCategories.js # Add-on category definitions
│   │   │   ├── eventTypes.js      # Event type definitions
│   │   │   ├── packages.js        # Service package definitions
│   │   │   └── syrups.js          # Syrup product definitions
│   │   ├── hooks/
│   │   │   └── useFormValidation.js # Form validation hook
│   │   ├── pages/
│   │   │   ├── Login.js, Register.js, ForgotPassword.js, ResetPassword.js
│   │   │   ├── Welcome.js, FieldGuide.js, Agreement.js
│   │   │   ├── ContractorProfile.js, PaydayProtocols.js, Completion.js
│   │   │   ├── Application.js, ApplicationStatus.js
│   │   │   ├── AdminDashboard.js, AdminApplicationDetail.js, AdminUserDetail.js
│   │   │   ├── StaffPortal.js
│   │   │   ├── admin/
│   │   │   │   ├── BlogDashboard.js
│   │   │   │   ├── ClientDetail.js
│   │   │   │   ├── ClientsDashboard.js
│   │   │   │   ├── CocktailMenuDashboard.js
│   │   │   │   ├── Dashboard.js
│   │   │   │   ├── DrinkPlanDetail.js
│   │   │   │   ├── DrinkPlansDashboard.js
│   │   │   │   ├── EventsDashboard.js
│   │   │   │   ├── FinancialsDashboard.js
│   │   │   │   ├── HiringDashboard.js
│   │   │   │   ├── ProposalCreate.js
│   │   │   │   ├── ProposalDetail.js
│   │   │   │   ├── ProposalsDashboard.js
│   │   │   │   ├── SettingsDashboard.js
│   │   │   │   ├── EmailMarketingDashboard.js  # Email marketing hub (tabs)
│   │   │   │   ├── EmailLeadsDashboard.js      # Lead list + import
│   │   │   │   ├── EmailLeadDetail.js          # Lead profile + history
│   │   │   │   ├── EmailCampaignsDashboard.js  # Campaign list
│   │   │   │   ├── EmailCampaignCreate.js      # Campaign builder
│   │   │   │   ├── EmailCampaignDetail.js      # Campaign detail + metrics
│   │   │   │   ├── EmailAnalyticsDashboard.js  # Analytics overview
│   │   │   │   └── EmailConversations.js       # Conversation inbox
│   │   │   ├── plan/             # PotionPlanningLab (public questionnaire)
│   │   │   │   ├── PotionPlanningLab.js
│   │   │   │   ├── data/         # cocktailMenu.js, servingTypes.js, drinkUpgrades.js
│   │   │   │   └── steps/        # WelcomeStep, LogisticsStep, FullBarStep, SyrupUpsellStep, etc.
│   │   │   ├── proposal/         # ProposalView (public client-facing)
│   │   │   ├── public/           # Client portal pages
│   │   │   │   ├── Blog.js, BlogPost.js
│   │   │   │   ├── ClientDashboard.js
│   │   │   │   └── ClientLogin.js
│   │   │   └── website/          # Public website pages
│   │   │       ├── Website.js
│   │   │       ├── HomePage.js       # Public homepage
│   │   │       ├── QuoteWizard.js    # Multi-step quote builder
│   │   │       ├── QuotePage.js      # Quote page wrapper
│   │   │       ├── FaqPage.js        # FAQ page
│   │   │       └── ClassWizard.js    # Cocktail class booking wizard
│   │   └── index.css         # Global styles
│   ├── package.json          # proxy: localhost:5000
│   └── vercel.json           # SPA rewrite for Vercel deployment
├── .claude/
│   └── agents/               # Claude Code review agents (all opus)
│       ├── security-review.md     # OWASP security audit
│       ├── code-review.md         # Code quality + error handling
│       ├── consistency-check.md   # Cross-file synchronization
│       ├── database-review.md     # Schema + query analysis
│       ├── performance-review.md  # Frontend, API, and bundle performance
│       └── ui-ux-review.md        # Playwright visual + accessibility review
├── scripts/
│   ├── build-testing-guide.js   # Builds client/public/testing-guide.html from TESTING.md
│   └── testing-guide-template.html
├── .env / .env.example
├── .husky/pre-commit         # Pre-commit hook (runs lint-staged)
├── eslint.config.mjs         # ESLint flat config + security plugin
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
| `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret (svix) |
| `TWILIO_*` | Twilio SMS |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe live payments |
| `STRIPE_SECRET_KEY_TEST` / `STRIPE_PUBLISHABLE_KEY_TEST` / `STRIPE_WEBHOOK_SECRET_TEST` | Stripe test-mode credentials |
| `STRIPE_TEST_MODE_UNTIL` | ISO date; while in the future, all Stripe calls use `*_TEST` creds (auto-reverts to live after cutoff) |
| `STRIPE_DEPOSIT_AMOUNT` | Deposit in cents (default 10000 = $100) |
| `THUMBTACK_WEBHOOK_SECRET` | Shared secret for Thumbtack webhook auth |
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

## Reasoning Effort

**Use maximum reasoning effort when:**
- A change crosses system boundaries (schema → routes → components, backend ↔ frontend)
- Pricing, payment, or Stripe logic is involved (real money at stake)
- Auth, security, or role-guard logic is involved (data exposure risk)
- Schema migrations (hard to reverse in production)
- Any change that triggers the Cross-Cutting Consistency rules below

**Normal effort is fine for:**
- Single-file, single-layer edits (one component, one route, one style block)
- Copy, text, or documentation-only changes
- CSS-only styling tweaks
- Isolated bug fixes with an obvious cause and fix

**Quick test:** *"If I get this subtly wrong, will it cause a bug that's hard to catch?"* If yes — max effort. If the mistake would be immediately obvious — normal effort.

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

**This is not optional.** When you add, rename, or remove files, update ALL THREE docs in the same change. The pre-commit hook will warn if you don't.

| What changed | Update in CLAUDE.md | Update in README.md | Update in ARCHITECTURE.md |
|---|---|---|---|
| New/removed route file | Folder structure tree | Folder structure tree | Add/remove API route table |
| New/removed util file | Folder structure tree | Folder structure tree | Mention in relevant section |
| New/removed component | Folder structure tree | Folder structure tree | — |
| New/removed page | Folder structure tree | Folder structure tree | — |
| New/removed context | Folder structure tree | Folder structure tree | — |
| Schema column/table change | — | — | Database Schema section |
| New env variable | Environment Variables table | Environment Variables table | — |
| New npm script | — | NPM Scripts table | — |
| New integration | Tech Stack list | Tech Stack table | Third-Party Integrations |
| New feature | — | Key Features section | Relevant architecture section |

---

## Code Verification System

This project is vibe-coded — the author relies on Claude to catch issues. Verification has two layers: an inline self-check on every change, and opus-powered review agents for thorough analysis.

### Inline Self-Check (Every Change — Free)

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

### Review Agents (All Opus)

After completing a feature, significant change, or before deploy, launch review agents. All agents are defined in `.claude/agents/` and run on the opus model for thorough analysis. Launch relevant agents **in parallel** after finishing work.

**@security-review** — Full OWASP Top 10 audit:
- SQL injection (string concat in queries), XSS (`dangerouslySetInnerHTML`), SSRF
- Missing `auth` middleware, IDOR (missing `req.user.id` ownership checks)
- Hardcoded secrets, JWT implementation, Stripe/Resend/Thumbtack webhook verification
- Rate limiting, CORS config, file upload validation, `npm audit`

**@code-review** — Code quality + error handling:
- Missing try/catch on async handlers, missing ROLLBACK after BEGIN, unhandled promises
- Missing loading/error/empty states in React components
- Dead code, duplication, function complexity (>50 lines), naming conventions
- React anti-patterns: useEffect deps, component size (>200 lines), props drilling
- API consistency: response shapes, HTTP status codes, snake_case keys

**@consistency-check** — Cross-file synchronization:
- Schema column changes reflected in all routes (SELECT, INSERT, UPDATE)
- New routes mounted in `index.js` with matching `App.js` frontend routes
- Pricing logic changes reflected in all consumers (ProposalCreate, ProposalDetail, PricingBreakdown)
- API response shape changes handled by all frontend consumers
- Doc updates: CLAUDE.md, README.md, ARCHITECTURE.md folder trees

**@database-review** — Schema + query analysis:
- Missing indexes, foreign keys, NOT NULL constraints
- N+1 query patterns, `SELECT *`, missing LIMIT on list queries
- Transaction integrity (BEGIN/COMMIT/ROLLBACK)
- Migration safety (idempotent DDL, nullable new columns)

**@performance-review** — Frontend, API, and bundle performance:
- Unnecessary React re-renders (missing memo/useMemo/useCallback)
- Heavy imports, missing lazy loading, unused code shipped to client
- Sequential DB queries that could use Promise.all, missing pagination
- Oversized API responses, `SELECT *` instead of specific columns
- Prioritizes public-facing pages (HomePage, ProposalView, PotionPlanningLab, Blog)

**@ui-ux-review** — Playwright visual + accessibility review:
- Screenshots at desktop, tablet, and mobile viewports
- Color contrast, form labels, heading hierarchy, keyboard navigation
- Loading states, error messages, empty states, form validation feedback
- Responsive layout, touch targets, admin sidebar behavior
- Requires app running locally (`npm run dev`)

**Full Pre-Deploy Review** — Run ALL six agents in parallel before deploying.
