---
spec: docs/superpowers/specs/2026-07-14-needs-attention-tabs-design.md
lanes:
  - id: natabs-a
    footprint:
      - client/src/pages/admin/overview/NeedsYouStrip.js      # reworked in place into the tabbed card
      - client/src/pages/admin/overview/queueItems.js         # NEW: item builders + tab assembly
      - client/src/pages/admin/overview/queueItems.test.js    # NEW
      - client/src/pages/admin/overview/PayrollStatus.js      # NEW: PayrollCard logic, card chrome dropped
      - client/src/pages/admin/overview/PayrollCard.js        # DELETED
      - client/src/pages/admin/overview/PrepQueue.js          # cap/overflow moves to tab level
      - client/src/pages/admin/overview/OverviewPage.js       # fetches + wiring + Band 1 layout
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: standard per-lane at the gate   # client-only presentation; no server files; payroll DISPLAY moves but no payroll logic changes; run sensitive-match at merge to confirm zero hits
---

# Needs-Attention Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. One lane, built via the think-on-main/build-in-lanes model.

**Goal:** Replace the overview's full-width needs-you grid and standalone Payroll card with one tabbed triage card (Staffing / Prep / Clients / Money, conditional Sales) beside the Pipeline card.

**Architecture:** Pure client rework over existing endpoints (zero server changes). Item-building becomes pure functions in `queueItems.js` (unit-tested); `NeedsYouStrip.js` becomes the tabbed card with all panels mounted (inactive hidden by CSS) so per-panel fetches mount once and background tabs feed their header dots; `PayrollCard.js` becomes the Money tab's `PayrollStatus.js` block.

**Tech Stack:** React 18 (CRA), vanilla CSS tokens in `index.css`, `react-scripts test` for the pure builders, `CI=true` build as the Vercel gate.

## Global Constraints

- Zero server changes; the two LAW endpoints untouched.
- Role gating (spec 2026-07-09 §1): payroll fetches + status block admin-only; a manager fires zero `/admin/payroll/*` requests. Applications fetch admin-only. Change requests, SMS conversations, payouts: admin+manager.
- Fetch isolation: every Band 1 fetch has its own `.catch`, degrading to absent items; nothing blanks the page.
- No em dashes in copy. Both skins (apothecary + After Hours), both density modes, 390px, no page-level horizontal scroll.
- Money display: `fmt$` for proposal dollars, `fmt$wholeFromCents` for payroll cents (unchanged call sites).
- Vercel gate before merge: `cd client && CI=true npx react-scripts build`.

---

### Task 1: queueItems.js builders + tab assembly (TDD)

**Files:**
- Create: `client/src/pages/admin/overview/queueItems.js`, `client/src/pages/admin/overview/queueItems.test.js`
- Modify: `client/src/pages/admin/overview/PrepQueue.js` (remove `MAX_PREP_ITEMS` cap + overflow block; keep the sort; return ALL items)

**Interfaces:**
- Consumes: `getEventTypeLabel` from `../../../utils/eventTypes`, `fmt$`, `fmtDate`, `dayDiff` from `../../../components/adminos/format`, `parsePositionsCount`, `approvedCount` from `../../../components/adminos/shifts`.
- Produces (exact exports Task 3/4 rely on):
  - `buildStaffingItems(unstaffed, newApplications)` → item[] (existing unstaffed mapping, NO `slice(0,3)`; plus the applications rollup item when `newApplications > 0`)
  - `buildClientItems(changeRequests, conversations)` → item[] (CRs first, then unread SMS)
  - `buildSalesItems(proposals, nowMs)` → item[] (sent-unviewed 72h)
  - `buildMoneyItems(payoutBadge)` → item[] (the existing payouts one-liner, or [])
  - `computeTabs({ staffing, prep, clients, money, sales, payrollOverdue, isAdmin })` → `{key, label, items, count, dot, overflowHref, hasBody}[]`
  - `defaultTabKey(tabs, isAdmin)` → `'staffing'|'prep'|'clients'|'money'|'sales'|null`
- Item shape is the existing queue-item contract: `{id, type, priority, title, sub, meta, target, ref}`.

- [ ] **1.1 Failing tests first** (`queueItems.test.js`, plain CRA/Jest, no DOM). Cover:

```js
// Sales aging: sent 73h ago → item; 71h ago → none; status 'viewed' at any age → none.
const now = Date.parse('2026-07-14T12:00:00Z');
const hrs = (n) => new Date(now - n * 3600e3).toISOString();
buildSalesItems([{ id: 1, status: 'sent', sent_at: hrs(73), client_name: 'Ana', total_price: 500 }], now); // length 1, target 'proposal', ref 1, priority 'info'
buildSalesItems([{ id: 2, status: 'sent', sent_at: hrs(71) }], now); // []
buildSalesItems([{ id: 3, status: 'viewed', sent_at: hrs(200) }], now); // []
// CR priority: edit_window 'inside_t14' → danger, else warn; target 'proposal', ref = proposal_id; CRs sort before SMS.
// SMS: only unread_count > 0 rows become items; target 'sms', ref = client_id, priority warn, meta String(unread_count).
// Staffing: <7 days out → danger else warn (reuse a shift row fixture with event_date + positions/approved); applications item only when count > 0.
// computeTabs: dot = worst priority in tab; money dot 'danger' when payrollOverdue even with zero items; sales tab ABSENT when empty, present when non-empty; hasBody true for money+isAdmin even with zero items, false for money+manager+zero items.
// defaultTabKey: danger in clients beats warn in staffing → 'clients'; tie (warn in staffing and prep) → 'staffing' (fixed order); all empty → 'money' for admin, null for manager; payrollOverdue alone → 'money'.
```

- [ ] **1.2 Run to verify FAIL**: `cd client && CI=true npx react-scripts test queueItems --watchAll=false` (module not found).
- [ ] **1.3 Implement.** Core of `queueItems.js`:

```js
const RANK = { danger: 0, warn: 1, info: 2 };
const OVERFLOW_HREF = {
  staffing: '/events', prep: '/drink-plans?tab=submitted', clients: '/messages',
  money: '/dashboard?tab=payouts', sales: '/proposals?tab=active',
};
const worstPriority = (items) =>
  items.reduce((w, i) => (w === null || (RANK[i.priority] ?? 3) < RANK[w] ? i.priority : w), null);

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

export function computeTabs({ staffing, prep, clients, money, sales, payrollOverdue, isAdmin }) {
  const defs = [
    { key: 'staffing', label: 'Staffing', items: staffing },
    { key: 'prep', label: 'Prep', items: prep },
    { key: 'clients', label: 'Clients', items: clients },
    { key: 'money', label: 'Money', items: money },
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
    if (t.dot === null) return;
    if (RANK[t.dot] < bestRank) { bestRank = RANK[t.dot]; best = t.key; }
  });
  if (best) return best;
  return isAdmin ? 'money' : null;
}
```

`buildStaffingItems` / `buildMoneyItems` port today's `actionQueue` unstaffed mapping (identical fields, priorities, targets, but no `slice(0,3)`) and the `payoutsItem` object verbatim from `OverviewPage.js:195-233`. In `PrepQueue.js`, delete the `MAX_PREP_ITEMS` constant and the overflow branch (lines 18, 54-65); the sorted full list returns as-is.
- [ ] **1.4 Run to verify PASS**: same command, all green.
- [ ] **1.5 Commit** (lane checkpoint): `git add client/src/pages/admin/overview/queueItems.js client/src/pages/admin/overview/queueItems.test.js client/src/pages/admin/overview/PrepQueue.js && git commit -m "feat(natabs): queue-item builders + tab assembly"`.

### Task 2: PayrollStatus.js (PayrollCard, chrome dropped)

**Files:**
- Create: `client/src/pages/admin/overview/PayrollStatus.js`
- Delete: `client/src/pages/admin/overview/PayrollCard.js`

**Interfaces:**
- Consumes: same fetch trio as PayrollCard today (`/admin/payroll/periods`, `/admin/payroll/periods/current`, `/admin/payroll/deferred-tips`), same helpers (`chicagoYmdParts`, `fmt$wholeFromCents`, `fmtDate`, `EntityLink`).
- Produces: `<PayrollStatus onOverdue={(overdue: boolean) => void} />`. Renders a BLOCK (no `.card` wrapper, no card-head): headline row (text + Overdue chip when overdue), total, subs line (staff count, payday, deferred tips), all wrapped in one `EntityLink` to `view.href`. All four view states preserved: due / accruing / no-open-period / error (link-only "Couldn't load payroll." still linking to `/financials/payroll`).

- [ ] **2.1 Create `PayrollStatus.js`** by porting `PayrollCard.js` wholesale: keep `ymd10`, `weekday`, `chicagoTodayYmd`, `periodRange`, the fetch effect, and the `view` memo BYTE-IDENTICAL (this is display-only movement; no payroll logic changes). Changes only in the render + report-up:
  - The `overdueItem` object in the `view` memo is no longer needed as an item; keep computing `overdue` and change the report-up effect to `onOverdue(Boolean(view.kind === 'due' && view.overdue))`.
  - Render: drop `.card` / `.card-head` chrome; root is `<EntityLink to={view.href} className="ov-payroll-link"><div className={'nat-payroll' + (view.overdue ? ' is-warn' : '')}>…</div></EntityLink>` reusing the existing `ov-payroll-headline` / `ov-payroll-total` / `ov-payroll-subs` inner classes so current CSS mostly carries over.
- [ ] **2.2 Delete `PayrollCard.js`** (`git rm`). The build will fail until Task 4 rewires OverviewPage; that is expected mid-lane. If building incrementally, do 2.2 together with Task 4.
- [ ] **2.3 Commit** with Task 4 (they are only buildable together) or as a lane checkpoint if the import swap in OverviewPage is included here.

### Task 3: NeedsYouStrip.js reworked into the tabbed card

**Files:**
- Modify: `client/src/pages/admin/overview/NeedsYouStrip.js` (full rework in place)

**Interfaces:**
- Consumes: `computeTabs` output via props; `PayrollStatus` (Task 2).
- Produces: `<NeedsYouStrip tabs={tabs} loading={bool} isAdmin={bool} onPayrollOverdue={(bool) => void} />`. Old `items` prop dies.

- [ ] **3.1 Rework the component:**
  - **Href map**: keep `queueItemHref` and `go()`; add `sms`: `if (a.target === 'sms') return '/messages?client=' + a.ref;` (both functions). Existing targets unchanged.
  - **Icons**: `QUEUE_ICON` gains `'change-request': 'pen', 'sms': 'chat'`.
  - **Active tab**: `const [picked, setPicked] = useState(null);` then `const active = picked && tabs.some(t => t.key === picked) ? picked : defaultTabKey(tabs, isAdmin);` The default is derived, so it follows data as fetches resolve; a user click sticks (until a picked Sales tab empties away, which falls back to the default).
  - **Collapsed state**: if `!loading && tabs.every(t => !t.hasBody)` render `<div className="card"><div className="card-body muted tiny">Nothing pressing right now.</div></div>` and nothing else (manager-only path by construction). If `loading` and every count is 0, render the card with a "Loading…" body and no tab row.
  - **Tab row**: card-head keeps `<h3><Icon name="alert" size={12}/> Needs attention <span className="k">Live</span></h3>`; below it a `.nat-tabs` row of `<button className={'nat-tab' + (active===t.key?' is-active':'') + (t.count===0?' is-empty':'')} onClick={() => setPicked(t.key)}>` containing label, `<span className="k">{t.count}</span>`, and `{t.dot && <span className={'nat-dot ' + t.dot} />}`.
  - **Panels**: ALL tabs render a panel `<div className={'nat-panel' + (active===t.key?'':' is-hidden')}>`; inactive hidden via CSS (`display:none`), never unmounted. Panel content: for `money` and `isAdmin`, `<PayrollStatus onOverdue={onPayrollOverdue}/>` first, then item rows. Item rows: `t.items.slice(0, 6)` in the existing `.queue-item` markup (icon / title EntityLink / sub / meta), then when `t.items.length > 6` an overflow row `<div className="queue-item nat-overflow" …>` with title `<EntityLink to={t.overflowHref}>{t.items.length - 6} more</EntityLink>` and row onClick navigating the same href. Empty visible panel (count 0, but hasBody or core tab): `<div className="muted tiny nat-empty">Nothing pressing.</div>`.
  - The old `.needs-you-grid` markup goes away entirely (single-column rows inside a panel; the grid CSS is retired in Task 5).
- [ ] **3.2 Commit** with Task 4 (prop change makes them one buildable unit).

### Task 4: OverviewPage wiring + Band 1 layout

**Files:**
- Modify: `client/src/pages/admin/overview/OverviewPage.js`

**Interfaces:**
- Consumes: everything Tasks 1-3 produce.
- Produces: Band 1 = one `.ov-band1` row containing the tabbed card + `PipelineCard`.

- [ ] **4.1 Fetches.** In the operational `useEffect` (`OverviewPage.js:155-185`), add two isolated fetches (both roles, spec §4):

```js
api.get('/proposals/change-requests', { params: { status: 'pending' } })
  .then(r => { if (!cancelled) setChangeRequests(r.data?.requests || []); })
  .catch(() => {}); // client items simply stay absent
api.get('/sms/conversations')
  .then(r => { if (!cancelled) setConversations(Array.isArray(r.data) ? r.data : []); })
  .catch(() => {});
```

with `const [changeRequests, setChangeRequests] = useState([]);` and `const [conversations, setConversations] = useState([]);`.
- [ ] **4.2 Item assembly.** Replace the `actionQueue`, `payoutsItem`, and `queueItems` memos (`OverviewPage.js:195-238`) and the `payrollItem` state with:

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

The `upcoming` / `unstaffed` / `newApplications` memos stay (the page subtitle uses them). The un-aged proposal-followup block inside the old `actionQueue` is deleted, not moved: that noise is the point of the spec.
- [ ] **4.3 Render.** Replace the strip + `grid-2` block (`OverviewPage.js:265-273`) with:

```jsx
<div className="ov-band1">
  <NeedsYouStrip tabs={tabs} loading={shiftsLoading || proposalsLoading} isAdmin={isAdmin} onPayrollOverdue={setPayrollOverdue} />
  <PipelineCard pipeline={pipeline} loading={!statsLoaded && statsLoading} error={statsError} />
</div>
```

Remove the `PayrollCard` import (add `queueItems` imports); everything below (tab seg, Band 2) is untouched.
- [ ] **4.4 Build gate**: `cd client && CI=true npx react-scripts build` passes (this also proves the PayrollCard deletion left no dangling imports).
- [ ] **4.5 Commit** Tasks 2+3+4 as the lane checkpoint: `git add client/src/pages/admin/overview/ && git commit -m "feat(natabs): tabbed needs-attention card, payroll absorbed"` (explicit paths; `git rm` already staged the deletion).

### Task 5: CSS (both skins, both densities, 390px)

**Files:**
- Modify: `client/src/index.css`

- [ ] **5.1 Add, near the existing overview styles (`~line 18000`),** tokens only:
  - `.ov-band1`: `display:grid; grid-template-columns: 2fr 1fr; gap: var(--gap); margin-bottom: var(--gap); align-items: start;` and at the existing mobile breakpoint `grid-template-columns: 1fr`.
  - `.nat-tabs`: horizontal row under the card-head (`display:flex; gap; padding; border-bottom: 1px solid var(--line-1); overflow-x:auto` so 390px scrolls inside its own container, LAW).
  - `.nat-tab`: chip-style button off existing button tokens; `.is-active` uses the accent border/ink treatment consistent with the page's seg buttons; `.is-empty` drops to `var(--ink-4)`.
  - `.nat-dot`: 6px dot; `.danger`/`.warn`/`.info` map to the same tokens the `queue-icon` priority classes use.
  - `.nat-panel.is-hidden { display: none; }`; `.nat-empty` padding; `.nat-overflow` row muted.
  - `.nat-payroll`: padding block replacing `.ov-payroll-card` chrome; keep/retarget `.ov-payroll-headline`, `.ov-payroll-total`, `.ov-payroll-subs`, `.ov-payroll-link`, `.is-warn` accents; delete now-dead `.ov-payroll-card` / `.ov-payroll-arrow` rules and the `.needs-you-grid` rules (including the light-skin and mobile overrides at `index.css:11554-11558`, `18004-18014`).
  - Light-skin (`data-skin="light"`) overrides for `.nat-tab` / `.nat-dot` where the dark defaults do not read; check both density modes.
- [ ] **5.2 Rebuild gate** (`CI=true npx react-scripts build`) and commit: `git add client/src/index.css && git commit -m "feat(natabs): tab styles, band-1 grid, payroll block css"`.

### Task 6: Docs + verification sweep

**Files:**
- Modify: `README.md` (folder tree: `PayrollCard.js` → `PayrollStatus.js`, add `queueItems.js`), `ARCHITECTURE.md` (grep `PayrollCard`/`NeedsYouStrip` and update the overview-components mention)

- [ ] **6.1 Update both docs** per the Mandatory Documentation Updates table; commit.
- [ ] **6.2 Manual smoke (dev box, Claude-driven via the local review recipe, then Dallas eyeball):**
  - Admin: mixed fixtures → correct counts/dots per tab; danger in a background tab shows its dot; default tab = worst tab; payroll block shows due/accruing states inside Money; a proposal sent yesterday appears NOWHERE; a 4-day-old unviewed sent proposal appears under Sales.
  - Links: change-request item lands on the proposal detail (decide card visible); unread SMS item opens the exact thread at `/messages?client=<id>`; payouts item lands on Payouts with unmatched focus; overflow rows land on their home surfaces.
  - Manager (dev manager-test login): network tab shows zero `/admin/payroll/*` and zero `/admin/applications` calls; Money tab = payouts only; zero items everywhere → the slim "Nothing pressing right now." line.
  - Both skins, both density modes, 390px (tab row scrolls in its own container, no page-level horizontal scroll).
- [ ] **6.3 Full client test pass** (`CI=true npx react-scripts test --watchAll=false`) + final `CI=true npx react-scripts build`. Lane ready for the merge gate (per-lane review; sensitive-match expected zero hits).

## Self-review notes (spec coverage)

- Spec §2 inventory → Tasks 1 (all five builders, cuts included), 2 (payroll block), 4 (fetches). §3 mechanics → Tasks 1 (computeTabs/defaultTabKey), 3 (mount-all panels, picked-vs-derived active, caps, collapse). §4 data flow → Task 4. §5 layout/files → Tasks 3-5 + 6.1. §6 gating → constraints + 6.2 manager smoke. §7 follow-ups → already recorded in the fix-list (spec commit 39b698f). §8 DoD → Task 6.
