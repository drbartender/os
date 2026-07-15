# Admin 24-hour clock + event-list time range

```yaml
lanes:
  - id: admin-24h-clock
    footprint:
      - client/src/components/adminos/format.js
      - client/src/components/adminos/format.test.js
      - client/src/components/adminos/drawers/*.js
      - client/src/components/TimePicker.js
      - client/src/utils/setupTime.js
      - client/src/utils/setupTime.test.js
      - client/src/pages/AdminDashboard.js
      - client/src/pages/admin/**/*.js
    depends_on: []
    review: light (no sensitive paths)
  - id: event-list-times
    footprint:
      - client/src/components/adminos/format.js
      - client/src/components/adminos/format.test.js
      - client/src/pages/admin/EventsDashboard.js
      - client/src/pages/admin/EventDetailPage.js
    depends_on: [admin-24h-clock]
    review: light (no sensitive paths)
```

## Context

Dallas wants (1) every time displayed in the **admin** pages to use a 24-hour clock, and (2) the event list rows to drop the relative-day text ("In 12d" etc.) and instead show start–end time plus duration.

Scope decisions (confirmed by Dallas):
- **Event list sub-line: drop ALL relative text** (Today/Tomorrow/"Xd ago" too) → sub-line becomes `18:00–23:00 · 5h`.
- **Admin pages only**: staff portal (`pages/staff/*`) and client-facing surfaces (proposal view, portal, website wizards, invoices, plan pages) **keep 12h**.
- **Admin form time pickers show 24h labels too**; stored values unchanged.

Key facts (verified in code + confirmed by the plan-review fleet):
- Event list = `client/src/pages/admin/EventsDashboard.js`, fed by `GET /shifts` (`SELECT s.*`) → `end_time` + `event_duration_hours` (nullable) already on every row. **No API change.**
- `shifts.start_time`/`end_time` are free-text: 12h ("7:00 PM") when written by `server/utils/eventCreation.js`, canonical "HH:MM" when written by the AdminDashboard TimePicker form — displays need a **tolerant** reformatter. Server stays untouched (staff/SMS/calendar read those strings raw).
- `relDay` has many consumers (admin + staff) — remove only the EventsDashboard usage, keep the function.
- `calcEndTime` / `formatTime12h` / `generateTimeOptions` are shared with client-facing code — **do not change their output** (`timeOptions.test.js` stays green).
- `fmtDateTime` importers (ProposalDetail + DrinkPlanCard) mount only on admin pages — safe to flip in place.
- Nothing touched is on `scripts/sensitive-paths.txt` (all server-side) → light review level.
- File-size ratchet: no touched file grows past caps (AdminDashboard 773 / ProposalDetailEditForm 846 grow ~1-2 lines; ProposalDetail 869 and EventDetailPage 559 net-shrink).

## Execution track

Two **sequential code-only lanes** (independent product decisions → independently revertable squashes):
- **Lane A `admin-24h-clock`** — Steps 1a, 3, 4, 5, 6 (the 24h sweep).
- **Lane B `event-list-times`** — Steps 1b, 2, and the EventDetailPage `fmtTimeRange` dedupe (cut after A merges; uses A's `fmtTime24`).

`npm run worktree:new` per lane, squash-merge via `scripts/merge-lane.sh`, delete lane. Commit this plan doc to `docs/superpowers/plans/` on main first. **No push** (push is Dallas's explicit cue; main already holds unpushed commits).

---

# Lane A — admin 24h clock

## Step 1a — `fmtTime24` helper in `client/src/components/adminos/format.js`

```js
// Tolerant 24h reformatter: "7:00 PM" | "6:00PM" | "18:00" → "HH:MM".
// Empty → ''. Unparseable non-empty → returned as-is (never blank a value).
export const fmtTime24 = (str) => { /* regex /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i, AM/PM→24h, pad, reject h>23||m>59 */ };
```

Leave `calcEndTime`, `relDay`, `fmtDate*` untouched. Add `format.test.js` cases: "7:00 PM"→"19:00", "6:00PM"→"18:00", "18:00" passthrough, "12:00 AM"→"00:00", "12:00 PM"→"12:00", ''→'', garbage passthrough.

## Step 3 — TimePicker 24h display prop (shared component, opt-in)

`client/src/components/TimePicker.js`: add `hour24 = false` prop. Declare `const toDisplay = (v) => hour24 ? (v || '') : formatTime12h(v);` **immediately after the props destructure — before the `useState` at :28** (TDZ otherwise). Replace the four display calls (:28, :37, :50, :83) with `toDisplay(...)`; dropdown label :207 → `{hour24 ? slot.value : slot.label}`. `onChange` still emits canonical "HH:MM"; `parseTimeInput` already accepts both typed forms.

Pass `hour24` at admin call sites only: `pages/admin/EventEditForm.js:153`, `pages/admin/ProposalDetailEditForm.js:388`, `pages/admin/proposalCreate/EventSection.js:123`, `pages/AdminDashboard.js:325 + :333`. **Not** `website/ClassWizard.js` / `quoteWizard/steps/EventDetailsStep.js`.

## Step 4 — setupTime 24h option (staff stays 12h)

`client/src/utils/setupTime.js`: `subtractMinutesFromTime(timeStr, minutes, { hour24 = false } = {})` + pass-through on `formatSetupTime`; note in the mirror comment that `hour24` is client-display-only (server twin untouched). Admin call sites pass `{ hour24: true }`: `EventEditForm.js:174`, `ProposalDetailEditForm.js:415`. Staff `ShiftDetail.js:200` unchanged. Add `client/src/utils/setupTime.test.js`: hour24 output, default 12h output unchanged, midnight wrap.

## Step 5 — `fmtDateTime` → 24h in place

`format.js:59`: `{ month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }` → "Jul 13, 2026, 18:05". (Importers ProposalDetail + DrinkPlanCard are admin-mounted only; noted future risk if DrinkPlanCard is ever reused publicly.)

## Step 6 — Remaining admin sites

**6a. Minimal 24h flips on bespoke timestamps — keep each site's current date style** (Dallas asked for the clock, not date reformatting): add `hour12: false` to the existing options object, or for bare `.toLocaleString()` calls use `.toLocaleString('en-US', { hour12: false })` (preserves the numeric date + seconds those sites show today). Sites: `Messages.js:167`, `TipsAdmin.js:167,:249`, `EmailConversations.js:148`, `EmailLeadDetail.js:166,:185`, `EmailCampaignDetail.js:136,:293`, `ProposalsDashboard.js:405`, **`AdminDashboard.js:708`** (`toLocaleDateString` with hour/minute — same treatment). `userDetail/tabs/MessagesTab.js:37` already uses fmtDateTime's exact option object inline → swap to the `fmtDateTime` import (identical output post-flip).

**6b. Specially-shaped sites in place** (`hour12:false`, keep weekday/TZ/time-only intent): `EventDetailPage.js:406` (bare `toLocaleTimeString()` — give it `{ hour:'2-digit', minute:'2-digit', hour12:false }`, also fixes the pre-existing seconds bug), `eventDetail/MessageLogCard.js:10`, `HiringDashboard.js:416`, `adminos/drawers/PresenceDrawer.js:13` (keep America/Chicago), `applicationDetail/components/StatsCard.js:29`, `applicationDetail/components/TimelineCard.js:33,:39`.

**6c. `ProposalDetail.js`**: delete local `formatTime12` (27–37); use `fmtTime24(proposal.event_start_time)` at :398 and keep the **ternary** at :525 (`proposal.event_start_time ? fmtTime24(...) : '—'`) so empty still renders `—`. Handles the mixed legacy "6:00 PM"/"6:00PM"/"HH:MM" data.

**6d. Raw stored-string renders → wrap in `fmtTime24`**: `EventDetailPage.js:370` (roster start–end), `userDetail/tabs/ShiftsTab.js:39`, `userDetail/components/AssignToEventModal.js:162` (leave its `relDay` at :161 alone), **`adminos/drawers/ShiftDrawer.js:420-421`** ("When" field), **`AdminDashboard.js:430`** (`🕐 {start_time} – {end_time}`). **Leave `AdminDashboard.js:573-574` alone** — it builds a staff SMS body (outbound comms stay 12h).

Import-path note: each touched file adds `import { fmtTime24 | fmtDateTime } from '<relative>/components/adminos/format'` — depths vary (e.g. `userDetail/tabs/` is `../../../../components/...`); verify each.

**Final sweep** of `pages/admin/ + components/adminos/ + AdminDashboard.js`, two passes: (1) `toLocaleTimeString|toLocaleString|toLocaleDateString|hour12|AM'|PM'`, (2) raw `start_time|end_time` JSX renders — every hit is either fixed or on the accepted-gaps list.

---

# Lane B — event-list times (after A merges)

## Step 1b — `fmtTimeRange24` helper in `format.js`

```js
// "18:00–23:00 · 5h". Prefers stored end; else derives end from start+durationHours
// (wraps midnight). Missing dur → derive from span; missing both → bare "18:00".
// durStyle 'paren' → "(5 hrs)" for EventDetailPage parity. Number(hrs) strips ".0".
export const fmtTimeRange24 = (start, end, durationHours, { durStyle = 'dot' } = {}) => { ... };
```

Extend `format.test.js`: stored end, derived end, 4.5h, no-dur span, bare start, missing start → '', paren style.

## Step 2 — EventsDashboard.js

- Import line 22: drop `relDay`, add `fmtTimeRange24` (keep the function itself — other admin + staff consumers).
- `TIME_SLOTS` (26–34): push `{ value: "7:00 PM", label: "19:00" }` objects — **value stays 12h** (stored raw into `shifts.start_time`, read by staff portal; changing it would leak 24h to staff). Render sites :293/:301 → `<option key={t.value} value={t.value}>{t.label}</option>`.
- EventRow date cell (516–519):
  ```jsx
  <td>
    <div>{fmtDate(e.event_date && e.event_date.slice(0, 10))}</div>
    <div className="sub">{e.start_time ? fmtTimeRange24(e.start_time, e.end_time, e.event_duration_hours) : '—'}</div>
  </td>
  ```

## Step 2b — EventDetailPage dedupe

Replace the local `fmtTimeRange` (:35-55) with the shared helper. Call site :153 currently passes `(start, duration)` — remap to `fmtTimeRange24(proposal.event_start_time, null, proposal.event_duration_hours, { durStyle: 'paren' })` (proposals carry no stored end; derived end reproduces today's "18:00–23:00 (5 hrs)").

---

## Known accepted gaps

- `EventDetailPage.js:223` renders server-rendered `proposal.setup_time_display` (12h) — server out of scope; will sit next to 24h times until a server pass.
- Emails/SMS (incl. `AdminDashboard.js:573`), calendar feeds, staff portal, client-facing: unchanged by design.

## Verification (per lane)

1. `cd client && CI=true npx react-scripts test --watchAll=false src/components/adminos/format.test.js src/utils/setupTime.test.js src/utils/timeOptions.test.js`
2. `CI=true npx react-scripts build` (repo law for client changes; same gate as `.husky/pre-push`).
3. Browser smoke (restart the Claude-managed dev server first — no auto-reload):
   - **Lane A:** event detail roster + drawers 24h; "Confirmed HH:MM" without seconds; proposal detail, hiring dashboard, emails/tips/messages timestamps 24h with unchanged date style; admin TimePickers display/accept 24h and still store "HH:MM"; "Crew arrives 18:00". Regression: public proposal view + quote-wizard picker 12h; staff ShiftDetail 12h.
   - **Lane B:** events list sub-lines `18:00–23:00 · 5h`, no relative text; null-end row shows derived range; no-start row `—`; create-form dropdowns labeled 24h, created event stores "7:00 PM" (staff portal shows 12h for it); event-detail identity bar `18:00–23:00 (5 hrs)` unchanged.
4. Light review pass per lane (non-sensitive, display-only), squash-merge, delete lane. No push.
