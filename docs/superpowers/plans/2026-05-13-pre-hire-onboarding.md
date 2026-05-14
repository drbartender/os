# Pre-Hire Onboarding URL Implementation Plan

> **⚠️ STATUS: SUPERSEDED (2026-05-14).** This plan was written against the original "skip the application form" design. After implementation began the design pivoted twice — the application form is now kept as a data-collection step, and additional endpoints (`claim-pre-hire`), schema changes (`users.pre_hired` column + NOT NULL), shared helpers (`contractorSeed.js`), and admin/applications + AuthContext changes were added that this plan does not describe. The plan is preserved for context but **the spec at `docs/superpowers/specs/2026-05-13-pre-hire-onboarding-design.md` is the authoritative source of truth.** Refer to git history for the actual shipped implementation.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Source spec:** `docs/superpowers/specs/2026-05-13-pre-hire-onboarding-design.md` (read first; this plan implements it).

**Goal:** Ship a single open URL at `hiring.drbartender.com/onboarding` where pre-hired contractors register themselves and land directly in the existing 5-step onboarding flow — no application form, no admin intervention.

**Architecture:** New public `POST /api/auth/register-pre-hired` endpoint creates a user with `onboarding_status='hired'` inside one transaction, mirroring the no-application fallback path the existing admin "Hire" button already uses (`server/routes/admin/users.js:218-225`). New public React page `/onboarding` is a thin reframe of `Register.js` that submits to the new endpoint and routes the user straight to `/welcome`. No schema changes, no new tables, no admin UI.

**Tech Stack:** Node 18 / Express 4.18, React 18 (CRA), Postgres (raw SQL via `pg`), bcryptjs, jsonwebtoken, vanilla CSS.

**Verification model:** This codebase has no automated tests (per `CLAUDE.md`). Each task ends with a **manual smoke test** (curl or browser) and the pre-push agent fleet is the verification layer. Per `CLAUDE.md` "one commit per logical feature" rule, all five files ship in **one commit at the end** — no intermediate commits.

---

## File structure (created/modified)

| Path | Status | Responsibility |
|---|---|---|
| `server/routes/auth.js` | modify | Add `POST /register-pre-hired` handler with transaction that seeds user + onboarding_progress + contractor_profiles skeleton |
| `client/src/pages/PreHireOnboarding.js` | create | Public registration page rendered at `/onboarding`; visually mirrors `Register.js` with reframed copy and a different submit endpoint |
| `client/src/App.js` | modify | Wire `<Route path="/onboarding">` into `HiringRoutes()` with `RedirectIfLoggedIn` wrapper |
| `README.md` | modify | Add PreHireOnboarding to the `(staff)` group in the pages tree |
| `ARCHITECTURE.md` | modify | Add `POST /register-pre-hired` row to the Authentication route table |

No tests. No schema changes. No new modules under `server/utils/`. No CSS changes (the new page reuses `Register.js`'s existing classes).

---

## Task 1: Server endpoint — `POST /auth/register-pre-hired`

**Files:**
- Modify: `server/routes/auth.js` (insert after the existing `POST /register` handler, before `POST /login`)

- [ ] **Step 1: Add the new endpoint to `server/routes/auth.js`**

Locate the line `// Login` (currently line 71). Immediately **above** that line, paste the following handler. The `authLimiter`, `EMAIL_RE`, `PASSWORD_RE`, `ValidationError`, `pool`, `bcrypt`, `jwt`, and `asyncHandler` symbols are all already imported at the top of the file — no new imports needed.

```javascript
// Register as a pre-hired contractor — open URL hand-off from admin
// (see docs/superpowers/specs/2026-05-13-pre-hire-onboarding-design.md).
// Same surface as POST /register, but the new user lands in
// onboarding_status='hired' and we seed an onboarding_progress row + a
// skeleton contractor_profiles row (mirroring the no-application fallback
// in PUT /api/admin/users/:id/status at server/routes/admin/users.js:218-225).
router.post('/register-pre-hired', authLimiter, asyncHandler(async (req, res) => {
  const { email, password, notifications_opt_in } = req.body;

  const fieldErrors = {};
  if (!email) fieldErrors.email = 'Email is required';
  else if (!EMAIL_RE.test(email)) fieldErrors.email = 'Please enter a valid email address';
  if (!password) fieldErrors.password = 'Password is required';
  else if (!PASSWORD_RE.test(password)) {
    fieldErrors.password = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors);

  const normalizedEmail = email.toLowerCase();

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows[0]) {
    throw new ValidationError({ email: 'An account with this email already exists' });
  }

  const hash = await bcrypt.hash(password, 12);

  // All three inserts share one transaction so a partial failure can't leave
  // a user in 'hired' status with no onboarding_progress / contractor_profiles row.
  const client = await pool.connect();
  let user;
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, notifications_opt_in, onboarding_status)
       VALUES ($1, $2, $3, 'hired')
       RETURNING id, email, role, onboarding_status, token_version`,
      [normalizedEmail, hash, notifications_opt_in || false]
    );
    user = userRes.rows[0];

    await client.query(
      'INSERT INTO onboarding_progress (user_id, account_created) VALUES ($1, true)',
      [user.id]
    );

    // Skeleton contractor_profiles row with hire_date. Mirrors the no-application
    // branch in PUT /api/admin/users/:id/status. The recruit fills in the rest
    // (preferred_name, address, equipment, emergency contact, files) at
    // /contractor-profile during onboarding.
    await client.query(
      `INSERT INTO contractor_profiles (user_id, hire_date)
       VALUES ($1, CURRENT_DATE)
       ON CONFLICT (user_id) DO UPDATE SET hire_date = COALESCE(contractor_profiles.hire_date, CURRENT_DATE)`,
      [user.id]
    );

    await client.query('COMMIT');
  } catch (txErr) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    // Surface the Postgres UNIQUE violation as a clean field error in the rare
    // race where two registrations land for the same email between our SELECT
    // and our INSERT.
    if (txErr && txErr.code === '23505') {
      throw new ValidationError({ email: 'An account with this email already exists' });
    }
    throw txErr;
  } finally {
    client.release();
  }

  const token = jwt.sign(
    { userId: user.id, tokenVersion: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({ token, user: { ...user, has_application: false } });
}));

```

- [ ] **Step 2: Smoke-test the endpoint with curl**

Start the dev server:

```bash
npm run dev
```

In another terminal, hit the endpoint with a fresh email. Use a unique email (substitute today's timestamp or any throwaway string) — the endpoint creates a real row:

```bash
curl -i -X POST http://localhost:5000/api/auth/register-pre-hired \
  -H "Content-Type: application/json" \
  -d '{"email":"prehire-smoke-001@example.com","password":"Test1234"}'
```

Expected:
- `HTTP/1.1 201 Created`
- Response body shape: `{"token":"eyJ...", "user":{"id":<num>,"email":"prehire-smoke-001@example.com","role":"staff","onboarding_status":"hired","token_version":0,"has_application":false}}`

Hit the endpoint again with the same email. Expected: `400 Bad Request` with body `{"error":"...","fieldErrors":{"email":"An account with this email already exists"}}`.

Hit it once more with a weak password (no uppercase): `'{"email":"prehire-smoke-002@example.com","password":"alllowercase1"}'`. Expected: `400` with `fieldErrors.password` set.

- [ ] **Step 3: Verify the database state for the smoke-test user**

Connect to your dev Postgres (or use whatever query tool you have wired). Run:

```sql
SELECT u.id, u.email, u.role, u.onboarding_status,
       op.account_created,
       cp.hire_date
FROM users u
LEFT JOIN onboarding_progress op ON op.user_id = u.id
LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
WHERE u.email = 'prehire-smoke-001@example.com';
```

Expected single row:
- `role = 'staff'`
- `onboarding_status = 'hired'`
- `account_created = true`
- `hire_date = <today's date>`

If any of these is wrong, the endpoint is broken — do not proceed to Task 2.

- [ ] **Step 4: Clean up the smoke-test user (optional)**

```sql
DELETE FROM users WHERE email LIKE 'prehire-smoke-%@example.com';
```

(Foreign-key cascades on `onboarding_progress` and `contractor_profiles` clean up the dependent rows.)

---

## Task 2: Client page — `client/src/pages/PreHireOnboarding.js`

**Files:**
- Create: `client/src/pages/PreHireOnboarding.js`

- [ ] **Step 1: Create the page file**

Create `client/src/pages/PreHireOnboarding.js` with the following content. The structure mirrors `Register.js` exactly — same imports, same form validation hook, same components — only the copy and the submit endpoint change.

```jsx
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import useFormValidation from '../hooks/useFormValidation';

export default function PreHireOnboarding() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ email: '', password: '', confirmPassword: '', notifications_opt_in: false });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const rules = [
    { field: 'email', label: 'Email' },
    { field: 'password', label: 'Password', test: v => v.length >= 8 },
    { field: 'confirmPassword', label: 'Confirm Password' },
  ];

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
    clearField(name);
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    if (form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'Passwords do not match.' });
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/register-pre-hired', {
        email: form.email,
        password: form.password,
        notifications_opt_in: form.notifications_opt_in,
      });
      login(res.data.token, res.data.user);
      toast.success('Welcome aboard!');
      navigate('/welcome');
    } catch (err) {
      setError(err.message || 'Could not create your account. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 460 }}>
          <div className="text-center mb-3">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }} aria-hidden="true">🥂</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Welcome aboard!</h1>
            <p className="text-muted italic">You've been pre-approved as a Dr. Bartender contractor</p>
          </div>

          <div className="card">
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Set up your account to start onboarding. You'll sign the contractor agreement,
                fill out your profile, and upload your W-9 — about 15 minutes total.
              </p>
            </div>

            <form onSubmit={submit}>
              <div className={"form-group" + fieldClass('email')}>
                <label htmlFor="prehire-email" className="form-label">Email Address</label>
                <input
                  id="prehire-email" name="email" type="email" className={"form-input" + inputClass('email')}
                  placeholder="your@email.com"
                  value={form.email} onChange={handle}
                  aria-invalid={!!fieldErrors?.email}
                />
                <FieldError error={fieldErrors?.email} />
              </div>

              <div className={"form-group" + fieldClass('password')}>
                <label htmlFor="prehire-password" className="form-label">Create Password</label>
                <input
                  id="prehire-password" name="password" type="password" className={"form-input" + inputClass('password')}
                  placeholder="Minimum 8 characters, with a number and uppercase letter"
                  value={form.password} onChange={handle}
                  aria-invalid={!!fieldErrors?.password}
                />
                <FieldError error={fieldErrors?.password} />
              </div>

              <div className={"form-group" + fieldClass('confirmPassword')}>
                <label htmlFor="prehire-confirmPassword" className="form-label">Confirm Password</label>
                <input
                  id="prehire-confirmPassword" name="confirmPassword" type="password" className={"form-input" + inputClass('confirmPassword')}
                  placeholder="Confirm your password"
                  value={form.confirmPassword} onChange={handle}
                  aria-invalid={!!fieldErrors?.confirmPassword}
                />
                <FieldError error={fieldErrors?.confirmPassword} />
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'normal' }}>
                  <input
                    type="checkbox"
                    name="notifications_opt_in"
                    checked={form.notifications_opt_in}
                    onChange={handle}
                  />
                  <span style={{ fontSize: '0.9rem' }}>Text me when new shifts post (optional)</span>
                </label>
              </div>

              <FormBanner error={error} fieldErrors={fieldErrors} />

              <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                {loading ? 'Creating Account...' : 'Start Onboarding →'}
              </button>
            </form>

            <div className="divider" />
            <p className="text-center text-small">
              Already have an account? <Link to="/login">Sign in here</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the route into `HiringRoutes` in `client/src/App.js`**

Open `client/src/App.js`. At the top of the file you'll find a block of lazy/eager imports for page components. Locate the `Register` import (around line 30-50 depending on diffs) and add a `PreHireOnboarding` import right after it:

```jsx
import PreHireOnboarding from './pages/PreHireOnboarding';
```

(If `Register` is imported via `React.lazy()`, lazy-load `PreHireOnboarding` the same way to match the bundle-splitting pattern.)

Then locate `function HiringRoutes()` (around line 269). Inside its `<Routes>` block, find the existing `<Route path="/register" ...>` line:

```jsx
<Route path="/register" element={<RedirectIfLoggedIn><Register /></RedirectIfLoggedIn>} />
```

Add a new route on the line immediately after it:

```jsx
<Route path="/onboarding" element={<RedirectIfLoggedIn><PreHireOnboarding /></RedirectIfLoggedIn>} />
```

That's the only edit to `App.js`.

- [ ] **Step 3: Smoke-test the page in the browser**

If the dev server isn't already running, start it: `npm run dev`.

Open an **incognito / private window** so you're guaranteed to be logged out. Navigate to:

```
http://localhost:3000/onboarding
```

Expected:
- Page renders the welcome copy ("Welcome aboard! You've been pre-approved...")
- Email, password, confirm password fields present
- Opt-in checkbox present
- "Start Onboarding →" button present

Test the happy path. Fill in:
- Email: `prehire-browser-001@example.com`
- Password: `Test1234`
- Confirm: `Test1234`

Click "Start Onboarding →". Expected:
- Toast appears: "Welcome aboard!"
- URL changes to `/welcome`
- The Welcome page renders (existing onboarding step 1)
- Browser localStorage / sessionStorage has the new JWT (open devtools → Application → Storage)

Click through the onboarding flow far enough to confirm `/field-guide` and `/agreement` load without errors. Stop before signing the agreement (you don't need to complete the whole flow — just verify the gate accepts the new user).

- [ ] **Step 4: Smoke-test the duplicate-email path**

Refresh `/onboarding` (still in incognito, but first log out via devtools → clear storage or by opening a fresh incognito window since you'll be auto-redirected away from `/onboarding` while logged in).

Submit the same email used in step 3 (`prehire-browser-001@example.com`) with any valid password. Expected:
- Inline error under the Email field: "An account with this email already exists"
- "Sign in here" link below is visible
- No redirect happens

- [ ] **Step 5: Smoke-test the logged-in redirect**

While logged in as the `prehire-browser-001@example.com` user (which you should still be from step 3), manually navigate to `http://localhost:3000/onboarding`. Expected:
- `RedirectIfLoggedIn` wrapper kicks in
- You get bounced to `/welcome` (the home path for a `'hired'`-status user)
- The PreHireOnboarding page never renders

If any of these smoke tests fail, fix before proceeding.

- [ ] **Step 6: Clean up the browser smoke-test user**

```sql
DELETE FROM users WHERE email LIKE 'prehire-browser-%@example.com';
```

---

## Task 3: Documentation updates

**Files:**
- Modify: `README.md` (pages tree)
- Modify: `ARCHITECTURE.md` (Authentication route table)

- [ ] **Step 1: Update `README.md` pages tree**

Open `README.md` and locate the `(staff)` line in the pages tree (around line 220):

```
│   │   │   ├── (staff)          # Application, ApplicationStatus, HiringLanding
```

Change it to:

```
│   │   │   ├── (staff)          # Application, ApplicationStatus, HiringLanding, PreHireOnboarding (open pre-hire URL)
```

That's the only README change.

- [ ] **Step 2: Update `ARCHITECTURE.md` Authentication route table**

Open `ARCHITECTURE.md` and locate the Authentication route table (around line 108-114):

```
### Authentication — `/api/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | No | Create account, auto-create onboarding_progress row |
| POST | `/login` | No | Validate credentials, return JWT (7-day expiry) |
| GET | `/me` | Yes | Current user + `has_application` flag |
```

Insert a new row immediately after the `/register` row:

```
| POST | `/register-pre-hired` | No | Create account at `onboarding_status='hired'` (skips application) — backs the open `hiring.drbartender.com/onboarding` URL |
```

So the section becomes:

```
### Authentication — `/api/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | No | Create account, auto-create onboarding_progress row |
| POST | `/register-pre-hired` | No | Create account at `onboarding_status='hired'` (skips application) — backs the open `hiring.drbartender.com/onboarding` URL |
| POST | `/login` | No | Validate credentials, return JWT (7-day expiry) |
| GET | `/me` | Yes | Current user + `has_application` flag |
```

That's the only ARCHITECTURE change.

---

## Task 4: End-to-end verification

**Files:** None — manual verification only.

- [ ] **Step 1: Full flow walkthrough**

Open a fresh incognito window. Navigate to `http://localhost:3000/onboarding`. Register with a fresh email (e.g. `e2e-001@example.com`, password `Test1234`).

Walk **all the way through** onboarding:

1. `/welcome` — click "Access the Field Guide →"
2. `/field-guide` — scroll through, click the proceed button
3. `/agreement` — fill in the signature + acknowledgments, submit
4. `/contractor-profile` — fill in the required fields (preferred name, phone, address, emergency contact, equipment checkboxes), submit
5. `/payday-protocols` — pick a payment method, upload a dummy PDF as the W-9, submit
6. `/complete` — should display the completion card

Expected: no errors, no redirects to `/apply` or `/application-status`, no application form ever shown.

After hitting `/complete`, verify in the database:

```sql
SELECT u.email, u.onboarding_status,
       op.onboarding_completed, op.payday_protocols_completed,
       cp.hire_date
FROM users u
LEFT JOIN onboarding_progress op ON op.user_id = u.id
LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
WHERE u.email = 'e2e-001@example.com';
```

Expected:
- `onboarding_status = 'approved'` (final step flipped it)
- `onboarding_completed = true`
- `payday_protocols_completed = true`
- `hire_date = <today>` (set on registration)

- [ ] **Step 2: Regression check — existing register flow still works**

Open another incognito window. Navigate to `/register` (the old flow). Register with a fresh email.

Expected: same behavior as before this change — lands on `/apply` after successful registration. The legacy applicant flow is untouched.

Clean up smoke-test users:

```sql
DELETE FROM users WHERE email IN ('e2e-001@example.com', '<the email used for register regression>');
```

- [ ] **Step 3: Lint check**

```bash
npm run lint
```

Expected: no new errors. (Pre-existing warnings are fine; the new endpoint and component should not introduce any.)

If lint flags anything in `server/routes/auth.js` or `client/src/pages/PreHireOnboarding.js`, fix before proceeding.

---

## Task 5: Commit

**Files:** All five files modified/created in Tasks 1–3.

- [ ] **Step 1: Confirm working tree is exactly the five intended files**

```bash
git status
```

Expected output (paths, not order):

```
modified:   server/routes/auth.js
modified:   client/src/App.js
modified:   README.md
modified:   ARCHITECTURE.md
Untracked files:
  client/src/pages/PreHireOnboarding.js
```

If you see anything else (stray edits, .env changes, screenshot files), stop and resolve them before staging.

- [ ] **Step 2: Stage exactly those five paths**

Per `CLAUDE.md` Git Rule 7, never use `git add .` / `-A` / `-u`. Stage by name:

```bash
git add server/routes/auth.js client/src/pages/PreHireOnboarding.js client/src/App.js README.md ARCHITECTURE.md
```

Then re-run `git status` to confirm exactly those five paths show under "Changes to be committed".

- [ ] **Step 3: Commit with a single-line message**

Per `CLAUDE.md` Git Rule 4 ("plain `git commit -m \"single line\"` ... keeps permission prompts at zero"):

```bash
git commit -m "feat(hiring): open pre-hire onboarding URL at /onboarding — skips application + admin gate"
```

- [ ] **Step 4: Stand down**

Per `CLAUDE.md` Git Rule 4: *"After a commit, Claude stands down — silence is correct. No 'ready to push?' question."*

Do not push. Do not run review agents. Do not propose anything else. The user decides when to push (they may be batching across multiple parallel sessions). When they issue an explicit push cue ("push", "deploy", "ship it"), follow the **Pre-Push Procedure** documented in `CLAUDE.md` — including the step 0.5 confirmation gate before launching the 5 review agents in parallel.

---

## Self-review checklist (already run)

- **Spec coverage:** every spec requirement maps to a task.
  - Open URL on hiring subdomain → Task 2 step 2 (route wired into `HiringRoutes()`)
  - New endpoint with hired status + skeleton seeds → Task 1 step 1
  - Same validation as `/register` → Task 1 step 1 (reuses `EMAIL_RE`, `PASSWORD_RE`, `authLimiter`)
  - Reframed copy on the page → Task 2 step 1 (hero + card copy)
  - Email-already-exists edge case → Task 1 step 1 (handler) + Task 2 step 4 (smoke test)
  - Concurrent duplicate-registration race → Task 1 step 1 (23505 catch in transaction)
  - No `activateTipPage` call → Task 1 step 1 (omitted intentionally)
  - README + ARCHITECTURE updates → Task 3
  - One commit per logical feature → Task 5

- **Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". All code is complete in the steps that need it.

- **Type/signature consistency:** the endpoint path used in both server (`/register-pre-hired` mounted under `/api/auth`) and client (`api.post('/auth/register-pre-hired', ...)`) matches. The response shape returned by the server (`{ token, user: { id, email, role, onboarding_status, token_version, has_application } }`) matches what the client's `login(token, user)` call expects (same shape as the existing `/register` endpoint returns).
