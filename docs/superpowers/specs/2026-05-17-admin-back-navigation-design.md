# Admin Back Navigation — Design

**Date:** 2026-05-17
**Status:** Approved (design)

## Summary

The adminOS detail pages have two separate, both-broken navigation
affordances that the user (correctly) lumps together as "confusing
breadcrumbs":

1. **Fake header crumbs** — `adminos/Header.js` renders a non-clickable
   `Workspace / <label>` span pair. `Workspace` is a hardcoded literal shown
   even on Revenue/Content pages (factually wrong), and `findNavLabel`
   collapses every sub-route to its top-level label, so `/events`,
   `/events/123`, and `/events/123/edit` all render identically. It looks
   like a breadcrumb but navigates nowhere.

2. **Hardcoded "‹ Section" back buttons** — every detail page has an in-page
   ghost button hardcoded to `navigate('/<section>')`. Going Event → Drink
   Plan → "‹ Drink Plans" dumps you in the Drink Plans *queue*, not back on
   the event you came from. Same bug on Event→Client, Proposal→Event, etc.

**Decision:** Delete the fake header-crumb system entirely. Replace all
in-page hardcoded back buttons with a single shared **history-aware** Back
primitive: return to the previous in-app location when one exists; fall back
to the section list only on a cold entry (deep link / hard refresh / new
tab / ⌘K command-palette jump). The header crumb slot is replaced with a
single **honest, non-clickable page title** (no fake `Workspace /` parent,
no separator).

## Goals

- One shared `useSmartBack(fallback)` hook + `<BackButton fallback>`
  component in `components/adminos/`. Label is always a generic **"‹ Back"**
  — it never names a destination it might not go to.
- All six adminOS detail pages use it; their bespoke hardcoded back buttons
  are deleted (9 button instances across 6 pages — DrinkPlanDetail,
  EventDetailPage, and AdminUserDetail each have two).
- The fake `Workspace / X` header crumb is gone; an honest current-page
  title takes the slot.
- Zero artifacts of the old fake system remain: dead CSS removed, stale
  source comment trimmed.

## Non-goals (explicit scope decisions — implementation must NOT touch)

- **Post-delete redirects** — `DrinkPlanDetail.js:118`, `ClientDetail.js:58`,
  `ProposalDetail.js:79` call `navigate('/<section>')` *after deleting the
  entity*. The entity no longer exists; the section list is the correct
  destination. These are not back buttons. Leave them.
- **`ProposalCreate` "Cancel"** (`ProposalCreate.js:282`) — a create-form
  cancel, not detail-back. Out of scope.
- **Staff onboarding "← Back" buttons** (`ContractorProfile.js:314`, peers)
  — a linear onboarding wizard where a hardcoded step-back is correct. Not
  adminOS. Out of scope.
- **`Drawer.js`'s `crumb` prop** (ShiftDrawer / ClientDrawer /
  InvoicesDrawer) — confusingly named, but it is the slide-over drawer's
  *title slot*, unrelated to the fake nav trail. Removing it breaks drawers.
  Out of scope (verified, not an oversight).
- No migration of the app from `<BrowserRouter>` to `createBrowserRouter`,
  no `useBlocker` work. Unrelated.

## Design

### 1. The primitive — `useSmartBack(fallback)` + `<BackButton>`

New file `client/src/components/adminos/BackButton.js`.

`useSmartBack(fallback)` returns a click handler:

- React Router stamps the **first** history entry with
  `location.key === 'default'`. When `key === 'default'`, the user arrived
  cold — deep link, hard refresh, new tab, or a ⌘K command-palette jump that
  replaced state — so there is no meaningful in-app "back": navigate to
  `fallback`.
- Otherwise there is real in-app history: `navigate(-1)` returns the user
  exactly where they were (the event, the review queue, wherever the trail
  actually led).

```js
function useSmartBack(fallback) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.key && location.key !== 'default') navigate(-1);
    else navigate(fallback);
  }, [navigate, location.key, fallback]);
}
```

`<BackButton fallback="/events" />` renders the existing ghost-button style
with `Icon name="left"` and the text **"Back"**. This is the single source
of truth for the affordance — it also fixes the current copy-paste drift
where `AdminApplicationDetail` fakes the arrow with a 180°-rotated
`arrow_right` while every other page uses `Icon name="left"`.

### 2. Wire the six detail pages

Replace the hardcoded back button(s) on each with `<BackButton fallback>`:

| Page | `fallback` |
|---|---|
| `DrinkPlanDetail.js` (main + not-found copy) | `/drink-plans` |
| `EventDetailPage.js` (main + not-found copy) | `/events` |
| `ClientDetail.js` | `/clients` |
| `ProposalDetail.js` | `/proposals` |
| `userDetail/AdminUserDetail.js` (two instances) | `/staffing` |
| `applicationDetail/AdminApplicationDetail.js` | `/hiring` |

Delete the now-unused per-page back-button JSX. Leave each page's
post-delete redirect calls untouched (see Non-goals).

### 3. Replace the fake header crumb

In `adminos/Header.js`:

- Delete the `Workspace` / `crumb-sep` / `crumb-current` span block.
- Keep the *good* half of `findNavLabel` (path → label lookup against
  `NAV`), rename it to convey "page title," and render a single
  non-clickable `<span className="header-title">{title}</span>`. No
  separator, no fake parent.
- `findNavLabel`'s fallback returns `'Dashboard'`; keep that behavior for
  the title (an unmatched path is rare and Dashboard is a safe label).

### 4. Dead-CSS + comment sweep (the "no artifacts" requirement)

- `index.css` ~1767–1803: the entire `.admin-breadcrumbs` /
  `.admin-breadcrumbs ol|li|a` / `.breadcrumb-sep` block. **Already 100%
  dead** — no JSX references `admin-breadcrumbs` anywhere. Delete outright.
- `index.css` ~9802–9814 and ~10679–10689: both `.header-crumbs` /
  `.crumb-sep` / `.crumb-current` blocks (light skin + base). Delete and
  replace with a minimal `.header-title` rule inheriting the prior
  `crumb-current` look (`color: var(--ink-1); font-weight: 500;` and the
  light-skin equivalent).
- `ProposalDetailEditForm.js` ~92–97: the unsaved-changes-guard comment
  still cites "breadcrumbs" as an in-app nav vector. Trim that wording so it
  no longer references a system that no longer exists.

## Edge cases / error handling

- **Cold entry → fallback.** Deep link / refresh / new tab /
  command-palette jump where `location.key === 'default'`: Back goes to the
  section list. Honest and predictable; the generic "Back" label never
  promised otherwise.
- **`navigate(-1)` lands on a transient page.** E.g. user came via an edit
  form they cancelled. Acceptable: this is strictly better than today's
  always-wrong hardcoded jump, and the case is rare. Not worth tracking a
  bespoke history stack.
- **`location.key` undefined.** Guarded (`location.key && ...`) — treated as
  cold entry → fallback.

## Testing

`useSmartBack` is the unit under test (TDD — write tests first):

- With `MemoryRouter` initial entry (`location.key === 'default'`) → handler
  calls `navigate(fallback)`.
- After an in-app navigation (history present, `key !== 'default'`) →
  handler calls `navigate(-1)`.
- `location.key` undefined → treated as cold entry → `navigate(fallback)`.

`<BackButton>` render test: renders `Icon name="left"` + "Back", click
invokes the handler.

## Implementation order

1. TDD `useSmartBack` + `<BackButton>`.
2. **Grep `client/src` for `Icon name="left"` and
   `navigate('/<section>')`** to confirm the six-page set is exhaustive
   before editing — operationalizes the "zero stragglers" requirement; any
   straggler found gets the same treatment.
3. Wire the six pages; delete bespoke back-button JSX.
4. Header.js: delete fake crumb, render honest title.
5. CSS + comment sweep.
6. Manual check: Event → Drink Plan → Back returns to the event; open a
   drink plan cold (paste URL) → Back goes to `/drink-plans`.
