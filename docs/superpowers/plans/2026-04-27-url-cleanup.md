# URL Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the redundant `/admin` and `/portal` route prefixes from `admin.drbartender.com` and `staff.drbartender.com`, and 301-redirect any client-facing URLs leaked onto the admin subdomain back to `drbartender.com`.

**Architecture:** Restructure `App.js` so the admin shell mounts at `/` (instead of `/admin`) and the staff shell mounts at `/` (instead of `/portal`). Sweep ~30 client files plus 5 server files for `/admin/...` / `/portal/...` references. Add 18 host-scoped Vercel `redirects` to `client/vercel.json` so old URLs (bookmarks, in-flight emails, indexed pages) keep working forever via HTTP 301. Atomic single-PR / single-push deploy.

**Tech Stack:** React 18 + React Router 6, Vercel `redirects` (host-scoped via `has`), Express server with raw SQL (no schema changes).

**Reference spec:** `docs/superpowers/specs/2026-04-27-url-cleanup-design.md`

---

## File touch summary

**New files:** none.

**Modified files (client):**
- `client/src/App.js` — route restructure, `getHomePath` update, `ShiftDetailRedirect` retarget, remove admin-context `/portal` fallback
- `client/src/components/adminos/nav.js` — strip `/admin` from `path:` values
- `client/src/components/adminos/CommandPalette.js` — strip `/admin` from jump targets
- `client/src/components/StaffLayout.js` — strip `/portal` from nav array
- `client/src/components/AdminLayout.js` — `navigate('/admin/proposals/new')` → `'/proposals/new'`
- `client/src/pages/Completion.js` — strip `/portal` from 2 `navigate()` calls
- `client/src/pages/ApplicationStatus.js` — `<Navigate to="/portal">` → `<Navigate to="/dashboard">`
- `client/src/pages/AdminDashboard.js` — strip `/admin` from references; fix hardcoded SMS template (`admin.drbartender.com/portal` → `staff.drbartender.com/dashboard`)
- `client/src/pages/staff/StaffDashboard.js` — strip `/portal` from 4 `<Link to=...>` props
- 25 other admin-side files — mechanical Link/Navigate/useNavigate sweep:
  `client/src/pages/AdminApplicationDetail.js`, `client/src/pages/AdminUserDetail.js`, `client/src/pages/admin/{ProposalsDashboard,FinancialsDashboard,EventsDashboard,ProposalDetail,EventDetailPage,ClientDetail,ProposalCreate,BlogDashboard,EmailLeadsDashboard,Dashboard,SettingsDashboard,DrinkPlanDetail,DrinkPlansDashboard,StaffDashboard,EmailCampaignCreate,EmailCampaignsDashboard,HiringDashboard,EmailMarketingDashboard}.js`, `client/src/components/adminos/drawers/{EventDrawer,ProposalDrawer,ClientDrawer,ShiftDrawer}.js`, `client/src/pages/admin/InvoicesDrawer.js` (if /admin refs found there)
- `client/vercel.json` — add 18 `redirects` entries

**Modified files (server):**
- `server/routes/proposals.js` — 3 admin URL builders, drop `/admin/`
- `server/routes/stripe.js` — 2 admin URL builders, drop `/admin/`
- `server/routes/drinkPlans.js` — 1 admin URL builder, drop `/admin/`
- `server/routes/thumbtack.js` — 2 admin URL builders, drop `/admin/`
- `server/routes/shifts.js` — fix stale `/admin/shifts` (no such route) → `/staffing`
- `server/routes/agreement.js` — switch from `${ADMIN_URL}/portal` to `${STAFF_URL}/dashboard`; update import

**Deletions:** 9-line `/portal/*` fallback block in admin context of App.js.

**No tests:** existing project has no E2E suite for routing; the few Jest tests (e.g. `packageGaps.test.js`) don't touch routes. Verification is manual via `npm run dev` + Vercel preview.

---

## Task 1: Restructure `client/src/App.js` route definitions

**Files:**
- Modify: `client/src/App.js` (lines 94-122 — `ShiftDetailRedirect`; 141-161 — `getHomePath`; 270-307 — staff context; 309-405 — app context)

- [ ] **Step 1: Update `ShiftDetailRedirect` to use new paths**

The legacy redirect inside `ShiftDetailRedirect()` currently navigates to `/admin/events/...`. Update to `/events/...`:

```js
function ShiftDetailRedirect() {
  const { id } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    api.get(`/shifts/detail/${id}`)
      .then(r => {
        if (cancelled) return;
        const eventId = r.data?.shift?.proposal_id;
        if (eventId) {
          navigate(`/events/${eventId}?drawer=shift&drawerId=${id}`, { replace: true });
        } else {
          navigate('/events', { replace: true });
        }
      })
      .catch(() => { if (!cancelled) navigate('/events', { replace: true }); });
    return () => { cancelled = true; };
  }, [id, navigate]);
  return (
    <div
      className="loading"
      style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      role="status"
      aria-live="polite"
    >
      <div className="spinner" aria-hidden="true" />
    </div>
  );
}
```

- [ ] **Step 2: Update `getHomePath` — `/admin` → `/dashboard`, `/portal` → `/dashboard`, plus cross-subdomain bounce for portal-status users on admin host**

Replace the entire `getHomePath` function (currently App.js:141-161):

```js
function getHomePath(user) {
  if (!user) return '/login';
  // Admins and managers always land on the dashboard
  if (user.role === 'admin' || user.role === 'manager') return '/dashboard';
  switch (user.onboarding_status) {
    case 'applied':
    case 'interviewing':
      return '/application-status';
    // Completed onboarding → portal
    case 'submitted':
    case 'reviewed':
    case 'approved':
      // Portal-status users belong on staff.drbartender.com.
      // If they end up on admin.drbartender.com (rare), kick them cross-domain.
      // Vercel cross-subdomain redirects only fire on full page loads, not React Router navs,
      // so we use window.location.replace explicitly here.
      if (typeof window !== 'undefined' && window.location.hostname === 'admin.drbartender.com') {
        window.location.replace('https://staff.drbartender.com/dashboard');
        return '/login';
      }
      return '/dashboard';
    // Actively going through onboarding
    case 'hired':
      return '/welcome';
    case 'in_progress':
    default:
      return user.has_application ? '/application-status' : '/apply';
  }
}
```

- [ ] **Step 3: Restructure staff context routes — drop `/portal` prefix**

Replace the staff context's `/portal` route block (App.js:289-297):

```jsx
        {/* Staff portal — mounted at root on staff.drbartender.com */}
        <Route element={<RequirePortal><StaffLayout /></RequirePortal>}>
          <Route path="/dashboard" element={<StaffDashboard />} />
          <Route path="/shifts" element={<StaffShifts />} />
          <Route path="/schedule" element={<StaffSchedule />} />
          <Route path="/events" element={<StaffEvents />} />
          <Route path="/resources" element={<StaffResources />} />
          <Route path="/profile" element={<StaffProfile />} />
        </Route>
```

The `RequirePortal` guard wraps `StaffLayout` — it now wraps the layout-without-path so each child route sits at the top level. After this, `staff.drbartender.com/dashboard`, `/shifts`, etc. all work.

- [ ] **Step 4: Restructure hiring context's portal fallback — same drop**

Replace the hiring context's `/portal` block (App.js:250-258):

```jsx
        {/* Staff portal — kept here so fully-onboarded users who bookmarked hiring.drb.com don't hit a blank page */}
        <Route element={<RequirePortal><StaffLayout /></RequirePortal>}>
          <Route path="/dashboard" element={<StaffDashboard />} />
          <Route path="/shifts" element={<StaffShifts />} />
          <Route path="/schedule" element={<StaffSchedule />} />
          <Route path="/events" element={<StaffEvents />} />
          <Route path="/resources" element={<StaffResources />} />
          <Route path="/profile" element={<StaffProfile />} />
        </Route>
```

- [ ] **Step 5: Restructure admin context — drop `/admin` prefix, remove `/portal` fallback block**

Replace the entire admin shell block (App.js:366-399) with the no-prefix version, AND DELETE the staff `/portal/*` fallback block at App.js:356-364 (which precedes it). The admin shell becomes:

```jsx
      {/* Admin + Manager shell — mounted at root on admin.drbartender.com */}
      <Route element={<ProtectedRoute adminOnly><AdminLayout /></ProtectedRoute>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/staffing" element={<AdminStaffDashboard />} />
        <Route path="/staffing/legacy" element={<AdminDashboard />} />
        <Route path="/staffing/users/:id" element={<AdminUserDetail />} />
        <Route path="/staffing/applications/:id" element={<AdminApplicationDetail />} />
        <Route path="/hiring" element={<HiringDashboard />} />
        <Route path="/drink-plans" element={<DrinkPlansDashboard />} />
        <Route path="/drink-plans/:id" element={<DrinkPlanDetail />} />
        <Route path="/cocktail-menu" element={<Navigate to="/settings" replace />} />
        <Route path="/drink-menu" element={<Navigate to="/settings" replace />} />
        <Route path="/proposals" element={<ProposalsDashboard />} />
        <Route path="/proposals/new" element={<ProposalCreate />} />
        <Route path="/proposals/:id" element={<ProposalDetail />} />
        <Route path="/events" element={<EventsDashboard />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/events/shift/:id" element={<ShiftDetailRedirect />} />
        <Route path="/clients" element={<ClientsDashboard />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/financials" element={<FinancialsDashboard />} />
        <Route path="/settings" element={<SettingsDashboard />} />
        <Route path="/blog" element={<BlogDashboard />} />
        <Route path="/email-marketing" element={<EmailMarketingDashboard />}>
          <Route index element={<EmailLeadsDashboard />} />
          <Route path="leads" element={<EmailLeadsDashboard />} />
          <Route path="leads/:id" element={<EmailLeadDetail />} />
          <Route path="campaigns" element={<EmailCampaignsDashboard />} />
          <Route path="campaigns/new" element={<EmailCampaignCreate />} />
          <Route path="campaigns/:id" element={<EmailCampaignDetail />} />
          <Route path="analytics" element={<EmailAnalyticsDashboard />} />
          <Route path="conversations" element={<EmailConversations />} />
        </Route>
      </Route>
```

Also update the `/` redirect inside the app context — currently `<Route path="/" element={<Navigate to="/register" replace />} />`. Keep that redirect as-is (anonymous traffic on admin.drb.com still gets pushed to `/register`/`/login`).

- [ ] **Step 6: Verify the file by reading it back**

Run: `Grep` for `path="/admin` in `client/src/App.js`.
Expected: zero matches (only literal `to="/login"` etc. remain).

Also `Grep` for `path="/portal` in `client/src/App.js`.
Expected: zero matches.

---

## Task 2: Update `client/src/components/adminos/nav.js`

**Files:**
- Modify: `client/src/components/adminos/nav.js` (whole file)

- [ ] **Step 1: Replace nav config — strip `/admin` from every `path:` value**

Replace the file contents:

```js
// Nav groups for the Admin OS sidebar.
// `badgeKey` maps to the /api/admin/badge-counts response shape.
const NAV = [
  { section: 'Workspace', items: [
    { id: 'dashboard',   label: 'Dashboard', icon: 'home',      path: '/dashboard' },
    { id: 'events',      label: 'Events',    icon: 'calendar',  path: '/events',    badgeKey: 'unstaffed_events' },
    { id: 'proposals',   label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
    { id: 'clients',     label: 'Clients',   icon: 'users',     path: '/clients' },
    { id: 'staff',       label: 'Staff',     icon: 'userplus',  path: '/staffing' },
    { id: 'hiring',      label: 'Hiring',    icon: 'pen',       path: '/hiring',    badgeKey: 'new_applications' },
  ]},
  { section: 'Revenue', items: [
    { id: 'financials',  label: 'Financials', icon: 'dollar',   path: '/financials' },
    { id: 'marketing',   label: 'Marketing',  icon: 'mail',     path: '/email-marketing' },
  ]},
  { section: 'Content', items: [
    { id: 'drink-plans', label: 'Drink Plans',   icon: 'flask', path: '/drink-plans', badgeKey: 'pending_shopping_lists' },
    { id: 'menu',        label: 'Cocktail Menu', icon: 'book',  path: '/cocktail-menu' },
    { id: 'blog',        label: 'Lab Notes',     icon: 'pen',   path: '/blog' },
    { id: 'settings',    label: 'Settings',      icon: 'gear',  path: '/settings' },
  ]},
];

export default NAV;
```

---

## Task 3: Update `client/src/components/adminos/CommandPalette.js`

**Files:**
- Modify: `client/src/components/adminos/CommandPalette.js` (lines 17-32)

- [ ] **Step 1: Strip `/admin` from each `go(...)` path**

Replace the `groups` array (lines 15-35) with:

```js
  const groups = [
    { group: 'Jump to', items: [
      { label: 'Dashboard',   icon: 'home',      onClick: go('/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/hiring') },
      { label: 'Financials',  icon: 'dollar',    onClick: go('/financials') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',     onClick: go('/drink-plans') },
      { label: 'Cocktail Menu', icon: 'book',    onClick: go('/cocktail-menu') },
      { label: 'Lab Notes',   icon: 'pen',       onClick: go('/blog') },
      { label: 'Settings',    icon: 'gear',      onClick: go('/settings') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: go('/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: go('/email-marketing/campaigns/new') },
    ]},
    // TODO: hook up /api/admin/search in a follow-up PR to populate a live Records group.
  ];
```

The `/api/admin/search` comment stays — it's a server API path, not a frontend route.

---

## Task 4: Update `client/src/components/StaffLayout.js`

**Files:**
- Modify: `client/src/components/StaffLayout.js` (lines 7-13 — nav array)

- [ ] **Step 1: Strip `/portal` from each nav item path**

Update the nav array entries (lines 7-13):

```js
  { label: 'Dashboard',   path: '/dashboard',  icon: '📊' },
  { label: 'Shifts',      path: '/shifts',     icon: '📅' },
  { label: 'My Schedule', path: '/schedule',   icon: '🗓' },
  { label: 'My Events',   path: '/events',     icon: '📋' },
```

(Then the existing line for the divider, then:)

```js
  { label: 'Resources',   path: '/resources',  icon: '📖' },
  { label: 'Profile',     path: '/profile',    icon: '👤' },
```

Read the current file first to see the exact surrounding lines, then Edit one block at a time using `replace_all: false` to preserve context.

- [ ] **Step 2: Check StaffLayout.js for any other `/portal` or `/admin` references**

Run: `Grep` for `/portal` AND `/admin` in `client/src/components/StaffLayout.js`.
Expected: zero remaining matches after edits.

---

## Task 5: Update remaining staff-side files

**Files:**
- Modify: `client/src/pages/Completion.js` (lines 32, 39)
- Modify: `client/src/pages/ApplicationStatus.js` (line 16)
- Modify: `client/src/pages/staff/StaffDashboard.js` (lines 81, 85, 89, 93)

- [ ] **Step 1: Update `Completion.js` — 2 navigate calls**

```js
// Line 32:  onClick={() => navigate('/portal/shifts')}   →   onClick={() => navigate('/shifts')}
// Line 39:  onClick={() => navigate('/portal/dashboard')} →  onClick={() => navigate('/dashboard')}
```

- [ ] **Step 2: Update `ApplicationStatus.js` — Navigate target**

```js
// Line 16: if (['submitted', 'reviewed', 'approved'].includes(status)) return <Navigate to="/portal" replace />;
//      →:  if (['submitted', 'reviewed', 'approved'].includes(status)) return <Navigate to="/dashboard" replace />;
```

- [ ] **Step 3: Update `StaffDashboard.js` (staff page) — 4 Link `to=` props**

```js
// Line 81: <Link to="/portal/shifts"   ...>   →   <Link to="/shifts"   ...>
// Line 85: <Link to="/portal/schedule" ...>   →   <Link to="/schedule" ...>
// Line 89: <Link to="/portal/schedule" ...>   →   <Link to="/schedule" ...>
// Line 93: <Link to="/portal/events"   ...>   →   <Link to="/events"   ...>
```

- [ ] **Step 4: Verify no `/portal` references remain on staff side**

Run: `Grep` for `/portal/` in `client/src/`.
Expected: zero matches (the only remaining hit should be `App.js` line 228 in a comment about the hiring → staff portal mirror, which is a comment about subdomains, not a path).

---

## Task 6: Sweep admin-side `/admin/` references in remaining 25 files

**Files (25):**
- `client/src/components/AdminLayout.js`
- `client/src/pages/AdminDashboard.js` (excluding the SMS template — handled separately in Task 11)
- `client/src/pages/AdminApplicationDetail.js`
- `client/src/pages/AdminUserDetail.js`
- `client/src/pages/admin/Dashboard.js`
- `client/src/pages/admin/StaffDashboard.js`
- `client/src/pages/admin/EventsDashboard.js`
- `client/src/pages/admin/EventDetailPage.js`
- `client/src/pages/admin/ProposalsDashboard.js`
- `client/src/pages/admin/ProposalCreate.js`
- `client/src/pages/admin/ProposalDetail.js`
- `client/src/pages/admin/ClientsDashboard.js` (if present in match list)
- `client/src/pages/admin/ClientDetail.js`
- `client/src/pages/admin/FinancialsDashboard.js`
- `client/src/pages/admin/HiringDashboard.js`
- `client/src/pages/admin/SettingsDashboard.js`
- `client/src/pages/admin/BlogDashboard.js`
- `client/src/pages/admin/DrinkPlansDashboard.js`
- `client/src/pages/admin/DrinkPlanDetail.js`
- `client/src/pages/admin/EmailMarketingDashboard.js`
- `client/src/pages/admin/EmailLeadsDashboard.js`
- `client/src/pages/admin/EmailCampaignsDashboard.js`
- `client/src/pages/admin/EmailCampaignCreate.js`
- `client/src/components/adminos/drawers/EventDrawer.js`
- `client/src/components/adminos/drawers/ProposalDrawer.js`
- `client/src/components/adminos/drawers/ClientDrawer.js`
- `client/src/components/adminos/drawers/ShiftDrawer.js`

- [ ] **Step 1: For each file, Grep for `/admin/` and inspect context**

Per-file workflow: Grep with `output_mode: content`, then Edit each line that matches one of the navigation patterns:

```
to="/admin/X            →  to="/X
to='/admin/X            →  to='/X
to={`/admin/X           →  to={`/X
navigate('/admin/X      →  navigate('/X
navigate(`/admin/X      →  navigate(`/X
<Navigate to="/admin/X  →  <Navigate to="/X
```

**Do NOT change:**
- `api.get('/admin/...')`, `api.post('/admin/...')`, `api.put('/admin/...')`, `api.delete('/admin/...')`, `api.patch('/admin/...')` — these hit the server's `/api/admin/...` namespace.
- Comments mentioning `/admin/...` (e.g., JSDoc references to old paths) — leave or update freely; behavior-inert.
- String literals that are user-visible labels mentioning "/admin" (none expected, but verify per-file).

- [ ] **Step 2: Verify after sweep**

Run: `Grep` for `to="/admin/` and `navigate('/admin/` and `<Navigate to="/admin/` in `client/src/`.
Expected: zero matches.

Run: `Grep` for `/admin/` in `client/src/` (broader).
Expected: only matches in:
- API call paths (`api.get('/admin/...')` etc.)
- Comments / JSDoc
- The CommandPalette's `/api/admin/search` TODO comment

---

## Task 7: Update server email URL builders

**Files:**
- Modify: `server/routes/proposals.js` (lines 193, 558, 1433)
- Modify: `server/routes/stripe.js` (lines 655, 931)
- Modify: `server/routes/drinkPlans.js` (line 442)
- Modify: `server/routes/thumbtack.js` (lines 291, 372)

- [ ] **Step 1: `server/routes/proposals.js` — 3 sites**

```
Line 193:   const adminUrl = `${ADMIN_URL}/admin/proposals/${pd.id}`;
        →   const adminUrl = `${ADMIN_URL}/proposals/${pd.id}`;

Line 558:   const adminUrl = `${ADMIN_URL}/admin/proposals/${proposal.id}`;
        →   const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;

Line 1433:  const adminUrl = `${ADMIN_URL}/admin/proposals/${proposal.id}`;
        →   const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;
```

- [ ] **Step 2: `server/routes/stripe.js` — 2 sites**

```
Line 655:   const adminUrl = `${ADMIN_URL}/admin/proposals/${proposalId}`;
        →   const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;

Line 931:   <p><a href="${ADMIN_URL}/admin/proposals/${proposalId}">View Proposal</a></p>
        →   <p><a href="${ADMIN_URL}/proposals/${proposalId}">View Proposal</a></p>
```

- [ ] **Step 3: `server/routes/drinkPlans.js` — 1 site**

```
Line 442:   <p><a href="${ADMIN_URL}/admin/proposals/${pn.id}">View Proposal</a></p>
        →   <p><a href="${ADMIN_URL}/proposals/${pn.id}">View Proposal</a></p>
```

- [ ] **Step 4: `server/routes/thumbtack.js` — 2 sites**

```
Line 291:   const adminUrl = clientId ? `${ADMIN_URL}/admin/clients/${clientId}` : null;
        →   const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;

Line 372:   const adminUrl = clientId ? `${ADMIN_URL}/admin/clients/${clientId}` : null;
        →   const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;
```

- [ ] **Step 5: Verify**

Run: `Grep` for `${ADMIN_URL}/admin/` in `server/routes/`.
Expected: zero matches.

---

## Task 8: Fix stale shifts link in `server/routes/shifts.js`

**Files:**
- Modify: `server/routes/shifts.js` (line 291)

- [ ] **Step 1: Change broken `/admin/shifts` to a real route**

```
Line 291:   adminUrl: `${ADMIN_URL}/admin/shifts`,
        →   adminUrl: `${ADMIN_URL}/staffing`,
```

`/admin/shifts` never existed as a route in `App.js` — pre-existing bug masked by login redirect. The closest real admin page for shift management is the staff/shifts dashboard at `/staffing` (post-cleanup) or `/admin/staffing` (pre-cleanup). Picking the post-cleanup form aligns with this PR.

---

## Task 9: Update `server/routes/agreement.js` to use STAFF_URL

**Files:**
- Modify: `server/routes/agreement.js` (line 12 — import; line 212 — URL)

- [ ] **Step 1: Update import**

```
Line 12: const { ADMIN_URL } = require('../utils/urls');
     →:  const { STAFF_URL } = require('../utils/urls');
```

If `ADMIN_URL` is used elsewhere in the file, keep both: `const { ADMIN_URL, STAFF_URL } = require('../utils/urls');`. Verify by grepping `ADMIN_URL` in `server/routes/agreement.js` first.

- [ ] **Step 2: Build URL with STAFF_URL + /dashboard**

```
Line 212:  const portalUrl = escapeHtml(`${ADMIN_URL}/portal`);
       →:  const portalUrl = escapeHtml(`${STAFF_URL}/dashboard`);
```

---

## Task 10: Update `client/src/pages/AdminDashboard.js` SMS template

**Files:**
- Modify: `client/src/pages/AdminDashboard.js` (line 565)

- [ ] **Step 1: Replace hardcoded admin URL with staff URL**

Find this line (line 565):

```js
setMsgBody(`Hey! We have an event coming up: ${shift.event_type_label || 'event'} at ${shift.client_name || 'TBD'} on ${date} at ${time} — ${shift.location || 'TBD'}. Interested in working it? Request the shift in your portal: https://admin.drbartender.com/portal - Dr. Bartender`);
```

Change `https://admin.drbartender.com/portal` to `https://staff.drbartender.com/dashboard`:

```js
setMsgBody(`Hey! We have an event coming up: ${shift.event_type_label || 'event'} at ${shift.client_name || 'TBD'} on ${date} at ${time} — ${shift.location || 'TBD'}. Interested in working it? Request the shift in your portal: https://staff.drbartender.com/dashboard - Dr. Bartender`);
```

---

## Task 11: Update `client/vercel.json` with redirects

**Files:**
- Modify: `client/vercel.json` (whole file — currently 3 lines)

- [ ] **Step 1: Replace file with redirect-augmented config**

Replace the whole file:

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

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('client/vercel.json'))"`
Expected: no error printed.

---

## Task 12: Local dev verification

**Files:** none (runtime check only)

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Expected: Express on :5000, React on :3000. Both come up clean (no compile errors from the App.js restructure).

- [ ] **Step 2: Verify admin shell at new paths**

Browser: `http://localhost:3000`. Login as admin (seeded account).
After login, the URL should land at `/dashboard`. Sidebar should be visible.

Click each top-level sidebar item. Verify URL becomes `/events`, `/proposals`, `/clients`, `/staffing`, `/hiring`, `/financials`, `/email-marketing`, `/drink-plans`, `/cocktail-menu` (auto-redirects to `/settings`), `/blog`, `/settings`.

Open ⌘K command palette. Verify each "Jump to" option navigates to the right top-level path.

- [ ] **Step 3: Spot-check internal navigations**

- Click a row in `/proposals` → URL becomes `/proposals/:id`, ProposalDetail renders.
- Open `/proposals/new` → ProposalCreate renders.
- Open `/events/:id` for any event → EventDetailPage renders.
- Click a shift drawer → URL gets `?drawer=shift&drawerId=...` query.
- `/email-marketing/leads/:id` deep link → EmailLeadDetail renders.

- [ ] **Step 4: Verify no console errors**

Browser DevTools console: should be clean. No "No route matches" warnings from React Router.

- [ ] **Step 5: Verify staff side (using a staff/portal-status user, OR by manually re-pointing localhost as staff via host hack)**

Easier check: just verify the staff routes compile and the `staff.drbartender.com` context's routes don't error in App.js. Full staff verification happens in Vercel preview.

---

## Task 13: Single commit

- [ ] **Step 1: Review the diff**

Run: `git status` then `git diff --stat`.
Expected: ~32 files changed (1 vercel.json + 1 App.js + 1 nav.js + 1 CommandPalette.js + 1 StaffLayout.js + 1 AdminLayout.js + 1 AdminDashboard.js + 1 Completion.js + 1 ApplicationStatus.js + 1 StaffDashboard.js (staff) + ~21 admin pages/components + 5 server route files = ~32-35).

- [ ] **Step 2: Stage files explicitly (no `git add .`)**

```bash
git add client/vercel.json
git add client/src/App.js
git add client/src/components/adminos/nav.js
git add client/src/components/adminos/CommandPalette.js
git add client/src/components/StaffLayout.js
git add client/src/components/AdminLayout.js
git add client/src/pages/AdminDashboard.js
git add client/src/pages/Completion.js
git add client/src/pages/ApplicationStatus.js
git add "client/src/pages/AdminApplicationDetail.js" "client/src/pages/AdminUserDetail.js"
git add client/src/pages/admin/
git add client/src/pages/staff/StaffDashboard.js
git add client/src/components/adminos/drawers/
git add server/routes/proposals.js server/routes/stripe.js server/routes/drinkPlans.js server/routes/thumbtack.js server/routes/shifts.js server/routes/agreement.js
```

(Adjust paths above if any expected file didn't actually need editing — Grep result of zero matches before edit means no edit needed.)

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(routing): drop /admin and /portal prefixes; close client-domain leak via Vercel 301s"
```

- [ ] **Step 4: Confirm commit succeeded**

Run: `git log --oneline -3`.
Expected: top commit is the new one.

- [ ] **Step 5: Stand down (do not push)**

Per CLAUDE.md Rule 4: pushes are user-initiated only. Report the commit summary and wait. Do not auto-push, do not nudge "ready to push?".

---

## Done

When the user gives a push cue, the standard Pre-Push Procedure (CLAUDE.md) takes over: confirmation gate → 5-agent gate → push. The `@consistency-check` agent will validate cross-file synchronization (caught any missed `/admin/` or `/portal/` references). Standard Render + Vercel deploy ensues.

Post-deploy verification per spec Section 6.D — trigger one of each admin notification email and verify URLs.
