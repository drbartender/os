# Mobile Admin Edit Sheet Layout (lane ma-e3b-edit-sheet-layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the phone edit sheet's layout to Dallas's design pass "readout above, controls pinned": everything that comes and goes sits in one readout between the head and the rows, and the four rows and the footer stay at the bottom of the screen, so nothing under a stepper can move.

**Architecture:** Client only, three files of code plus CSS. The pure view-model (`editSheetView.js`) gains `readoutView` (the readout's two top lines and its lines for every state) and the "was" lines; `useEditSheet.js` hands the sheet `readout` in place of `view`; `EditSheet.js` draws head, readout, rows, footer in that order. The readout has two parts: its copy (the total, the balance line, the reprice lines, the notes), which scrolls past the max height, and under it the notices, which do not scroll, so they are pinned above the rows as the rows are. The notify step fills the sheet's max height. The sheet drops the fixed height, the content floor and the notify-step scroll restore; its half-second arm also counts the sheet opening and every phase change; after a reload the fresh sheet takes focus. `index.css` carries the new block. Money behaviour is untouched: the reads, the preview, the payload, the re-read guard, the curfew retry and the notify step's logic are byte for byte what lane ma-e3 shipped.

**Tech Stack:** React 18, jest + RTL 13 (jest-dom imported per file, CRA `resetMocks: true`), `playwright-core` 1.61 driving `/opt/google/chrome/chrome` for the gate.

**Spec:** `docs/superpowers/specs/2026-08-13-mobile-admin-design.md`, section 3, "Design pass of 2026-10-06" (the contract for this lane, decisions and numbers), with the 2026-10-05 list above it for everything this lane keeps.

**Benchmark (Visual contract):** `docs/design-artifacts/2026-10-06-edit-sheet-layout/`, Dallas's export, snapshotted byte for byte, the working input. `Edit Details Sheet.dc.html` is the canvas (untouched, a change with three reprice lines, a figure loading; 390x844, 360x740, 320x568; both skins; two live demos); `EditSheetPhone.dc.html` is the sheet over the event detail and holds every number (inline styles). Render it: `python3 -I -m http.server 8765 --bind 127.0.0.1 --directory docs/design-artifacts/2026-10-06-edit-sheet-layout` inside one foreground command, headless Chrome on `Edit%20Details%20Sheet.dc.html`, stop the server by its PID (never `pkill -f`). Its own live figure under each phone, verified 2026-10-08: Duration's stepper top 164px and Guests' 116px above the screen bottom in all 20 frames; the untouched sheet 381px (readout 56px); three reprice lines 515px at 390 and 531px at 360 and 320.

**Scope:** `client/src/utils/editSheetView.js`, `client/src/components/mobile/useEditSheet.js`, `client/src/components/mobile/EditSheet.js`, their tests, `client/src/index.css`, README and ARCHITECTURE lines. Not touched: the server, the service worker, `EventDetailPhone.js` (the sheet's props do not change), the note sheet, the assignment sheet (it keeps `.m-sheet`'s 80dvh cap), the desktop editor.

**Proven context (verified against main `4430906a` on 2026-10-08; re-checked at `62e7e614`, after another window's lane merge `63f3eeef`: the lane's code files are unchanged, the README lines below moved by two):**
- Lane ma-e3 (`589092fc`) and ma-e3a (`675727cc`) are on origin (`git merge-base --is-ancestor`, both true; pushed 2026-10-07 in `5e6ae928..b3148da4`).
- `EditSheet.js` (386 lines): the arm `:55-78` (`viewSig = ready ? (pending || proposal) : null`, `holding = ready && ...`, so nothing is held while loading); the floor `:20-41` (with `holdFloor`'s comment `:20-24` and `dropFloor`'s `:33-36`) and `:113-131`; the notify scroll restore `:133-153` (the Confirm-focus effect `:154-158` stays); the render `:160-306` (rows, then the total block, hint, notices under the rows; `m-sheet-body` wraps both views); `NotifyStep` `:311-386`, whose message preview renders UNDER its channel boxes, only while the channel is ticked (`:328-355`).
- `useEditSheet.js:132` `const view = base ? confirmViewNow(...) : null`, returned as `view` (`:237`); `EditSheet.js` is its only consumer. The preview effect `:103-129` asks `/proposals/calculate` once as the sheet opens and again as guests or hours move; that first ask stays (spec: a date-only save reprices on the server when the catalog moved).
- `editSheetView.js`: `confirmView` `:183` (its balance line is the literal "balance due becomes ..." at `:207`), `confirmViewNow` `:217` (its pending return `:222` uses `ELLIPSIS`, `:32`), `setupMinutesText` `:110`, `sheetDateText` `:101`, `startInputValue` `:78`, `fmtHours` `:60`; imports `BOOKED_STATUSES`, `dollars`, `fmtTime24`. `buildRepriceSummary.newBalance` is `next - paid` on raw `amount_paid`; `financialsOf` (`eventDetailView.js:233`) owes `total - paid` on the same basis and reads "Overpaid" from `overpayment_cents` (`:302-310`), which `GET /proposals/:id` returns netted (`server/routes/proposals/getOne.js:133`).
- `useSheetFocus.js:13` focuses the sheet as it mounts; nothing focuses it again after a reload (the button that had focus unmounts).
- `index.css`: the global `.visually-hidden` (`:601`); the sheet family `:21728-21772` (`.m-sheet` caps at `max-height: 80dvh`, `.m-sheet-body { flex: 1; min-height: 0; overflow-y: auto; }`, so a sheet is as tall as its content up to its cap); the edit block `:21812-21849` (`.m-sheet.m-edit-sheet { height: 80dvh; }`, `.m-edit-content { display: flow-root; }`, `.m-stepper-value { min-width: 56px }`); the notify footer `:21883-21885`; the House Lights squared list `:21936-21940` (no stepper in it; `--radius` is 6px in both skins); reduced motion `:21966-21970`. `.m-stepper-*` and `.m-edit-*` classes are used only by `EditSheet.js` (and `.m-edit-note*` by `EventDetailSections.js`, untouched).
- `mobileClassContract.test.js`: every `m-*` class in `EditSheet.js` must appear as a selector in `index.css`. `mobileDetailCss.test.js:80` pins the reduced-motion block (`.m-sheet, .m-sheet-scrim { animation: none; }` then `.m-section-caret`).
- Sensitive-listed (`scripts/sensitive-paths.txt:469-471`): `useEditSheet.js`, `editSheetView.js`, `EditSheet.js`. Full lane fleet, and the sensitive-path re-review plus `/second-opinion` at push.
- `scripts/dev-signin.js` plants its token only on ports 3000 and 3001 (`DEV_PORTS`, `:41`). The admin skin is the `drb-admin-prefs-<user id>` localStorage entry (`UserPrefsContext.js:27-30`), `{"skin":"light"|"dark","density":"comfy","sidebar":"full"}`.

**Decisions this plan makes** are recorded in the spec, section 3, "Where the export is silent". With the export they are the complete contract for `ui-ux-review`; any other difference is a finding. The stepper's value slot is 68px, as the export draws it twice (its CSS and its note 05); the brief said 64px, and the plan follows the export.

## Global Constraints

- **No em dashes** in copy, comments, commit messages or docs.
- **Money behaviour is frozen.** No change to what is read, sent or saved, to the timeouts, the re-read guard, the curfew retry or the notify step's logic. `useEditSheet.js` changes one name (`view` becomes `readout`). The existing payload, preflight, guard, curfew and notify tests stay green unchanged.
- **Copy from the export, verbatim:** "Total", "New total", "paid <$> · balance due <$>", "balance due becomes <$>", "pricing" (drawn uppercase by CSS), "was <value>", "setup <N> min before", "···" (three U+00B7). Added: "paid <$> · overpaid <$>", and "pending" (heard by a screen reader in place of the dots). Everything else is lane ma-e3's approved copy, unchanged.
- **Unique `m-*` class names,** every one defined in `index.css`. **44px** minimum for every button and row.
- **Client tests:** `import '@testing-library/jest-dom'` in every test file; `jest.mock` factories close over `mock`-prefixed names only.
- **Client gate before every commit:** `cd client && CI=true npx react-scripts build` (exit 0; the html2pdf.js source-map warning is the only known warning).
- **File size:** `EditSheet.js` stays under 450 lines; if it would pass, `NotifyStep` moves to `client/src/components/mobile/EditSheetNotify.js` unchanged (and gets its README line).
- **Explicit staging only;** commit with `git commit -F - <<'MSG'` (no backticks in messages); never `npm install` inside the lane.
- **Known intermittents, not this work's:** `EventsListPhone.test.js` "scroll offsets are saved only after the loaded list has been restored" and one `AssignmentSheet.test.js` test; re-run the file alone before calling either a regression.

## Review Focus

1. **A double tap on Edit details, on Reload, or on a failed load's Retry,** where the second tap now lands on the scrim of a sheet that just got shorter (a content-sized sheet shrinks while it loads). Expected: the sheet stays open, nothing stacks. Pinned in Task 2.
2. **"Couldn't price the change." and "This event changed since you opened it." showing together at 320x568 with the copy scrolling,** and Retry tapped twice. Expected: the second tap lands on copy, never on Reload (which discards the edits). A single scrolling readout would fail this (a scrolling box keeps its top); the notices' own strip is what passes it. Pinned in Task 3 (the strip and its order) and the gate (G4).
3. **Email or Text ticked twice in the notify step.** Expected: the box does not move (its message showing or hiding under it no longer resizes the sheet), the step stays open, and nothing sends. Pinned in Task 3 (the step fills the max height) and the gate (G7).
4. **Rapid stepper taps at 320x568 while figures load and land,** with three reprice lines and the notes making the copy scroll. Expected: every tap lands on the same button; the stepper tops stay where the export measures them, and Reload and Keep editing stay put while the copy changes. Pinned in Task 3 (nothing between or under the rows; the strip) and the gate (G1, G4).
5. **An untouched readout on a fully paid or overpaid event.** Expected: "balance due $0.00", or "overpaid $Y" from the server's netted figure, never a negative. Pinned in Task 1.

## Lane map

```yaml
lanes:
  - id: ma-e3b-edit-sheet-layout
    phase: 3
    scope: >
      The phone edit sheet's layout, per the design pass of 2026-10-06
      ("readout above, controls pinned"): one readout between the head and the
      rows, its copy (the total, the balance line, the reprice lines, the notes)
      scrolling past the max height and its notices pinned under the copy; the
      rows (Date, Start with the setup under it, Duration, Guests) and the
      footer at the bottom of the screen; the sheet as tall as its content, at
      most the screen less 12px; the notify step at the max height. The
      half-second arm also counts the sheet opening and every phase change. No
      money, payload or server change. Visual fidelity to the export is owned
      here.
    inputs:
      - docs/design-artifacts/2026-10-06-edit-sheet-layout/Edit Details Sheet.dc.html
      - docs/design-artifacts/2026-10-06-edit-sheet-layout/EditSheetPhone.dc.html
    footprint:
      - client/src/utils/editSheetView.js
      - client/src/utils/editSheetView.test.js
      - client/src/components/mobile/useEditSheet.js
      - client/src/components/mobile/EditSheet.js
      - client/src/components/mobile/EditSheet.test.js
      - client/src/components/mobile/EditSheetNotify.js   # only if EditSheet.js would pass 450 lines
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [code-review, consistency-check, security-review, performance-review, ui-ux-review, second-opinion]
    # Three sensitive-listed files, so the full fleet. security-review: the
    # payload and guards must be untouched, the readout's money figures true.
    # consistency-check: the readout's balance and overpaid line against the
    # summary's and the detail's. performance-review: a layout effect measuring
    # the readout after every render. ui-ux-review: the export, the spec's
    # decisions, both skins, 390, 360 and 320. second-opinion at push.
```

**Execution (Dallas, 2026-10-07):** subagent-driven; implementers on Opus; each task's review (spec and quality, one reviewer) on Fable if its credits are back, else Opus. Tasks 1, 2 and 3 are serial (2 and 3 share `EditSheet.js`). Task 4 (the signed-in browser gate) and Task 5 (lane close) are the orchestrator's: subagents cannot mint the dev session. **Order:** Task 1 and its review; Task 2 and its review; Task 3; Task 4 (the gate); then Task 3's review, with Task 4's table in its brief, because the gate is the only real-layout evidence for this lane's central risk; then Task 5. A gate FAIL goes back to Task 3's implementer before that review.

**Each task reviewer's brief** carries: this header through "Who writes what"; the task's own text with its Interfaces block; the Review Focus lines that name the task; Self-Review item 1's mapping for the task (the spec checklist); the spec's "Design pass of 2026-10-06" bullet; the task's commit diff; and for Task 3, Task 4's table and screenshots. Every reviewer looks for the tap-stability family as a family: anything that moves, appears or leaves under a finger, with the double-tap timing per swap.

**Who writes what.** An implementer sees this header and their own task, commits only the paths their task names, and reports anything the plan should record. The plan and the spec live on main and are edited there by the orchestrator, never from the lane.

---

### Task 1: The readout's view-model and the "was" lines

**Files:**
- Modify: `client/src/utils/editSheetView.js`
- Test: `client/src/utils/editSheetView.test.js`
- Test: `client/src/components/mobile/EditSheet.test.js:8,680` (one assertion follows the new pending glyph, so this commit stays green)

**Interfaces:**
- Consumes: `confirmViewNow`, `confirmView`, `BOOKED_STATUSES`, `dollars`, `sheetDateText`, `startInputValue`, `fmtHours`, `setupMinutesText`, `fmtTime24` (all already in or imported by this module).
- Produces: `PENDING_FIGURE` (string, three U+00B7); `BALANCE_BECOMES` (`'balance due becomes'`); `readoutView({ proposal, preview, shown, changed })` returning `{ label: 'Total'|'New total', old: string|null, now: string, sub: string|null, pricing: boolean, dim: boolean, pending: boolean, lines: string[], button: 'Done'|'Confirm new total' }`; `wasLine(field, initial, now, todayYmd)` returning `string|null` for `field` in `event_date`, `event_start_time`, `event_duration_hours`, `guest_count`; `startSubLine(proposal, initial, now)` returning `string|null`. `confirmViewNow`'s pending return gains `pending: true` and draws `PENDING_FIGURE` in place of the ellipsis.

- [ ] **Step 1: Write the failing tests**

In `EditSheet.test.js`, import `PENDING_FIGURE` beside `READ_TIMEOUT_MS` (`:8`, `import { READ_TIMEOUT_MS, PENDING_FIGURE } from '../../utils/editSheetView';`) and, in the test `while the next figure loads the last one stays, dimmed, and Confirm waits for the new one`, replace `String.fromCharCode(0x2026)` with `PENDING_FIGURE` (`:680`; Task 3 rewrites that test whole).

In `editSheetView.test.js`, add `readoutView, wasLine, startSubLine, PENDING_FIGURE` to the import list from `./editSheetView`. Replace the test `before any figure describes a change: the stored total and an ellipsis, and no lines` with:

```js
  test('before any figure describes a change: the stored total and three dots, and no lines', () => {
    const atOpen = { state: 'ready', total: 3650, gratuityTotal: 120 };
    for (const shown of [null, atOpen]) {
      expect(confirmViewNow({ proposal: booked, preview: { state: 'loading' }, shown, changed: true })).toMatchObject({
        repriced: true, stale: true, pending: true, oldTotal: '$3,650.00', newTotal: PENDING_FIGURE, balanceLine: null, lines: [], button: 'Confirm new total',
      });
    }
  });
```

After the `confirmViewNow` describe block, add:

```js
// ma-e3b (design pass 2026-10-06): the readout's two top lines.
describe('readoutView', () => {
  const booked = {
    status: 'deposit_paid', total_price: '3650.00', amount_paid: '1900.00', off_contract_paid_cents: 0,
    gratuity_rate_change_origin: null, pricing_snapshot: { gratuity: { total: 120 } },
  };
  const landed = { state: 'ready', total: 3800, gratuityTotal: 120 };
  test('untouched: the stored total, what is paid and the balance, and Done, before any figure lands', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: null, changed: false })).toEqual({
      label: 'Total', old: null, now: '$3,650.00', sub: 'paid $1,900.00 · balance due $1,750.00',
      pricing: false, dim: false, pending: false, lines: [], button: 'Done',
    });
  });
  test('the balance is floored at $0.00 when nothing is netted as overpaid', () => {
    for (const [paid, shown] of [['3650.00', '$3,650.00'], ['4000.00', '$4,000.00']]) {
      expect(readoutView({ proposal: { ...booked, amount_paid: paid }, preview: null, shown: null, changed: false }).sub)
        .toBe(`paid ${shown} · balance due $0.00`);
    }
  });
  test('an overpaid row says so, from the server\'s netted figure, in place of a balance of $0.00', () => {
    expect(readoutView({ proposal: { ...booked, amount_paid: '4000.00', overpayment_cents: 35000 }, preview: null, shown: null, changed: false }).sub)
      .toBe('paid $4,000.00 · overpaid $350.00');
  });
  test('a change that leaves the total where it was reads as untouched', () => {
    const atOpen = { state: 'ready', total: 3650, gratuityTotal: 120 };
    expect(readoutView({ proposal: booked, preview: atOpen, shown: atOpen, changed: true }))
      .toMatchObject({ label: 'Total', now: '$3,650.00', sub: 'paid $1,900.00 · balance due $1,750.00', pending: false, button: 'Done' });
  });
  test('a landed figure: New total, old to new, the balance it becomes, the lines', () => {
    const r = readoutView({ proposal: booked, preview: landed, shown: landed, changed: true });
    expect(r).toMatchObject({
      label: 'New total', old: '$3,650.00', now: '$3,800.00', sub: 'balance due becomes $1,900.00',
      pricing: false, dim: false, pending: false, button: 'Confirm new total',
    });
    expect(r.lines[r.lines.length - 1]).toBe('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.');
  });
  test('while the next figure loads, the last one stays, dimmed, under PRICING', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: landed, changed: true }))
      .toMatchObject({ label: 'New total', now: '$3,800.00', sub: 'balance due becomes $1,900.00', pricing: true, dim: true, pending: false });
  });
  test('before any figure describes the change: three dots under PRICING, nothing dimmed', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'loading' }, shown: null, changed: true })).toEqual({
      label: 'New total', old: '$3,650.00', now: PENDING_FIGURE, sub: `balance due becomes ${PENDING_FIGURE}`,
      pricing: true, dim: false, pending: true, lines: [], button: 'Confirm new total',
    });
  });
  test('a failed figure keeps the last one dimmed, with no PRICING', () => {
    expect(readoutView({ proposal: booked, preview: { state: 'failed' }, shown: landed, changed: true }))
      .toMatchObject({ now: '$3,800.00', pricing: false, dim: true, pending: false });
  });
  test('an unbooked row carries no balance line', () => {
    expect(readoutView({ proposal: { ...booked, status: 'accepted' }, preview: null, shown: null, changed: false }).sub).toBeNull();
  });
});

describe('was lines', () => {
  const initial = { event_date: '2999-08-15', event_start_time: '7:00 PM', event_duration_hours: 4, guest_count: 140 };
  test('nothing for a field that has not changed', () => {
    for (const field of Object.keys(initial)) expect(wasLine(field, initial, initial, '2026-10-08')).toBeNull();
  });
  test('what a changed field held when the sheet opened', () => {
    expect(wasLine('event_duration_hours', initial, { ...initial, event_duration_hours: 4.5 })).toBe('was 4 hr');
    expect(wasLine('guest_count', initial, { ...initial, guest_count: 145 })).toBe('was 140');
    expect(wasLine('event_date', initial, { ...initial, event_date: '2999-08-22' }, '2026-10-08')).toBe('was THU AUG 15 2999');
    expect(wasLine('event_start_time', initial, { ...initial, event_start_time: '20:00' })).toBe('was 19:00');
  });
  test('the same start in another shape is not a change', () => {
    expect(wasLine('event_start_time', initial, { ...initial, event_start_time: '19:00' })).toBeNull();
  });
  test('a stored value that cannot be read says nothing', () => {
    expect(wasLine('event_start_time', { ...initial, event_start_time: 'later' }, { ...initial, event_start_time: '20:00' })).toBeNull();
  });
  test('the line under Start: what it was, once changed, then the setup', () => {
    const p = { setup_time_display: '18:15', event_start_time: '7:00 PM' };
    expect(startSubLine(p, initial, initial)).toBe('setup 45 min before');
    expect(startSubLine(p, initial, { ...initial, event_start_time: '20:00' })).toBe('was 19:00 · setup 45 min before');
    expect(startSubLine({}, initial, initial)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/editSheetView.test.js`
Expected: FAIL (`readoutView is not a function`, `PENDING_FIGURE` undefined).

- [ ] **Step 3: Implement**

In `editSheetView.js`, replace `const ELLIPSIS = String.fromCharCode(0x2026);` with:

```js
// A figure not yet known, as the design pass draws it (2026-10-06): three middle dots.
export const PENDING_FIGURE = String.fromCharCode(0xb7).repeat(3);
// The second line after a change, before its figure.
export const BALANCE_BECOMES = 'balance due becomes';
```

In `confirmView`, build the balance line from the constant: `` balanceLine: booked && known ? `${BALANCE_BECOMES} ${dollars(Math.max(0, Number(summary.newBalance) || 0))}` : null, `` (same text as today).

In `confirmViewNow`, change the comment's "the stored total and an ellipsis" to "the stored total and three dots", and its last line to:

```js
  return { ...last, repriced: true, stale: true, pending: true, newTotal: PENDING_FIGURE, button: 'Confirm new total' };
```

After `confirmViewNow`, add:

```js
// The readout's two top lines and its lines (design pass 2026-10-06, "readout
// above, controls pinned"). Untouched, or after a change that leaves the total
// where it was: the booking as it stands, from the event row. After a change
// that reprices: "New total", old and new, the balance it becomes, and the
// reprice lines. While the next figure is on its way the last one stays,
// dimmed, under PRICING; before any figure describes the change, three dots
// (pending). Paid is amount_paid and the balance the total less paid, floored
// at zero: the basis of the shared summary's newBalance and of the detail's
// Financials, so the three agree; an overpaid row reads the server's netted
// overpayment_cents, as the detail's Financials does.
export function readoutView({ proposal, preview, shown, changed }) {
  const p = proposal || {};
  const v = confirmViewNow({ proposal: p, preview, shown, changed });
  const booked = BOOKED_STATUSES.includes(p.status);
  if (!v.repriced) {
    const total = Number(p.total_price) || 0;
    const paid = Number(p.amount_paid) || 0;
    const over = Number(p.overpayment_cents) || 0;
    let sub = null;
    if (booked) {
      sub = over > 0
        ? `paid ${dollars(paid)} · overpaid ${dollars(over / 100)}`
        : `paid ${dollars(paid)} · balance due ${dollars(Math.max(0, total - paid))}`;
    }
    return { label: 'Total', old: null, now: dollars(total), sub, pricing: false, dim: false, pending: false, lines: [], button: v.button };
  }
  const pending = !!v.pending;
  return {
    label: 'New total',
    old: v.oldTotal,
    now: v.newTotal,
    sub: pending ? (booked ? `${BALANCE_BECOMES} ${PENDING_FIGURE}` : null) : v.balanceLine,
    pricing: !!changed && !!preview && preview.state === 'loading',
    dim: !!v.stale && !pending,
    pending,
    lines: v.lines,
    button: v.button,
  };
}

// What a changed field held when the sheet opened ("was 3 hr", design pass
// 2026-10-06), drawn under its label inside the row. Null for a field that has
// not changed, or one whose stored value cannot be read.
export function wasLine(field, initial, now, todayYmd) {
  if (!initial || !now) return null;
  const a = initial[field];
  const b = now[field];
  let was = '';
  if (field === 'event_date') was = a !== b ? sheetDateText(a, todayYmd) : '';
  else if (field === 'event_start_time') was = fmtTime24(a) !== fmtTime24(b) ? startInputValue(a) : '';
  else if (field === 'event_duration_hours') was = Number(a) !== Number(b) ? fmtHours(a) : '';
  else if (field === 'guest_count') was = Number(a) !== Number(b) ? String(Number(a)) : '';
  return was ? `was ${was}` : null;
}

// The line under Start: what it was, once changed, then the setup ("setup 45
// min before"; "setup from 17:15" when the stored start cannot be read).
export function startSubLine(proposal, initial, now) {
  const setup = setupMinutesText(proposal);
  return [wasLine('event_start_time', initial, now), setup ? `setup ${setup}` : null].filter(Boolean).join(' · ') || null;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/utils/editSheetView.test.js src/components/mobile/EditSheet.test.js`
Expected: PASS, every test in both files.

- [ ] **Step 5: Build and commit**

Run: `cd client && CI=true npx react-scripts build` (exit 0).

```bash
git add client/src/utils/editSheetView.js client/src/utils/editSheetView.test.js client/src/components/mobile/EditSheet.test.js
git commit -F - <<'MSG'
feat(phone): the edit sheet readout's view-model and the was lines

readoutView gives the readout's two top lines for every state (Total with
paid and balance, or overpaid from the server's netted figure; New total
with the balance it becomes; the last figure dimmed under PRICING; three
dots before any figure). wasLine and startSubLine give the line under a
changed field's label.
MSG
```

### Task 2: The arm covers the sheet opening and every phase change

Task 2 lands the protection before the layout that needs it: on today's 80dvh sheet a phase change moves nothing, so the only visible effect until Task 3 is the half-second hold on the loading sheet's scrim; its tests hold either way. A reviewer reading it against main should judge it as preparation for Task 3, not as a fix to the 80dvh sheet.

**Files:**
- Modify: `client/src/components/mobile/EditSheet.js:55-78`, the failed state's Retry (`:202`), and one effect after `useSheetFocus` (`:93`)
- Test: `client/src/components/mobile/EditSheet.test.js`

**Interfaces:**
- Consumes: `sheet.phase` (`'loading' | 'ready' | 'failed' | 'locked'`), `sheet.pending`, `sheet.proposal`.
- Produces: `holding` (boolean), now true for `armDelayMs` after the sheet mounts and after every phase change, in any phase; the dialog takes focus when the sheet returns to ready without focus inside it. Task 3 keeps both as they are.

- [ ] **Step 1: Write the failing tests**

Append to `EditSheet.test.js`, after the last test. `MOVED` is the existing constant (declared before `toStaleNotice`); Task 3 deletes `toStaleNotice` and keeps `MOVED`.

```js
// ma-e3b (design pass 2026-10-06): the sheet is as tall as its content, so a
// phase change moves its top edge, and the second tap of a double tap can land
// on the scrim. The sheet opening and every phase change arm too.
function serveStale(reloadRead) {
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      reads += 1;
      if (reads === 1) return Promise.resolve({ data: PROPOSAL });
      if (reads === 2) return Promise.resolve({ data: MOVED });   // the re-read before the PATCH: moved
      return reloadRead();
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404 });
  });
  api.post.mockImplementation((url) => (url === '/proposals/calculate'
    ? Promise.resolve({ data: { total: 3800, gratuity: { total: 120 } } })
    : Promise.resolve({ data: { notices: [] } })));
}
const pastTheArm = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 350); }); });

test('the sheet opening holds the scrim and Escape for the arm, while the event still loads', async () => {
  api.get.mockImplementation(() => new Promise(() => {}));   // the reads have not answered
  const { onClose } = mount({ armDelayMs: 300 });
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  // The second tap of a double tap on Edit details, on the scrim above a short sheet.
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await pastTheArm();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Reload holds the scrim and Escape while the event reloads, so a double tap on Reload leaves the sheet open', async () => {
  serveStale(() => new Promise(() => {}));   // the reload has not answered
  const { onClose } = mount({ armDelayMs: 300 });
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'More guests' })).toBeEnabled());
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(screen.getByText('Loading the event')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await pastTheArm();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a failed load\'s Retry is held for the arm, then takes a tap', async () => {
  serve({ proposal: { reject: NETWORK } });
  mount({ armDelayMs: 300 });
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await ready();
});

test('after a reload the fresh sheet takes focus, since the button that had it is gone', async () => {
  serveStale(() => Promise.resolve({ data: MOVED }));
  mount();
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('150')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Edit details' })).toHaveFocus();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js -t "arm, while|double tap on Reload leaves|failed load's Retry|fresh sheet takes focus"`
Expected: FAIL: the scrim and Escape both close the loading sheet (`onClose` called twice), Retry is enabled at once, and focus is on the document body after the reload.

- [ ] **Step 3: Implement**

Replace the arm block, from the comment `// One arm for the whole sheet.` through `const holding = ...`, with:

```js
  // One arm for the whole sheet. Each time the sheet swaps the view under the
  // finger, the new view's controls, the scrim and Escape wait armDelayMs
  // before they take a tap: the second tap of a double tap lands on whatever
  // replaced the first tap's target. A swap is the sheet opening, every change
  // of phase (loading, ready, failed, locked), the notify step opening, and the
  // step going back to the form. The sheet is as tall as its content (design
  // pass 2026-10-06), so a phase change moves its top edge, and a double tap on
  // Edit details or Reload would otherwise land on the scrim. A change inside a
  // view (a figure landing, a notice or an error coming or going, a step that
  // withdraws the curfew confirm) is not a swap. The swap is counted in the
  // render that shows the new view (state adjusted during render), so its
  // controls are held from its very first commit.
  const viewSig = ready ? (sheet.pending || sheet.proposal) : sheet.phase;
  const [seenSig, setSeenSig] = useState(viewSig);
  const [swaps, setSwaps] = useState(1);   // the opening is the first swap
  if (seenSig !== viewSig) {
    setSeenSig(viewSig);
    setSwaps((n) => n + 1);
  }
  const [armedAt, setArmedAt] = useState(0);
  useEffect(() => {
    if (armDelayMs <= 0) return undefined;
    const done = swaps;
    const timer = setTimeout(() => setArmedAt(done), armDelayMs);
    return () => clearTimeout(timer);
  }, [swaps, armDelayMs]);
  const holding = armDelayMs > 0 && armedAt !== swaps;
```

In the failed state, hold Retry for the arm:

```jsx
                <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.reload}>Retry</button>
```

Right after `useSheetFocus(sheetRef, closers);`, add:

```js
  // After a reload, or a failed load's Retry, the button that had focus is
  // gone: the fresh sheet takes it back (the dialog), as the opening does.
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (sheet.phase === 'ready' && el && !el.contains(document.activeElement)) el.focus();
  }, [sheet.phase]);
```

- [ ] **Step 4: Run the file to verify everything passes**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js`
Expected: PASS, every test, including the existing arm tests ("nothing else arms" among them) unchanged.

- [ ] **Step 5: Build and commit**

Run: `cd client && CI=true npx react-scripts build` (exit 0).

```bash
git add client/src/components/mobile/EditSheet.js client/src/components/mobile/EditSheet.test.js
git commit -F - <<'MSG'
fix(phone): the edit sheet's arm counts its opening and every phase change

A content-sized sheet gets shorter while it loads, so the second tap of a
double tap on Edit details or Reload would land on the scrim and close it.
The scrim, Escape and a failed load's Retry now wait the half second too,
and after a reload the fresh sheet takes focus back.
MSG
```

### Task 3: Readout above, controls pinned

**Files:**
- Modify: `client/src/components/mobile/useEditSheet.js:11,132,237`
- Modify: `client/src/components/mobile/EditSheet.js` (imports, header comment, delete the floor and the notify scroll restore, add the fade, the render)
- Modify: `client/src/index.css` (the edit sheet block, the House Lights squared list, reduced motion)
- Test: `client/src/components/mobile/EditSheet.test.js`
- Read, not changed: `client/src/utils/mobileDetailCss.test.js:80` (it pins the reduced-motion block Step 5 edits: `.m-sheet-scrim { animation: none; }` verbatim, then `.m-section-caret`)
- Modify: `README.md:603,610`, `ARCHITECTURE.md:2098`

**Interfaces:**
- Consumes: Task 1's `readoutView`, `wasLine`, `startSubLine`, `PENDING_FIGURE`, `BALANCE_BECOMES`; Task 2's `holding` and its focus effect.
- Produces: the hook returns `readout` (Task 1's shape) in place of `view`; the DOM the gate measures: `.m-sheet.m-edit-sheet` (with `.m-edit-notifying` while the notify step is open) > `.m-sheet-handle`, `.m-sheet-head`, `.m-edit-readout` (the copy), `.m-edit-notices` (the strip, empty when no notice shows), `.m-edit-rows` (exactly four `.m-sheet-row`), `.m-acts.m-edit-acts`; in the notify step `.m-sheet-body` and `.m-acts.m-acts-notify.m-edit-acts`; the steppers' buttons keep their names (Shorter, Longer, Fewer guests, More guests).

- [ ] **Step 1: Rewrite and add the tests**

In `EditSheet.test.js`:

1. `PENDING_FIGURE` is already imported (Task 1).
2. Replace the test `the head, the rows as drawn, the stored values, and Setup with no arrow` with:

```js
test('the head, the readout, its notices, then Date, Start, Duration and Guests, then the footer; Setup is the line under Start', async () => {
  serve();
  mount();
  await ready();
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  // eslint-disable-next-line testing-library/no-node-access
  expect([...dialog.children].map((el) => el.className)).toEqual(['m-sheet-handle', 'm-sheet-head', 'm-edit-readout', 'm-edit-notices', 'm-edit-rows', 'm-acts m-edit-acts']);
  // eslint-disable-next-line testing-library/no-node-access
  expect(dialog.querySelector('.m-edit-notices').children).toHaveLength(0);
  // eslint-disable-next-line testing-library/no-node-access
  const names = [...dialog.querySelector('.m-edit-rows').children].map((row) => row.querySelector('.m-edit-label').firstChild.textContent);
  expect(names).toEqual(['Date', 'Start', 'Duration', 'Guests']);
  expect(screen.getByText('event edit · reprices the booking')).toBeInTheDocument();
  expect(screen.getByText('THU AUG 15 2999')).toBeInTheDocument();
  expect(screen.getByLabelText('Start')).toHaveValue('19:00');
  expect(screen.getByText('setup 45 min before')).toBeInTheDocument();
  expect(screen.queryByText('Setup')).toBeNull();
  expect(screen.getByText('4 hr')).toBeInTheDocument();
  expect(screen.getByText('140')).toBeInTheDocument();
});
```

3. In `an untouched sheet says Done and closes without a request`, before `fireEvent.click(confirmBtn())`, add:

```js
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.getByText('$3,650.00')).toBeInTheDocument();
  expect(screen.getByText('paid $1,900.00 · balance due $1,750.00')).toBeInTheDocument();
```

4. In `a change asks the server for the new total and shows the booked lines`, change the comment to `// The readout says New total at once (three dots), then the figure lands in it.` and add after the "Unlocked invoices" assertion:

```js
  // Plain lines, no bullet indent (design pass 2026-10-06).
  expect(screen.getByText('Unlocked invoices will be rebuilt at the new pricing. Locked and manual invoices stay untouched.').tagName).toBe('P');
```

5. Replace `while the next figure loads the last one stays, dimmed, and Confirm waits for the new one` with:

```js
test('while the next figure loads the last one stays, dimmed under PRICING, and Confirm waits for the new one', async () => {
  serve();
  const asks = [];
  const served = api.post.getMockImplementation();
  api.post.mockImplementation((url, body, config) => (url === '/proposals/calculate'
    ? new Promise((resolve) => { asks.push({ guests: body.guest_count, resolve }); })
    : served(url, body, config)));
  const ask = (guests) => asks.filter((a) => a.guests === guests).pop();
  // eslint-disable-next-line testing-library/no-node-access
  const figure = () => screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-figure');
  mount();
  await ready();
  // Untouched: the stored booking at once, before the figure asked at open has landed.
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.getByText('paid $1,900.00 · balance due $1,750.00')).toBeInTheDocument();
  await waitFor(() => expect(ask(140)).toBeDefined());
  await act(async () => { ask(140).resolve({ data: { total: 3650, gratuity: { total: 120 } } }); });
  // The first change, before any figure describes it: three dots under PRICING, nothing dimmed.
  more('More guests');
  expect(screen.getByText('New total')).toBeInTheDocument();
  expect(screen.getAllByText(PENDING_FIGURE)).toHaveLength(2);   // the figure and the balance line
  expect(screen.getByText('balance due becomes')).toBeInTheDocument();
  expect(screen.getByText('pricing')).toBeInTheDocument();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(figure()).toHaveAttribute('aria-busy', 'true');
  expect(confirmBtn()).toHaveTextContent('Confirm new total');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(145)).toBeDefined());
  await act(async () => { ask(145).resolve({ data: { total: 3800, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.queryByText('pricing')).toBeNull();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(figure()).not.toHaveAttribute('aria-busy');
  expect(confirmBtn()).toBeEnabled();
  // A further step: the figure that landed stays, with its balance line, dimmed under PRICING.
  more('More guests');
  expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  expect(screen.getByText('balance due becomes $1,900.00')).toBeInTheDocument();
  expect(screen.getByText('pricing')).toBeInTheDocument();
  expect(figure()).toHaveClass('m-edit-dim');
  expect(confirmBtn()).toBeDisabled();
  await waitFor(() => expect(ask(150)).toBeDefined());
  await act(async () => { ask(150).resolve({ data: { total: 3900, gratuity: { total: 120 } } }); });
  expect(screen.getByText('$3,900.00')).toBeInTheDocument();
  expect(figure()).not.toHaveClass('m-edit-dim');
  expect(confirmBtn()).toBeEnabled();
  // Back to the stored values: the readout reads Total again, and Done closes.
  more('Fewer guests');
  more('Fewer guests');
  expect(screen.getByText('Total')).toBeInTheDocument();
  expect(screen.queryByText('New total')).toBeNull();
  expect(confirmBtn()).toHaveTextContent('Done');
  expect(confirmBtn()).toBeEnabled();
});
```

6. Replace `the edit sheet keeps one height, so a figure that loads, lands or leaves never moves the steppers` with:

```js
test('the stylesheet: as tall as its content up to the screen less 12px (scrolling whole only when even that is too short), the notify step at the max, the copy scrolls, the notices, rows and footer hold, a 68px value, a square light stepper, PRICING still under reduced motion', () => {
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-sheet\.m-edit-sheet \{ max-height: calc\(100dvh - 12px\); overflow-y: auto; \}/);
  expect(css).not.toMatch(/\.m-edit-sheet \{[^}]*(^|[^-])height:/m);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-sheet\.m-edit-sheet\.m-edit-notifying \{ height: calc\(100dvh - 12px\); \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-readout \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-notices \{ flex: none; padding: 0 16px; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-edit-rows \{ flex: none; \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-acts\.m-edit-acts \{ flex: none; padding: 10px 16px 14px; border-top: 1px solid var\(--line-1\); \}/);
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-stepper-value \{[^}]*width: 68px;/);
  expect(css).toMatch(/\[data-skin="light"\] \.m-stepper-ctl \{ border-radius: 0; \}/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.m-edit-pricing \{ animation: none; \}/);
  expect(css).not.toMatch(/m-edit-content|m-edit-total-stale|m-edit-static/);
});
```

7. In `the stylesheet: the light stepper keeps its corners, the staff channels dim while off, the autopay notice is tinted as a warning`, delete its first assertion (the `.m-stepper-ctl` one) and retitle it `the stylesheet: the staff channels dim while off, the autopay notice is tinted as a warning`.
8. Delete these tests and helpers whole: `the body content never shrinks while the sheet is open: ...` with its comment, `back from the notify step, the edit view is scrolled where it was, ...`, the function `toStaleNotice`, the function `withCountedHeights` with its comment, `Reload from the stale notice drops the floor ...` and `a failed reload's line and Retry, and the locked message, are not left under a stale floor`, and the "Fold round E" comment above `MOVED`. KEEP `const MOVED` (Task 2's `serveStale` reads it).
9. Add, after the Task 2 tests:

```js
// ma-e3b: readout above, controls pinned.
test('the copy holds what comes and goes in order, the notices sit in their own strip under it, and the rows hold only the four rows', async () => {
  let failing = false;
  let reads = 0;
  api.get.mockImplementation((url) => {
    if (url === '/proposals/13') {
      reads += 1;
      return Promise.resolve({ data: reads === 1 ? { ...PROPOSAL, settled_extension_hours: 1, contract_floor_hours: 3 } : MOVED });
    }
    if (url === '/proposals/packages') return Promise.resolve({ data: [PKG] });
    if (url === '/proposals/addons') return Promise.resolve({ data: [BARBACK] });
    return Promise.reject({ status: 404 });
  });
  api.post.mockImplementation((url) => (url === '/proposals/calculate'
    ? (failing ? Promise.reject(NETWORK) : Promise.resolve({ data: { total: 3800, gratuity: { total: 120 } } }))
    : Promise.resolve({ data: { notices: [] } })));
  mount({ shiftCount: 2 });
  await ready();
  more('More guests');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  await screen.findByRole('button', { name: 'Reload' });   // changed since you opened it
  failing = true;
  more('More guests');   // a step while that notice shows; its figure fails
  await screen.findByText("Couldn't price the change.");
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  // eslint-disable-next-line testing-library/no-node-access
  const copy = [...dialog.querySelector('.m-edit-readout').children].map((el) => el.textContent);
  expect(copy[0]).toMatch(/^New total/);
  expect(copy.slice(1)).toEqual([
    'Includes 1h of on-site extension, billed on its own invoice. The contract prices 3h.',
    'This event has 2 shifts. Changing the date or time here does not move them; each shift is edited from desktop view.',
  ]);
  // eslint-disable-next-line testing-library/no-node-access
  expect([...dialog.querySelector('.m-edit-notices').children].map((el) => el.textContent)).toEqual([
    "Couldn't price the change.Retry",
    'This event changed since you opened it.Reload',
  ]);
  // eslint-disable-next-line testing-library/no-node-access
  expect(dialog.querySelector('.m-edit-rows').children).toHaveLength(4);
});

test('the curfew confirm is the strip\'s last notice, right above the rows, and Keep editing leaves the save\'s line there', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }), patch: () => Promise.reject(CURFEW_NO) });
  mount({ shiftCount: 2 });
  await ready();
  more('Longer');
  await waitFor(() => expect(confirmBtn()).toBeEnabled());
  fireEvent.click(confirmBtn());
  const keep = await screen.findByRole('button', { name: 'Keep editing' });
  // eslint-disable-next-line testing-library/no-node-access
  const notices = screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-notices');
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toHaveClass('m-confirm');
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toContainElement(keep);
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.nextElementSibling).toHaveClass('m-edit-rows');
  fireEvent.click(keep);
  // eslint-disable-next-line testing-library/no-node-access
  expect(notices.lastElementChild).toHaveTextContent('Not saved. The end time is past our 2:00 AM service curfew.');
});

test('a changed field says what it was, inside its row', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  expect(screen.queryByText(/^was /)).toBeNull();
  more('Longer');
  more('More guests');
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-08-22' } });
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '20:00' } });
  // eslint-disable-next-line testing-library/no-node-access
  const rowOf = (text) => screen.getByText(text).closest('.m-sheet-row');
  expect(rowOf('was 4 hr')).toBe(rowOf('Duration'));
  expect(rowOf('was 140')).toBe(rowOf('Guests'));
  expect(rowOf('was THU AUG 15 2999')).toBe(rowOf('Date'));
  expect(rowOf('was 19:00 · setup 45 min before')).toBe(rowOf('Start'));
  more('Shorter');   // back to the stored hours, the line goes
  expect(screen.queryByText('was 4 hr')).toBeNull();
});

test('the fade at the copy\'s foot shows whenever the copy overflows, as the export draws it', async () => {
  serve({ calculate: () => ({ total: 3800, gratuity: { total: 120 } }) });
  mount();
  await ready();
  // eslint-disable-next-line testing-library/no-node-access
  const readout = screen.getByRole('dialog', { name: 'Edit details' }).querySelector('.m-edit-readout');
  // eslint-disable-next-line testing-library/no-node-access
  const fade = () => readout.querySelector('.m-edit-fade');
  expect(fade()).toBeNull();
  // jsdom has no layout: 300px of copy in a 200px box; a step re-renders and re-measures.
  let height = 300;
  Object.defineProperty(readout, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(readout, 'clientHeight', { configurable: true, get: () => 200 });
  more('More guests');
  expect(fade()).not.toBeNull();
  height = 200;   // it fits again
  more('Fewer guests');
  expect(fade()).toBeNull();
});

test('the notify step fills the sheet\'s max height while it is open, so a channel\'s message showing or hiding moves nothing', async () => {
  await toNotifyStep();
  const dialog = screen.getByRole('dialog', { name: 'Edit details' });
  expect(dialog).toHaveClass('m-edit-notifying');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(dialog).not.toHaveClass('m-edit-notifying');
});

test('a screen reader hears the two top lines as one, and "pending" in place of the three dots', async () => {
  serve();
  api.post.mockImplementation(() => new Promise(() => {}));   // no figure ever lands
  mount();
  await ready();
  more('More guests');
  // eslint-disable-next-line testing-library/no-node-access
  const live = screen.getByText('New total').closest('[aria-live]');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live).toHaveAttribute('aria-atomic', 'true');
  expect(live).toHaveTextContent('balance due becomes');
  expect(screen.getAllByText('pending')).toHaveLength(2);
  for (const dots of screen.getAllByText(PENDING_FIGURE)) expect(dots).toHaveAttribute('aria-hidden', 'true');
});
```

- [ ] **Step 2: Run the file to verify the new tests fail**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js`
Expected: FAIL on the rewritten and new tests (no `.m-edit-readout` or `.m-edit-notices`, Setup still a row, no "Total" line, no `m-edit-notifying`, no live region); everything else passes.

- [ ] **Step 3: The hook**

In `useEditSheet.js`: import `readoutView` in place of `confirmViewNow`; replace `:132` with `const readout = base ? readoutView({ proposal: base.proposal, preview, shown, changed }) : null;`; return `readout,` in place of `view,`. Nothing else changes in this file.

- [ ] **Step 4: The sheet**

In `EditSheet.js`:

1. Imports: `import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';`; from `editSheetView` drop `setupMinutesText` and add `wasLine, startSubLine, PENDING_FIGURE, BALANCE_BECOMES`.
2. Delete `holdFloor` and `dropFloor` with their comment blocks (`:20-24`, `:33-36`), and the block from `// The content's floor, from the moment the sheet opens` through the ResizeObserver effect (`bodyRef`, `contentRef`, `floor`).
3. Replace the header comment above `export default function EditSheet` with:

```js
// The phone edit sheet for an EVENT (lane ma-e3; spec 2026-08-13-mobile-admin
// section 3, the brainstorm decisions of 2026-10-05 and the design pass of
// 2026-10-06; benchmark docs/design-artifacts/2026-10-06-edit-sheet-layout).
// This file draws; useEditSheet.js reads and writes. Mounted only while open;
// the owner holds the URL state (useDrawerParam, push). "Readout above,
// controls pinned": everything that comes and goes is in one readout between
// the head and the rows. Its copy (the total, the reprice lines, the notes)
// scrolls past the max height; its notices sit under the copy and do not
// scroll; the notices, the rows and the footer sit at the bottom of the
// screen. The sheet is as tall as its content, at most the screen less 12px,
// so when the copy changes only the head moves. The notify step fills the max
// height, so a channel's message showing or hiding moves nothing.
```

4. After the imports, add `const ARROW = String.fromCharCode(0x2192);`
5. Replace the step-change block (from `// A step change moves focus too:` through its `useLayoutEffect`) with:

```js
  // A step change moves focus: into the notify step's heading as it opens (a
  // heading, so a stray Enter cannot send), and back to Confirm when Cancel,
  // Escape or the scrim returns to the edit view, once the edit view is armed
  // (a held button cannot take focus). A curfew or stale notice takes it above.
  // The edit view comes back whole and at its top; the rows never moved.
  const wasPending = useRef(false);
  const confirmFocusDue = useRef(false);
  useLayoutEffect(() => {
    if (sheet.pending && !wasPending.current) {
      if (headRef.current) headRef.current.focus();
    } else if (!sheet.pending && wasPending.current) {
      confirmFocusDue.current = !sheet.curfew && !sheet.stale;
    }
    wasPending.current = !!sheet.pending;
  }, [sheet.pending, sheet.curfew, sheet.stale]);
```

6. After that block (and before the Confirm-focus `useEffect`, which stays), add the fade:

```js
  // The fade at the copy's foot: shown whenever the copy overflows, as the
  // export draws it. Measured after every render and when its box resizes.
  const editView = ready && !sheet.pending;
  const readoutRef = useRef(null);
  const [fade, setFade] = useState(false);
  const measureFade = useCallback(() => {
    const el = readoutRef.current;
    const over = !!el && el.scrollHeight > el.clientHeight + 1;
    setFade((cur) => (cur === over ? cur : over));
  }, []);
  useLayoutEffect(() => { measureFade(); });
  useEffect(() => {
    const el = readoutRef.current;
    if (!editView || !el || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measureFade);
    watch.observe(el);
    return () => watch.disconnect();
  }, [editView, measureFade]);
```

7. Replace everything from `const today = ctDay(new Date());` to the end of the component's `return` with:

```jsx
  const today = ctDay(new Date());
  const v = sheet.values || {};
  const r = sheet.readout;
  const confirmLabel = r ? r.button : 'Done';
  const canConfirm = ready && !sheet.busy && !holding && !sheet.curfew && !sheet.stale
    && (!sheet.changed || sheet.preview.state === 'ready');
  const onConfirm = () => { if (sheet.changed) sheet.confirm(); else closeSheet(); };
  const hint = ready ? extensionHint(sheet.proposal, v.event_duration_hours) : null;
  const shiftsNote = multiShiftNote(shiftCount);
  const rides = sheet.curfew ? curfewRidesLine(sheet.curfew.notify, sheet.curfew.staff) : null;
  const was = (field) => wasLine(field, sheet.initial, sheet.values, today);
  // Three dots on screen, "pending" to a screen reader.
  const pendingDots = (
    <>
      <span aria-hidden="true">{PENDING_FIGURE}</span>
      <span className="visually-hidden">pending</span>
    </>
  );

  // A row's label, and under it what a changed field was (under Start, the setup).
  const label = (name, sub) => (
    <span className="m-edit-label">
      <span>{name}</span>
      {sub && <span className="m-edit-was">{sub}</span>}
    </span>
  );

  const stepper = (name, value, text, step, field, lessName, moreName) => (
    <div className="m-sheet-row m-edit-stepper-row">
      {label(name, was(field))}
      <span className="m-stepper-ctl">
        <button type="button" className="m-stepper-btn" aria-label={lessName}
          disabled={sheet.busy || holding || !canStep(value, -1, step)}
          onClick={() => sheet.setValue(field, step(value, -1))}>{String.fromCharCode(0x2212)}</button>
        <span className="m-stepper-value" aria-live="polite">{text}</span>
        <button type="button" className="m-stepper-btn" aria-label={moreName}
          disabled={sheet.busy || holding || !canStep(value, 1, step)}
          onClick={() => sheet.setValue(field, step(value, 1))}>+</button>
      </span>
    </div>
  );

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={() => closers.current.onClose()} />
      <div className={`m-sheet m-edit-sheet${ready && sheet.pending ? ' m-edit-notifying' : ''}`} role="dialog" aria-modal="true" aria-label="Edit details" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">{clientName || 'Event'}{kind ? <span className="m-sheet-kind">{` · ${kind}`}</span> : null}</h2>
          <div className="m-sheet-mix">{SHEET_NOTE}</div>
        </div>
        {!ready && (
          <div className="m-sheet-body">
            {sheet.phase === 'loading' && <div className="m-sheet-state">Loading the event</div>}
            {sheet.phase === 'failed' && (
              <div className="m-fail" role="alert">
                <span className="m-fail-msg">{LOAD_FAILED}</span>
                <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.reload}>Retry</button>
              </div>
            )}
            {sheet.phase === 'locked' && <div className="m-sheet-state">{sheet.lockedMessage}</div>}
          </div>
        )}
        {editView && (
          <>
            {/* The readout's copy: what comes and goes, scrolling past the max height. */}
            <div className="m-edit-readout" ref={readoutRef}>
              <div className={`m-edit-figure${r.dim ? ' m-edit-dim' : ''}`} aria-busy={r.pricing ? 'true' : undefined}>
                {/* The two top lines, read as a whole when they change. */}
                <div aria-live="polite" aria-atomic="true">
                  <div className="m-edit-total">
                    <span className="m-edit-total-label">{r.label}</span>
                    <span className="m-edit-figs">
                      {r.old && <span className="m-edit-total-old">{r.old}</span>}
                      {r.old && <span className="m-edit-arrow" aria-hidden="true">{ARROW}</span>}
                      <span className="m-edit-total-new">{r.pending ? pendingDots : r.now}</span>
                    </span>
                  </div>
                  <div className="m-edit-sub">
                    {r.pricing && <span className="m-edit-pricing">pricing</span>}
                    {r.sub && <span className="m-edit-bal">{r.pending ? <>{`${BALANCE_BECOMES} `}{pendingDots}</> : r.sub}</span>}
                  </div>
                </div>
                {r.lines.length > 0 && (
                  <div className="m-edit-lines">{r.lines.map((line) => <p key={line}>{line}</p>)}</div>
                )}
              </div>
              {hint && <p className="m-edit-hint">{hint}</p>}
              {shiftsNote && <p className="m-edit-hint">{shiftsNote}</p>}
              {fade && <div className="m-edit-fade" aria-hidden="true" />}
            </div>
            {/* The notices: under the copy, not scrolling, their foot on the rows.
                When a button removes its own notice, copy from above slides into
                its place, never another button. */}
            <div className="m-edit-notices">
              {sheet.changed && sheet.preview.state === 'failed' && (
                <div className="m-fail" role="alert">
                  <span className="m-fail-msg">{PREVIEW_FAILED}</span>
                  <button type="button" className="m-fail-retry" disabled={holding} onClick={sheet.retryPreview}>Retry</button>
                </div>
              )}
              {sheet.error && (
                <div className="m-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
              )}
              {sheet.stale && (
                <div className="m-sheet-note" role="alert" ref={staleRef}>
                  <span className="m-sheet-note-dot" aria-hidden="true" />
                  <span className="m-sheet-note-text">{STALE_EVENT}</span>
                  <button type="button" className="m-fail-retry" ref={reloadRef} disabled={holding} onClick={sheet.reload}>Reload</button>
                </div>
              )}
              {sheet.curfew && (
                <div className="m-confirm" role="alert" ref={curfewRef}>
                  <div className="m-confirm-copy">{`${sheet.curfew.reason} Book it anyway? This will be recorded.`}</div>
                  {rides && <div className="m-confirm-copy">{rides}</div>}
                  <div className="m-confirm-btns">
                    <button type="button" className="m-act m-act-quiet" ref={keepRef} disabled={sheet.busy || holding} onClick={sheet.declineCurfew}>Keep editing</button>
                    <button type="button" className="m-act m-act-confirm" disabled={sheet.busy || holding} onClick={sheet.acknowledgeCurfew}>Book it anyway</button>
                  </div>
                </div>
              )}
            </div>
            <div className="m-edit-rows">
              <label className="m-sheet-row m-edit-pick">
                <Icon name="calendar" size={18} />
                {label('Date', was('event_date'))}
                <span className="m-edit-value">{sheetDateText(v.event_date, today)}</span>
                <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                <input type="date" className="m-edit-native" aria-label="Date" value={v.event_date || ''}
                  min={today} disabled={sheet.busy || holding}
                  onChange={(e) => { const next = nextDateValue(e.target.value, today); if (next) sheet.setValue('event_date', next); }} />
              </label>
              <label className="m-sheet-row m-edit-pick">
                <Icon name="clock" size={18} />
                {label('Start', startSubLine(sheet.proposal, sheet.initial, sheet.values))}
                <span className="m-edit-value">{startInputValue(v.event_start_time)}</span>
                <span className="m-edit-caret" aria-hidden="true"><Icon name="right" size={16} /></span>
                <input type="time" className="m-edit-native" aria-label="Start" step={300}
                  min={START_MIN} max={START_MAX} value={startInputValue(v.event_start_time)} disabled={sheet.busy || holding}
                  onChange={(e) => {
                    const next = nextStartValue(e.target.value, sheet.initial.event_start_time);
                    if (next) sheet.setValue('event_start_time', next);
                  }} />
              </label>
              {stepper('Duration', v.event_duration_hours, fmtHours(v.event_duration_hours), stepHours, 'event_duration_hours', 'Shorter', 'Longer')}
              {stepper('Guests', v.guest_count, String(v.guest_count), stepGuests, 'guest_count', 'Fewer guests', 'More guests')}
            </div>
            <div className="m-acts m-edit-acts">
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={closeSheet}>Cancel</button>
              <button type="button" className="m-act m-act-primary" ref={confirmRef} disabled={!canConfirm} onClick={onConfirm}>{sheet.busy ? 'Saving' : confirmLabel}</button>
            </div>
          </>
        )}
        {ready && sheet.pending && (
          <>
            <div className={`m-sheet-body${sheet.busy ? ' m-sheet-busy' : ''}`}>
              {/* A failed save in the notify step says so above "Notify the client?", where the step starts. */}
              {sheet.error && (
                <div className="m-fail m-notify-fail" role="alert" tabIndex={-1} ref={errorRef}><span className="m-fail-msg">{sheet.error}</span></div>
              )}
              <NotifyStep sheet={sheet} headRef={headRef} holding={holding} />
            </div>
            {/* Two rows: Cancel and "Send the update", then "Don't send" (the main
                button, last in reading order) across the whole width; no label wraps. */}
            <div className="m-acts m-acts-notify m-edit-acts">
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding} onClick={sheet.backToEdit}>Cancel</button>
              <button type="button" className="m-act m-act-quiet" disabled={sheet.busy || holding || !sheet.canSend}
                onClick={() => { setTapped('send'); sheet.sendUpdate(); }}>{sheet.busy && tapped === 'send' ? 'Saving' : 'Send the update'}</button>
              <button type="button" className="m-act m-act-primary" disabled={sheet.busy || holding}
                onClick={() => { setTapped('quiet'); sheet.dontSend(); }}>{sheet.busy && tapped === 'quiet' ? 'Saving' : "Don't send"}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
```

`NotifyStep` below the component is unchanged.

- [ ] **Step 5: The stylesheet**

In `index.css`, replace the block from the comment `/* Edit sheet (lane ma-e3; benchmark 2026-09-15, the edit sheet).` through `html[data-app="admin-os"] .m-edit-content { display: flow-root; }` (its comments included) with:

```css
/* Edit sheet (lane ma-e3; layout from the design pass of 2026-10-06, "readout
   above, controls pinned", benchmark docs/design-artifacts/2026-10-06-edit-
   sheet-layout). The sheet is as tall as its content, at most the screen less
   12px. Everything that comes and goes is in the readout: its copy shrinks and
   scrolls past that height, and its notices, under the copy, do not scroll;
   the notices, the rows and the footer never shrink, so they sit at the bottom
   of the screen whatever the copy says. On a screen too short even for those
   (a phone in landscape in a browser tab), the whole sheet scrolls, so the
   footer stays reachable. The notify step fills the max height, so a channel's
   message showing or hiding under its box moves nothing. The stepper is the
   design system's (components-mobile.css), folded, with a fixed 68px value
   slot so "10.5 hr" cannot push the minus button sideways. A date or time row
   carries its native input across the whole row, transparent, so a tap
   anywhere opens the phone's own picker. */
html[data-app="admin-os"] .m-sheet.m-edit-sheet { max-height: calc(100dvh - 12px); overflow-y: auto; }
html[data-app="admin-os"] .m-sheet.m-edit-sheet.m-edit-notifying { height: calc(100dvh - 12px); }
html[data-app="admin-os"] .m-edit-readout {
  flex: 0 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: none; padding: 10px 16px;
}
html[data-app="admin-os"] .m-edit-readout::-webkit-scrollbar { display: none; }
html[data-app="admin-os"] .m-edit-total { display: flex; align-items: center; gap: 8px; min-height: 18px; }
html[data-app="admin-os"] .m-edit-total-label { flex: 1; min-width: 0; font-size: var(--fs-body); font-weight: 600; color: var(--ink-1); }
html[data-app="admin-os"] .m-edit-figs { flex: none; display: flex; align-items: center; gap: 8px; transition: opacity 120ms ease; }
html[data-app="admin-os"] .m-edit-total-old { font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-3); }
html[data-app="admin-os"] .m-edit-arrow { color: var(--ink-4); }
html[data-app="admin-os"] .m-edit-total-new { font-family: var(--font-numeric); font-size: 12.5px; font-weight: 600; color: var(--ink-1); }
/* The second line keeps its height whatever it says, so "Total" turning into
   "New total" changes the height of nothing. */
html[data-app="admin-os"] .m-edit-sub { margin-top: 3px; display: flex; align-items: center; gap: 8px; min-height: 15px; }
html[data-app="admin-os"] .m-edit-pricing { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); animation: m-edit-pulse 1.2s ease-in-out infinite; }
@keyframes m-edit-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
html[data-app="admin-os"] .m-edit-bal { margin-left: auto; flex: none; font-family: var(--font-numeric); font-size: 11px; color: var(--ink-3); transition: opacity 120ms ease; }
html[data-app="admin-os"] .m-edit-lines { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; transition: opacity 120ms ease; }
html[data-app="admin-os"] .m-edit-lines p { margin: 0; font-size: 11px; line-height: 1.5; color: var(--ink-2); text-wrap: pretty; }
/* The last figure, kept while the next is on its way or failed: the figures
   dim, the label and PRICING do not. */
html[data-app="admin-os"] .m-edit-figure.m-edit-dim .m-edit-figs,
html[data-app="admin-os"] .m-edit-figure.m-edit-dim .m-edit-bal,
html[data-app="admin-os"] .m-edit-figure.m-edit-dim .m-edit-lines { opacity: 0.45; }
html[data-app="admin-os"] .m-edit-hint { margin: 8px 0 0; font-size: 11px; line-height: 1.45; color: var(--ink-3); }
/* Whenever the copy overflows, as the export draws it (EditSheet.js measures it). */
html[data-app="admin-os"] .m-edit-fade {
  position: sticky; bottom: -10px; height: 24px; margin: -14px -16px -10px;
  background: linear-gradient(to bottom, transparent, var(--bg-elev)); pointer-events: none;
}
/* The notices: under the copy, not scrolling, their foot on the rows, inset by
   the readout's 16px. When one leaves, copy from above slides into its place,
   never another button: inside a scrolling box, which keeps its top, a notice
   that left would pull the one below it up into the finger's place. Empty, the
   strip has no height. */
html[data-app="admin-os"] .m-edit-notices { flex: none; padding: 0 16px; }
html[data-app="admin-os"] .m-edit-notices .m-fail,
html[data-app="admin-os"] .m-edit-notices .m-sheet-note,
html[data-app="admin-os"] .m-edit-notices .m-confirm { margin: 0 0 10px; }
html[data-app="admin-os"] .m-edit-rows { flex: none; }
html[data-app="admin-os"] .m-edit-rows > .m-sheet-row:first-child { border-top-color: var(--line-2); }
html[data-app="admin-os"] .m-stepper-ctl { display: flex; align-items: center; flex: none; background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--radius); }
html[data-app="admin-os"] .m-stepper-btn { min-width: 44px; min-height: 44px; padding: 0; background: none; border: none; color: var(--ink-1); font-size: 18px; font-family: var(--font-mono); cursor: pointer; }
html[data-app="admin-os"] .m-stepper-btn:disabled { color: var(--ink-4); cursor: default; }
html[data-app="admin-os"] .m-stepper-value { flex: none; width: 68px; text-align: center; font-family: var(--font-numeric); font-size: 15px; color: var(--ink-1); }
html[data-app="admin-os"] .m-edit-pick { position: relative; }
html[data-app="admin-os"] .m-edit-pick:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
html[data-app="admin-os"] .m-edit-native { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
/* The label column: the name, and under it what a changed field was (or, under
   Start, the setup), inside the 48px row. */
html[data-app="admin-os"] .m-edit-label { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
html[data-app="admin-os"] .m-edit-was { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.05em; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
html[data-app="admin-os"] .m-edit-value { flex: none; font-family: var(--font-numeric); font-size: 12.5px; color: var(--ink-2); }
html[data-app="admin-os"] .m-edit-caret { flex: none; display: flex; color: var(--ink-4); }
html[data-app="admin-os"] .m-sheet-row.m-edit-stepper-row { cursor: default; }
/* The footer in both views: Cancel and the main button, or the notify step's two rows. */
html[data-app="admin-os"] .m-acts.m-edit-acts { flex: none; padding: 10px 16px 14px; border-top: 1px solid var(--line-1); }
html[data-app="admin-os"] .m-acts.m-edit-acts .m-act-primary { transition: opacity 120ms ease; }
```

In the House Lights list that begins `html[data-app="admin-os"][data-skin="light"] .m-section,` (the squared one), add `html[data-app="admin-os"][data-skin="light"] .m-stepper-ctl` as its LAST selector (so its line reads `... .m-stepper-ctl { border-radius: 0; }`), and add "the stepper (design pass 2026-10-06)" to the comment above it. In the reduced-motion block at the end, add `.m-edit-pricing` as its own rule, first in the block (`mobileDetailCss.test.js:80` pins `.m-sheet-scrim { animation: none; }` verbatim, and this lane's stylesheet test needs the PRICING rule before that pair), so the block reads:

```css
@media (prefers-reduced-motion: reduce) {
  html[data-app="admin-os"] .m-edit-pricing { animation: none; }
  html[data-app="admin-os"] .m-sheet,
  html[data-app="admin-os"] .m-sheet-scrim { animation: none; }
  html[data-app="admin-os"] .m-section-caret { transition: none; }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd client && CI=true npx react-scripts test --watchAll=false src/components/mobile/EditSheet.test.js src/utils/editSheetView.test.js src/utils/mobileClassContract.test.js src/utils/mobileDetailCss.test.js`
Expected: PASS, every test in the four files.
Then the whole client suite: `cd client && CI=true npx react-scripts test --watchAll=false` (read the pass count; only the two known intermittents may need a lone re-run).

- [ ] **Step 7: Docs**

`README.md:603` (`editSheetView.js`): after "the confirm lines from the desktop's buildRepriceSummary," add "the readout's lines (the stored total or the new one, the balance or the overpaid figure, PRICING) and the was lines,". `README.md:610`: "(bottom sheet: date, start, duration, guests, the notify step; it draws)" becomes "(bottom sheet: a readout above the date, start, duration and guests rows, which stay at the bottom of the screen; the notify step; it draws)".

`ARCHITECTURE.md:2098` ("Edit sheet"): "(Date, Start, Duration, a read-only Setup, Guests)" becomes "(Date, Start with the setup under it, Duration, Guests)". Replace the sentences from "The sheet keeps one height (80dvh)," through "Back from the notify step, the edit view comes back scrolled where it was." with: "Its layout is the design pass of 2026-10-06 ("readout above, controls pinned", `docs/design-artifacts/2026-10-06-edit-sheet-layout/`): one readout between the head and the rows. Its copy (the total and its balance line, the reprice lines, the extension hint, the multi-shift note) scrolls past the max height, under a fade while it overflows; under the copy, not scrolling, sit the notices ("Couldn't price the change.", a save's line, the changed-meanwhile notice, the curfew confirm, in that order); the notices, the rows and the footer sit at the bottom of the screen, so when a notice leaves, copy slides into its place and no button moves. The sheet is as tall as its content, at most the screen less 12px, and the whole sheet scrolls only on a screen too short even for its rows and footer. Untouched, the readout shows the stored total, what is paid and the balance (or the server's netted overpaid figure) from the event read ("Total"); after a change, "New total $old → $new" and "balance due becomes $X" in the same two lines, so the first tap changes the height of nothing; while a newer figure is on its way the last one stays, dimmed, under PRICING (before any figure describes the change, three dots, which a screen reader hears as "pending"; the two lines are a polite live region). A changed field shows what it was under its label ("was 3 hr"). The notify step fills the max height, so a channel's message showing or hiding moves nothing." In the arm sentence, "(the form's first ready render after the sheet opens or reloads, the notify step opening, ...)" becomes "(the sheet opening, every change of phase (loading, ready, failed, locked), the notify step opening, ...)", and add after it: "The sheet being as tall as its content, a phase change moves its top edge, which is why the opening and the phases arm too; after a reload the fresh sheet takes focus."

- [ ] **Step 8: Build and commit**

Run: `cd client && CI=true npx react-scripts build` (exit 0). Check `wc -l client/src/components/mobile/EditSheet.js` is under 450 (else move `NotifyStep` to `EditSheetNotify.js` unchanged, import it, add its README line, re-run Step 6).

```bash
git add client/src/components/mobile/useEditSheet.js client/src/components/mobile/EditSheet.js client/src/components/mobile/EditSheet.test.js client/src/index.css README.md ARCHITECTURE.md
git commit -F - <<'MSG'
feat(phone): readout above, controls pinned (the edit sheet's design pass)

Everything that comes and goes sits in one readout between the head and the
rows: its copy scrolls past the max height, and its notices sit under the
copy without scrolling. The notices, Date, Start (with the setup under it),
Duration and Guests and the footer sit at the bottom of the screen. The
sheet is as tall as its content, at most the screen less 12px; the notify
step fills that height. The fixed height, the content floor and the
notify-step scroll restore are gone.
MSG
```

### Task 4: Browser gate (orchestrator)

**Files:** none committed. The script and screenshots live in the session scratchpad and `~/.playwright-mcp/ma-e3b-gate/`; the results go into "Browser checks" at the end of this plan, on main.

- [ ] **Step 1: Servers, sign-in, fixture**

Confirm `git -C <lane> diff main -- server/db/schema.sql` is empty (the lane API then runs the schema main runs). One foreground command starts the lane API (`PORT=5100 NODE_ENV=development node server/index.js` from the lane) and the lane client (`PORT=3001 HOST=localhost DANGEROUSLY_DISABLE_HOST_CHECK=true BROWSER=none REACT_APP_API_URL=http://localhost:5100 npx react-scripts start` from `<lane>/client`; 3001 because `dev-signin.js` plants only on 3000 and 3001; if 3001 is taken, 3100 with a token minted into an init-script file that is never printed), waits for "Server running" and "Compiled", runs the checks, and stops both in a trap by the PIDs listening on 5100 and 3001. Sign in with `node /home/drbartender/projects/os/scripts/dev-signin.js --as admin` and `context.addInitScript({ path })`; `--clear` at the end. Skin: the `drb-admin-prefs-1` localStorage entry set by an init script, `{"skin":"dark"|"light","density":"comfy","sidebar":"full"}`.

Fixture, a node script run from the lane (dotenv first: `server/db` does not load it), recording every id:

```js
require('dotenv').config();
const { pool } = require('./server/db');
const { calculateProposal } = require('./server/utils/pricingEngine');
const { composeVenueLocation } = require('./server/utils/venueAddress');
(async () => {
  const nonce = Date.now();
  const pkg = (await pool.query("SELECT * FROM service_packages WHERE is_active AND pricing_type <> 'per_guest' ORDER BY sort_order LIMIT 1")).rows[0];
  const venue = { venue_name: 'Gate Hall', venue_street: '1 Gate St', venue_city: 'Rockford', venue_state: 'Illinois', venue_zip: '61101' };
  const where = composeVenueLocation(venue);
  // The client-elected gratuity (paid booking: jar on, 12 a staffer-hour), priced as /calculate prices it.
  const snap = calculateProposal({ pkg, guestCount: 100, durationHours: 4, numBars: 0, addons: [], syrupSelections: [], adjustments: [], totalPriceOverride: null, gratuityRate: 12, tipJar: true, gratuityFloorRate: null });
  const client = (await pool.query("INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555550111') RETURNING id", [`Gate Layout ${nonce}`, `gate-layout-${nonce}@example.com`])).rows[0].id;
  const proposal = (await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_start_time, event_duration_hours, guest_count, package_id, num_bars,
       total_price, amount_paid, event_type, venue_name, venue_street, venue_city, venue_state, venue_zip, event_location,
       event_timezone, tip_jar, gratuity_rate, pricing_snapshot)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + 30, '7:00 PM', 4, 100, $2, 0, $3, 100, 'birthday-party', $4, $5, $6, $7, $8, $9,
       'America/Chicago', true, 12, $10) RETURNING id`,
    [client, pkg.id, snap.total, venue.venue_name, venue.venue_street, venue.venue_city, venue.venue_state, venue.venue_zip, where, snap],
  )).rows[0].id;
  const shift = (await pool.query(
    "INSERT INTO shifts (proposal_id, event_date, start_time, end_time, status, location, positions_needed) VALUES ($1, CURRENT_DATE + 30, '7:00 PM', '11:00 PM', 'open', $2, '[\"Bartender\"]') RETURNING id",
    [proposal, where],
  )).rows[0].id;
  console.log(JSON.stringify({ client, proposal, shift, total: snap.total, gratuity: snap.gratuity && snap.gratuity.total }));
  await pool.end();
})();
```

Before any check, `POST /proposals/calculate` for the stored values (as the sheet sends it) must return `snap.total`; if not, the fixture is wrong, stop. For G3 a second shift (same insert, `CURRENT_DATE + 31`) is added and removed by id.

Cleanup, by recorded id, in this order: `admin_audit_log` rows whose `metadata->>'proposal_id'` is the proposal, `proposal_activity_log` rows for it, `scheduled_messages` with `entity_type = 'proposal'` and its id, `invoices` for it (a delete a foreign key refuses: delete the child rows it names first, by id), the shifts, the proposal, the client. Confirm each count is zero afterwards.

- [ ] **Step 2: The checks**

Playwright with `/opt/google/chrome/chrome`, headless, `hasTouch: true`, each check at 390x844, 360x740 and 320x568, both skins unless it says otherwise. "From the bottom" is `innerHeight - getBoundingClientRect().top` (headless has no safe-area inset). Record each as PASS or FAIL with its screenshot.

- G1 Pinned controls: in every state below, Duration's stepper top is 164px (plus or minus 1) and Guests' 116px from the bottom: untouched; a change with its figure landed (hours plus one on the fixture: three reprice lines, the gratuity line among them); a figure loading (the `/calculate` response held by `page.route`); "Couldn't price the change." (the response failed); the changed-meanwhile notice (`UPDATE proposals SET guest_count = guest_count WHERE id = <proposal>` before Confirm); the curfew confirm (start 23:30 with 4 hours); the save's line (Keep editing at that confirm); the multi-shift note (G3's second shift). And while a notice shows, its button does not move when the copy changes (a figure landing or failing above it): Reload's and Keep editing's tops, before and after, within 1px.
- G2 Beside the export: the untouched, three-line and loading sheets next to the export's frames at the same size and skin (render the vendored snapshot); the sheet's height within a few px of 381, 515 (390) and 531 (360, 320); every difference is a spec decision or a finding.
- G3 The long readout at 320x568: three reprice lines and the multi-shift note in the copy, then the changed-meanwhile notice, then "Couldn't price" with it. The sheet's top is at least 12px from the screen top; the copy scrolls; the notices strip is in view whatever the copy's scroll position; the fade shows while the copy overflows; G1 holds while the copy is scrolled.
- G4 Double taps (two taps at one point, 150ms apart): Edit details (the sheet stays open); Reload (stays open, one history entry); Retry with "Couldn't price" and the changed-meanwhile notice both showing, at 320x568 with the copy overflowing (the second tap's `elementFromPoint` is copy text, not a button and not the scrim, and nothing reloads); Keep editing (the second tap lands on the save's line or copy); Confirm opening the notify step (nothing sent, E13); the notify Cancel (one step back, E19); five quick taps on More guests and on Longer while figures load and land (each tap's `elementFromPoint` is the same button, E14).
- G5 The money path, once, at 390 in After Hours: a duration change saves with the desktop's complete payload (`addon_ids`, `addon_quantities`, start as stored, no venue key, no `gratuity_mandate_total`, `notify: []`) and the row holds it (E2); a date change opens the notify step and Don't send saves (E3); "Book it anyway" carries `acknowledge_past_curfew: true` (E5).
- G6 The rows at 320: no sideways scroll; every button and row at least 44px; "was 19:00 · setup <N> min before" fits or ends in an ellipsis inside its row; `elementFromPoint` at Confirm's centre is Confirm (E10).
- G7 The notify step: the sheet is `innerHeight - 12` tall; its footer's labels each on one line (E21); Email ticked off and on again (two taps, 150ms apart) leaves the Email box at the same top and the step open, nothing sent; at 320x568 its body scrolls inside the sheet.
- G8 A short screen (568x300, the phone layout in a landscape browser tab), After Hours only: the sheet scrolls as a whole and its footer can be reached; nothing overflows sideways.

- [ ] **Step 3: Record**

Write the table into "Browser checks" at the end of this plan, on main. A FAIL goes back to Task 3's implementer, then its check runs again, before Task 3's review.

### Task 5: Lane close (orchestrator)

- [ ] **Step 1:** In the lane: the whole client suite (read the pass count) and `CI=true npx react-scripts build` (exit 0). No server suite: the lane changes no server file.
- [ ] **Step 2: The fleet.** `code-review`, `consistency-check`, `security-review`, `performance-review`, `ui-ux-review`, each on `git diff <lane base>..HEAD`, each a general-purpose agent briefed with its `.claude/agents/<name>.md`, with a coverage manifest (every changed file in exactly one seat's package for the per-file verdict, the cross-cutting seats on everything) and a budget. Tell every seat what is settled: the suites and build results, Task 4's table, that money behaviour is meant to be unchanged. `ui-ux-review` judges against the export and the spec's decisions, both skins, 390, 360 and 320, on Task 4's screenshots and a static render with the real markup and `index.css` (it cannot sign in). Every seat looks for the tap-stability family as a family. Iron rule: a seat that does not complete or returns no verdict is not a pass. Reviewers on Fable if credits are back, else Opus.
- [ ] **Step 3: Fold and merge.** Fix rounds re-reviewed by the seats that own the changed files; a re-run of any Task 4 check the fix reaches. Record the as-built deltas at the end of this plan, on main. Merge with `scripts/merge-lane.sh ma-e3b-edit-sheet-layout docs/superpowers/plans/2026-10-08-mobile-admin-edit-sheet-layout.md ma-e3b-edit-sheet-layout`, re-run the client suite on main, confirm every lane file is byte-identical on main, clean up the lane, update the board (and the stale ma-e3 line, which still says "not pushed"). At push: the sensitive-path re-review and `/second-opinion` on this lane's commits.

## Self-Review (2026-10-08)

1. **Spec coverage** (section 3, "Design pass of 2026-10-06"): composition and the pinned rows and footer, Task 3 (render, CSS) and G1; content-sized to `100dvh - 12px`, Task 3 CSS and G3; the readout holds every conditional line, in two parts (copy and notices), Task 3 (render, two order tests) and G3, G4; untouched Total with paid and balance, or overpaid, Task 1 and Task 3; Total to New total with no height change, Task 1 (`readoutView`) and the CSS `min-height` on both lines; PRICING and the dimmed last figure, Tasks 1 and 3; three dots and "pending", Tasks 1 and 3; the failed figure, Task 1; Setup under Start, Tasks 1 (`startSubLine`) and 3; "was" lines, Tasks 1 and 3; the 68px slot, Task 3 CSS; plain reprice lines with `text-wrap: pretty`, Task 3; the measured numbers, G1 and G2; the arm on the opening and every phase, and the failed load's Retry, Task 2; focus after a reload, Task 2; the notify step at the max height and its footer's rule and padding, Task 3 and G7; the balance basis, Task 1; the figure still asked at open, unchanged hook (Proven context) and the untouched test in Task 3; the short screen, Task 3 CSS and G8; the live region, Task 3; the square light stepper, Task 3 CSS and its stylesheet test; the export's small values (button padding, the main button's transition), Task 3 CSS; the kept departures, nothing to build (G2 judges them). No gap found.
2. **Placeholders.** None: every code step carries its code; the docs step quotes the exact replacement text.
3. **Type consistency.** `readoutView` returns the keys Task 3 draws (`label`, `old`, `now`, `sub`, `pricing`, `dim`, `pending`, `lines`, `button`); the hook returns `readout`; `wasLine(field, initial, now, todayYmd)` and `startSubLine(proposal, initial, now)` are called with `sheet.initial` and `sheet.values`, the hook's existing names; `PENDING_FIGURE` and `BALANCE_BECOMES` are exported in Task 1 and imported by Task 3 and the test files.
4. **Review Focus.** Each of the five lines names its test or gate check: Task 2 (four tests), Task 3 (the copy-and-notices order test, the curfew-last test, the notify-height test, the rows-hold-four assertion), Task 1 (the floor and overpaid tests), G1, G3, G4 and G7.
5. **Verified by running, first draft, 2026-10-08,** in a scratch copy of the client (nothing written in os; one Fable feasibility agent, then the orchestrator): Tasks 1 to 3 as then written went red for their stated reasons and then green; the whole client suite 151 of 151 suites, 1887 of 1887 tests; the CI build exit 0 with only the html2pdf.js source-map warning and no lint finding; `EditSheet.js` at 381 lines; five mutations each failed their named test, a sixth (the curfew confirm moved above the notes) failed the curfew-last test. Folded from that run: Task 1 carries the one `EditSheet.test.js` assertion that follows the new pending glyph; Task 2 Step 2 counts two closes; Task 3 Step 5 puts the PRICING rule first in the reduced-motion block (`mobileDetailCss.test.js:80` pins it); Step 6 runs that file.
6. **Plan review, 2026-10-08 (three Fable seats: plan-fidelity, plan-decomposition, spec-gaps; feasibility was item 5's run).** Two Blockers, both folded: (fidelity) a single scrolling readout keeps its top, not its foot, so at 320x568 a notice that leaves pulls the one below it up, Reload into Retry's place; the readout is now its copy, which scrolls, and a strip of notices under it, which does not; (gaps) in a content-sized sheet, ticking a channel in the notify step shows or hides its message under the box, resizes the sheet and moves the box under the thumb, possibly onto the scrim; the notify step now fills the max height. Warnings folded: Task 3's review runs after the gate (decomposition); the spec names the notify-step scroll restore among what this replaces, the fade follows the export (whenever the copy overflows), and the failed figure, the hints' style and the notices' inset are declared (fidelity); "Couldn't price" takes no focus and is never scrolled away; the whole sheet scrolls on a screen too short for its rows and footer; the two top lines are a polite live region and the dots read "pending" (gaps). Suggestions folded: the export's `text-wrap: pretty`, button padding and the main button's 120ms transition; line one's 18px; the failed load's Retry in the arm; focus after a reload; the overpaid line from `overpayment_cents`; the numbers measured from the safe-area padding's edge; Task 2's note that it lands before the layout needs it; the reviewer's inputs; the deleted helpers' comments. Declined: the bank debit in flight on the readout (stated in the spec: the reprice confirm cannot see it either, and the detail's Financials behind the sheet can); the 12px of scrim above a sheet at its max height (the 80dvh sheet left a fifth of the screen as scrim, so this is less exposed than before, not more). Parked on the fix list: closing a sheet arms nothing beneath it (true before this lane).
7. **Re-verified by running after the review's fold, 2026-10-08** (the same Fable agent, a fresh scratch copy of the client, nothing written in os): every task went red for exactly the reasons its Step 2 gives, then green; the four named files 262 of 262; the whole client suite 151 of 151 suites, 1891 of 1891 tests (the known `AssignmentSheet.test.js` intermittent fired once and passed alone, 75 of 75); the CI build exit 0 with no lint finding; `EditSheet.js` at 402 lines; `useEditSheet.js` changed in exactly three lines. Nine mutations each failed their named test: the old arm rule, the focus effect removed, the notices moved inside the copy, the notify class dropped, the live region removed, the overpaid line ignored, the fade's measure removed, the max-height rule removed, the stale notice above "Couldn't price". No errata.
