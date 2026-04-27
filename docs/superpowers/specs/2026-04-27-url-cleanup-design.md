# URL Cleanup — Drop Redundant `/admin` and `/portal` Prefixes; Close Client-Domain Leak

**Date**: 2026-04-27
**Status**: Design approved, pending implementation plan

## Problem

Three related URL ergonomics problems on the same single-SPA-with-hostname-routing setup:

1. **Redundant admin prefix.** `admin.drbartender.com/admin/dashboard` — the `admin` subdomain is already implicit; the path prefix repeats it. Same shape across every admin page.
2. **Redundant staff prefix.** `staff.drbartender.com/portal/dashboard` — `portal` is implicit on the staff subdomain.
3. **Client-domain leak.** Client-facing routes (token URLs for proposals/invoices/drink plans/shopping lists, plus `/client-login`, `/my-proposals`, and the public-site preview routes) are defensively defined on the admin context too. A copy-paste from an admin's browser, or a stale link, can show clients the `admin.drbartender.com` host.

## Goal

- Admin shell mounts at `/` on `admin.drbartender.com`. No `/admin` prefix anywhere.
- Staff portal mounts at `/` on `staff.drbartender.com`. No `/portal` prefix anywhere.
- Client-facing routes on `admin.drbartender.com` 301 to `drbartender.com`. Admin domain is admin-only.
- Old URLs (`/admin/foo`, `/portal/foo`, client-routes-on-admin) keep working forever via HTTP 301 — bookmarks, in-flight emails, search-engine indices all continue to resolve.

## Non-goals

- No change to public site (`drbartender.com`) routes.
- No change to hiring site (`hiring.drbartender.com`) routes.
- No change to server API namespaces (e.g., `/api/admin/*` server route mount stays).
- No change to auth/onboarding/applicant fallback routes that exist on the admin context for misrouted bookmarks (`/login`, `/forgot-password`, `/welcome`, `/field-guide`, `/agreement`, `/contractor-profile`, `/payday-protocols`, `/complete`, `/apply`, `/application-status`).
- No CORS, env-var, or schema changes.
- No new Vercel projects, aliases, or deployment topology changes.

## Architecture

The single React SPA on Vercel continues to serve all four subdomains via hostname-routed contexts in `client/src/App.js`. The `getSiteContext()` host-detection function (App.js:131) is unchanged. Only the route definitions inside the 'app' (admin) and 'staff' contexts change.

Redirects are expressed in `client/vercel.json` as `redirects` entries, each scoped to its target subdomain via `has: [{ type: "host", value: "..." }]`. All `permanent: true` (HTTP 301).

### Hosting layout

```
admin.drbartender.com   → admin shell mounted at "/"      (was: /admin/*)
staff.drbartender.com   → staff shell mounted at "/"      (was: /portal/*)
hiring.drbartender.com  → unchanged
drbartender.com         → unchanged
```

## Route mapping

### Admin shell — `admin.drbartender.com`

```
/admin                              →  /
/admin/dashboard                    →  /dashboard
/admin/staffing                     →  /staffing
/admin/staffing/legacy              →  /staffing/legacy
/admin/staffing/users/:id           →  /staffing/users/:id
/admin/staffing/applications/:id    →  /staffing/applications/:id
/admin/hiring                       →  /hiring
/admin/drink-plans                  →  /drink-plans
/admin/drink-plans/:id              →  /drink-plans/:id
/admin/cocktail-menu                →  /cocktail-menu  (still inner-redirects to /settings)
/admin/drink-menu                   →  /drink-menu     (still inner-redirects to /settings)
/admin/proposals                    →  /proposals
/admin/proposals/new                →  /proposals/new
/admin/proposals/:id                →  /proposals/:id
/admin/events                       →  /events
/admin/events/:id                   →  /events/:id
/admin/events/shift/:id             →  /events/shift/:id   (existing legacy ShiftDetailRedirect — kept, repointed at new internal path)
/admin/clients                      →  /clients
/admin/clients/:id                  →  /clients/:id
/admin/financials                   →  /financials
/admin/settings                     →  /settings
/admin/blog                         →  /blog
/admin/email-marketing              →  /email-marketing
/admin/email-marketing/leads        →  /email-marketing/leads
/admin/email-marketing/leads/:id    →  /email-marketing/leads/:id
/admin/email-marketing/campaigns    →  /email-marketing/campaigns
/admin/email-marketing/campaigns/new →  /email-marketing/campaigns/new
/admin/email-marketing/campaigns/:id →  /email-marketing/campaigns/:id
/admin/email-marketing/analytics    →  /email-marketing/analytics
/admin/email-marketing/conversations →  /email-marketing/conversations
```

### Staff portal — `staff.drbartender.com`

```
/portal           →  /
/portal/dashboard →  /dashboard
/portal/shifts    →  /shifts
/portal/schedule  →  /schedule
/portal/events    →  /events
/portal/resources →  /resources
/portal/profile   →  /profile
```

Onboarding routes (`/welcome`, `/field-guide`, `/agreement`, `/contractor-profile`, `/payday-protocols`, `/complete`) and auth routes (`/login`, `/forgot-password`, `/reset-password/:token`) are already top-level — no change. No clashes with the new staff portal paths.

### Cross-domain (admin → public, client-leak closure)

```
admin.drb.com/proposal/:token        →  drbartender.com/proposal/:token
admin.drb.com/invoice/:token         →  drbartender.com/invoice/:token
admin.drb.com/plan/:token            →  drbartender.com/plan/:token
admin.drb.com/shopping-list/:token   →  drbartender.com/shopping-list/:token
admin.drb.com/client-login           →  drbartender.com/login            (path change — ClientLogin lives at /login on public)
admin.drb.com/my-proposals           →  drbartender.com/my-proposals
admin.drb.com/website                →  drbartender.com                  (path change — /website doesn't exist on public)
admin.drb.com/quote                  →  drbartender.com/quote
admin.drb.com/faq                    →  drbartender.com/faq
admin.drb.com/classes                →  drbartender.com/classes
admin.drb.com/labnotes               →  drbartender.com/labnotes
admin.drb.com/labnotes/:slug         →  drbartender.com/labnotes/:slug
```

### Cross-domain (admin → staff, legacy `/portal` fallback closure)

```
admin.drb.com/portal           →  staff.drbartender.com
admin.drb.com/portal/:path*    →  staff.drbartender.com/:path*
```

The admin context's existing `/portal/*` fallback routes (App.js:356-364) are removed. Misrouted staff bookmarks now bounce cross-domain to `staff.drbartender.com` instead of rendering an ugly fallback URL on admin.

## Vercel redirect config

`client/vercel.json` adds 18 `redirects` entries (kept the existing `rewrites` block):

```json
{
  "redirects": [
    { "source": "/admin",            "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "/",          "permanent": true },
    { "source": "/admin/:path*",     "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "/:path*",    "permanent": true },

    { "source": "/portal",           "has": [{ "type": "host", "value": "staff.drbartender.com" }], "destination": "/",          "permanent": true },
    { "source": "/portal/:path*",    "has": [{ "type": "host", "value": "staff.drbartender.com" }], "destination": "/:path*",    "permanent": true },

    { "source": "/proposal/:token",      "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/proposal/:token",      "permanent": true },
    { "source": "/invoice/:token",       "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/invoice/:token",       "permanent": true },
    { "source": "/plan/:token",          "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/plan/:token",          "permanent": true },
    { "source": "/shopping-list/:token", "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/shopping-list/:token", "permanent": true },

    { "source": "/client-login",     "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/login",            "permanent": true },
    { "source": "/my-proposals",     "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/my-proposals",     "permanent": true },

    { "source": "/website",          "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com",                   "permanent": true },
    { "source": "/quote",            "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/quote",             "permanent": true },
    { "source": "/faq",              "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/faq",               "permanent": true },
    { "source": "/classes",          "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/classes",           "permanent": true },
    { "source": "/labnotes",         "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/labnotes",          "permanent": true },
    { "source": "/labnotes/:slug",   "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://drbartender.com/labnotes/:slug",    "permanent": true },

    { "source": "/portal",           "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://staff.drbartender.com",          "permanent": true },
    { "source": "/portal/:path*",    "has": [{ "type": "host", "value": "admin.drbartender.com" }], "destination": "https://staff.drbartender.com/:path*",   "permanent": true }
  ],
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

**Ordering note:** Vercel runs `redirects` before `rewrites`, so prefix-strip redirects fire first and the rewrite to `/index.html` only fires for unredirected paths. A really stale URL like `admin.drb.com/admin/proposal/abc` (token route on admin) hops twice: prefix-strip → cross-domain redirect → public SPA. Two 301s, then served. Acceptable for legacy URLs.

## Internal link updates (client side)

### A. Route source-of-truth files

- **`client/src/App.js`** — restructure both 'app' and 'staff' contexts. Admin shell mounts at `/` (was `/admin`); staff portal mounts at `/` (was `/portal`). All nested route paths drop their parent prefix. The `ShiftDetailRedirect` component (App.js:104) hardcodes `/admin/events/...` redirect targets — update to `/events/...`. Remove the `/portal/*` fallback block from the 'app' context (App.js:356-364).
- **`client/src/components/adminos/nav.js`** — every `path:` value loses the `/admin` prefix (`/admin/dashboard` → `/dashboard`, etc.).
- **`client/src/components/adminos/CommandPalette.js`** — hardcoded admin-page jump targets. Update.
- **`getHomePath` in `client/src/App.js:141`** — admin/manager users currently redirect to `/admin`; portal-status users to `/portal`. Both become `/dashboard` after cleanup. Used by `ProtectedRoute`, `RedirectIfLoggedIn`, `RequireHired`, `RequirePortal`.

### B. Mechanical sweep — frontend `Link` / `Navigate` / `useNavigate` (~27 files)

30 files contain `/admin/` references; 3 are source-of-truth files handled in (A); the remaining 27 get the mechanical sweep. Plus 3 staff-side files for the `/portal/` sweep (`StaffLayout.js`, `StaffDashboard.js`, `Completion.js`).

Sweep these patterns and strip the `/admin` or `/portal` prefix:

```
to="/admin/...           →  to="/...
to='/admin/...           →  to='/...
to={`/admin/...          →  to={`/...
navigate('/admin/...     →  navigate('/...
navigate(`/admin/...     →  navigate(`/...
<Navigate to="/admin/... →  <Navigate to="/...
```

Same six patterns for `/portal/...` on staff-side files (`StaffLayout.js`, `StaffDashboard.js`, `Completion.js`).

Done as pattern-based Edits (not blind global replace) — verifying each match in context to avoid touching API paths or comments.

### C. Excluded — server route namespace, NOT frontend routes

`api.get('/admin/badge-counts')`, `api.post('/admin/users/...')`, etc. — these hit the server's `/api/admin/...` namespace via the axios baseURL. **These do not change.** The collision in naming is unfortunate but the two `/admin` prefixes are independent: one is a frontend route prefix (going away), the other is a backend API namespace (staying). The sweep matches `to=`/`navigate(`/`<Navigate to=` patterns specifically, not `api.get('/admin/...')`.

### D. Special cases

- **`AdminDashboard.js:565`** — hardcoded SMS template `https://admin.drbartender.com/portal` → `https://staff.drbartender.com/dashboard`.
- **Admin-context `/portal/*` fallback** — removed (replaced by Vercel cross-domain redirect above).
- **Admin-context onboarding fallback** (`/welcome`, `/field-guide`, etc.) — kept as-is. Onboarding may legitimately land on whichever subdomain a hire was given a link to.

## Server-side updates

### A. Email URL builders — drop `/admin/` from path (8 sites)

`ADMIN_URL` is just an origin (no path) — paths are appended manually:

```
server/routes/proposals.js:193    ${ADMIN_URL}/admin/proposals/${pd.id}        →  ${ADMIN_URL}/proposals/${pd.id}
server/routes/proposals.js:558    ${ADMIN_URL}/admin/proposals/${proposal.id} →  ${ADMIN_URL}/proposals/${proposal.id}
server/routes/proposals.js:1433   ${ADMIN_URL}/admin/proposals/${proposal.id} →  ${ADMIN_URL}/proposals/${proposal.id}
server/routes/stripe.js:655       ${ADMIN_URL}/admin/proposals/${proposalId}  →  ${ADMIN_URL}/proposals/${proposalId}
server/routes/stripe.js:931       ${ADMIN_URL}/admin/proposals/${proposalId}  →  ${ADMIN_URL}/proposals/${proposalId}
server/routes/drinkPlans.js:442   ${ADMIN_URL}/admin/proposals/${pn.id}       →  ${ADMIN_URL}/proposals/${pn.id}
server/routes/thumbtack.js:291    ${ADMIN_URL}/admin/clients/${clientId}      →  ${ADMIN_URL}/clients/${clientId}
server/routes/thumbtack.js:372    ${ADMIN_URL}/admin/clients/${clientId}      →  ${ADMIN_URL}/clients/${clientId}
```

### B. Fix the stale shifts link

`server/routes/shifts.js:291` currently builds `${ADMIN_URL}/admin/shifts` — but no such route exists in `App.js` (this is a pre-existing bug masked by the redirect-to-login behavior). Change to `${ADMIN_URL}/staffing` (the staff/shifts management dashboard). Affects the "new shift request" admin notification email.

### C. Staff-portal link in agreement email

`server/routes/agreement.js:212` currently builds `${ADMIN_URL}/portal` for the "your contract is signed" email. Two changes:

1. Import `STAFF_URL` instead of `ADMIN_URL` (or in addition to it): `const { STAFF_URL } = require('../utils/urls');`
2. Build `${STAFF_URL}/dashboard` (explicit landing page rather than relying on the index route).

### D. No change needed

- **`server/utils/urls.js`** — exports origins only, no paths. Stays as-is.
- **CORS allowlist in `server/index.js:88`** — origins, not paths. No change.
- **`server/routes/auth.js:169`, `server/routes/application.js:193`** — `clientUrl` reads from env (no path appended). No change.
- **Server route mounts** (e.g., `app.use('/api/admin', ...)`) — backend API namespaces, fully independent of frontend route prefixes. No change.

## Testing & rollout

### A. Atomicity (must ship as one push)

Vercel redirects + route restructure ship together in a single push. Splitting them breaks things:

- **Redirects-only first:** `/admin/dashboard` → 301 → `/dashboard` → 404 (route doesn't exist yet).
- **Routes-only first:** Bookmarks at `/admin/dashboard` 404 in the SPA's catch-all.

So one PR, one push, one deploy. Standard `git push origin main` triggers the unified deploy on Render + Vercel.

### B. Local dev verification (before push)

- `npm run dev`. On `localhost:3000` (treated as 'app' context), verify the admin shell renders at every new path: `/dashboard`, `/proposals`, `/proposals/new`, `/proposals/:id`, `/events`, `/events/:id`, `/clients`, `/clients/:id`, `/staffing`, `/staffing/users/:id`, `/financials`, `/settings`, `/blog`, `/email-marketing`, `/email-marketing/leads/:id`, etc.
- Sidebar nav (driven by `nav.js`) navigates correctly to new paths.
- Spot-check internal navigations: clicking a proposal in `ProposalsDashboard` opens `/proposals/:id`, etc.
- The `ShiftDetailRedirect` legacy redirect resolves to `/events/:eventId?drawer=shift&drawerId=:id`.
- Inner redirects: `/cocktail-menu` and `/drink-menu` both Navigate to `/settings`.
- **Caveat:** Vercel `redirects` do NOT apply on the dev server — they're edge-only. Old-URL redirects can only be verified in Vercel preview, not local. The risk is in path changes, not in Vercel's redirect engine.

### C. Vercel preview verification (before promoting)

- `admin.drb.com/admin/dashboard` → 301 → `admin.drb.com/dashboard` (renders).
- `admin.drb.com/admin/proposals/123` → 301 → `admin.drb.com/proposals/123` (renders).
- `admin.drb.com/admin/email-marketing/leads/42` → 301 → `admin.drb.com/email-marketing/leads/42` (renders).
- `staff.drb.com/portal/dashboard` → 301 → `staff.drb.com/dashboard` (renders).
- `admin.drb.com/proposal/<token>` → 301 → `drbartender.com/proposal/<token>` (cross-domain — renders public proposal view).
- `admin.drb.com/portal` → 301 → `staff.drbartender.com` (cross-domain — renders staff login or dashboard).
- `admin.drb.com/labnotes/some-slug` → 301 → `drbartender.com/labnotes/some-slug`.
- Old shift-detail bookmark `admin.drb.com/admin/events/shift/99` → 301 → `admin.drb.com/events/shift/99` → ShiftDetailRedirect → `admin.drb.com/events/:eventId?drawer=shift&drawerId=99`.

### D. Production verification (post-push)

- Trigger one of each admin notification email (or spot-check via email source after a real event):
  - Proposal created/updated/paid → email contains `https://admin.drbartender.com/proposals/:id` (no `/admin/`).
  - Thumbtack lead/message → `https://admin.drbartender.com/clients/:id`.
  - Drink plan submitted → `https://admin.drbartender.com/proposals/:id`.
  - Staff shift request → `https://admin.drbartender.com/staffing` (the bug fix).
  - Contractor agreement signed → `https://staff.drbartender.com/dashboard`.

### E. Pre-push agent gate

Per CLAUDE.md Rule 6, all 5 non-UI review agents auto-run before push. `@consistency-check` is the most load-bearing one for this change — it should catch any missed `/admin/` or `/portal/` references between schema/routes/components. If it flags anything, fix before pushing.

### F. Rollback plan

Standard `git revert <sha>` + push (per CLAUDE.md Rule 9). Old in-flight emails sent during the brief window when `/admin/...` paths existed will keep working forever via the Vercel 301s — even if we revert, the underlying routes are unchanged. Reverting only restores the prefix; old admin URLs still reach valid pages either way.

### G. Doc updates (per CLAUDE.md)

No folder-structure, schema, or env-var changes — no CLAUDE.md/README.md/ARCHITECTURE.md updates required. The spec doc itself in `docs/superpowers/specs/` is the durable record.

## Risk summary

- **Atomicity risk (low):** redirects + routes ship together; can't be partial. Standard single-push deploy.
- **Missed-link risk (medium):** 159 `/admin/` and 12 `/portal/` occurrences across 31 client files plus 8 server URL builders. Mitigation: `@consistency-check` agent, and pattern-based Edits that skip API paths and comments. Old URLs still work via 301 even if a sweep miss happens — degraded UX (extra hop) but not broken.
- **Cross-domain redirect risk (low):** Vercel `has`-host filtering is well-supported. Each rule is host-scoped, so rules don't accidentally fire on the wrong subdomain.
- **Wrong-subdomain edge cases (low):** Admin lands on staff subdomain, etc. — `getHomePath` and the role guards handle this today; behavior is unchanged.
- **Email rollback risk (none):** Old emails (already in inboxes) keep resolving via 301 forever, even if we revert the route changes.

## Out-of-scope follow-ups (not part of this work)

- Consolidating client-facing auth surfaces (currently `/login` exists on both public and admin contexts with different components).
- Cross-subdomain redirect for `/apply`/`/application-status` from admin/staff to `hiring.drbartender.com` (current admin-context fallback is intentional).
- Onboarding flow consolidation (currently mounted on every staff-facing context).
