# Pre-Hire Onboarding URL

**Date:** 2026-05-13 (revised 2026-05-14 — pivot to keep application as data-collection step)
**Surfaces affected:** `server/db/schema.sql` (new `users.pre_hired` column), `server/middleware/auth.js` (select `pre_hired`), `server/routes/auth.js` (new endpoint), `server/routes/application.js` (branch on `pre_hired`), `server/routes/admin/users.js` (refactor to use shared helper), new `server/utils/contractorSeed.js` (extracted helper), `client/src/pages/PreHireOnboarding.js` (new page), `client/src/pages/Application.js` (route based on returned status), `client/src/App.js` (route table), `README.md`, `ARCHITECTURE.md`
**Predecessor:** the existing hiring funnel documented in `ARCHITECTURE.md` (registration → application → admin hire → 5-step onboarding)

## Problem

When Dallas hires someone in person, they currently have to:

1. Register at `hiring.drbartender.com/register`
2. Fill out the full application at `/apply`
3. Sit on `/application-status` polling, waiting for Dallas to log into the admin dashboard and click "Hire"

Step 3 is the friction. People hired off the books — at events, by referral, in conversation — get parked on a wait screen for an arbitrary stretch until an admin notices them. The application form was designed to filter unknown applicants; it's redundant for people Dallas has already decided to hire.

## Goal

A single, well-known, **open** URL Dallas can hand off verbally: *"go to hiring.drbartender.com/onboarding."*

A recruit who visits the URL can register on their own, complete the existing contractor application, and land directly in the onboarding flow as a hired contractor — no admin intervention required. The application form is preserved as a data-collection step (revised 2026-05-14 — see High-level approach below).

## Non-goals

- **No invite tokens, slugs, or per-person URLs.** Dallas explicitly does not want to generate or manage links per recruit. A single static URL that anyone can use is the desired model.
- **No access control on the URL.** Random strangers who find the URL can complete onboarding too. This is acceptable because Dallas controls who actually gets shifts assigned — a fake contractor account that never gets work cannot earn money.
- **No admin UI for tracking who used the URL.** The existing Hiring Dashboard already shows new contractors moving through Onboarding; the source of their hire (URL vs. manual admin button) is captured in `application_activity` (see audit-trail discussion below) but not surfaced as a top-level admin view.
- **No SMS delivery integration.** Dallas hands off the URL verbally; no need for the system to send it.
- **No expiry or revocation** for the URL — it stays live indefinitely. Audit-log entries on registration and claim *are* written (revised 2026-05-14 — see the `claim-pre-hire` and `register-pre-hired` server sections) so forensic investigation of abuse is possible. Rate-limiting reuses the existing `authLimiter` (10 requests / 15 min per IP) shared with `/auth/register` and `/auth/login`.

## High-level approach (revised 2026-05-14)

The pre-hire URL **keeps the application form as a data-collection step** — it only bypasses the admin-review wait. The full pipeline of application data (bartending experience, availability, equipment, resume, BASSET cert, etc.) is still captured for every contractor, including pre-hires. This matters operationally: Dallas relies on application data for staffing decisions.

The mechanism is a new `users.pre_hired` boolean column:

- **Register** at `hiring.drbartender.com/onboarding` → `POST /api/auth/register-pre-hired` creates a normal user (`onboarding_status = 'in_progress'`) with `pre_hired = true`. Identical to `POST /register` except for the new flag. The recruit is redirected to `/apply`.
- **Apply** at `/apply` → existing application form, unchanged. On `POST /api/application` submit, the handler reads `req.user.pre_hired`:
  - **If `pre_hired`** → flip `onboarding_status` to `'hired'` (instead of `'applied'`), seed `contractor_profiles` from the application via the shared `seedContractorProfileFromApplication` helper (same SQL the admin Hire button uses), and skip the "new applicant" admin email + the "we'll be in touch" recruit email.
  - **If not `pre_hired`** → existing behavior unchanged (`'applied'`, no seed, both emails fire).
- **Application response** now includes the new `onboarding_status` so `Application.js` can route to `/welcome` (pre-hired) vs `/application-status` (regular). From `/welcome` onward, the existing 5-step onboarding flow runs unchanged.

The SQL block that seeds `contractor_profiles` from `applications` is extracted from the admin hire endpoint into `server/utils/contractorSeed.js` and reused by both the admin Hire button and the new pre-hire application submit, so the two paths can't drift.

**Schema:** one idempotent `ADD COLUMN IF NOT EXISTS users.pre_hired BOOLEAN DEFAULT false`. No new tables, no admin UI.

## Schema: `users.pre_hired`

Idempotent column added to the `users` table in `server/db/schema.sql`:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS pre_hired BOOLEAN DEFAULT false;
```

The auth middleware (`server/middleware/auth.js`) is updated to include `pre_hired` in its `SELECT`, so `req.user.pre_hired` is available to every authenticated route.

## Server: `POST /auth/register-pre-hired`

**File:** `server/routes/auth.js` (added alongside existing `/register`)

**Path:** `POST /api/auth/register-pre-hired`. Public, no auth required. Rate-limited via the existing `authLimiter` middleware shared with `/register` and `/login` (10 requests / 15 min per IP).

**Request body:** `{ email, password, notifications_opt_in? }` — same fields as existing `/register`.

**Validation:** identical to `/register` — `EMAIL_RE`, `PASSWORD_RE`, duplicate-email check. Same `ValidationError` shape with `fieldErrors`.

**Behavior:** mechanically identical to `/register` except `pre_hired = true` is set on the new row. Two non-transactional inserts (matching the existing `/register` pattern):

1. `INSERT INTO users (email, password_hash, notifications_opt_in, pre_hired) VALUES ($1, $2, $3, true) RETURNING ...`
2. `INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)`
3. `INSERT INTO application_activity (user_id, actor_id, event_type, metadata) VALUES (...)` — emits a `pre_hire_registered` audit event so a recruit who registers but never applies still has a trail in the hiring dashboard's activity feed.

All three writes share a `BEGIN`/`COMMIT` so a partial failure can't leave a `pre_hired=true` user with no onboarding_progress row. The new user has `onboarding_status = 'in_progress'` (the default) — *not* `'hired'`. The status flip happens later, at application submit.

**Response:** `201 { token, user: { ..., onboarding_status: 'in_progress', pre_hired: true, has_application: false } }`. JWT identical to `/register`.

## Server: `POST /auth/claim-pre-hire`

**File:** `server/routes/auth.js`

**Path:** `POST /api/auth/claim-pre-hire`. Authenticated (uses `auth` middleware). Rate-limited via `authLimiter`. Staff-only: admins and managers are short-circuited to a no-op response (they have no business setting `pre_hired` on themselves).

Used by the `/onboarding` page when an **already-logged-in** user visits the URL — a returning recruit, or someone who registered at `/register` before being told about `/onboarding`. The page's `useEffect` calls this endpoint, refreshes the auth context with the returned user, and routes them onward (`/welcome` if status flipped to `'hired'`, otherwise `/apply`).

**Behavior (one transaction per branch):**

- **`onboarding_status = 'in_progress'`** (no application yet): set `pre_hired = true`. Write a `pre_hire_claimed` activity event. Return updated user.
- **`onboarding_status = 'applied'`** (application already submitted): flip status to `'hired'`, set `pre_hired = true`, seed `contractor_profiles` from the existing application (via `seedContractorProfileFromApplication`), write a `status_change` row to `interview_notes` for the admin's status-change feed, and a `status_changed` row to `application_activity` (with `via: 'claim_pre_hire'`). No email fires — symmetric with the application-submit pre-hire path; the recruit lands on `/welcome` directly and the audit trail covers admin visibility.
- **Anything else** (`'hired'`, `'interviewing'`, `'rejected'`, `'deactivated'`, etc.): no-op. The flag's only effect is at application-submit time, which is past for these statuses, so back-filling it would be pointless. (`rejected`/`deactivated` users have also had `pre_hired` explicitly cleared by the admin status-flip flow.)

**Response:** `200 { user: { ..., pre_hired: true (or unchanged for no-op cases), has_application: bool } }`.

## Server: `POST /application` (modified)

**File:** `server/routes/application.js`

Existing handler is unchanged except for two branches keyed off `req.user.pre_hired`:

1. **Status update** — replaces the hardcoded `UPDATE users SET onboarding_status = 'applied'`:
   ```js
   const isPreHired = !!req.user.pre_hired;
   const newStatus = isPreHired ? 'hired' : 'applied';
   await client.query('UPDATE users SET onboarding_status = $1 WHERE id = $2', [newStatus, req.user.id]);
   ```

2. **Contractor profile seed** — added in the same transaction, only when `pre_hired`:
   ```js
   if (isPreHired) {
     await seedContractorProfileFromApplication(client, req.user.id, null);
   }
   ```
   The helper lives at `server/utils/contractorSeed.js` (see below).

3. **Emails skipped** — the "new applicant" admin notification and "we'll be in touch" recruit confirmation are wrapped in an `if (!req.user.pre_hired)` guard. Pre-hires need neither: Dallas already knows about them, and the recruit is about to land on `/welcome`.

4. **Activity timeline** — the `application_submitted` event now records `via: 'pre_hire_onboarding'` for pre-hires (vs the existing `via: 'self'`) so the admin's activity timeline can show how the application landed.

5. **Response shape** — extended to include the user's new `onboarding_status` so the client can route correctly:
   ```js
   res.status(201).json({ ...result.rows[0], onboarding_status: req.user.pre_hired ? 'hired' : 'applied' });
   ```

## Shared helper: `seedContractorProfileFromApplication`

**File:** new `server/utils/contractorSeed.js`

The 50-line UPSERT SQL that populates `contractor_profiles` from `applications` is extracted from `server/routes/admin/users.js` (where the admin Hire button uses it) into a single exported function. Both callers — the admin Hire button and the new pre-hire application submit — now use the same helper, so the seeded column list and conflict-resolution logic can't drift.

Signature:
```js
async function seedContractorProfileFromApplication(client, userId, existingHireDate = null)
```

`existingHireDate` is the previously-set `hire_date` on `contractor_profiles` if any (for the re-hire / status-toggle case). For the pre-hire application submit, it's always `null` (a fresh hire), and the SQL defaults to `CURRENT_DATE`.

## Client: `/onboarding` page

**File:** new `client/src/pages/PreHireOnboarding.js`

**Wired in:** `client/src/App.js`, inside `HiringRoutes()`, after the existing `/register` route. Wrapped in `RedirectIfLoggedIn`.

```jsx
<Route path="/onboarding" element={<RedirectIfLoggedIn><PreHireOnboarding /></RedirectIfLoggedIn>} />
```

**Page structure:** mirrors `Register.js` (same imports, same form layout, same validation hook). Reframed copy:

- Hero: *"Welcome aboard! You've been pre-approved as a Dr. Bartender contractor"*
- Sub: *"Set up your account to get started. Next you'll fill out a quick contractor application, then sign the agreement, complete your profile, and upload your W-9 — about 20 minutes total."*
- Form: email, password, confirm password, "Text me when new shifts post (optional)" opt-in checkbox.
- Submit: *"Start Onboarding →"*.

**Submit behavior:**

1. `POST /api/auth/register-pre-hired` with `{ email, password, notifications_opt_in }`.
2. On `201`: `login(token, user)` then `navigate('/apply')`. The recruit goes straight into the application form.
3. On `ValidationError`: render inline field errors. For duplicate email, the "Sign in instead" link is prominent below the form.

## Client: `Application.js` (modified)

**File:** `client/src/pages/Application.js`

After a successful `POST /application`, the existing flow refreshes the user via `GET /auth/me`. Now the post-submit navigation branches on the returned status:

```js
const newStatus = submitRes?.data?.onboarding_status || meRes?.data?.user?.onboarding_status;
if (newStatus === 'hired') {
  toast.success("You're all set — welcome aboard!");
  navigate('/welcome');
} else {
  toast.success('Application submitted!');
  navigate('/application-status');
}
```

Regular applicants are unaffected (`newStatus === 'applied'` → `/application-status`). Pre-hires land directly on `/welcome` and continue through the existing 5-step onboarding flow.

## Routing & domain

The `/onboarding` route lives on `hiring.drbartender.com` only — `HiringRoutes()` in `App.js`. Not exposed on `admin.drbartender.com`, `staff.drbartender.com`, or the public marketing site.

No path collisions: `/onboarding` is not currently a route on any of the four domain configurations in `App.js`.

## Edge cases

- **Email already in use.** Server returns `ValidationError({ email: 'An account with this email already exists' })`. Frontend renders the error inline and shows the "Sign in instead" link. The recruit signs in; if their existing account is `in_progress` with no application, they land on `/apply` like any regular applicant, and their submission follows the existing (admin-review-required) path. Workaround for moving them onto the pre-hire path: Dallas can flip `pre_hired = true` directly in the DB, or use the existing admin "Hire" button on their record after they apply.
- **Weak password / invalid email.** Validated by the same regex constants as `/register`.
- **Rate-limit hit.** `authLimiter` returns 429. Same UX as `/register`.
- **User registers via `/onboarding` then never completes the application.** Their account sits in `'in_progress'` with `pre_hired = true` and no application — identical to the existing "Unfinished signups" bucket that the Hiring Dashboard already surfaces. No special handling needed.
- **User registers via `/onboarding` then completes the application.** Status flips to `'hired'`, contractor_profiles is seeded from the application row, no admin email fires, recruit lands on `/welcome`. They appear in the Onboarding column on the Hiring Dashboard like any newly-hired contractor.

## Security review

- **`pre_hired = true` is set by an open public endpoint.** Anyone who hits `/api/auth/register-pre-hired` becomes a `pre_hired` user. The threat: a stranger registers, fills out the application form, and lands as `'hired'` instead of `'applied'`. Mitigations: (1) shift assignment is still admin-gated, so a fake contractor cannot earn money without Dallas assigning them work; (2) the tip page is not activated by application submit — it's only created at the end of `/payday-protocols` via `POST /payment`; (3) the application form requires uploading a resume + BASSET cert, raising the friction for casual abuse; (4) `authLimiter` rate-limits registrations; (5) Dallas can revoke any contractor via the existing admin status flip.
- **Open registration with a pre-hire flag is acceptable.** A `pre_hired = true` user with `onboarding_status = 'in_progress'` and no application has exactly the same access surface as a regular `/register` user — none of the onboarding pages render until they actually apply. The flag only changes what happens at application submit.
- **PII collected from strangers.** A fake account that progresses to `/payday-protocols` would submit a W-9 and (optionally) banking info that gets encrypted via `server/utils/encryption.js`. Same encryption that protects real contractors. Risk is data hygiene, not data leakage.
- **Rate limiting** prevents automated mass signups. Same protection as `/register`.

Net new risk vs. the existing `/register` endpoint is minimal: a stranger who finds the URL can fill out an application and arrive at `'hired'` instead of `'applied'`, but they still need admin shift assignment to earn anything.

## Files touched

- `server/db/schema.sql` — `ADD COLUMN IF NOT EXISTS users.pre_hired BOOLEAN DEFAULT false NOT NULL` (with idempotent backfill)
- `server/middleware/auth.js` — include `pre_hired` in the SELECT
- `server/routes/auth.js` — new `POST /register-pre-hired` (transactional + audit) and `POST /claim-pre-hire` (staff-only, rate-limited, audit) handlers
- `server/routes/application.js` — branch on `req.user.pre_hired` (status, profile seed, emails, response shape); defense-in-depth gate on `onboarding_status === 'in_progress'`
- `server/routes/admin/users.js` — refactor to use shared `seedContractorProfileFromApplication` helper; clear `pre_hired = false` on transitions to `'rejected'` / `'deactivated'`
- `server/routes/admin/applications.js` — clear `pre_hired = false` on reject
- `server/utils/contractorSeed.js` — new shared helper (~80 LOC of SQL extracted from `admin/users.js`)
- `client/src/pages/PreHireOnboarding.js` — new page (~190 LOC modeled on `Register.js`, with logged-in claim path)
- `client/src/pages/Application.js` — route based on returned `onboarding_status` after submit
- `client/src/context/AuthContext.js` — include `pre_hired` in the `isSameUser` shallow comparator
- `client/src/App.js` — one new route line in `HiringRoutes()` + a parallel route in the default `'app'` block (so localhost / admin.drbartender.com also serve the page) + lazy import
- `README.md` — folder-structure tree entry for `PreHireOnboarding.js`
- `ARCHITECTURE.md` — add `POST /register-pre-hired` and `POST /claim-pre-hire` rows to API route table

No test files in this codebase to update (verified: no `__tests__` directories, no `*.test.js` files in the affected paths).

## Rollout

Single commit. No feature flag — the URL is intentionally open, and there's no migration risk because no schema changes. Push to `main` deploys to Render + Vercel via the existing pipeline.

After deploy: smoke-test by visiting `https://hiring.drbartender.com/onboarding` in an incognito window, registering with a throwaway email, confirming the JWT lands and the redirect to `/welcome` succeeds, then walking through the existing onboarding pages to confirm no regression.

## Out-of-scope follow-ups (not part of this spec)

- An admin "Resend invite" / "Send onboarding link" email button (would auto-email the URL to a recruit's address — useful but not needed for v1)
- An admin "Mark already-hired" button on the user detail page for the rare case where a recruit registered through the regular `/register` flow and you want to skip the application without using the URL (workaround today: use the existing status flip to `'hired'`)
- SMS delivery of the URL via Twilio
- Custom welcome copy per recruit (would require the per-person token model we explicitly rejected)
