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
| Styling | Vanilla CSS |

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
| `TWILIO_ACCOUNT_SID` | For SMS | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | For SMS | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | For SMS | Twilio sender number |
| `STRIPE_SECRET_KEY` | For payments | Stripe secret key |
| `STRIPE_PUBLISHABLE_KEY` | For payments | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | For payments | Stripe webhook signing secret |
| `STRIPE_DEPOSIT_AMOUNT` | No | Deposit in cents (default: 10000 = $100) |
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
│   │   └── seed.js             # Admin account seeder script
│   ├── middleware/
│   │   └── auth.js             # JWT verification + role guards (auth, adminOnly)
│   ├── routes/
│   │   ├── auth.js             # POST /register, POST /login, GET /me
│   │   ├── progress.js         # Onboarding step tracking
│   │   ├── agreement.js        # Contractor agreement + digital signature
│   │   ├── contractor.js       # Contractor profile + file uploads
│   │   ├── payment.js          # Payment method + W-9 upload
│   │   ├── application.js      # Contractor application form
│   │   ├── admin.js            # Admin user management, status changes
│   │   ├── drinkPlans.js       # Client event planning questionnaire
│   │   ├── cocktails.js        # Cocktail menu CRUD
│   │   ├── mocktails.js        # Mocktail menu CRUD
│   │   ├── proposals.js        # Service proposals + pricing calculator
│   │   ├── stripe.js           # Payment intents, payment links, webhooks
│   │   ├── clients.js          # Client CRUD
│   │   └── shifts.js           # Shift scheduling
│   └── utils/
│       ├── email.js            # Resend email wrapper
│       ├── sms.js              # Twilio SMS wrapper
│       ├── storage.js          # Cloudflare R2 upload + signed URL helpers
│       ├── fileValidation.js   # Magic-byte file type validation
│       ├── pricingEngine.js    # Pure pricing calculation engine
│       └── eventCreation.js   # Auto-create shifts from paid proposals
├── client/
│   ├── src/
│   │   ├── App.js              # All routes, auth guards (ProtectedRoute, RequireHired, etc.)
│   │   ├── context/
│   │   │   └── AuthContext.js  # React auth state (login, logout, user)
│   │   ├── utils/
│   │   │   └── api.js          # Axios instance with JWT interceptor
│   │   ├── components/         # Layout, SignaturePad, FileUpload, PricingBreakdown, etc.
│   │   ├── pages/              # Register, Login, onboarding steps, StaffPortal, admin pages
│   │   │   ├── admin/          # Dashboard sub-pages (proposals, clients, drink plans, menus)
│   │   │   ├── plan/           # PotionPlanningLab — public event questionnaire
│   │   │   └── proposal/       # ProposalView — public client-facing proposal
│   │   ├── images/             # Brand assets
│   │   └── index.css           # Global styles
│   ├── vercel.json             # SPA rewrite rule for Vercel
│   └── package.json            # React deps, proxy: localhost:5000
├── .env.example                # Environment variable template
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
- Client signature capture and acceptance workflow
- $100 deposit collection via Stripe

### Event Planning (Potion Planning Lab)
- Public questionnaire sent to clients via unique token link
- Clients select cocktails, mocktails, and serving preferences
- Admin review dashboard

### Proposal → Event Pipeline
- When a client signs the contract and pays the deposit, a shift is automatically created
- Shift is populated from proposal data (event name, date, time, duration, location, bartenders needed)
- Staff can immediately see and request the shift via the Staff Portal
- Admin can also manually trigger shift creation via `POST /api/proposals/:id/create-shift`
- Events dashboard shows all confirmed events with staffing status and staff request management

### Admin Dashboard
- **Staffing**: Application review, hire/reject, interview notes, user management
- **Proposals**: Create, price, send, track views/signatures/payments
- **Clients**: CRM with source tracking (direct, Thumbtack, referral, website)
- **Drink Plans**: Review client event questionnaires
- **Drink Menu**: Manage 25 cocktails + 16 mocktails across categories
- **Events**: Confirmed events from paid proposals, staffing status, shift request management
- **Financials / Settings**: Placeholder tabs ready for expansion

### Staff Portal
- View available shifts and request assignments
- Profile and notification management

## Deployment

### Backend — Render
The `render.yaml` blueprint defines the web service and PostgreSQL database. Push to `main` auto-deploys.

### Frontend — Vercel
The React app is deployed separately on Vercel. `client/vercel.json` handles SPA routing. The build-time `REACT_APP_API_URL` points to the Render backend.

### Database
Schema is auto-initialized on server start via `server/db/index.js`, which runs `schema.sql`. All DDL is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
