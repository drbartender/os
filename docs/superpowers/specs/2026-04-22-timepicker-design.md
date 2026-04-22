# TimePicker — Unified Time Input Component

**Date**: 2026-04-22
**Status**: Design approved, pending implementation plan

## Problem

Time pickers are inconsistent across the app:

- **Native `<input type="time">`** in `AdminDashboard.js` (shift form) and `ShiftDetail.js` (shift edit). Browser-native stepper UI varies by browser; mobile Safari ignores `step`.
- **Custom `<select>` dropdowns** in `QuoteWizard.js`, `ClassWizard.js`, `ProposalCreate.js`, `ProposalDetail.js`. 30-minute increments, but no arrow stepping, no free typing.
- **Three duplicated inline `TIME_OPTIONS` generators** across those admin/wizard files, instead of using the existing `client/src/utils/timeOptions.js` utility.

Users get different controls depending on which form they land on, and the admin `type="time"` controls feel clunky (no list of common slots, no AM/PM display consistency).

## Goal

Single `<TimePicker>` component used everywhere, offering **all three** input affordances:

1. Free-form typing (any minute, not just 30-min grid)
2. ▲ / ▼ stepper buttons (30-min increments, snap to grid)
3. Dropdown list of 30-min presets

One value contract — 24h `"HH:MM"` strings — so it's a drop-in replacement with zero schema, API, or state-model changes.

## Non-goals

- No change to database schema, API contracts, or the shape of any existing `start_time` / `end_time` field.
- No seconds support. All values are hour+minute only.
- No timezone handling. Time strings remain naive, interpreted by callers.
- No date picker. Out of scope.

## Component API

```jsx
<TimePicker
  value="18:30"              // 24h "HH:MM", same as existing fields
  onChange={(next) => ...}   // next is 24h "HH:MM"
  minHour={8}                // inclusive, default 0
  maxHour={23}               // inclusive max hour for the grid, default 23
  className="form-input"     // forwarded to the text input
  placeholder="Select time"
  disabled={false}
  required={false}
  id="start_time"
  name="start_time"
/>
```

### Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `string \| null` | — | 24h `"HH:MM"` or empty string / null for unset |
| `onChange` | `(next: string) => void` | — | Fires with canonicalized 24h `"HH:MM"` after valid edit, or `""` when cleared |
| `minHour` | `number` | `0` | Inclusive lower bound (24h) for dropdown + step clamping |
| `maxHour` | `number` | `23` | Inclusive upper bound for 30-min grid; last slot is `maxHour:30` |
| `className` | `string` | `"form-input"` | Forwarded to the inner text input |
| `placeholder` | `string` | `"—:— —"` | Shown when value is empty |
| `disabled` | `boolean` | `false` | Disables input, buttons, and dropdown |
| `required` | `boolean` | `false` | Sets `required` on the input |
| `id` | `string` | — | Applied to the inner input for `<label htmlFor>` |
| `name` | `string` | — | Applied to the inner input |

### Behavior

**Typing**
- User can type anything in the input.
- On `blur` or Enter keypress: parse the string using the rules below. If valid, canonicalize to `"H:MM AM/PM"` for display and call `onChange` with `"HH:MM"`. If invalid, revert display to the last valid value and briefly flash red via a CSS class toggled for ~400ms. No toast or inline error text — flash is the signal, same as the app's existing validation UI pattern.
- While focused, the user's raw text stays in the input (do not canonicalize mid-edit).

**Parser accepts** (case-insensitive, whitespace-tolerant):
- `"6:30 PM"`, `"6:30pm"`, `"6:30p"`, `"06:30 PM"`
- `"6 PM"`, `"6pm"`, `"6p"` → `18:00`
- `"18:30"`, `"1830"` (24h, no separator)
- `"630pm"`, `"630p"` → `18:30`
- Minutes: 0–59, any value (6:17 PM is valid).

**Parser rejects** (revert + flash):
- Out of range hours (`"25:00"`)
- Out of range minutes (`"6:75"`)
- Below `minHour` or above `maxHour:59` after parsing
- Garbage (`"asdf"`, `"99"`)

**Special cases**:
- **Clearing**: empty input (all whitespace or zero-length) on blur is treated as intentional clear. Fires `onChange("")`, placeholder reappears. No flash.
- **Empty required field**: standard HTML form validation takes over on submit. Component does not flash purely for being empty.
- **No last valid value**: if the field started empty and the user types garbage then blurs, revert to empty and flash.

**Arrow buttons (▲ / ▼)**
- Step by **exactly 30 minutes**, independent of current minute value.
- Snap behavior when current time is off-grid:
  - Current `6:15 PM`, press ▲ → `6:30 PM`
  - Current `6:15 PM`, press ▼ → `6:00 PM`
  - Current `6:00 PM`, press ▲ → `6:30 PM`
  - Current `6:00 PM`, press ▼ → `5:30 PM`
- Clamp at `minHour:00` and `maxHour:30`. At bounds, the button is disabled (greyed, `aria-disabled`).
- Empty value + ▲ → jump to `minHour:00`. Empty value + ▼ → jump to `maxHour:30`.

**Dropdown**
- Opens via ▾ chevron button or via keyboard (Alt+Down when input focused).
- Lists every 30-min slot from `minHour:00` to `maxHour:30` inclusive.
- Click a row → set value, close dropdown, canonicalize display, fire `onChange`.
- Keyboard: ↑/↓ moves highlight, Enter selects, Esc closes.
- If current value is on-grid, that row is highlighted on open. If off-grid, the nearest lower row is highlighted.
- Closes on outside click, Esc, or selection.

### Display format

Canonical display is `"H:MM AM/PM"` — no leading zero on hour, uppercase AM/PM, single space before AM/PM. Matches existing dropdown labels in the app.

## Implementation notes

**File layout**

- New: `client/src/components/TimePicker.js` — the component
- Update: `client/src/utils/timeOptions.js` — add two helpers:
  - `parseTimeInput(raw, { minHour, maxHour }) → "HH:MM" | null`
  - `formatTime12h("HH:MM") → "H:MM AM/PM"`
  - Existing `generateTimeOptions(startHour, endHour)` already covers slot generation but treats `endHour` as exclusive; keep that signature but the component calls it with `maxHour + 1` internally for inclusive semantics.
- Update: `client/src/index.css` — one block of styles for `.time-picker`, `.time-picker-step`, `.time-picker-dropdown`, `.time-picker-flash`

**Internal state**

- `displayValue` (string) — what's in the input right now; may be mid-edit
- `isOpen` (boolean) — dropdown open state
- `isFlashing` (boolean) — toggled for ~400ms on invalid blur
- Value itself is controlled by the parent via `value` / `onChange`

**Layout**

```
┌───────────────────────┬──┬──┐
│ 6:30 PM               │▲ │▾│
│                       │▼ │  │
└───────────────────────┴──┴──┘
```

Single `<div class="time-picker">` wrapping:
- `<input class="form-input time-picker-input" />`
- Stacked ▲/▼ buttons (small, width ~20px each, absolute-positioned or flex)
- ▾ chevron button that toggles the dropdown
- Dropdown panel absolutely positioned below the wrapper, `z-index` above neighboring form fields

**Accessibility**

- Input has the label semantics from `id` + external `<label>` (callers are already writing `<label className="form-label">`).
- Stepper buttons have `aria-label="Increase time by 30 minutes"` / `"Decrease..."`.
- Dropdown button has `aria-haspopup="listbox"` and `aria-expanded`.
- Dropdown is a `<ul role="listbox">` with `<li role="option" aria-selected>` items.
- Keyboard: Tab lands on input, Shift+Tab reverses; arrows inside dropdown work as described above. Up/Down arrows from the input trigger the stepper buttons (standard `<input type="time">` behavior — not strictly required but nice).

**Dependencies**: none added. No date-fns, no dayjs, no downshift. Pure React + vanilla CSS, matching the project's "no utility frameworks" rule.

## Call site replacements

All six files consume `<TimePicker>` with matching props. Exact hour ranges preserved from current code:

| File | Picker | `minHour` | `maxHour` |
|---|---|---|---|
| `AdminDashboard.js` (shift form) | start_time, end_time | 0 | 23 (full day, admin flexibility) |
| `ShiftDetail.js` | start_time, end_time | 0 | 23 |
| `QuoteWizard.js` | event start | 8 | 22 (matches current `h < 23`, i.e. last slot 10:30 PM) |
| `ClassWizard.js` | class start | 8 | 22 |
| `ProposalCreate.js` | event time | 6 | 23 (matches current `h < 24`, last slot 11:30 PM) |
| `ProposalDetail.js` | event time | 6 | 23 |

Three inline `TIME_OPTIONS = []; for (let h = ...)` blocks are deleted. The centralized `utils/timeOptions.js` becomes the single source.

## Testing

Manual verification (no unit test framework in this project for UI):

1. Admin shift form: type `"7p"` → `7:00 PM` on blur. Arrows step 30 min. Dropdown lists 12:00 AM–11:30 PM.
2. QuoteWizard: dropdown lists 8:00 AM–10:30 PM. Arrows clamp at those bounds.
3. ProposalDetail edit: existing saved value (e.g. `"17:00"`) displays as `5:00 PM`. Save and reload — value persists as `"17:00"` in DB.
4. Type `"25:00"` → flash red, revert. Type `"6:15 PM"` (off-grid) → accepts, displays `6:15 PM`, arrow up → `6:30 PM`.
5. Empty value + down arrow → jumps to `maxHour:30`.
6. Keyboard-only: Tab to field, Alt+Down opens dropdown, ↓ ↓ Enter selects a slot.
7. Mobile Safari + Android Chrome: tap input, type, blur — parser runs. Stepper buttons have ≥44px touch target.

## Risk and rollback

- **Low risk**. Value contract is unchanged (`"HH:MM"`). No schema, no API, no persistence change.
- Rollback = revert the PR. All touched call sites are pure swaps; reverting restores native inputs / dropdowns.
- Forms already validate `start_time` server-side with parameterized SQL inserts. No new injection surface.
