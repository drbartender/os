# Dr. Bartender OS: a reviewer's map

Built to be skimmed in two minutes so you can pick where to spend your time. Pick one thing off the menu, or none. No wrong answer.

## What it is

One operations system for a bartending services company. It quotes the job, builds the drink plan, staffs it, runs the contract and e-signature, invoices the client, takes the payment, and pays the bartenders. Real money and real client contracts move through it every week.

Node/Express API, React front end, Postgres on Neon. Server on Render, client on Vercel. Stripe for payments and payouts, Twilio for SMS and voice, Resend for email, Cloudflare R2 for files, WebAuthn passkeys, Sentry for errors.

Roughly 88k lines of server code in 394 files, 90k lines of client code, 93k lines of tests in 375 test files, 92 tables, 60 mounted API route groups. One developer.

## The map

| Area | Where it lives |
| --- | --- |
| Quoting and proposals: pricing engine, packages, add-ons, comparable options | `server/utils/pricingEngine.js`, `server/routes/proposals/` |
| Drink planning: recipe catalog, per-event plans, shopping lists | `server/routes/drinkPlans/`, `server/utils/potionCatalog.js` |
| Staffing: roster, shifts, waitlist, onboarding, staff portal | `server/routes/staffPortal/`, `server/routes/shifts.js` |
| Client-facing: portal, e-signature, token-addressed links | `server/routes/clientPortal/`, `server/routes/clientAuth.js` |
| Payments: invoices, Stripe intents, webhooks, refunds | `server/routes/invoices.js`, `server/routes/stripeWebhook.js` |
| Payroll: accrual, pay periods, gratuity, duty pay, paystubs | `server/utils/payroll*.js`, `server/routes/admin/payroll.js` |
| Comms: two-way SMS, a voice tree, marketing email, scheduled sends | `server/utils/smsInbound.js`, `server/routes/voice.js` |

## The menu

### 1. Auth and session handling. About 20 minutes.

Three identity systems run side by side: staff JWT with role checks, client access by emailed token and OTP, and WebAuthn passkeys. The question I can't answer myself is whether they can be made to overlap, or whether a client token reaches anything a client shouldn't.

`server/middleware/auth.js`, `server/routes/auth.js`, `server/routes/clientAuth.js`, `server/routes/webauthn.js`, `server/middleware/rateLimiters.js`

### 2. Stripe webhook handling. About 20 minutes.

Signature verification, idempotency, out-of-order and replayed events, and what happens when a webhook and an admin action race for the same invoice. This is where a wrong answer quietly becomes a wrong balance.

`server/routes/stripeWebhook.js`, then `server/routes/stripeWebhookHandlers/paymentIntentSucceeded.js`

### 3. Payout and payroll math. About 30 minutes.

Money that leaves the business. Accrual into open pay periods, tip handling, clawback when a client refunds after a bartender was already paid, and period boundaries across time zones.

`server/utils/payrollMath.js`, `payrollAccrual.js`, `payrollPeriods.js`, `payrollGuards.js`, `server/routes/admin/payroll.js`

### 4. The data model. About 15 minutes.

92 tables in one file. Mostly I want to know where a constraint should exist and doesn't.

`server/db/schema.sql`

### 5. Anything that looks wrong to you. However long you feel like.

Probably the most valuable option on this list. You will see things I stopped seeing a year ago.

## Access

- Admin login: sent separately
- Repo: sent separately

One caution: this is production, not a sandbox. There is no staging copy. Reading and clicking around is completely safe, but anything that sends, refunds, voids, or texts fires for real at a real client. If you want to see one of those paths run, ping me and I will drive it.

## Before you go hunting

I keep a running list of known defects. Ask and I will send it, so you don't spend your time rediscovering something already on it. Otherwise assume anything you find is news to me.
