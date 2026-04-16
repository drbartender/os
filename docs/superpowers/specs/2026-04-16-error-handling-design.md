# App-Wide Error Handling and Reporting

## Context

The app currently has happy-path error handling but inconsistent and sometimes silent failure modes. Symptoms today:

- **Silent failures** — `admin/ClientDetail.js` logs save errors and shows the user nothing; `admin/ProposalCreate.js` swallows preview-calc failures silently.
- **No global toast/notification system** — every form has its own inline `<div className="alert alert-error">`.
- **Server collapses every error into a single string** — `{ error: "..." }` only; field-level attribution (e.g., `{ email: "Already in use" }`) is impossible.
- **Inconsistent duplicate handling** — `/auth/register` returns a clear 409, but `/client-auth/request` always returns generic success (enumeration safety) with no way to surface real failures.
- **No error logging beyond `console.error`** — production failures are only discovered when a user emails to complain.
- **External service failures can crash a request** — `storage.js` (R2 uploads) has no error wrapping; a Cloudflare hiccup takes down the request.

Goal: every user (client portal, admin, applicant, public visitor) sees clear feedback when something goes wrong, and the developer is alerted to production errors automatically.

---

## Goals

1. No silent failures anywhere in the app — every error reaches the user via the appropriate display surface.
2. Consistent layered display pattern (field-level inline / form-level banner / toast / fallback modal).
3. Standardized server error response envelope so frontend handling is predictable across routes.
4. Production observability via Sentry — unhandled errors auto-reported with request and user context.

## Non-Goals (explicitly deferred)

These are different problems and need their own designs:

- **Server-side validation library** (zod / joi / express-validator) — current ad-hoc inline checks remain. The new error classes give a cleaner way to throw existing validation results.
- **Network resilience** (offline mode, service worker, optimistic UI) — separate roadmap item.
- **Auto-retry with exponential backoff** — manual retry only.
- **Structured logging / request correlation IDs** — Sentry covers errors specifically; full structured logging is for ops observability beyond errors.
- **Internationalization** — English-only error messages.
- **Email/SMS alerts on errors** — Sentry's own alert rules cover this.
- **Test framework** — none exists in the project; verification is manual smoke testing.
- **Rate-limit / brute-force code standardization** — current implementations in `auth.js` and `clientAuth.js` work.

---

## Display Surfaces (Routing Rules)

Four surfaces. Every error and every success notification flows through exactly one.

| Surface | Component | When | Examples |
|---|---|---|---|
| **Field-level inline** | `<FieldError>` | Server attributes failure to a specific field | *"Email already in use"* under email input; *"Phone must be 10 digits"* under phone input |
| **Form-level banner** | `<FormBanner>` | Operation failed but isn't field-specific | *"Failed to save proposal — try again."*; *"You don't have permission to do this."* |
| **Toast** | `useToast()` | System event not tied to a form action | *"Saved!"*, *"Session expired — please log in"*, *"Connection lost"* |
| **Modal / fallback** | `<ErrorBoundary>` | Unhandled React error (page can't render) | *"Something went wrong. Refresh the page."* |

### Banner placement rule

`<FormBanner>` is rendered **immediately above the submit button** — never at the top of the form. When `error` becomes truthy, the banner auto-scrolls into view via `scrollIntoView({ behavior: "smooth", block: "center" })`. This guarantees the user sees feedback near the action they just took, even if the form is long and they've scrolled away from the top.

### Toast rules

- Top-right of viewport, dismissible.
- Auto-fade: 5 seconds for success, 8 seconds for errors.
- Stack max 3 visible; oldest fades early when a fourth arrives.
- **Success toasts fire only on explicit user-initiated submit actions** — clicking a Save/Submit/Send/Confirm button, completing an onboarding step, sending a message. Never on page load, route change, or background data refresh. Keeps the toast layer signal-rich, not noisy.

### Special-case routing

- **401 (session expired)** — toast (*"Your session expired — please log in again"*) → 1.5s delay → redirect to login. Replaces the current silent redirect.
- **Network failure** (no response) — toast (*"Network error — check your connection"*).
- **Stripe Elements card errors** — handled natively by the Stripe Element. Surrounding API failures (load invoice, create payment intent) use FormBanner.
- **Enumeration-sensitive endpoints** (forgot-password, client-login passwordless request) — always return success on the public response; FormBanner surfaces only hard errors (rate limit, server error).

---

## Server-Side Architecture

### Error envelope

Every error response (4xx and 5xx) uses this shape:

```json
{
  "error": "An account with this email already exists",
  "code": "DUPLICATE_EMAIL",
  "fieldErrors": { "email": "An account with this email already exists" }
}
```

| Key | Required? | Purpose |
|---|---|---|
| `error` | Yes | Human-readable message. Backward compatible with all existing `err.response.data.error` consumers. |
| `code` | No | Machine-readable category. Used by frontend for special handling (`SESSION_EXPIRED` → redirect) and by Sentry for tagging. |
| `fieldErrors` | No | Object mapping field name → error message. Drives field-level inline display. |

### Error classes — `server/utils/errors.js` (new)

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
  constructor(fieldErrors, message = "Please fix the errors below") {
    super(message, 400, "VALIDATION_ERROR", fieldErrors);
  }
}

class ConflictError extends AppError {
  constructor(message, code = "CONFLICT") {
    super(message, 409, code);
  }
}

class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

class PermissionError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(message, 403, "PERMISSION_DENIED");
  }
}

class ExternalServiceError extends AppError {
  constructor(service, originalError, message = "Service temporarily unavailable. Please try again.") {
    super(message, 502, "EXTERNAL_SERVICE_ERROR");
    this.service = service;
    this.originalError = originalError;
  }
}

module.exports = { AppError, ValidationError, ConflictError, NotFoundError, PermissionError, ExternalServiceError };
```

### Async handler — `server/middleware/asyncHandler.js` (new)

```js
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
```

Routes wrap async handlers: `router.post("/", asyncHandler(async (req, res) => { ... }))`. Lets `throw new ConflictError(...)` reach the global error middleware instead of becoming an unhandled rejection.

### Global error middleware — added to `server/index.js`

Mounted last in the middleware chain.

```js
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.fieldErrors && { fieldErrors: err.fieldErrors }),
    });
  }

  // Unknown error — report to Sentry, log, return generic 500
  Sentry.captureException(err, {
    user: req.user ? { id: req.user.id, role: req.user.role } : undefined,
    tags: { route: req.originalUrl, method: req.method },
  });
  console.error("Unhandled error:", err);

  res.status(500).json({
    error: "An unexpected error occurred. Please try again.",
    code: "INTERNAL_ERROR",
  });
});
```

### Sentry server SDK

`@sentry/node`. Initialized at the top of `server/index.js` before any other middleware:

```js
if (process.env.SENTRY_DSN_SERVER) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_SERVER,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data) event.request.data = "[redacted]";
      return event;
    },
  });
}
```

- Disabled in dev unless DSN explicitly set.
- Request body redacted by default (PII / passwords / tokens).
- Tagged by route + user role for filtering.

### Backend route migration pattern

Replace inline `res.status(X).json({ error: ... })` with `throw new XxxError(...)`. Examples:

**Before:**
```js
const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
if (existing.rows.length > 0) {
  return res.status(409).json({ error: "An account with this email already exists" });
}
```

**After (conflict, no field attribution):**
```js
if (existing.rows.length > 0) {
  throw new ConflictError("An account with this email already exists", "DUPLICATE_EMAIL");
}
```

**After (field-level — preferred for register form):**
```js
if (existing.rows.length > 0) {
  throw new ValidationError({ email: "An account with this email already exists" });
}
```

**External service wrapping** (Stripe / R2 / Twilio / Resend):
```js
try {
  await s3.send(uploadCommand);
} catch (err) {
  throw new ExternalServiceError("R2", err, "File upload failed. Please try again.");
}
```

---

## Frontend Architecture

### Toast system — `client/src/context/ToastContext.js` + `client/src/components/Toast.js` (new)

`<ToastProvider>` mounted at App root. Exposes `useToast()` hook:

```js
const toast = useToast();
toast.success("Saved!");
toast.error("Failed to save");
toast.info("Reconnected");
```

Toast container renders top-right of viewport. Each toast: dismissible (× button), auto-fades after 5s (success) or 8s (error). Stack max 3 visible; older fades when a fourth arrives.

Accessibility: container is `role="status"` / `aria-live="polite"` so screen readers announce new toasts.

### FormBanner — `client/src/components/FormBanner.js` (new)

```jsx
<FormBanner error={error} fieldErrors={fieldErrors} />
<button type="submit">Save</button>
```

- Placed immediately above submit button.
- Auto-scrolls into view via `useEffect` + `scrollIntoView({ behavior: "smooth", block: "center" })` when `error` first becomes truthy.
- If `fieldErrors` is non-empty, banner shows summary message (*"Please fix the errors below"*) and individual `<FieldError>` components show field-specific text.
- If `error` is set without `fieldErrors`, banner shows the `error` message in a red bar.
- Renders `null` if both are empty.

### FieldError — `client/src/components/FieldError.js` (new)

```jsx
<input name="email" ... />
<FieldError error={fieldErrors?.email} />
```

- Inline red text immediately below the input.
- Renders `null` if error is empty/undefined.
- Accessibility: `aria-live="polite"` so screen readers announce on appearance; the related input gets `aria-invalid="true"` when an error is present (caller wires this).

### ErrorBoundary — `client/src/components/ErrorBoundary.js` (existing, updated)

Wire at App root in `App.js`:

```jsx
<ErrorBoundary>
  <ToastProvider>
    <Routes>...</Routes>
  </ToastProvider>
</ErrorBoundary>
```

Updates:
- Send caught errors to Sentry via `Sentry.captureException(error, { extra: errorInfo })`.
- Friendly fallback UI: *"Something went wrong"* + Refresh button + (in dev only) error stack.

### Axios interceptor — `client/src/utils/api.js` (existing, updated)

Replace the current 401-only interceptor with a normalizing interceptor:

```js
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Network failure (no response received)
    if (!error.response) {
      return Promise.reject({
        message: "Network error — check your connection.",
        code: "NETWORK_ERROR",
        fieldErrors: undefined,
        status: 0,
      });
    }

    const { status } = error.response;
    const data = error.response.data || {};

    // Special handling for session expiration
    if (status === 401) {
      window.dispatchEvent(new CustomEvent("session-expired"));
    }

    return Promise.reject({
      message: data.error || "Something went wrong. Please try again.",
      code: data.code,
      fieldErrors: data.fieldErrors,
      status,
    });
  }
);
```

A small `<SessionExpiryHandler>` component mounted near root listens for the `session-expired` event:
1. Fires `toast.error("Your session expired — please log in again")`.
2. Waits 1.5s.
3. Determines which auth context was active by checking which storage key holds a token (the staff/admin key used by `AuthContext` vs the client key used by `ClientAuthContext`).
4. Clears that context's auth state and redirects to the matching login page (`/login` for staff/admin, `/client/login` for clients).
5. If both or neither token is present at the time of the event (edge case), defaults to `/login`.

If the failed request was made from a page that's already public (no auth required), the event is ignored — no toast, no redirect.

### Sentry browser SDK

`@sentry/react`. Initialized in `client/src/index.js` before `ReactDOM.render`:

```js
if (process.env.REACT_APP_SENTRY_DSN_CLIENT) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN_CLIENT,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}
```

Captures unhandled exceptions + ErrorBoundary catches.

### Frontend migration pattern (per form)

1. Add `useToast()` import.
2. Add `useState` for `error` and `fieldErrors`.
3. Replace existing `<div className="alert alert-error">{error}</div>` with `<FormBanner error={error} fieldErrors={fieldErrors} />` immediately above the submit button.
4. Add `<FieldError error={fieldErrors?.<name>} />` under each input that can produce a field-level error.
5. In submit handler:
   ```js
   try {
     await api.post("/endpoint", payload);
     toast.success("Saved!");
   } catch (err) {
     setError(err.message);
     setFieldErrors(err.fieldErrors);
   }
   ```
6. Replace any silent `console.error` swallows with `toast.error("...")` or `setError("...")` as appropriate.

### Frontend migration pattern (read-only page with load-on-mount)

1. On load failure: `toast.error("Failed to load. Try refreshing.")`.
2. Optional: render an inline error state with a Retry button if reload-by-user is the right pattern (e.g., dashboards).

---

## Sweep Checklist

### Public-facing forms (FormBanner + FieldError + toast)

| Page | Field-level? | Notes |
|---|---|---|
| `Login.js` | No (security) | Banner only; generic *"Invalid email or password"* + rate-limit message |
| `Register.js` | **Yes** — email, password | Duplicate-email scenario: server returns `fieldErrors: { email: "An account with this email already exists" }` |
| `ForgotPassword.js` | No (enumeration safety) | Banner only on hard errors (rate limit, server) |
| `ResetPassword.js` | Yes — password strength, token expired | Token-expired → banner with link to request a new one |
| `Application.js` | **Yes** — required fields, phone, age, etc. | Long form — field-level matters most here |
| `Agreement.js`, `ContractorProfile.js`, `PaydayProtocols.js` | Some (W-9 fields, banking) | Onboarding submit pages |
| `ClientLogin.js` | No (enumeration safety) | Same shape as ForgotPassword |
| `QuoteWizard.js`, `ClassWizard.js`, `PotionPlanningLab.js` | Yes | Multi-step — banner at the bottom of each step, near Next/Submit |
| `ProposalView.js` | No | Banner if accept/sign API fails |
| `InvoicePage.js` | Stripe Elements handles card | Banner for surrounding API failures (load invoice, create payment intent) |

### Public-facing read-only (toast on load failure)

`ClientDashboard.js`, `HomePage.js` (Thumbtack reviews), `Blog.js`, `BlogPost.js`, `ApplicationStatus.js`, `Welcome.js`, `FieldGuide.js`, `Completion.js`

### Admin forms (FormBanner + FieldError + toast)

| Page | Field-level? | Notes |
|---|---|---|
| `admin/SettingsDashboard.js` | Yes | Settings save |
| `admin/ClientDetail.js` | Yes | **Has known silent-save failure** — fixes audit finding |
| `admin/ProposalCreate.js` | Yes | **Has silent preview-calc swallow** — fixes audit finding |
| `admin/ProposalDetail.js` | Yes | Proposal edit + status changes |
| `admin/HiringDashboard.js` | Some | Application review actions |
| `admin/EventsDashboard.js` | Some | Event create/edit |
| `admin/CocktailMenuDashboard.js` | Some | Menu item CRUD (handles both cocktails and mocktails) |
| `admin/EmailLeadsDashboard.js`, `admin/EmailLeadDetail.js` | Yes | Lead import / create / edit |
| `admin/EmailCampaignCreate.js`, `admin/EmailCampaignDetail.js` | Yes | Campaign builder |
| `admin/EmailConversations.js` | Some | Reply send |
| `admin/BlogDashboard.js` | Yes | Post create/edit (TipTap editor) |
| `AdminApplicationDetail.js`, `AdminUserDetail.js` | Some | Profile edit, status changes |
| `admin/DrinkPlanDetail.js` | Some | Drink plan edits, conversion to proposal |

### Admin read-only (toast on load failure)

`AdminDashboard.js`, `admin/Dashboard.js`, `admin/ClientsDashboard.js`, `admin/DrinkPlansDashboard.js`, `admin/EmailMarketingDashboard.js`, `admin/EmailCampaignsDashboard.js`, `admin/EmailAnalyticsDashboard.js`, `admin/FinancialsDashboard.js`, `admin/ProposalsDashboard.js`, `StaffPortal.js`

### Backend routes — convert to error classes + asyncHandler

**Public-facing routes:**
`auth.js`, `clientAuth.js`, `application.js`, `agreement.js`, `contractor.js`, `progress.js`, `clientPortal.js`, `blog.js` (public endpoints), `publicReviews.js`, `drinkPlans.js`, `proposals.js` (public token endpoints), `invoices.js` (public token endpoints), `stripe.js` (non-webhook endpoints)

**Admin routes:**
`admin.js`, `calendar.js`, `clients.js`, `cocktails.js`, `mocktails.js`, `payment.js`, `proposals.js` (admin endpoints), `shifts.js`, `messages.js`, `blog.js` (admin endpoints), `invoices.js` (admin endpoints), `emailMarketing.js`

For each: replace `res.status(X).json({ error: ... })` with `throw new XxxError(...)`. Wrap async handlers in `asyncHandler`.

### Webhook handlers — global handler + Sentry, no UX layer

`emailMarketingWebhook.js`, `thumbtack.js`, `stripe.js` (webhook routes only).

- Wrap with `asyncHandler` so unhandled errors reach the global middleware.
- Errors land in Sentry with full context.
- No FormBanner / toast (no user looking at the response).
- Webhook-specific concerns (idempotency, replay, signature verification) remain unchanged.

---

## Implementation Order

1. **Foundation backend** — `errors.js`, `asyncHandler.js`, global error middleware, Sentry server SDK.
2. **Foundation frontend** — `ToastProvider`, `<FormBanner>`, `<FieldError>`, axios interceptor update, `<SessionExpiryHandler>`, ErrorBoundary wiring at App root, Sentry browser SDK.
3. **Public-facing sweep** — backend routes first, then frontend pages (so the routes return the new envelope before the pages start consuming it).
4. **Admin sweep** — same order: backend routes, then frontend pages.
5. **Webhook coverage** — wrap handlers with `asyncHandler`. Verify by forcing a test error from each webhook and confirming Sentry receives it.
6. **Manual smoke test** — every migrated page, golden path + at least one forced error path.

---

## Verification

No test framework exists. Manual smoke tests per migrated page:

- Trigger the success path → see success toast (where applicable).
- Force an error (disconnect DB, bad payload, malformed input) → see appropriate display surface.
- For field-level: submit a form with one bad field → see field-level error appear; correct it → error disappears on next submit.
- Disconnect network in browser dev tools → submit form → see network-error toast.
- Trigger a 500 → confirm Sentry receives event with route, user, and error context.
- Trigger a 401 (expire token in dev tools) → see toast → redirect to login after 1.5s.
- Trigger an unhandled React error in dev → see ErrorBoundary fallback → confirm Sentry capture.

---

## Environment Variables (added)

| Variable | Purpose | Required? |
|---|---|---|
| `SENTRY_DSN_SERVER` | Server-side Sentry DSN | Optional in dev; required in prod |
| `REACT_APP_SENTRY_DSN_CLIENT` | Client-side Sentry DSN | Optional in dev; required in prod |

Both default to disabled when unset, so dev and CI continue to work without Sentry credentials.

---

## Documentation Updates Required

When implemented, update per CLAUDE.md "Mandatory Documentation Updates":

- **CLAUDE.md** Folder Structure — add `server/utils/errors.js`, `server/middleware/asyncHandler.js`, `client/src/components/FormBanner.js`, `client/src/components/FieldError.js`, `client/src/components/Toast.js`, `client/src/context/ToastContext.js`.
- **CLAUDE.md** Environment Variables — add `SENTRY_DSN_SERVER`, `REACT_APP_SENTRY_DSN_CLIENT`.
- **CLAUDE.md** Tech Stack — add `@sentry/node`, `@sentry/react`.
- **README.md** — same updates as CLAUDE.md.
- **ARCHITECTURE.md** — add an Error Handling section covering the four display surfaces, the server envelope shape, and the Sentry integration.
