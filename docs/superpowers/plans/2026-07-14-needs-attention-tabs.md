---
spec: docs/superpowers/specs/2026-07-14-needs-attention-tabs-design.md
lanes:
  - id: natabs-a
    footprint:
      - client/src/pages/admin/overview/queueItems.js         # NEW: item builders + tab assembly
      - client/src/pages/admin/overview/queueItems.test.js    # NEW
      - client/src/pages/admin/overview/PayrollStatus.js      # NEW: PayrollCard logic, card chrome dropped
      - client/src/pages/admin/overview/PayrollCard.js        # DELETED (in Task 3, with its caller)
      - client/src/pages/admin/overview/NeedsYouStrip.js      # reworked in place into the tabbed card
      - client/src/pages/admin/overview/PrepQueue.js          # cap/overflow moves to tab level
      - client/src/pages/admin/overview/OverviewPage.js       # fetches + wiring + Band 1 layout
      - client/src/pages/admin/Messages.js                    # URL-named thread marks read (Task 5)
      - client/src/index.css
      - README.md
    blockedBy: []
    review:
      - after Task 4 (CSS): ui-ux-reviewer on the tabbed card, both skins + both densities + 390px
      - at merge gate: standard per-lane fleet + `node scripts/sensitive-match.js` (expect zero hits; client-only, no server files)
---

# Needs-Attention Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. One lane, built via the think-on-main/build-in-lanes model.

**Goal:** Replace the overview's full-width needs-you grid and standalone Payroll card with one tabbed triage card (Staffing / Prep / Clients / Money, conditional Sales) beside the Pipeline card.

**Architecture:** Pure client rework over existing endpoints (zero server changes). Item-building becomes pure functions in `queueItems.js` (unit-tested); `NeedsYouStrip.js` becomes the tabbed card with all panels mounted (inactive hidden by CSS) so per-panel fetches mount once and background tabs feed their header dots; `PayrollCard.js` becomes the Money tab's `PayrollStatus.js` block.

**Tech Stack:** React 18 (CRA), vanilla CSS tokens in `index.css`, `react-scripts test` (21 existing client test files; runner verified working) for the pure builders, `CI=true` build as the Vercel gate.

## Global Constraints

- Zero server changes; the two LAW endpoints untouched.
- Role gating (spec 2026-07-09 §1): payroll fetches + status block admin-only; a manager fires zero `/admin/payroll/*` requests. Applications fetch admin-only. Change requests, SMS conversations, payouts: admin+manager.
- Fetch isolation: every Band 1 fetch has its own `.catch`, degrading to absent items; nothing blanks the page.
- **CI build is a hard gate, and CRA fails the build on `no-unused-vars`.** Every task that moves code out of a file must prune that file's now-dead imports and helpers in the same step.
- **Never trust a cited `index.css` line number.** Line refs drift the moment rules are inserted. Re-grep by selector before editing or deleting anything (this plan's original CSS ranges were wrong; the review caught it).
- No em dashes in copy. Both skins (apothecary + After Hours), both density modes, 390px, no page-level horizontal scroll.
- Money display: `fmt$` for proposal dollars, `fmt$wholeFromCents` for payroll cents (unchanged call sites).
- Vercel gate before merge: `cd client && CI=true npx react-scripts build`.

---

### Task 1: queueItems.js builders + tab assembly (TDD)

**Files:**
- Create: `client/src/pages/admin/overview/queueItems.js`, `client/src/pages/admin/overview/queueItems.test.js`
- Modify: `client/src/pages/admin/overview/PrepQueue.js` (remove `MAX_PREP_ITEMS` cap + overflow block; keep the sort; return ALL items)

**Ownership boundary (pinned):** `buildPrepItems` STAYS in `PrepQueue.js` and keeps being imported from there (`OverviewPage.js:14`). `queueItems.js` owns the other four builders plus tab assembly. Do not move `buildPrepItems`.

**Interfaces:**
- Consumes: `getEventTypeLabel` from `../../../utils/eventTypes` (signature: takes an object `{event_type, event_type_custom}`), `fmt$`, `fmtDate`, `dayDiff` from `../../../components/adminos/format` (`dayDiff` takes a `YYYY-MM-DD` string; `proposals.sent_at` is TIMESTAMPTZ, so sales aging uses `Date.parse`, not `dayDiff`), `parsePositionsCount`, `approvedCount` from `../../../components/adminos/shifts`.
- Produces (exact exports Tasks 2/3 rely on):
  - `buildStaffingItems(unstaffed, newApplications)` → item[]
  - `buildClientItems(changeRequests, conversations)` → item[]
  - `buildSalesItems(proposals, nowMs)` → item[]
  - `buildMoneyItems(payoutBadge)` → item[]
  - `computeTabs({ staffing, prep, clients, money, sales, payrollOverdue, isAdmin })` → `{key, label, items, count, dot, overflowHref, hasBody}[]`
  - `defaultTabKey(tabs, isAdmin)` → `'staffing'|'prep'|'clients'|'money'|'sales'|null`
- Item shape is the existing queue-item contract: `{id, type, priority, title, sub, meta, target, ref}`.

- [ ] **1.1 Write the failing tests** (`queueItems.test.js`; plain Jest via CRA, no DOM). Cover:

```js
import { buildStaffingItems, buildClientItems, buildSalesItems, buildMoneyItems, computeTabs, defaultTabKey } from './queueItems';
import { buildPrepItems } from './PrepQueue';

const now = Date.parse('2026-07-14T12:00:00Z');
const hrs = (n) => new Date(now - n * 3600e3).toISOString();

// Sales aging (sent_at is TIMESTAMPTZ):
//   sent 73h ago  -> 1 item, target 'proposal', ref 1, priority 'info'
//   sent 71h ago  -> []            (inside the 72h window)
//   status 'viewed' at 200h -> []  (viewed proposals are the drip's job)
// Clients:
//   edit_window 'inside_t14' -> priority 'danger'; anything else -> 'warn'
//   CR item: target 'proposal', ref = proposal_id
//   SMS: only unread_count > 0 becomes an item; target 'sms', ref = client_id, priority 'warn', meta = String(unread_count)
//   ordering: all CRs before all SMS items
// Staffing:
//   event < 7 days out -> 'danger'; >= 7 -> 'warn'; NO cap (5 unstaffed -> 5 items)
//   applications rollup appears only when newApplications > 0
// Money:
//   buildMoneyItems(0) -> [];  buildMoneyItems(3) -> 1 item, priority 'warn', target 'payouts'
// Prep (guards the Task-1 edit to PrepQueue.js):
//   buildPrepItems with 7 qualifying plans -> 7 items, and NO item with id 'prep-overflow'
// computeTabs:
//   dot = worst priority within the tab
//   payrollOverdue + zero money items -> money tab { count: 0, dot: 'danger' }
//   sales tab ABSENT when empty, PRESENT when non-empty
//   hasBody: true for money when isAdmin even at count 0; false for money when !isAdmin and count 0
// defaultTabKey:
//   danger in clients + warn in staffing -> 'clients'
//   warn in staffing + warn in prep (tie) -> 'staffing' (fixed order)
//   payrollOverdue only -> 'money'
//   everything empty -> 'money' for admin, null for manager
```

- [ ] **1.2 Run to verify FAIL**: `cd client && CI=true npx react-scripts test queueItems --watchAll=false`. Expected: FAIL, "Cannot find module './queueItems'".
- [ ] **1.3 Implement `queueItems.js`:**

```js
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt$, fmtDate, dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';

const RANK = { danger: 0, warn: 1, info: 2 };
const OVERFLOW_HREF = {
  staffing: '/events', prep: '/drink-plans?tab=submitted', clients: '/messages',
  money: '/dashboard?tab=payouts', sales: '/proposals?tab=active',
};
const worstPriority = (items) =>
  items.reduce((w, i) => (w === null || (RANK[i.priority] ?? 3) < RANK[w] ? i.priority : w), null);

export function buildStaffingItems(unstaffed, newApplications) {
  const items = (unstaffed || []).map(e => {
    const open = parsePositionsCount(e) - approvedCount(e);
    const days = dayDiff(e.event_date.slice(0, 10));
    return {
      id: 'unstaffed-' + e.id, type: 'unstaffed', priority: days < 7 ? 'danger' : 'warn',
      title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
      sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
      meta: `${open} open`, target: e.proposal_id ? 'event' : 'shift', ref: e.proposal_id || e.id,
    };
  });
  if (newApplications > 0) {
    items.push({
      id: 'apps', type: 'application', priority: 'info',
      title: `${newApplications} new ${newApplications === 1 ? 'application' : 'applications'}`,
      sub: 'Review in hiring', meta: `${newApplications} new`, target: 'hiring', ref: null,
    });
  }
  return items;
}

export function buildClientItems(changeRequests, conversations) {
  const crs = (changeRequests || []).map(r => ({
    id: 'cr-' + r.id, type: 'change-request',
    priority: r.edit_window === 'inside_t14' ? 'danger' : 'warn',
    title: `${r.client_name || r.client_email || 'Client'} requested changes`,
    sub: `${getEventTypeLabel({ event_type: r.event_type, event_type_custom: r.event_type_custom })}${r.event_date ? ' · ' + fmtDate(String(r.event_date).slice(0, 10)) : ''}`,
    meta: 'review', target: 'proposal', ref: r.proposal_id,
  }));
  const sms = (conversations || []).filter(c => Number(c.unread_count) > 0).map(c => ({
    id: 'sms-' + c.client_id, type: 'sms', priority: 'warn',
    title: `${c.name || c.phone || 'Client'} · ${c.unread_count} unread`,
    sub: 'text message', meta: String(c.unread_count), target: 'sms', ref: c.client_id,
  }));
  return [...crs, ...sms];
}

export function buildSalesItems(proposals, nowMs) {
  const cutoff = nowMs - 72 * 3600e3;
  return (proposals || [])
    .filter(p => p.status === 'sent' && p.sent_at && Date.parse(p.sent_at) < cutoff)
    .map(p => ({
      id: 'sales-' + p.id, type: 'proposal', priority: 'info',
      title: `${p.client_name || p.client_email} proposal unviewed`,
      sub: `sent ${Math.floor((nowMs - Date.parse(p.sent_at)) / 86400e3)}d ago · ${getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}`,
      meta: fmt$(Number(p.total_price || 0)), target: 'proposal', ref: p.id,
    }));
}

export function buildMoneyItems(payoutBadge) {
  if (!payoutBadge) return [];
  return [{
    id: 'payouts-unmatched', type: 'payouts', priority: 'warn',
    title: `${payoutBadge} Stripe ${payoutBadge === 1 ? 'payout' : 'payouts'} unmatched`,
    sub: 'Settlement mirror', meta: String(payoutBadge), target: 'payouts', ref: null,
  }];
}

export function computeTabs({ staffing, prep, clients, money, sales, payrollOverdue, isAdmin }) {
  const defs = [
    { key: 'staffing', label: 'Staffing', items: staffing || [] },
    { key: 'prep', label: 'Prep', items: prep || [] },
    { key: 'clients', label: 'Clients', items: clients || [] },
    { key: 'money', label: 'Money', items: money || [] },
  ];
  if ((sales || []).length > 0) defs.push({ key: 'sales', label: 'Sales', items: sales });
  return defs.map(t => {
    let dot = worstPriority(t.items);
    if (t.key === 'money' && payrollOverdue) dot = 'danger';
    return {
      ...t, count: t.items.length, dot, overflowHref: OVERFLOW_HREF[t.key],
      hasBody: t.items.length > 0 || (t.key === 'money' && isAdmin),
    };
  });
}

export function defaultTabKey(tabs, isAdmin) {
  let best = null, bestRank = Infinity;
  tabs.forEach(t => {
    if (!t.dot) return;
    if (RANK[t.dot] < bestRank) { bestRank = RANK[t.dot]; best = t.key; }
  });
  if (best) return best;
  return isAdmin ? 'money' : null;
}
```

- [ ] **1.4 Edit `PrepQueue.js`**: delete `const MAX_PREP_ITEMS = 4;` (line 18) and the whole overflow branch (lines 54-65); the function now ends `return items;` after the sort. The `prep-overflow` item and its `drink-plans-queue` target die with it (the per-tab overflow row replaces them in Task 3).
- [ ] **1.5 Run to verify PASS**: `cd client && CI=true npx react-scripts test queueItems --watchAll=false`. Expected: all green, including the `buildPrepItems` no-overflow assertion.
- [ ] **1.6 Commit** (lane checkpoint):

```bash
git add client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/queueItems.test.js client/src/pages/admin/overview/PrepQueue.js
git commit -m "feat(natabs): queue-item builders + tab assembly"
```

### Task 2: PayrollStatus.js (PayrollCard's logic, card chrome dropped)

**Files:**
- Create: `client/src/pages/admin/overview/PayrollStatus.js`

**PayrollCard.js is NOT deleted here.** It stays (unused by nothing yet, still mounted by OverviewPage) so this task ends with a green build and a real checkpoint. Task 3 swaps the caller and deletes it in the same step.

**Interfaces:**
- Consumes: the same three fetches PayrollCard makes today (`/admin/payroll/periods`, `/admin/payroll/periods/current`, `/admin/payroll/deferred-tips`), same helpers (`chicagoYmdParts` from `../../../hooks/useMetricsFilter`, `fmt$wholeFromCents` + `fmtDate` from `../../../components/adminos/format`, `EntityLink`).
- Produces: `<PayrollStatus onOverdue={(overdue: boolean) => void} />`, a BLOCK (no `.card`, no `.card-head`).

- [ ] **2.1 Create `PayrollStatus.js`** by porting `PayrollCard.js`. Keep `ymd10`, `weekday`, `chicagoTodayYmd`, the fetch effect, and the `view` memo's state machine unchanged (display-only movement; NO payroll logic changes). Deltas, all forced by dropping the item and the chrome:
  - **Drop `periodRange`** (PayrollCard.js:32). It is referenced ONLY inside `overdueItem`, which is going away; leaving it triggers `no-unused-vars` and fails the CI build.
  - **Drop the `Icon` import** (PayrollCard.js:4). It is used ONLY by the card-head chrome being deleted. Same build-failure trap.
  - **`view` memo**: keep computing `overdue`, delete the `overdueItem` object from the `due` branch. All FIVE view kinds stay: `loading`, `error`, `empty`, `due`, `accruing` (the loading kind is live during the fetch and must still render, or the Money tab body is blank on first paint).
  - **Report-up**: `useEffect(() => { if (onOverdue) onOverdue(view.kind === 'due' && Boolean(view.overdue)); }, [onOverdue, view]);`
  - **Render**: root becomes `<EntityLink to={view.href} className="ov-payroll-link"><div className={'nat-payroll' + (view.overdue ? ' is-warn' : '')}>{body}</div></EntityLink>`. Body keeps the existing inner classes (`ov-payroll-headline`, `ov-payroll-total`, `ov-payroll-subs`) and the Overdue chip, so existing CSS carries over. No card-head, no arrow icon.
- [ ] **2.2 Build gate**: `cd client && CI=true npx react-scripts build`. Expected: exit 0 (this proves no dead imports/helpers survived the port). PayrollCard.js is still mounted and rendering normally at this point; nothing user-visible changed.
- [ ] **2.3 Commit**:

```bash
git add client/src/pages/admin/overview/PayrollStatus.js
git commit -m "feat(natabs): PayrollStatus block (payroll card logic, chrome dropped)"
```

### Task 3: Tabbed card + OverviewPage wiring + PayrollCard deletion

Tasks 3 and 4 of the reviewed draft are merged: the prop contract change (`items` → `tabs`) and its only caller are one unit, and a build gate cannot catch a broken prop contract. This task lands them together, plus the two CSS rules needed to make the result observable, and ends with a runtime checkpoint.

**Files:**
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js` (full rework in place), `client/src/pages/admin/overview/OverviewPage.js`, `client/src/index.css` (two rules only)
- Delete: `client/src/pages/admin/overview/PayrollCard.js`

- [ ] **3.1 Rework `NeedsYouStrip.js`:**
  - **Props**: `({ tabs, loading, isAdmin, onPayrollOverdue })`. The old `items` prop dies.
  - **Imports**: add `defaultTabKey` from `./queueItems` and `PayrollStatus` from `./PayrollStatus`.
  - **Href map**: keep `queueItemHref` and `go()`; in BOTH, add `sms` → `/messages?client=<ref>` and DELETE the now-orphaned `drink-plans-queue` branch (`NeedsYouStrip.js:17,38`; its only producer was PrepQueue's overflow item, removed in Task 1).
  - **Icons**: `QUEUE_ICON` gains `'change-request': 'pen'` and `'sms': 'chat'` (both glyphs exist in `Icon.js`).
  - **Active tab**: `const [picked, setPicked] = useState(null);` then `const active = picked && tabs.some(t => t.key === picked) ? picked : defaultTabKey(tabs, isAdmin);` Derived default follows the data as fetches resolve; a click sticks; a picked Sales tab that empties away falls back to the default.
  - **Collapsed state** (terminal, never transient): render the slim card ONLY when `!loading && tabs.every(t => !t.hasBody)`. While `loading`, render the card shell with a "Loading…" body and no tab row.
  - **Tab row**: card-head keeps `<h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>`. Below it `.nat-tabs`, one button per tab: `className={'nat-tab' + (active === t.key ? ' is-active' : '') + (t.count === 0 && !t.dot ? ' is-empty' : '')}` (the `!t.dot` guard is load-bearing: a payroll-overdue Money tab has count 0 but a danger dot, and must NOT be greyed out). Contents: label, `<span className="k">{t.count}</span>`, and `{t.dot && <span className={'nat-dot ' + t.dot} />}`.
  - **Panels**: EVERY tab renders its panel, `<div className={'nat-panel' + (active === t.key ? '' : ' is-hidden')}>`; inactive hidden by CSS, never unmounted (so PayrollStatus mounts once and its dot works from any tab). Money panel, when `isAdmin`, leads with `<PayrollStatus onOverdue={onPayrollOverdue} />`, then its items. Rows: `t.items.slice(0, 6)` in the existing `.queue-item` markup (unchanged: `queue-icon` + priority class, title in an `EntityLink`, sub, meta). When `t.items.length > 6`, an overflow row (`.queue-item.nat-overflow`) titled `${t.items.length - 6} more` linking to `t.overflowHref`, with the row onClick navigating the same href. A visible panel with zero rows shows `<div className="muted tiny nat-empty">Nothing pressing.</div>`.
  - The `.needs-you-grid` wrapper goes away (rows are single-column inside a panel).
- [ ] **3.2 Wire `OverviewPage.js` — fetches.** Add `const [changeRequests, setChangeRequests] = useState([]);`, `const [conversations, setConversations] = useState([]);`, and a loading flag for the pair: `const [clientsLoading, setClientsLoading] = useState(true);` (without it, a manager sees the collapsed "Nothing pressing" card flash and then re-expand when SMS lands). In the operational effect (`OverviewPage.js:155-185`), alongside the existing fetches:

```js
setClientsLoading(true);
Promise.allSettled([
  api.get('/proposals/change-requests', { params: { status: 'pending' } }),
  api.get('/sms/conversations'),
]).then(([crRes, smsRes]) => {
  if (cancelled) return;
  if (crRes.status === 'fulfilled') setChangeRequests(crRes.value.data?.requests || []);
  if (smsRes.status === 'fulfilled') setConversations(Array.isArray(smsRes.value.data) ? smsRes.value.data : []);
  setClientsLoading(false);   // either failing just means those items stay absent
});
```

Also change the existing proposals fetch (`OverviewPage.js:164`) from `api.get('/proposals')` to `api.get('/proposals', { params: { limit: 200 } })`. The route defaults to `limit=50` ordered `created_at DESC` and caps at 200 (`server/routes/proposals/list.js:37`); sales aging wants the OLDEST still-sent rows, which a newest-50 window silently drops. Client-only change, no server edit.
- [ ] **3.3 Wire `OverviewPage.js` — assembly.** Delete the `payrollItem` state, the `actionQueue` memo, the `payoutsItem` memo, and the `queueItems` memo (`OverviewPage.js:195-238`) — the un-aged proposal-followup block inside `actionQueue` is deleted, not moved; that noise is the point of the spec. Replace with:

```js
const [payrollOverdue, setPayrollOverdue] = useState(false);
const staffingItems = useMemo(() => buildStaffingItems(unstaffed, newApplications), [unstaffed, newApplications]);
const prepItems = useMemo(() => buildPrepItems(drinkPlans), [drinkPlans]);
const clientItems = useMemo(() => buildClientItems(changeRequests, conversations), [changeRequests, conversations]);
const salesItems = useMemo(() => buildSalesItems(proposals, Date.now()), [proposals]);
const moneyItems = useMemo(() => buildMoneyItems(payoutBadge), [payoutBadge]);
const tabs = useMemo(
  () => computeTabs({ staffing: staffingItems, prep: prepItems, clients: clientItems, money: moneyItems, sales: salesItems, payrollOverdue, isAdmin }),
  [staffingItems, prepItems, clientItems, moneyItems, salesItems, payrollOverdue, isAdmin]
);
```

Keep the `upcoming` / `unstaffed` / `newApplications` memos (the page subtitle uses them). Keep `import { buildPrepItems } from './PrepQueue';`. Add the `queueItems` import. **Remove the `PayrollCard` import AND the now-unused `getEventTypeLabel` (line 5), `fmt$` and `fmtDate` (line 10) imports** — they moved into the builders, and CRA fails the CI build on `no-unused-vars`. `dayDiff`, `parsePositionsCount`, and `approvedCount` STAY (still used by `upcoming` / `unstaffed`).
- [ ] **3.4 Wire `OverviewPage.js` — render.** Replace the strip + `grid-2` block (`OverviewPage.js:265-273`, i.e. the `<NeedsYouStrip items=… />`, the scrapped-events comment, and the `grid-2` div holding `PayrollCard` + `PipelineCard`) with:

```jsx
<div className="ov-band1">
  <NeedsYouStrip tabs={tabs} loading={shiftsLoading || proposalsLoading || clientsLoading}
    isAdmin={isAdmin} onPayrollOverdue={setPayrollOverdue} />
  <PipelineCard pipeline={pipeline} loading={!statsLoaded && statsLoading} error={statsError} />
</div>
```

Everything below (the Overview/Payouts seg, Band 2) is untouched.
- [ ] **3.5 Delete `PayrollCard.js`**: `git rm client/src/pages/admin/overview/PayrollCard.js` (its only caller is gone as of 3.4).
- [ ] **3.6 Minimal CSS so the result is observable** (full styling is Task 4). Append near the other overview rules:

```css
html[data-app="admin-os"] .ov-band1 {
  display: grid; grid-template-columns: 2fr 1fr; gap: var(--gap);
  margin-bottom: var(--gap); align-items: start;
}
html[data-app="admin-os"] .nat-panel.is-hidden { display: none; }
```

Without `.is-hidden` every panel renders stacked and the tabs cannot be judged.
- [ ] **3.7 Build gate**: `cd client && CI=true npx react-scripts build`. Expected exit 0 (also proves the PayrollCard deletion left no dangling import).
- [ ] **3.8 Runtime checkpoint (the real gate — a build cannot catch a broken prop contract).** Start the dev server, log in as admin, load `/dashboard`. Expected, all observable: only the active tab's rows render; other tabs show counts and (where items exist) dots; clicking a tab swaps the body; the Money tab shows the payroll block (due or accruing) plus any unmatched-payouts row; the standalone payroll card is gone; a proposal sent yesterday appears in NO tab. If the board is quiet, force a state (e.g. a pending change request on a dev proposal) rather than declaring pass on an empty board.
- [ ] **3.9 Commit** (per-file staging; `git rm` already staged the deletion):

```bash
git add client/src/pages/admin/overview/NeedsYouStrip.js client/src/pages/admin/overview/OverviewPage.js client/src/index.css
git commit -m "feat(natabs): tabbed needs-attention card, payroll absorbed, band-1 row"
```

### Task 4: Full CSS (both skins, both densities, 390px)

**Files:**
- Modify: `client/src/index.css`

`index.css` is OUTSIDE the file-size ratchet (`scripts/check-file-size.js` scopes to `^(server|client/src)/.+\.(js|jsx)$`), so its length is not a gate.

- [ ] **4.1 Add the tab styles** (tokens only), beside the `.ov-band1` rule from Task 3:
  - `.nat-tabs`: flex row under the card-head, `gap`, padding, `border-bottom: 1px solid var(--line-1)`, `overflow-x: auto`, `flex-wrap: nowrap`, `-webkit-overflow-scrolling: touch` so 390px scrolls inside its own container (LAW: never the page).
  - `.nat-tab`: chip-style button on existing button tokens, `white-space: nowrap; flex: 0 0 auto`. `.is-active` takes the accent treatment used by the page's other seg buttons. `.is-empty` drops to `var(--ink-4)` (applied only when the tab has no dot, per Task 3.1).
  - `.nat-dot`: ~6px round dot; `.danger` / `.warn` / `.info` reuse the exact tokens the existing `.queue-icon` priority classes use (grep `queue-icon` and mirror, so the dot and the row icon never disagree).
  - `.nat-empty` (padding, muted), `.nat-overflow` (muted row).
  - `.nat-payroll`: the padding block replacing `.ov-payroll-card` chrome; keep the existing `.ov-payroll-link`, `.ov-payroll-headline`, `.ov-payroll-total`, `.ov-payroll-subs`, and `.is-warn` accent rules working against the new wrapper.
  - Mobile: inside the existing `@media (max-width: 640px)` overview block, `.ov-band1 { grid-template-columns: 1fr; }`.
  - Light skin: add `html[data-app="admin-os"][data-skin="light"]` overrides for `.nat-tab` and `.nat-dot` wherever the dark defaults do not read. Check both density modes.
- [ ] **4.2 Delete dead rules — BY SELECTOR, not by line number.** Run `grep -n "needs-you-grid\|ov-payroll-card\|ov-payroll-arrow" client/src/index.css` and delete exactly those rule blocks. Two traps the review caught:
  - The light-skin block near line 11554 is `.queue-item` / `.queue-item:hover`, NOT `.needs-you-grid`. The reworked panels still render `.queue-item` rows. **Do not delete it.**
  - The `.needs-you-grid` mobile overrides sit INSIDE a shared `@media (max-width: 640px)` block that also holds live `.overview-tabs` rules. Delete only the `.needs-you-grid` lines within it; leave the `@media` opener, the `.overview-tabs` rules, and the closing brace intact. Verify the file still parses by rebuilding.
- [ ] **4.3 Build gate + visual pass**: `cd client && CI=true npx react-scripts build` (exit 0), then eyeball `/dashboard` in both skins, both density modes, and at 390px: tab row scrolls inside itself, no page-level horizontal scroll, queue rows still styled correctly in the light skin (the trap above), payroll block reads correctly in both skins.
- [ ] **4.4 Review checkpoint**: dispatch `ui-ux-reviewer` on the tabbed card (both skins, both densities, 390px) before moving on.
- [ ] **4.5 Commit**:

```bash
git add client/src/index.css
git commit -m "feat(natabs): tab styles, payroll block css, retire needs-you-grid"
```

### Task 5: Unread SMS items must clear when acted on

**Files:**
- Modify: `client/src/pages/admin/Messages.js`

The spec's inclusion test (§1) requires an item to disappear once acted on. Today `/messages?client=<id>` opens the thread with `markRead: false` (`Messages.js:60-66`), deliberately: that same effect also auto-opens the newest thread on a bare `/messages` visit, and merely landing on the page must not silently clear unread counts. So the fix is narrow: an explicitly URL-named thread is a deliberate open and marks read; the fallback auto-open of `threads[0]` keeps `markRead: false`.

- [ ] **5.1 Change the URL-open effect** so the two cases split:

```js
useEffect(() => {
  if (selectedClientId || threads.length === 0) return;
  const fromUrl = listState.client
    ? threads.find(t => String(t.client_id) === listState.client)
    : null;
  // A URL-named thread is a deliberate open (a needs-attention item, a shared
  // link): mark it read. A bare /messages visit auto-opens the newest thread
  // for convenience and must NOT clear its unread count.
  if (fromUrl) openThread(fromUrl.client_id, { markRead: true });
  else openThread(threads[0].client_id, { markRead: false });
}, [threads, selectedClientId, listState.client, openThread]);
```

- [ ] **5.2 Runtime checkpoint**: with an unread inbound message on a dev client, load `/dashboard`, confirm the Clients tab shows the unread item, click it, confirm the thread opens AND the unread badge clears; return to `/dashboard` and confirm the item is gone. Then load bare `/messages` with another unread thread and confirm that thread's count does NOT clear on auto-open.
- [ ] **5.3 Commit**:

```bash
git add client/src/pages/admin/Messages.js
git commit -m "fix(natabs): URL-named thread marks read so unread items clear"
```

### Task 6: Docs + full verification sweep

**Files:**
- Modify: `README.md` (folder tree only)

Per CLAUDE.md's docs table, "New/removed component" maps to README's folder tree and NOT to ARCHITECTURE.md (which has no mention of `overview/`, `PayrollCard`, or `NeedsYouStrip` to update — verified by grep). No ARCHITECTURE edit is owed.

- [ ] **6.1 Update the README folder tree**: `PayrollCard.js` → `PayrollStatus.js`, add `queueItems.js`. Commit (`git add README.md`).
- [ ] **6.2 Manager smoke (the role-gating gate).** Log in with the dev `manager-test` account, load `/dashboard`, watch the network tab. Expected: ZERO `/admin/payroll/*` requests, ZERO `/admin/applications` requests, no Sentry `role_denial` noise; the Money tab shows unmatched payouts only, with no payroll block; with a clean board, the card collapses to the single "Nothing pressing right now." line (and does not flash-expand as the SMS/change-request fetches land).
- [ ] **6.3 Link sweep.** Every item lands where it claims: change request → the proposal detail with its decide card visible; unread SMS → the exact thread (and clears, per Task 5); unmatched payouts → Payouts tab focused on unmatched; unstaffed → the event; prep → the drink plan; applications → `/hiring`; each overflow row → its home surface.
- [ ] **6.4 Final gates**: `cd client && CI=true npx react-scripts test --watchAll=false` (full client suite green) and `cd client && CI=true npx react-scripts build` (exit 0). Lane is then ready for the merge gate: per-lane review fleet + `node scripts/sensitive-match.js` on the lane's diff (expect zero hits; client-only, no server files).

## Review-fleet fixes folded in (2026-07-14)

The plan fleet (fidelity / decomposition / feasibility, all three returning real verdicts) caught these before any code was written:

- **BLOCKER, cross-confirmed x3:** the original CSS deletion ranges were wrong. `index.css:11554-11558` is the light-skin `.queue-item` block the reworked panels still use (deleting it regresses the light skin), and the `.needs-you-grid` mobile rules sit inside a shared `@media` block whose opener/closer must survive. Task 4.2 now deletes by selector and names both traps; a global constraint forbids trusting cited CSS line numbers.
- **BLOCKER (feasibility):** porting PayrollCard would have orphaned `periodRange` and the `Icon` import, and dropping the `actionQueue` memos would have orphaned `getEventTypeLabel` / `fmt$` / `fmtDate` in OverviewPage. CRA fails the CI build on `no-unused-vars`, so both are now explicit prune steps (2.1, 3.3).
- **BLOCKER (decomposition):** old Tasks 2/3/4 had no independent checkpoints (2.2 deliberately broke the build; a build gate cannot catch a broken prop contract). Resequenced: PayrollCard's deletion moved to the task that removes its caller, old 3+4 merged, and the merged task now ends on a runtime checkpoint (3.8) with the two CSS rules needed to observe it.
- **WARNING, cross-confirmed x2:** `GET /api/proposals` defaults to `limit=50` ordered `created_at DESC` — exactly the window that drops the oldest still-sent proposals the Sales tab exists to surface. Now fetched with `limit=200` (server-capped at 200; client-only change).
- **WARNING (feasibility), real behavior bug:** `/messages?client=<id>` opens with `markRead: false`, so an unread item would survive being acted on, violating the spec's inclusion test. Task 5 splits URL-named opens (mark read) from the bare-visit auto-open (do not).
- **WARNING (fidelity):** PayrollCard's `loading` view kind would have been dropped, blanking the Money tab on first paint. Task 2.1 now names all five view kinds.
- **WARNING (fidelity):** the collapse state would flicker for a manager (the two new fetches had no loading flag). Task 3.2 adds `clientsLoading` and folds it into the gate.
- **WARNING (fidelity):** `is-empty` greying would have fought the danger dot on a payroll-overdue Money tab with zero items. Task 3.1 guards it with `!t.dot`.
- **SUGGESTIONS:** `buildMoneyItems` now has test coverage (1.1); the `PrepQueue.js` vs `queueItems.js` ownership boundary is pinned; the orphaned `drink-plans-queue` href branch is removed (3.1); the vacuous ARCHITECTURE.md edit is dropped (Task 6 preamble); review agents are named at checkpoints (front-matter, 4.4).
