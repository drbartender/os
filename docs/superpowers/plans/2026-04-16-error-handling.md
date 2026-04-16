# Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll out a layered error-handling system app-wide — field-level inline + form banner above submit + global toast + ErrorBoundary fallback — backed by standardized server error envelope and Sentry observability.

**Architecture:** Backend introduces `AppError` subclasses + `asyncHandler` wrapper + global Express error middleware so routes can `throw new ConflictError(...)` instead of writing try/catch + status JSON every time. Frontend gains a Toast provider, `<FormBanner>`, `<FieldError>`, an updated axios interceptor that normalizes errors, and a `<SessionExpiryHandler>` for 401s. Both sides report unhandled errors to Sentry. Then sweep every public-facing and admin route + page to use the new pattern, plus wrap webhook handlers so unhandled errors land in Sentry.

**Tech Stack:** Node.js 18 / Express 4, React 18 (CRA), `@sentry/node`, `@sentry/react`, vanilla CSS.

**Verification model:** Codebase has no automated test suite. Verification per task is manual: `npm run dev`, browser smoke test of golden path + at least one forced-error path. Force errors via DevTools network throttling, expired tokens, malformed payloads, or temporary throws inside handlers.

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `server/utils/errors.js` | Custom `AppError` subclasses (`ValidationError`, `ConflictError`, `NotFoundError`, `PermissionError`, `ExternalServiceError`) |
| `server/middleware/asyncHandler.js` | 3-line wrapper that funnels async-handler rejections into the global error middleware |
| `client/src/context/ToastContext.js` | `<ToastProvider>` + `useToast()` hook with `success`/`error`/`info` methods |
| `client/src/components/Toast.js` | Toast container + individual toast rendering |
| `client/src/components/FormBanner.js` | Error/summary banner placed above submit button; auto-scrolls into view |
| `client/src/components/FieldError.js` | Inline red text under an input |
| `client/src/components/SessionExpiryHandler.js` | Listens for `session-expired` event, shows toast, clears auth, redirects |

### Modified Files (foundation)

| File | What Changes |
|---|---|
| `server/index.js` | Sentry init at top; global error middleware mounted last |
| `client/src/index.js` | Sentry init |
| `client/src/App.js` | Mount `<ErrorBoundary>`, `<ToastProvider>`, `<SessionExpiryHandler>` at root |
| `client/src/utils/api.js` | Replace minimal interceptor with normalizing interceptor; dispatch `session-expired` event on 401 |
| `client/src/components/ErrorBoundary.js` | Send caught errors to Sentry; cleaner fallback UI |
| `client/src/index.css` | Styles for `.toast-*`, `.form-banner`, `.field-error` |
| `package.json` | Add `@sentry/node` |
| `client/package.json` | Add `@sentry/react` |
| `.env.example` | Add `SENTRY_DSN_SERVER`, `REACT_APP_SENTRY_DSN_CLIENT` |

### Modified Files (sweep — see Phases 3-5 for full list)

~26 backend route files + ~55 frontend page files + 3 webhook routes.

### Documentation (Phase 6)

`CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.

---

## Reusable Migration Patterns

Three patterns defined once. Phases 3-5 reference these by name to keep the per-feature tasks compact.

### Pattern A: Backend route migration

For every route handler in scope:

1. Wrap async handlers in `asyncHandler` so thrown errors reach the global middleware.
2. Replace `if (...) return res.status(X).json({ error: '...' })` with `throw new XxxError(...)` using the appropriate subclass.
3. Replace `try { ... } catch (err) { console.error(err); res.status(500).json(...) }` with `try { ... } catch (err) { throw err; }` — or just remove the try/catch entirely since `asyncHandler` + global middleware handle it. Keep try/catch only when you need to wrap a non-AppError into an `ExternalServiceError` or do cleanup (e.g., `ROLLBACK`).
4. For validation failures attributable to specific fields, prefer `ValidationError({ fieldName: "message" })` over a generic 400 string so the frontend can render field-level errors.
5. Never delete the explicit error message — keep the human-readable text in the `XxxError` constructor.

**Subclass cheat sheet:**

| Status | Class | When | Example |
|---|---|---|---|
| 400 | `ValidationError(fieldErrors, message?)` | Field-attributable input failure | `throw new ValidationError({ email: 'Invalid format' })` |
| 401 | (handled by `auth` middleware — leave alone) | Missing/expired token | — |
| 403 | `PermissionError(message?)` | Authenticated but not allowed | `throw new PermissionError('Only admins can do this')` |
| 404 | `NotFoundError(message?)` | Resource doesn't exist | `throw new NotFoundError('Proposal not found')` |
| 409 | `ConflictError(message, code?)` | State conflict (duplicate, locked, already-paid) | `throw new ConflictError('Email already in use', 'DUPLICATE_EMAIL')` |
| 502 | `ExternalServiceError(service, originalErr, message?)` | Stripe/R2/Twilio/Resend/Nominatim failure | `throw new ExternalServiceError('R2', err, 'File upload failed')` |

**Before/after example** (from `server/routes/auth.js`):

```js
// BEFORE
router.post('/register', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    // ... insert ...
    res.json({ user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// AFTER
router.post('/register', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ValidationError({ email: 'Email is required' });
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rows.length > 0) {
    throw new ValidationError({ email: 'An account with this email already exists' });
  }
  // ... insert ...
  res.json({ user });
}));
```

### Pattern B: Frontend form migration

For every page that submits a form:

1. Add `import { useToast } from '../context/ToastContext';` and `import FormBanner from '../components/FormBanner';` (and `FieldError` if any field-level errors apply).
2. Add `const toast = useToast();` inside the component.
3. Add (or reuse) state: `const [error, setError] = useState('');` and `const [fieldErrors, setFieldErrors] = useState({});`.
4. In submit handler: clear both at the start; on success → `toast.success('Saved!')` (or other action-specific message); on error → `setError(err.message); setFieldErrors(err.fieldErrors || {});`.
5. Replace existing `<div className="alert alert-error">{error}</div>` with `<FormBanner error={error} fieldErrors={fieldErrors} />`, placed **immediately above the submit button** (not at the top of the form).
6. Add `<FieldError error={fieldErrors?.<inputName>} />` directly below each input where field-level errors are expected. Add `aria-invalid={!!fieldErrors?.<inputName>}` to the input itself.
7. Replace any silent `.catch(err => console.error(err))` patterns with `toast.error('...')` or `setError(err.message)` as appropriate.
8. **Do NOT remove `useFormValidation`** if the page already uses it. Client-side required-field checks complement server-side errors — keep them. The hook returns a `valid`/`message` shape; on submit, either short-circuit with the local message in the banner OR let the server validate and surface field-level errors. Either order works; pick what the page already does.

**Before/after example** (from `client/src/pages/Register.js`):

```jsx
// BEFORE — banner at top, no field-level
const [error, setError] = useState('');
const handleSubmit = async (e) => {
  e.preventDefault();
  try {
    const res = await api.post('/auth/register', form);
    login(res.data.token, res.data.user);
  } catch (err) {
    setError(err.response?.data?.error || 'Registration failed.');
  }
};
return (
  <form onSubmit={handleSubmit}>
    {error && <div className="alert alert-error">{error}</div>}
    <input name="email" value={form.email} onChange={...} />
    <input name="password" type="password" value={form.password} onChange={...} />
    <button type="submit">Register</button>
  </form>
);

// AFTER — field-level + banner above submit + toast on success
const [error, setError] = useState('');
const [fieldErrors, setFieldErrors] = useState({});
const toast = useToast();
const handleSubmit = async (e) => {
  e.preventDefault();
  setError('');
  setFieldErrors({});
  try {
    const res = await api.post('/auth/register', form);
    login(res.data.token, res.data.user);
    toast.success('Account created!');
  } catch (err) {
    setError(err.message);
    setFieldErrors(err.fieldErrors || {});
  }
};
return (
  <form onSubmit={handleSubmit}>
    <input
      name="email"
      value={form.email}
      onChange={...}
      aria-invalid={!!fieldErrors.email}
    />
    <FieldError error={fieldErrors.email} />
    <input
      name="password"
      type="password"
      value={form.password}
      onChange={...}
      aria-invalid={!!fieldErrors.password}
    />
    <FieldError error={fieldErrors.password} />
    <FormBanner error={error} fieldErrors={fieldErrors} />
    <button type="submit">Register</button>
  </form>
);
```

### Pattern C: Read-only page migration

For every page that loads data on mount and has no submit form:

1. Import `useToast`.
2. In the load `useEffect`, replace silent `.catch(err => console.error(err))` with `toast.error('Failed to load — try refreshing.')`. Keep the `setError` state if the page already renders an inline error block — both are fine.
3. If the page has a Retry button, no further changes needed; otherwise consider adding one (out of scope unless trivial).

---

## Phase 1 — Backend Foundation

### Task 1: Install `@sentry/node` and add env vars

**Files:**
- Modify: `package.json` (root)
- Modify: `.env.example`

- [ ] **Step 1: Install Sentry**

```bash
npm install @sentry/node
```

- [ ] **Step 2: Add to `.env.example`** (append at the end)

```
# Sentry — leave unset in dev to disable error reporting
SENTRY_DSN_SERVER=
REACT_APP_SENTRY_DSN_CLIENT=
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add @sentry/node and env var stubs"
```

---

### Task 2: Create `server/utils/errors.js`

**Files:**
- Create: `server/utils/errors.js`

- [ ] **Step 1: Write the file**

```js
class AppError extends Error {
  constructor(message, statusCode, code, fieldErrors) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

class ValidationError extends AppError {
  constructor(fieldErrors, message = 'Please fix the errors below') {
    super(message, 400, 'VALIDATION_ERROR', fieldErrors);
  }
}

class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, 409, code);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class PermissionError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(message, 403, 'PERMISSION_DENIED');
  }
}

class ExternalServiceError extends AppError {
  constructor(service, originalError, message = 'Service temporarily unavailable. Please try again.') {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR');
    this.service = service;
    this.originalError = originalError;
  }
}

module.exports = {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ExternalServiceError,
};
```

- [ ] **Step 2: Commit**

```bash
git add server/utils/errors.js
git commit -m "feat(server): add AppError class hierarchy"
```

---

### Task 3: Create `server/middleware/asyncHandler.js`

**Files:**
- Create: `server/middleware/asyncHandler.js`

- [ ] **Step 1: Write the file**

```js
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
```

- [ ] **Step 2: Commit**

```bash
git add server/middleware/asyncHandler.js
git commit -m "feat(server): add asyncHandler middleware"
```

---

### Task 4: Initialize Sentry in `server/index.js`

**Files:**
- Modify: `server/index.js` (top of file, after `require('dotenv').config()`)

- [ ] **Step 1: Add Sentry require + init at the top of the file**

Insert immediately after `require('dotenv').config();` on line 1:

```js
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN_SERVER) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_SERVER,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data) event.request.data = '[redacted]';
      return event;
    },
  });
  console.log('Sentry server SDK initialized');
}
```

- [ ] **Step 2: Manual verify**

Start the server with `npm run dev`. Confirm no startup errors. Without `SENTRY_DSN_SERVER` set, you should see no "Sentry server SDK initialized" log. Set `SENTRY_DSN_SERVER=test` temporarily; restart; confirm the log appears (Sentry won't actually send anything to a fake DSN, but init should not crash).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat(server): initialize Sentry SDK"
```

---

### Task 5: Add global error middleware to `server/index.js`

**Files:**
- Modify: `server/index.js` (just before the `app.listen(...)` call at the bottom)

- [ ] **Step 1: Add the requires near the top of `server/index.js`** (with other requires)

```js
const { AppError } = require('./utils/errors');
```

- [ ] **Step 2: Add the global error middleware as the LAST middleware before `app.listen(...)`**

Find the line that calls `app.listen(...)`. Insert immediately above it:

```js
// Global error handler — must be the last middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    const body = { error: err.message, code: err.code };
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    return res.status(err.statusCode).json(body);
  }

  // Unknown error — Sentry + log + generic 500
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(err, {
      user: req.user ? { id: req.user.id, role: req.user.role } : undefined,
      tags: { route: req.originalUrl, method: req.method },
    });
  }
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'An unexpected error occurred. Please try again.',
    code: 'INTERNAL_ERROR',
  });
});
```

- [ ] **Step 3: Manual verify with a temporary smoke route**

Add a temporary route just above the error middleware:

```js
const { ConflictError, asyncHandler: testAH } = (() => {
  const ah = require('./middleware/asyncHandler');
  const errs = require('./utils/errors');
  return { ConflictError: errs.ConflictError, asyncHandler: ah };
})();
app.get('/api/_test_error', testAH(async () => {
  throw new ConflictError('Test conflict', 'TEST_CODE');
}));
app.get('/api/_test_unhandled', testAH(async () => {
  throw new Error('Unhandled test error');
}));
```

Restart the server. `curl http://localhost:5000/api/_test_error` should return:
```json
{"error":"Test conflict","code":"TEST_CODE"}
```
with status 409.

`curl http://localhost:5000/api/_test_unhandled` should return:
```json
{"error":"An unexpected error occurred. Please try again.","code":"INTERNAL_ERROR"}
```
with status 500. The server console should log `Unhandled error: Error: Unhandled test error`.

- [ ] **Step 4: Remove the temporary smoke routes**

Delete the two `app.get('/api/_test_*', ...)` lines and the IIFE around them. Restart, confirm `/api/_test_error` now 404s.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat(server): mount global error middleware"
```

---

## Phase 2 — Frontend Foundation

### Task 6: Install `@sentry/react`

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Install**

```bash
cd client && npm install @sentry/react && cd ..
```

- [ ] **Step 2: Commit**

```bash
git add client/package.json client/package-lock.json
git commit -m "chore: add @sentry/react"
```

---

### Task 7: Create `client/src/context/ToastContext.js` and `client/src/components/Toast.js`

**Files:**
- Create: `client/src/context/ToastContext.js`
- Create: `client/src/components/Toast.js`
- Modify: `client/src/index.css` (append toast styles)

- [ ] **Step 1: Create `client/src/context/ToastContext.js`**

```jsx
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import ToastContainer from '../components/Toast';

const ToastContext = createContext(null);

const MAX_VISIBLE = 3;
const SUCCESS_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 8000;
const INFO_TIMEOUT_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idCounter = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((type, message, timeoutMs) => {
    const id = ++idCounter.current;
    setToasts((prev) => {
      const next = [...prev, { id, type, message }];
      // If over max, drop the oldest
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
    setTimeout(() => dismiss(id), timeoutMs);
  }, [dismiss]);

  const value = {
    success: useCallback((m) => push('success', m, SUCCESS_TIMEOUT_MS), [push]),
    error: useCallback((m) => push('error', m, ERROR_TIMEOUT_MS), [push]),
    info: useCallback((m) => push('info', m, INFO_TIMEOUT_MS), [push]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
};
```

- [ ] **Step 2: Create `client/src/components/Toast.js`**

```jsx
import React from 'react';

export default function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Append toast styles to `client/src/index.css`**

Append at the end of the file:

```css
/* ─── Toast notifications ──────────────────────────────────── */
.toast-container {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: min(360px, calc(100vw - 2rem));
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 0.9rem;
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  font-size: 0.9rem;
  animation: toast-in 180ms ease-out;
}
.toast-success { background: #F0FFF0; border: 1px solid #A8D4A8; color: var(--success); }
.toast-error   { background: #FFF0F0; border: 1px solid #E8AAAA; color: var(--error); }
.toast-info    { background: #FFF8F0; border: 1px solid var(--border); color: var(--warm-brown); }
.toast-message { flex: 1; line-height: 1.35; }
.toast-dismiss {
  background: none;
  border: none;
  font-size: 1.1rem;
  cursor: pointer;
  color: inherit;
  line-height: 1;
  padding: 0 0.25rem;
  opacity: 0.7;
}
.toast-dismiss:hover { opacity: 1; }
@keyframes toast-in {
  from { transform: translateX(20px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/context/ToastContext.js client/src/components/Toast.js client/src/index.css
git commit -m "feat(client): add Toast provider and component"
```

---

### Task 8: Create `client/src/components/FormBanner.js`

**Files:**
- Create: `client/src/components/FormBanner.js`
- Modify: `client/src/index.css` (append form-banner styles)

- [ ] **Step 1: Create the component**

```jsx
import React, { useEffect, useRef } from 'react';

export default function FormBanner({ error, fieldErrors }) {
  const ref = useRef(null);
  const hasFieldErrors = fieldErrors && Object.keys(fieldErrors).length > 0;
  const hasError = Boolean(error);
  const visible = hasError || hasFieldErrors;

  useEffect(() => {
    if (visible && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [visible, error]);

  if (!visible) return null;

  const message = hasFieldErrors && !hasError
    ? 'Please fix the errors below.'
    : error;

  return (
    <div ref={ref} className="form-banner form-banner-error" role="alert">
      {message}
    </div>
  );
}
```

- [ ] **Step 2: Append styles to `client/src/index.css`**

```css
/* ─── Form banner (above submit button) ─────────────────────── */
.form-banner {
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  font-size: 0.9rem;
  margin: 0.75rem 0;
}
.form-banner-error { background: #FFF0F0; border: 1px solid #E8AAAA; color: var(--error); }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/FormBanner.js client/src/index.css
git commit -m "feat(client): add FormBanner component"
```

---

### Task 9: Create `client/src/components/FieldError.js`

**Files:**
- Create: `client/src/components/FieldError.js`
- Modify: `client/src/index.css`

- [ ] **Step 1: Create the component**

```jsx
import React from 'react';

export default function FieldError({ error }) {
  if (!error) return null;
  return (
    <div className="field-error" role="alert" aria-live="polite">
      {error}
    </div>
  );
}
```

- [ ] **Step 2: Append styles to `client/src/index.css`**

```css
/* ─── Inline field error ────────────────────────────────────── */
.field-error {
  color: var(--error);
  font-size: 0.8rem;
  margin: 0.25rem 0 0.5rem;
  line-height: 1.3;
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/FieldError.js client/src/index.css
git commit -m "feat(client): add FieldError component"
```

---

### Task 10: Update `client/src/utils/api.js` interceptor

**Files:**
- Modify: `client/src/utils/api.js`

- [ ] **Step 1: Replace the response interceptor**

Replace the existing `api.interceptors.response.use(...)` block (lines 20-34) with:

```js
api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Network failure — no response received
    if (!err.response) {
      return Promise.reject({
        message: 'Network error — check your connection.',
        code: 'NETWORK_ERROR',
        fieldErrors: undefined,
        status: 0,
      });
    }

    const { status, config } = err.response;
    const data = err.response.data || {};
    const url = config?.url || '';

    // Session expired (any 401 outside the auth/login endpoints)
    if (status === 401 && !url.startsWith('/auth/') && !url.startsWith('/client-auth/')) {
      // Tag the URL so SessionExpiryHandler picks the right login redirect
      window.dispatchEvent(new CustomEvent('session-expired', { detail: { url } }));
    }

    return Promise.reject({
      message: data.error || 'Something went wrong. Please try again.',
      code: data.code,
      fieldErrors: data.fieldErrors,
      status,
    });
  }
);
```

Also delete the `let onUnauthorized = null;` and `api.setOnUnauthorized = ...` lines (lines 11-12) — `SessionExpiryHandler` replaces this mechanism.

- [ ] **Step 2: Find any existing callers of `api.setOnUnauthorized(...)`**

Run: `grep -r "setOnUnauthorized" client/src/`. For each caller (likely in `App.js` or a context provider), remove the call. The `session-expired` event handles the redirect now.

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/api.js client/src/App.js
git commit -m "feat(client): normalize axios errors and emit session-expired event"
```

(Add any additional files touched in step 2.)

---

### Task 11: Create `client/src/components/SessionExpiryHandler.js`

**Files:**
- Create: `client/src/components/SessionExpiryHandler.js`

- [ ] **Step 1: Create the component**

```jsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { useClientAuth } from '../context/ClientAuthContext';

export default function SessionExpiryHandler() {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { clientLogout } = useClientAuth();

  useEffect(() => {
    const onExpired = (e) => {
      const url = e.detail?.url || '';
      const isClientRequest = url.startsWith('/client-portal/') || url.startsWith('/client-auth/');
      const target = isClientRequest ? '/client/login' : '/login';

      toast.error('Your session expired — please log in again.');

      setTimeout(() => {
        if (isClientRequest) clientLogout();
        else logout();
        navigate(target, { replace: true });
      }, 1500);
    };

    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, [toast, navigate, logout, clientLogout]);

  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/SessionExpiryHandler.js
git commit -m "feat(client): add SessionExpiryHandler"
```

---

### Task 12: Update `client/src/components/ErrorBoundary.js`

**Files:**
- Modify: `client/src/components/ErrorBoundary.js`

- [ ] **Step 1: Read the current file** with `Read` first to preserve any existing fallback styling.

- [ ] **Step 2: Replace the file with the updated version**

```jsx
import React from 'react';
import * as Sentry from '@sentry/react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
      Sentry.captureException(error, { extra: errorInfo });
    }
  }

  handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred. Please refresh the page to try again.</p>
          <button type="button" onClick={this.handleRefresh}>Refresh page</button>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <pre className="error-boundary-stack">
              {this.state.error.toString()}
              {'\n'}
              {this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
```

- [ ] **Step 3: Append fallback styles to `client/src/index.css`**

```css
/* ─── ErrorBoundary fallback ───────────────────────────────── */
.error-boundary-fallback {
  max-width: 520px;
  margin: 4rem auto;
  padding: 2rem;
  text-align: center;
}
.error-boundary-fallback button {
  margin-top: 1rem;
  padding: 0.6rem 1.4rem;
  background: var(--primary);
  color: white;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
}
.error-boundary-stack {
  margin-top: 1.5rem;
  text-align: left;
  background: #FAFAFA;
  border: 1px solid var(--border);
  padding: 1rem;
  border-radius: var(--radius);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-x: auto;
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ErrorBoundary.js client/src/index.css
git commit -m "feat(client): wire ErrorBoundary to Sentry"
```

---

### Task 13: Initialize Sentry in `client/src/index.js` and mount providers in `client/src/App.js`

**Files:**
- Modify: `client/src/index.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: In `client/src/index.js`, add Sentry init at the top**

After the existing imports, before `ReactDOM.render(...)` or `createRoot(...)`:

```js
import * as Sentry from '@sentry/react';

if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN_CLIENT,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}
```

- [ ] **Step 2: In `client/src/App.js`, mount the providers**

Find the root render structure. Wrap the app in `<ErrorBoundary>`, `<ToastProvider>`, and add `<SessionExpiryHandler />` once inside the providers. Order matters: `ErrorBoundary` outermost, then `ToastProvider`, then auth providers, then router.

Add imports near the top:

```js
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './context/ToastContext';
import SessionExpiryHandler from './components/SessionExpiryHandler';
```

Update the render to look approximately like (preserve existing context order — only add the new wrappers):

```jsx
return (
  <ErrorBoundary>
    <ToastProvider>
      <AuthProvider>
        <ClientAuthProvider>
          <BrowserRouter>
            <SessionExpiryHandler />
            {/* existing <Routes>...</Routes> */}
          </BrowserRouter>
        </ClientAuthProvider>
      </AuthProvider>
    </ToastProvider>
  </ErrorBoundary>
);
```

`SessionExpiryHandler` MUST be rendered inside both auth providers AND the router (it uses `useNavigate`, `useAuth`, `useClientAuth`, and `useToast`).

- [ ] **Step 3: Manual verify foundation**

Start the dev server (`npm run dev`).

1. **Toast test:** in browser DevTools console, run:
   ```js
   // Trigger a toast manually by navigating to a page that uses one — easier:
   // open any page, then in console, dispatch a session-expired event
   window.dispatchEvent(new CustomEvent('session-expired', { detail: { url: '/foo' }}));
   ```
   You should see a red toast "Your session expired — please log in again." appear top-right and fade after ~5s. After 1.5s the page should redirect to `/login`.

2. **ErrorBoundary test:** edit any page component temporarily to `throw new Error('boom')` in render. Reload — you should see the fallback UI with the stack trace (in dev only). Revert the change.

3. **Network error test:** in DevTools Network tab, set offline. Try to navigate to a page that fetches data. The interceptor should reject with `code: 'NETWORK_ERROR'` and `message: 'Network error — check your connection.'` Check the console — no crash.

- [ ] **Step 4: Commit**

```bash
git add client/src/index.js client/src/App.js
git commit -m "feat(client): mount ErrorBoundary, ToastProvider, SessionExpiryHandler"
```

---

## Phase 3 — Public-Facing Sweep

Each task in this phase migrates a feature area: backend route(s) per **Pattern A**, frontend pages per **Pattern B** (or **C** for read-only). Apply the patterns exactly; per-task notes call out anything specific.

### Task 14: Auth (auth.js + Login + Register + ForgotPassword + ResetPassword)

**Files:**
- Modify: `server/routes/auth.js`
- Modify: `client/src/pages/Login.js`
- Modify: `client/src/pages/Register.js`
- Modify: `client/src/pages/ForgotPassword.js`
- Modify: `client/src/pages/ResetPassword.js`

- [ ] **Step 1: Migrate `server/routes/auth.js`** per Pattern A.

Specific replacements:
- `POST /register` — duplicate email → `throw new ValidationError({ email: 'An account with this email already exists' })`. Missing email/password → `throw new ValidationError({ email: 'Email is required' })` etc. Bad email format → field-level. Weak password → field-level.
- `POST /login` — invalid credentials → `throw new ConflictError('Invalid email or password', 'INVALID_CREDENTIALS')` (no field-level — security). Lockout → `throw new ConflictError('Too many attempts. Please try again later.', 'RATE_LIMITED')`.
- `POST /forgot-password` — keep generic success response (enumeration safety). Server errors still throw normally.
- `POST /reset-password` — bad/expired token → `throw new ValidationError({ token: 'This reset link is invalid or has expired' })`. Weak password → `throw new ValidationError({ password: '...' })`.
- `GET /me`, `POST /refresh` — wrap with `asyncHandler`; no inline errors expected to change.

Add at the top of the file:

```js
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, ConflictError } = require('../utils/errors');
```

Wrap every async route handler with `asyncHandler(async (req, res) => { ... })`.

- [ ] **Step 2: Migrate `client/src/pages/Login.js`** per Pattern B.

Field-level: NO (security — generic message). Banner only.

- [ ] **Step 3: Migrate `client/src/pages/Register.js`** per Pattern B.

Field-level: YES on `email`, `password`, `name` (whatever fields the form has). On success → `toast.success('Account created!')`.

- [ ] **Step 4: Migrate `client/src/pages/ForgotPassword.js`** per Pattern B.

Field-level: NO (enumeration safety — backend always returns success). Banner only on hard errors (rate limit, server error).

- [ ] **Step 5: Migrate `client/src/pages/ResetPassword.js`** per Pattern B.

Field-level: YES on `password`. Token-expired error: show banner with a link to `/forgot-password`.

- [ ] **Step 6: Manual verify**

1. Register with an email that's already in use → see *"An account with this email already exists"* under the email input AND the form banner above the submit button.
2. Register leaving email blank → see field-level *"Email is required"*.
3. Login with wrong password → see banner *"Invalid email or password"*.
4. Forgot-password with a non-existent email → no error shown (silent success per security).
5. Reset-password with an expired token → banner with link.
6. Confirm the FormBanner auto-scrolls into view — make the form long enough that the submit button is below the fold (or temporarily set `min-height: 1500px` on the form), submit with an error, confirm the banner scrolls into view.

- [ ] **Step 7: Commit**

```bash
git add server/routes/auth.js client/src/pages/Login.js client/src/pages/Register.js client/src/pages/ForgotPassword.js client/src/pages/ResetPassword.js
git commit -m "feat(auth): migrate auth routes and pages to layered error system"
```

---

### Task 15: Onboarding (application + agreement + contractor + progress)

**Files:**
- Modify: `server/routes/application.js`
- Modify: `server/routes/agreement.js`
- Modify: `server/routes/contractor.js`
- Modify: `server/routes/progress.js`
- Modify: `client/src/pages/Application.js`
- Modify: `client/src/pages/ApplicationStatus.js`
- Modify: `client/src/pages/Agreement.js`
- Modify: `client/src/pages/ContractorProfile.js`
- Modify: `client/src/pages/PaydayProtocols.js`
- Modify: `client/src/pages/Welcome.js`
- Modify: `client/src/pages/FieldGuide.js`
- Modify: `client/src/pages/Completion.js`

- [ ] **Step 1: Migrate the 4 backend route files** per Pattern A.

Per-route notes:
- `application.js POST /submit` — required-field failures → `ValidationError({ ... })` with all missing fields at once. Duplicate application from same email → `ConflictError('You already submitted an application', 'DUPLICATE_APPLICATION')`.
- `agreement.js POST /sign` — missing signature → `ValidationError({ signature: 'Please sign the agreement before submitting' })`. Already signed → `ConflictError('Agreement already signed', 'ALREADY_SIGNED')`.
- `contractor.js POST /save` (or equivalent) — required W-9 fields → `ValidationError({ ssn: '...', address: '...' })`.
- `progress.js` — wrap and throw, no inline message changes likely.

Anywhere a route uses a transaction with `client.query('BEGIN')`, keep the surrounding try/catch + ROLLBACK + `client.release()` — but inside the catch, re-throw the error so the global middleware handles the response: `} catch (err) { try { await client.query('ROLLBACK'); } catch (e) {} throw err; } finally { client.release(); }`.

- [ ] **Step 2: Migrate the 5 form pages** (`Application.js`, `Agreement.js`, `ContractorProfile.js`, `PaydayProtocols.js`) per Pattern B.

Application is the most complex form — apply field-level errors thoroughly. On success → `toast.success('Application submitted!')` (or appropriate message per form).

- [ ] **Step 3: Migrate the 3 read-only pages** (`ApplicationStatus.js`, `Welcome.js`, `FieldGuide.js`, `Completion.js`) per Pattern C.

- [ ] **Step 4: Manual verify**

1. Submit an application with required fields blank → see field-level errors on each missing input.
2. Submit a duplicate application → see banner *"You already submitted an application"*.
3. Sign agreement without signature → see field-level error.
4. Save W-9 with bad SSN format → field-level.
5. Onboarding `*Status` page with a 500 from server → toast appears.

- [ ] **Step 5: Commit**

```bash
git add server/routes/application.js server/routes/agreement.js server/routes/contractor.js server/routes/progress.js client/src/pages/Application.js client/src/pages/ApplicationStatus.js client/src/pages/Agreement.js client/src/pages/ContractorProfile.js client/src/pages/PaydayProtocols.js client/src/pages/Welcome.js client/src/pages/FieldGuide.js client/src/pages/Completion.js
git commit -m "feat(onboarding): migrate onboarding routes and pages to layered error system"
```

---

### Task 16: Client portal (clientAuth + clientPortal)

**Files:**
- Modify: `server/routes/clientAuth.js`
- Modify: `server/routes/clientPortal.js`
- Modify: `client/src/pages/public/ClientLogin.js`
- Modify: `client/src/pages/public/ClientDashboard.js`

- [ ] **Step 1: Migrate `server/routes/clientAuth.js`** per Pattern A.

Per-route notes:
- `POST /request` (passwordless link) — keep generic success response (enumeration safety). Rate-limit/server errors throw normally.
- `POST /verify` — bad/expired magic link → `ValidationError({ token: 'This sign-in link is invalid or has expired' })`.
- `GET /me` — wrap, no inline changes.

- [ ] **Step 2: Migrate `server/routes/clientPortal.js`** per Pattern A.

All endpoints get `asyncHandler` and throw `NotFoundError`/`PermissionError`/etc. as appropriate.

- [ ] **Step 3: Migrate `client/src/pages/public/ClientLogin.js`** per Pattern B.

Field-level: NO (enumeration safety). Banner only on hard errors. On success → `toast.success('Check your email for a sign-in link.')`.

- [ ] **Step 4: Migrate `client/src/pages/public/ClientDashboard.js`** per Pattern C.

Replace the `console.error('Failed to load client proposals:', err); setError('Could not load your proposals. Please try again.')` block with `toast.error(err.message)` plus keep the inline error UI if one exists.

- [ ] **Step 5: Manual verify**

1. Request a magic link with a non-existent email → see success message (silent for enumeration).
2. Click an expired magic link → see banner with the error.
3. ClientDashboard with backend down → toast appears.
4. Trigger a 401 from the dashboard (manually delete `db_client_token` from localStorage and click anything that fetches) → toast → 1.5s → redirect to `/client/login`.

- [ ] **Step 6: Commit**

```bash
git add server/routes/clientAuth.js server/routes/clientPortal.js client/src/pages/public/ClientLogin.js client/src/pages/public/ClientDashboard.js
git commit -m "feat(client-portal): migrate client portal routes and pages"
```

---

### Task 17: Public website (publicReviews + blog public + drinkPlans)

**Files:**
- Modify: `server/routes/publicReviews.js`
- Modify: `server/routes/blog.js` (public endpoints only — list, single post by slug)
- Modify: `server/routes/drinkPlans.js`
- Modify: `client/src/pages/website/HomePage.js`
- Modify: `client/src/pages/website/QuoteWizard.js`
- Modify: `client/src/pages/website/QuotePage.js`
- Modify: `client/src/pages/website/ClassWizard.js`
- Modify: `client/src/pages/website/FaqPage.js`
- Modify: `client/src/pages/public/Blog.js`
- Modify: `client/src/pages/public/BlogPost.js`
- Modify: `client/src/pages/plan/PotionPlanningLab.js`

- [ ] **Step 1: Migrate the 3 backend route files** per Pattern A.

Per-route notes:
- `publicReviews.js` — Thumbtack fetch failures → `ExternalServiceError('Thumbtack', err, 'Reviews temporarily unavailable')` so the homepage falls back gracefully.
- `blog.js` (public endpoints only) — `NotFoundError('Post not found')` for unknown slugs.
- `drinkPlans.js` — bad/expired token → `NotFoundError('This drink plan link is no longer valid')`. Field-level errors for the form submission step.

- [ ] **Step 2: Migrate `HomePage.js`, `Blog.js`, `BlogPost.js`, `FaqPage.js`** per Pattern C (read-only).

For `HomePage.js`, the reviews-fetch failure should fail silently (just don't render the carousel) since it's a non-critical decoration. No toast.

- [ ] **Step 3: Migrate `QuoteWizard.js`, `QuotePage.js`, `ClassWizard.js`** per Pattern B.

Multi-step forms: place a `<FormBanner>` near the bottom of EACH step's content (right above the Next/Submit button). Field-level errors per step.

- [ ] **Step 4: Migrate `PotionPlanningLab.js`** per Pattern B.

Multi-step. The lab has many step components in `client/src/pages/plan/steps/`. The `<FormBanner>` should be in the parent `PotionPlanningLab.js` near the navigation buttons. Field-level errors (`<FieldError>`) live inside each step component for inputs that need them. Pass `fieldErrors` and a setter down to each step as props if not already.

- [ ] **Step 5: Manual verify**

1. Start a quote, leave a required field blank, click Next → field-level error appears, banner appears above the Next button.
2. PotionPlanningLab — same test on a few steps.
3. Disconnect network mid-quote → toast.
4. Visit an invalid drink plan token → see banner *"This drink plan link is no longer valid"*.

- [ ] **Step 6: Commit**

```bash
git add server/routes/publicReviews.js server/routes/blog.js server/routes/drinkPlans.js client/src/pages/website/HomePage.js client/src/pages/website/QuoteWizard.js client/src/pages/website/QuotePage.js client/src/pages/website/ClassWizard.js client/src/pages/website/FaqPage.js client/src/pages/public/Blog.js client/src/pages/public/BlogPost.js client/src/pages/plan/PotionPlanningLab.js
git commit -m "feat(public): migrate public website and quote flows"
```

---

### Task 18: Public token-gated (proposals public + invoices public + stripe non-webhook)

**Files:**
- Modify: `server/routes/proposals.js` (public token endpoints only — typically `GET /public/:token`, `POST /public/:token/accept`, etc.)
- Modify: `server/routes/invoices.js` (public token endpoints only)
- Modify: `server/routes/stripe.js` (non-webhook endpoints — `POST /create-intent-for-deposit`, `POST /create-intent-for-invoice/:token`, etc.)
- Modify: `client/src/pages/proposal/ProposalView.js`
- Modify: `client/src/pages/invoice/InvoicePage.js`

- [ ] **Step 1: Migrate the public endpoints in `server/routes/proposals.js`** per Pattern A.

Per-route notes:
- Bad/expired token → `NotFoundError('This proposal is no longer available')`.
- Already-accepted → `ConflictError('This proposal has already been accepted', 'ALREADY_ACCEPTED')`.
- Missing signature on accept → `ValidationError({ signature: 'Please sign before accepting' })`.

Leave admin endpoints in this file untouched — those go in Phase 4.

- [ ] **Step 2: Migrate the public endpoints in `server/routes/invoices.js`** per Pattern A.

Per-route notes:
- Bad/expired token → `NotFoundError('This invoice is no longer available')`.
- Already paid → `ConflictError('This invoice has already been paid in full', 'ALREADY_PAID')`.

Leave admin endpoints for Phase 4.

- [ ] **Step 3: Migrate the non-webhook Stripe endpoints in `server/routes/stripe.js`** per Pattern A.

Per-route notes:
- Stripe API failures → wrap in `ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.')`. Card declines come back as Stripe errors with codes — pass the user-facing message through if Stripe provided one (e.g., `err.message` for `StripeCardError`), otherwise generic.
- Invoice token validation errors → `NotFoundError('Invoice not found')`.

DO NOT touch the webhook handler in this file — it's Phase 5.

- [ ] **Step 4: Migrate `client/src/pages/proposal/ProposalView.js`** per Pattern B.

Banner above the Accept/Sign button. No field-level errors (signature pad doesn't have field validation in our scheme).

- [ ] **Step 5: Migrate `client/src/pages/invoice/InvoicePage.js`** per Pattern B.

Banner above the Pay button. Stripe Elements handle card validation natively — DO NOT replace those. The FormBanner shows surrounding API failures (load invoice, create payment intent).

- [ ] **Step 6: Manual verify**

1. Open a valid proposal token → loads. Open an invalid one → see *"This proposal is no longer available"*.
2. Try to accept a proposal that's already accepted → banner *"This proposal has already been accepted"*.
3. On the invoice page, use Stripe test card `4000 0000 0000 0002` (decline) → Stripe Element shows the decline message; surrounding flow handles cleanly.
4. On the invoice page, simulate a 502 from the create-intent endpoint (kill DB temporarily, refresh, try to pay) → banner *"Payment temporarily unavailable. Please try again."*.

- [ ] **Step 7: Commit**

```bash
git add server/routes/proposals.js server/routes/invoices.js server/routes/stripe.js client/src/pages/proposal/ProposalView.js client/src/pages/invoice/InvoicePage.js
git commit -m "feat(public-token): migrate public proposal/invoice/stripe flows"
```

---

## Phase 4 — Admin Sweep

Same patterns. Each task = one feature area. Most admin pages can use field-level errors more aggressively than public-facing because admins know what they're doing — but apply the same Pattern B everywhere.

### Task 19: Admin auth/admin route + Settings + AdminDashboard

**Files:**
- Modify: `server/routes/admin.js`
- Modify: `client/src/pages/admin/SettingsDashboard.js`
- Modify: `client/src/pages/AdminDashboard.js`
- Modify: `client/src/pages/admin/Dashboard.js`
- Modify: `client/src/pages/StaffPortal.js`

- [ ] **Step 1: Migrate `server/routes/admin.js`** per Pattern A.

- [ ] **Step 2: Migrate `SettingsDashboard.js`** per Pattern B (form). On save success → `toast.success('Settings saved!')`.

- [ ] **Step 3: Migrate `AdminDashboard.js`, `admin/Dashboard.js`, `StaffPortal.js`** per Pattern C (read-only).

- [ ] **Step 4: Manual verify** — save a setting; force a 500; confirm toast/banner. Load the dashboard with backend down; confirm toast.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.js client/src/pages/admin/SettingsDashboard.js client/src/pages/AdminDashboard.js client/src/pages/admin/Dashboard.js client/src/pages/StaffPortal.js
git commit -m "feat(admin): migrate admin core (settings, dashboards)"
```

---

### Task 20: Clients (clients.js + ClientsDashboard + ClientDetail) — fixes silent-save bug

**Files:**
- Modify: `server/routes/clients.js`
- Modify: `client/src/pages/admin/ClientsDashboard.js`
- Modify: `client/src/pages/admin/ClientDetail.js`

- [ ] **Step 1: Migrate `server/routes/clients.js`** per Pattern A.

Per-route notes:
- Required-field failures → `ValidationError({ name: 'Name is required', ... })`.
- Source enum invalid → `ValidationError({ source: 'Invalid source value' })`.
- Not found → `NotFoundError('Client not found')`.

- [ ] **Step 2: Migrate `ClientsDashboard.js`** per Pattern C (read-only).

- [ ] **Step 3: Migrate `ClientDetail.js`** per Pattern B (form). **This fixes the known silent-save bug.** The current code (around line 38-40 of `admin/ClientDetail.js`) catches save errors and only logs them — replace with proper banner + toast. On success → `toast.success('Client saved!')`.

- [ ] **Step 4: Manual verify**

1. Edit a client and save with a blank name → field-level *"Name is required"* + banner.
2. Edit a client and save successfully → `toast.success('Client saved!')` and no banner.
3. Force a 500 (kill DB during save) → banner with the error message.

- [ ] **Step 5: Commit**

```bash
git add server/routes/clients.js client/src/pages/admin/ClientsDashboard.js client/src/pages/admin/ClientDetail.js
git commit -m "feat(admin): migrate clients routes and pages; fix silent save failure"
```

---

### Task 21: Proposals admin (proposals.js admin endpoints + ProposalsDashboard + ProposalCreate + ProposalDetail) — fixes silent preview-calc bug

**Files:**
- Modify: `server/routes/proposals.js` (admin endpoints — leave public endpoints from Task 18 unchanged)
- Modify: `client/src/pages/admin/ProposalsDashboard.js`
- Modify: `client/src/pages/admin/ProposalCreate.js`
- Modify: `client/src/pages/admin/ProposalDetail.js`

- [ ] **Step 1: Migrate the admin endpoints in `proposals.js`** per Pattern A.

Per-route notes:
- POST/PATCH validation → `ValidationError({ ... })`.
- Not found → `NotFoundError('Proposal not found')`.
- Permission (non-owner) → `PermissionError(...)`.
- Pricing-engine errors → `ValidationError({ ... })` if attributable, else let propagate.
- Already-locked invoice/proposal conflicts → `ConflictError(...)`.

- [ ] **Step 2: Migrate `ProposalsDashboard.js`** per Pattern C.

- [ ] **Step 3: Migrate `ProposalCreate.js`** per Pattern B.

**This fixes the known silent preview-calc bug.** The current code does `.catch(() => setPreview(null))` for pricing preview — keep clearing the preview but ALSO `toast.error('Could not calculate preview pricing.')` so the admin knows something failed.

Field-level errors on required fields (event date, package, etc.). On save success → `toast.success('Proposal created!')`.

- [ ] **Step 4: Migrate `ProposalDetail.js`** per Pattern B.

Field-level on edit. On save success → `toast.success('Proposal updated!')`. On status change (sent/accepted) → action-specific toast (`toast.success('Proposal sent to client.')`).

- [ ] **Step 5: Manual verify**

1. Create a proposal with no event date → field-level + banner.
2. Save with invalid pricing inputs that crash the preview → toast error appears (no longer silent).
3. Update a locked invoice → banner *"This invoice is locked"* (or whatever the specific message is).
4. Successful save → green toast.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals.js client/src/pages/admin/ProposalsDashboard.js client/src/pages/admin/ProposalCreate.js client/src/pages/admin/ProposalDetail.js
git commit -m "feat(admin): migrate proposals admin; fix silent preview-calc failure"
```

---

### Task 22: Events + calendar + shifts (calendar.js + shifts.js + EventsDashboard)

**Files:**
- Modify: `server/routes/calendar.js`
- Modify: `server/routes/shifts.js`
- Modify: `client/src/pages/admin/EventsDashboard.js`

- [ ] **Step 1: Migrate `calendar.js` and `shifts.js`** per Pattern A.

- [ ] **Step 2: Migrate `EventsDashboard.js`** per Pattern B for any forms (event create/edit) and Pattern C for the read-only list.

- [ ] **Step 3: Manual verify** — create an event with missing fields; force a backend error.

- [ ] **Step 4: Commit**

```bash
git add server/routes/calendar.js server/routes/shifts.js client/src/pages/admin/EventsDashboard.js
git commit -m "feat(admin): migrate events, calendar, shifts"
```

---

### Task 23: Hiring (HiringDashboard + AdminApplicationDetail + AdminUserDetail)

**Files:**
- Modify: `client/src/pages/admin/HiringDashboard.js`
- Modify: `client/src/pages/AdminApplicationDetail.js`
- Modify: `client/src/pages/AdminUserDetail.js`
- Modify: `server/routes/admin.js` (hiring-specific endpoints, if any were missed in Task 19)

- [ ] **Step 1: Confirm backend coverage**

`grep -n "approve\\|reject\\|hire" server/routes/admin.js` to find hiring action endpoints. Confirm they were migrated in Task 19. If any were missed, migrate them now per Pattern A (e.g., `POST /admin/applications/:id/approve` → `throw new NotFoundError('Application not found')` if missing, `ConflictError('Application already approved', 'ALREADY_APPROVED')` for state conflicts).

- [ ] **Step 2: Migrate the three frontend pages** per Pattern B (forms) / Pattern C (lists).

Action toasts:
- Approve application → `toast.success('Application approved.')`
- Reject application → `toast.success('Application rejected.')`
- User profile save → `toast.success('User updated.')`

- [ ] **Step 3: Manual verify** — approve an application, confirm toast; reject with a server error forced, confirm banner; edit a user with invalid input, confirm field-level + banner.

- [ ] **Step 4: Commit**

```bash
git add server/routes/admin.js client/src/pages/admin/HiringDashboard.js client/src/pages/AdminApplicationDetail.js client/src/pages/AdminUserDetail.js
git commit -m "feat(admin): migrate hiring pages"
```

---

### Task 24: Drink plans admin (drinkPlans admin endpoints + DrinkPlansDashboard + DrinkPlanDetail)

**Files:**
- Modify: `server/routes/drinkPlans.js` (admin endpoints — leave public endpoints from Task 17 unchanged)
- Modify: `client/src/pages/admin/DrinkPlansDashboard.js`
- Modify: `client/src/pages/admin/DrinkPlanDetail.js`

- [ ] **Step 1: Migrate admin endpoints in `drinkPlans.js`** per Pattern A.

- [ ] **Step 2: Migrate `DrinkPlansDashboard.js`** per Pattern C.

- [ ] **Step 3: Migrate `DrinkPlanDetail.js`** per Pattern B (it has edit + convert-to-proposal forms). On convert success → `toast.success('Drink plan converted to proposal.')`.

- [ ] **Step 4: Manual verify**

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js client/src/pages/admin/DrinkPlansDashboard.js client/src/pages/admin/DrinkPlanDetail.js
git commit -m "feat(admin): migrate drink plans admin"
```

---

### Task 25: Cocktails + mocktails menu (cocktails.js + mocktails.js + CocktailMenuDashboard)

**Files:**
- Modify: `server/routes/cocktails.js`
- Modify: `server/routes/mocktails.js`
- Modify: `client/src/pages/admin/CocktailMenuDashboard.js`

- [ ] **Step 1: Migrate `cocktails.js` and `mocktails.js`** per Pattern A.

- [ ] **Step 2: Migrate `CocktailMenuDashboard.js`** per Pattern B.

- [ ] **Step 3: Manual verify** — create a cocktail with missing required fields; field-level + banner.

- [ ] **Step 4: Commit**

```bash
git add server/routes/cocktails.js server/routes/mocktails.js client/src/pages/admin/CocktailMenuDashboard.js
git commit -m "feat(admin): migrate cocktail/mocktail menu admin"
```

---

### Task 26: Financials (payment.js + invoices.js admin + FinancialsDashboard)

**Files:**
- Modify: `server/routes/payment.js`
- Modify: `server/routes/invoices.js` (admin endpoints — leave public from Task 18 unchanged)
- Modify: `client/src/pages/admin/FinancialsDashboard.js`

- [ ] **Step 1: Migrate `payment.js`** per Pattern A. Manual payment record creation: missing fields → field-level. Already-recorded → `ConflictError(...)`.

- [ ] **Step 2: Migrate admin endpoints in `invoices.js`** per Pattern A. Locked-invoice updates → `ConflictError('This invoice is locked and cannot be edited', 'INVOICE_LOCKED')`.

- [ ] **Step 3: Migrate `FinancialsDashboard.js`** per Pattern B/C as needed.

- [ ] **Step 4: Manual verify** — record a payment with missing amount; try to edit a locked invoice.

- [ ] **Step 5: Commit**

```bash
git add server/routes/payment.js server/routes/invoices.js client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(admin): migrate financials/payment/invoices admin"
```

---

### Task 27: Email marketing (emailMarketing.js + 8 frontend pages)

**Files:**
- Modify: `server/routes/emailMarketing.js`
- Modify: `client/src/pages/admin/EmailMarketingDashboard.js`
- Modify: `client/src/pages/admin/EmailLeadsDashboard.js`
- Modify: `client/src/pages/admin/EmailLeadDetail.js`
- Modify: `client/src/pages/admin/EmailCampaignsDashboard.js`
- Modify: `client/src/pages/admin/EmailCampaignCreate.js`
- Modify: `client/src/pages/admin/EmailCampaignDetail.js`
- Modify: `client/src/pages/admin/EmailAnalyticsDashboard.js`
- Modify: `client/src/pages/admin/EmailConversations.js`

- [ ] **Step 1: Migrate `emailMarketing.js`** per Pattern A.

Per-route notes:
- CSV import validation → `ValidationError({ csv: 'Row 4: missing email address' })` if row-specific; `ValidationError({ csv: 'CSV must include an email column' })` for header issues.
- Resend API failures → `ExternalServiceError('Resend', err, 'Email sending temporarily unavailable')`.
- Lead duplicates → `ConflictError('Lead with this email already exists', 'DUPLICATE_LEAD')` or merge silently per existing logic — match existing behavior.

- [ ] **Step 2: Migrate the 8 frontend pages.** Forms = Pattern B; lists/analytics = Pattern C.

Action toasts:
- Send campaign → `toast.success('Campaign queued for sending.')`
- Save draft → `toast.success('Draft saved.')`
- Add lead → `toast.success('Lead added.')`
- Delete lead → `toast.success('Lead deleted.')`
- Reply in conversation → `toast.success('Reply sent.')`

- [ ] **Step 3: Manual verify** — try to import a malformed CSV; create a campaign with no recipients; force a Resend 5xx.

- [ ] **Step 4: Commit**

```bash
git add server/routes/emailMarketing.js client/src/pages/admin/EmailMarketingDashboard.js client/src/pages/admin/EmailLeadsDashboard.js client/src/pages/admin/EmailLeadDetail.js client/src/pages/admin/EmailCampaignsDashboard.js client/src/pages/admin/EmailCampaignCreate.js client/src/pages/admin/EmailCampaignDetail.js client/src/pages/admin/EmailAnalyticsDashboard.js client/src/pages/admin/EmailConversations.js
git commit -m "feat(admin): migrate email marketing routes and pages"
```

---

### Task 28: Blog admin (blog.js admin endpoints + BlogDashboard)

**Files:**
- Modify: `server/routes/blog.js` (admin endpoints — leave public from Task 17 unchanged)
- Modify: `client/src/pages/admin/BlogDashboard.js`

- [ ] **Step 1: Migrate admin endpoints in `blog.js`** per Pattern A.

- [ ] **Step 2: Migrate `BlogDashboard.js`** per Pattern B. The TipTap editor handles its own internal state — wrap the surrounding form (title, slug, publish toggle, etc.) with FormBanner + FieldError. On post save → `toast.success('Post saved.')`.

- [ ] **Step 3: Manual verify** — create a post with duplicate slug → field-level *"Slug already in use"*.

- [ ] **Step 4: Commit**

```bash
git add server/routes/blog.js client/src/pages/admin/BlogDashboard.js
git commit -m "feat(admin): migrate blog admin"
```

---

### Task 29: Messages (messages.js)

**Files:**
- Modify: `server/routes/messages.js`

(No dedicated frontend page — messages are sent from various admin contexts; if any page calls these endpoints, they should already have toast/banner from earlier tasks.)

- [ ] **Step 1: Migrate `messages.js`** per Pattern A.

Per-route notes:
- Twilio failures → `ExternalServiceError('Twilio', err, 'SMS could not be sent. Please try again.')`.
- Recipient missing phone → `ValidationError({ phone: 'No phone number on file for this user' })`.

- [ ] **Step 2: Find any callers in admin pages** — `grep -r "/api/messages" client/src/`. For each caller, ensure on-success → `toast.success('Message sent.')`, on-error → toast/banner per Pattern B.

- [ ] **Step 3: Manual verify** — send an SMS with bad recipient; force a Twilio failure (set test creds to bogus value temporarily).

- [ ] **Step 4: Commit**

```bash
git add server/routes/messages.js
git commit -m "feat(admin): migrate messages route"
```

(Add any frontend callers updated in step 2.)

---

## Phase 5 — Webhook Coverage

### Task 30: Wrap webhook handlers

**Files:**
- Modify: `server/routes/emailMarketingWebhook.js`
- Modify: `server/routes/thumbtack.js`
- Modify: `server/routes/stripe.js` (webhook handler only — non-webhook endpoints already done in Task 18)

- [ ] **Step 1: Wrap each webhook handler with `asyncHandler`**

For each file:

```js
const asyncHandler = require('../middleware/asyncHandler');
```

Wrap the route handler: `router.post('/webhook', asyncHandler(async (req, res) => { ... }))`.

Webhook handlers should still respond with the format the third-party service expects (Stripe expects `200` or `400` with no body for signature failures, etc.). Keep that behavior — for known signature/auth failures, throw `new ConflictError('Invalid signature', 'WEBHOOK_INVALID_SIGNATURE')` or use `res.status(400).end()` if the third party expects a bare 400. For UNHANDLED errors during event processing, the global middleware now catches them and reports to Sentry.

- [ ] **Step 2: Force a Sentry event from each webhook**

For each webhook, temporarily add `throw new Error('Sentry test from <webhook-name>');` inside the handler after the signature-verification step. POST a valid (signed) request. Confirm:
1. The server returns 500.
2. Sentry receives the event with route + method tagged (you'll need a real `SENTRY_DSN_SERVER` set for this — use a test DSN or skip if Sentry isn't configured locally yet).

Remove the test throws after verifying.

- [ ] **Step 3: Commit**

```bash
git add server/routes/emailMarketingWebhook.js server/routes/thumbtack.js server/routes/stripe.js
git commit -m "feat(webhooks): wrap webhook handlers with asyncHandler for Sentry coverage"
```

---

## Phase 6 — Documentation

### Task 31: Update CLAUDE.md, README.md, ARCHITECTURE.md

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md` (or `docs/ARCHITECTURE.md` — check both)

- [ ] **Step 1: Update `.claude/CLAUDE.md`**

In the **Folder Structure** tree, add:
- `server/utils/errors.js` — Custom error classes
- `server/middleware/asyncHandler.js` — Async route wrapper
- `client/src/components/Toast.js` — Toast container
- `client/src/components/FormBanner.js` — Form-level error banner
- `client/src/components/FieldError.js` — Inline field error
- `client/src/components/SessionExpiryHandler.js` — 401 → toast → redirect
- `client/src/context/ToastContext.js` — Toast provider + `useToast()`

In the **Tech Stack** list, append:
- `@sentry/node` (server error reporting)
- `@sentry/react` (client error reporting)

In the **Environment Variables** table, append:
- `SENTRY_DSN_SERVER` — Server-side Sentry DSN (optional in dev)
- `REACT_APP_SENTRY_DSN_CLIENT` — Client-side Sentry DSN (optional in dev)

- [ ] **Step 2: Update `README.md`** with the same changes.

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Find or create the appropriate section. Add a new section titled **Error Handling**:

```markdown
## Error Handling

The app uses a layered error display system:

| Surface | Component | Used for |
|---|---|---|
| Field-level inline | `<FieldError>` | Server-attributed validation failure on a specific field |
| Form-level banner | `<FormBanner>` | Operation failure not tied to one field; placed above submit button, auto-scrolls into view |
| Toast | `useToast()` | System events not tied to a form: success confirmations, session expiry, network drops |
| Modal fallback | `<ErrorBoundary>` | Unhandled React errors |

### Server error envelope

All error responses use:

\`\`\`json
{
  "error": "Human-readable message",
  "code": "OPTIONAL_MACHINE_CODE",
  "fieldErrors": { "fieldName": "field-specific message" }
}
\`\`\`

Custom error classes in `server/utils/errors.js` (`ValidationError`, `ConflictError`, `NotFoundError`, `PermissionError`, `ExternalServiceError`) map to status codes. Routes throw via `asyncHandler`-wrapped handlers; the global error middleware in `server/index.js` formats the response and reports unknown errors to Sentry.

### Observability

- Server: `@sentry/node` initialized in `server/index.js`. PII-scrubbed by default.
- Client: `@sentry/react` initialized in `client/src/index.js`. ErrorBoundary captures React errors.
- Both are gated on env vars (`SENTRY_DSN_SERVER`, `REACT_APP_SENTRY_DSN_CLIENT`) — disabled in dev unless explicitly set.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs: update for error handling system"
```

---

## Final Verification (before push)

- [ ] **Run pre-push procedure per CLAUDE.md** — launch all 5 review agents in parallel: `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`. Address any flagged issues.
- [ ] **End-to-end smoke test:**
  1. Register a new account with a duplicate email — see field-level error.
  2. Login with bad credentials — see banner.
  3. Submit application with missing fields — field-level + banner.
  4. ClientDashboard with backend stopped — toast.
  5. Create a proposal with bad pricing input — toast/banner (no longer silent).
  6. Edit a client and save — toast confirmation.
  7. Disconnect network and try to submit any form — network-error toast.
  8. Expire token in DevTools, navigate to a protected page — toast → redirect.
  9. Trigger ErrorBoundary by editing a component to throw — see fallback.
  10. With `SENTRY_DSN_SERVER` set, force a 500 — confirm Sentry receives the event.
- [ ] **Verify Sentry env vars** are set in Render and Vercel production environments before merging.
- [ ] **Push** when clean.
