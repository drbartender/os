# Unified TimePicker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every time-entry control in the app (native `<input type="time">` and custom `<select>` dropdowns) with a single `<TimePicker>` component that supports free typing, 30-min arrow stepping, and a dropdown of presets.

**Architecture:** New React component `client/src/components/TimePicker.js` wraps a text input + stepper buttons + dropdown. Pure-function parser/formatter helpers live in `client/src/utils/timeOptions.js`. Component value contract is 24h `"HH:MM"` (unchanged from every existing call site) so swaps are drop-in — no schema, API, or state changes. Six files get picker swaps; three get their duplicated inline `TIME_OPTIONS` generators deleted.

**Tech Stack:** React 18 (CRA), vanilla CSS in `client/src/index.css`, Jest (available via CRA `react-scripts test`, currently unused in repo — one new test file for the pure parser).

**Spec:** `docs/superpowers/specs/2026-04-22-timepicker-design.md`

---

## File Structure

**Create:**
- `client/src/components/TimePicker.js` — the component
- `client/src/utils/timeOptions.test.js` — Jest tests for parser + formatter

**Modify:**
- `client/src/utils/timeOptions.js` — add `parseTimeInput`, `formatTime12h`; change `generateTimeOptions` to return `{value, label}` pairs; drop unused `TIME_OPTIONS` / `EVENT_TIME_OPTIONS` constants (nothing imports them)
- `client/src/index.css` — TimePicker styles block
- `client/src/pages/AdminDashboard.js` — 2 picker swaps
- `client/src/pages/admin/ShiftDetail.js` — 2 picker swaps
- `client/src/pages/admin/ProposalCreate.js` — 1 picker swap + delete inline TIME_OPTIONS
- `client/src/pages/admin/ProposalDetail.js` — 1 picker swap + delete inline TIME_OPTIONS
- `client/src/pages/website/QuoteWizard.js` — 1 picker swap + delete inline TIME_OPTIONS
- `client/src/pages/website/ClassWizard.js` — 1 picker swap + delete inline TIME_OPTIONS
- `CLAUDE.md` + `README.md` — add TimePicker to component list

---

## Task 1: Enhance `timeOptions.js` utility

**Files:**
- Modify: `client/src/utils/timeOptions.js`

- [ ] **Step 1: Replace the file contents**

```js
/**
 * Generate 30-minute time slot options.
 * @param {number} startHour - Inclusive start hour (24h, 0–23). Default 0.
 * @param {number} endHour - Exclusive end hour (24h, 1–24). Default 24. Last slot is (endHour - 1):30.
 * @returns {Array<{value: string, label: string}>} e.g. [{ value: "06:00", label: "6:00 AM" }, ...]
 */
export function generateTimeOptions(startHour = 0, endHour = 24) {
  const options = [];
  for (let h = startHour; h < endHour; h++) {
    for (const m of ['00', '30']) {
      const value = `${String(h).padStart(2, '0')}:${m}`;
      const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const label = `${displayHour}:${m} ${ampm}`;
      options.push({ value, label });
    }
  }
  return options;
}

/**
 * Format a 24h "HH:MM" string as "H:MM AM/PM".
 * Empty or falsy input returns "".
 */
export function formatTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const h = parseInt(match[1], 10);
  const m = match[2];
  if (isNaN(h) || h < 0 || h > 23) return '';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${m} ${ampm}`;
}

/**
 * Parse a free-form time string into canonical 24h "HH:MM".
 * Accepts: "6:30 PM", "6:30pm", "6:30p", "6 PM", "6pm", "18:30", "1830", "630pm".
 * Returns null if the input can't be parsed or falls outside [minHour, maxHour].
 *
 * @param {string} raw
 * @param {{ minHour?: number, maxHour?: number }} [bounds]
 * @returns {string|null} "HH:MM" or null
 */
export function parseTimeInput(raw, { minHour = 0, maxHour = 23 } = {}) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (cleaned === '') return null;

  // Detect AM/PM suffix (accept "am", "a", "pm", "p")
  let ampm = null;
  let timePart = cleaned;
  const suffixMatch = cleaned.match(/(a|am|p|pm)$/);
  if (suffixMatch) {
    const s = suffixMatch[1];
    ampm = (s === 'a' || s === 'am') ? 'am' : 'pm';
    timePart = cleaned.slice(0, cleaned.length - s.length);
  }

  if (timePart === '' || !/^\d+:?\d*$/.test(timePart)) return null;

  let hour;
  let minute;
  if (timePart.includes(':')) {
    const [hStr, mStr] = timePart.split(':');
    if (hStr === '' || hStr.length > 2) return null;
    hour = parseInt(hStr, 10);
    minute = mStr === '' || mStr === undefined ? 0 : parseInt(mStr, 10);
    if (mStr !== '' && mStr !== undefined && mStr.length > 2) return null;
  } else if (timePart.length <= 2) {
    hour = parseInt(timePart, 10);
    minute = 0;
  } else if (timePart.length === 3) {
    hour = parseInt(timePart[0], 10);
    minute = parseInt(timePart.slice(1), 10);
  } else if (timePart.length === 4) {
    hour = parseInt(timePart.slice(0, 2), 10);
    minute = parseInt(timePart.slice(2), 10);
  } else {
    return null;
  }

  if (isNaN(hour) || isNaN(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  // 12h input with AM/PM: hour must be 1–12
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }

  if (hour < 0 || hour > 23) return null;
  if (hour < minHour || hour > maxHour) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/utils/timeOptions.js
git commit -m "feat(timeOptions): add parseTimeInput + formatTime12h, return {value,label} from generator"
```

---

## Task 2: Parser tests

**Files:**
- Create: `client/src/utils/timeOptions.test.js`

Rationale: the parser has 20+ edge cases. A Jest file here is cheap insurance. CRA already ships `react-scripts test` — no config changes needed.

- [ ] **Step 1: Create the test file**

```js
import { parseTimeInput, formatTime12h, generateTimeOptions } from './timeOptions';

describe('parseTimeInput', () => {
  const cases12hPm = [
    ['6:30 PM', '18:30'],
    ['6:30pm', '18:30'],
    ['6:30p', '18:30'],
    ['06:30 PM', '18:30'],
    ['  6:30 PM  ', '18:30'],
    ['6 PM', '18:00'],
    ['6pm', '18:00'],
    ['6p', '18:00'],
    ['630pm', '18:30'],
    ['630p', '18:30'],
    ['12 PM', '12:00'],
    ['12:30 PM', '12:30'],
  ];
  test.each(cases12hPm)('parses 12h PM %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const cases12hAm = [
    ['6:30 AM', '06:30'],
    ['6:30am', '06:30'],
    ['6:30a', '06:30'],
    ['12 AM', '00:00'],
    ['12:30 AM', '00:30'],
    ['1:00 AM', '01:00'],
  ];
  test.each(cases12hAm)('parses 12h AM %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const cases24h = [
    ['18:30', '18:30'],
    ['1830', '18:30'],
    ['0:00', '00:00'],
    ['0030', '00:30'],
    ['23:59', '23:59'],
    ['08:15', '08:15'],
    ['6:15', '06:15'],
  ];
  test.each(cases24h)('parses 24h %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const rejected = [
    '', '   ', 'asdf', '99', '25:00', '6:75', '13 PM', '0 AM',
    '6:30xm', '6::30', ':30', '123456', '6:', 'pm',
  ];
  test.each(rejected)('rejects %s', (input) => {
    expect(parseTimeInput(input)).toBeNull();
  });

  test('honors minHour bound', () => {
    expect(parseTimeInput('7:00 AM', { minHour: 8 })).toBeNull();
    expect(parseTimeInput('8:00 AM', { minHour: 8 })).toBe('08:00');
  });

  test('honors maxHour bound', () => {
    expect(parseTimeInput('11:30 PM', { maxHour: 22 })).toBeNull();
    expect(parseTimeInput('10:30 PM', { maxHour: 22 })).toBe('22:30');
  });

  test('allows any minute within bounds', () => {
    expect(parseTimeInput('6:17 PM')).toBe('18:17');
    expect(parseTimeInput('18:45')).toBe('18:45');
  });

  test('returns null for non-string input', () => {
    expect(parseTimeInput(null)).toBeNull();
    expect(parseTimeInput(undefined)).toBeNull();
    expect(parseTimeInput(630)).toBeNull();
  });
});

describe('formatTime12h', () => {
  test.each([
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['06:00', '6:00 AM'],
    ['08:15', '8:15 AM'],
    ['11:59', '11:59 AM'],
    ['12:00', '12:00 PM'],
    ['13:00', '1:00 PM'],
    ['18:30', '6:30 PM'],
    ['23:30', '11:30 PM'],
  ])('formats %s -> %s', (input, expected) => {
    expect(formatTime12h(input)).toBe(expected);
  });

  test.each(['', null, undefined, 'nope', '25:00', '1830'])('returns "" for invalid %s', (input) => {
    expect(formatTime12h(input)).toBe('');
  });
});

describe('generateTimeOptions', () => {
  test('default range returns 48 slots (00:00 to 23:30)', () => {
    const slots = generateTimeOptions();
    expect(slots).toHaveLength(48);
    expect(slots[0]).toEqual({ value: '00:00', label: '12:00 AM' });
    expect(slots[47]).toEqual({ value: '23:30', label: '11:30 PM' });
  });

  test('honors custom range (8am–11pm exclusive)', () => {
    const slots = generateTimeOptions(8, 23);
    expect(slots).toHaveLength(30);
    expect(slots[0]).toEqual({ value: '08:00', label: '8:00 AM' });
    expect(slots[slots.length - 1]).toEqual({ value: '22:30', label: '10:30 PM' });
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd client && npm test -- --watchAll=false --passWithNoTests=false timeOptions
```

Expected: all tests pass. If any fail, fix `timeOptions.js` (Task 1 code) rather than the test.

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/timeOptions.test.js
git commit -m "test(timeOptions): parser + formatter coverage"
```

---

## Task 3: Build the `TimePicker` component

**Files:**
- Create: `client/src/components/TimePicker.js`

- [ ] **Step 1: Create the component**

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime12h, generateTimeOptions, parseTimeInput } from '../utils/timeOptions';

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default function TimePicker({
  value = '',
  onChange,
  minHour = 0,
  maxHour = 23,
  className = 'form-input',
  placeholder = '—:— —',
  disabled = false,
  required = false,
  id,
  name,
}) {
  const [displayValue, setDisplayValue] = useState(formatTime12h(value));
  const [isOpen, setIsOpen] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Keep display in sync when parent updates value externally
  useEffect(() => {
    setDisplayValue(formatTime12h(value));
  }, [value]);

  const slots = generateTimeOptions(minHour, maxHour + 1);

  const flash = useCallback(() => {
    setIsFlashing(true);
    const t = setTimeout(() => setIsFlashing(false), 400);
    return () => clearTimeout(t);
  }, []);

  const commit = useCallback((next) => {
    if (next !== value) onChange(next);
    setDisplayValue(formatTime12h(next));
  }, [value, onChange]);

  const stepBy = useCallback((mins) => {
    const minTotal = minHour * 60;
    const maxTotal = maxHour * 60 + 30;
    let total;
    const cur = toMinutes(value);
    if (cur === null) {
      total = mins > 0 ? minTotal : maxTotal;
    } else if (mins > 0) {
      // snap up to next 30-min grid line
      total = Math.floor(cur / 30) * 30 + 30;
      if (total <= cur) total = cur + 30;
    } else {
      // snap down to previous 30-min grid line
      total = Math.ceil(cur / 30) * 30 - 30;
      if (total >= cur) total = cur - 30;
    }
    if (total < minTotal) total = minTotal;
    if (total > maxTotal) total = maxTotal;
    commit(fromMinutes(total));
  }, [value, minHour, maxHour, commit]);

  const handleBlur = () => {
    const raw = displayValue.trim();
    if (raw === '') {
      if (value !== '') onChange('');
      setDisplayValue('');
      return;
    }
    const parsed = parseTimeInput(raw, { minHour, maxHour });
    if (parsed === null) {
      setDisplayValue(formatTime12h(value));
      flash();
    } else {
      commit(parsed);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepBy(30);
    } else if (e.key === 'ArrowDown') {
      if (e.altKey) {
        e.preventDefault();
        setIsOpen(true);
      } else {
        e.preventDefault();
        stepBy(-30);
      }
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Scroll highlighted slot into view when opening
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const active = listRef.current.querySelector('li.selected, li[data-nearest="true"]');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }, [isOpen]);

  const cur = toMinutes(value);
  const atMin = cur !== null && cur <= minHour * 60;
  const atMax = cur !== null && cur >= maxHour * 60 + 30;

  // Find highlighted slot: exact match if on-grid, else nearest lower
  let nearestIndex = -1;
  if (cur !== null) {
    for (let i = slots.length - 1; i >= 0; i--) {
      if (toMinutes(slots[i].value) <= cur) { nearestIndex = i; break; }
    }
  }

  return (
    <div ref={wrapperRef} className={`time-picker${isFlashing ? ' time-picker-flash' : ''}${disabled ? ' time-picker-disabled' : ''}`}>
      <input
        ref={inputRef}
        type="text"
        className={`time-picker-input ${className}`.trim()}
        value={displayValue}
        onChange={(e) => setDisplayValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        id={id}
        name={name}
        autoComplete="off"
      />
      <div className="time-picker-steppers">
        <button
          type="button"
          aria-label="Increase time by 30 minutes"
          disabled={disabled || atMax}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(30)}
        >▲</button>
        <button
          type="button"
          aria-label="Decrease time by 30 minutes"
          disabled={disabled || atMin}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(-30)}
        >▼</button>
      </div>
      <button
        type="button"
        className="time-picker-chevron"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Open time list"
        disabled={disabled}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setIsOpen((o) => !o)}
      >▾</button>
      {isOpen && (
        <ul ref={listRef} className="time-picker-dropdown" role="listbox">
          {slots.map((slot, i) => {
            const selected = slot.value === value;
            const nearest = !selected && i === nearestIndex;
            return (
              <li
                key={slot.value}
                role="option"
                aria-selected={selected}
                data-nearest={nearest ? 'true' : undefined}
                className={selected ? 'selected' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(slot.value);
                  setIsOpen(false);
                }}
              >
                {slot.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/TimePicker.js
git commit -m "feat(components): add TimePicker with typing, stepper, and dropdown"
```

---

## Task 4: TimePicker styles

**Files:**
- Modify: `client/src/index.css` — append a new block at the end of the file

- [ ] **Step 1: Open `client/src/index.css`, scroll to the end, and append this block**

Find the actual last line of the file first with `tail -5 client/src/index.css` to confirm you're appending (not replacing). Then paste this block on a new line after the final closing `}`:

```css
/* =========================================================
   TimePicker
   ========================================================= */
.time-picker {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  width: 100%;
}

.time-picker-input {
  flex: 1 1 auto;
  padding-right: 56px; /* room for stepper + chevron */
}

.time-picker-steppers {
  position: absolute;
  top: 1px;
  right: 26px;
  bottom: 1px;
  display: flex;
  flex-direction: column;
  width: 22px;
  border-left: 1px solid #d1d5db;
}

.time-picker-steppers button {
  flex: 1 1 0;
  min-height: 0;
  padding: 0;
  font-size: 9px;
  line-height: 1;
  background: #f9fafb;
  color: #374151;
  border: none;
  border-bottom: 1px solid #e5e7eb;
  cursor: pointer;
}
.time-picker-steppers button:last-child { border-bottom: none; }
.time-picker-steppers button:hover:not(:disabled) { background: #f3f4f6; }
.time-picker-steppers button:disabled { color: #d1d5db; cursor: not-allowed; }

.time-picker-chevron {
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  width: 24px;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  background: #f9fafb;
  color: #374151;
  border: none;
  border-left: 1px solid #d1d5db;
  cursor: pointer;
}
.time-picker-chevron:hover:not(:disabled) { background: #f3f4f6; }
.time-picker-chevron:disabled { color: #d1d5db; cursor: not-allowed; }

.time-picker-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 20;
}

.time-picker-dropdown li {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 14px;
  color: #111827;
}
.time-picker-dropdown li:hover { background: #f3f4f6; }
.time-picker-dropdown li.selected { background: #e0e7ff; font-weight: 600; }

.time-picker-flash .time-picker-input {
  animation: time-picker-flash 0.4s ease-out;
}
@keyframes time-picker-flash {
  0%   { background: #fee2e2; border-color: #f87171; }
  100% { background: transparent; border-color: inherit; }
}

.time-picker-disabled { opacity: 0.6; }

/* Mobile: bigger touch targets */
@media (max-width: 640px) {
  .time-picker-steppers { width: 28px; right: 32px; }
  .time-picker-chevron { width: 30px; }
  .time-picker-input { padding-right: 68px; }
  .time-picker-dropdown li { padding: 10px 12px; }
}
```

- [ ] **Step 2: Start the dev server (if not running) and visually verify the picker renders**

Add a throwaway `<TimePicker value="18:30" onChange={console.log} minHour={8} maxHour={22} />` in `AdminDashboard.js` temporarily or just wait until the next task swaps a real one.

- [ ] **Step 3: Commit**

```bash
git add client/src/index.css
git commit -m "style(time-picker): add component styles"
```

---

## Task 5: Swap in `AdminDashboard.js` (shift form)

**Files:**
- Modify: `client/src/pages/AdminDashboard.js:322-328`

- [ ] **Step 1: Add import at the top of the file**

Find the block of component imports near the top. Add this line after the other `components/` imports:

```js
import TimePicker from '../components/TimePicker';
```

- [ ] **Step 2: Replace the two `<input type="time">` elements**

Find the block around lines 320–328:

```jsx
<div>
  <label className="form-label">Start Time</label>
  <input className="form-input" type="time" value={shiftForm.start_time}
    onChange={e => setShiftForm(f => ({ ...f, start_time: e.target.value }))} />
</div>
<div>
  <label className="form-label">End Time</label>
  <input className="form-input" type="time" value={shiftForm.end_time}
    onChange={e => setShiftForm(f => ({ ...f, end_time: e.target.value }))} />
</div>
```

Replace with:

```jsx
<div>
  <label className="form-label" htmlFor="shift-start-time">Start Time</label>
  <TimePicker
    id="shift-start-time"
    value={shiftForm.start_time}
    onChange={(v) => setShiftForm(f => ({ ...f, start_time: v }))}
  />
</div>
<div>
  <label className="form-label" htmlFor="shift-end-time">End Time</label>
  <TimePicker
    id="shift-end-time"
    value={shiftForm.end_time}
    onChange={(v) => setShiftForm(f => ({ ...f, end_time: v }))}
  />
</div>
```

(No `minHour` / `maxHour` — full 24h range for admin flexibility.)

- [ ] **Step 3: Manual verify in browser**

Start `npm run dev` if not running. Navigate to admin dashboard → create a shift. Test: type `"7p"` → blurs to `7:00 PM`. Arrows step 30 min. Dropdown shows 12:00 AM–11:30 PM. Save — value persists as `"19:00"` in DB.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AdminDashboard.js
git commit -m "feat(admin): use TimePicker in shift creation form"
```

---

## Task 6: Swap in `ShiftDetail.js`

**Files:**
- Modify: `client/src/pages/admin/ShiftDetail.js:178-182`

- [ ] **Step 1: Add import**

```js
import TimePicker from '../../components/TimePicker';
```

(Two `..` because this file lives under `pages/admin/`.)

- [ ] **Step 2: Replace the two `<input type="time">` elements**

Find the two `<input className="form-input" type="time" ...>` lines and replace each with:

```jsx
<TimePicker
  value={editForm.start_time}
  onChange={(v) => setEditForm(f => ({ ...f, start_time: v }))}
/>
```

```jsx
<TimePicker
  value={editForm.end_time}
  onChange={(v) => setEditForm(f => ({ ...f, end_time: v }))}
/>
```

- [ ] **Step 3: Manual verify — edit an existing shift**

Open a shift, click edit, confirm current time renders correctly, change it, save, reload.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ShiftDetail.js
git commit -m "feat(admin): use TimePicker in shift edit form"
```

---

## Task 7: Swap in `ProposalCreate.js`

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js:14-23` (delete inline TIME_OPTIONS block)
- Modify: `client/src/pages/admin/ProposalCreate.js:~294` (replace `<select>`)

- [ ] **Step 1: Add import, remove inline generator**

Add to the imports:

```js
import TimePicker from '../../components/TimePicker';
```

Delete the block at lines 14–23:

```js
// Generate 30-minute time slots from 6:00 AM to 11:30 PM
const TIME_OPTIONS = [];
for (let h = 6; h < 24; h++) {
  ['00', '30'].forEach(m => {
    const val = `${String(h).padStart(2, '0')}:${m}`;
    const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ampm = h >= 12 ? 'PM' : 'AM';
    TIME_OPTIONS.push({ value: val, label: `${hour12}:${m} ${ampm}` });
  });
}
```

- [ ] **Step 2: Replace the `<select>` that uses `TIME_OPTIONS`**

Find this block around line 292:

```jsx
<select className="form-select" value={form.event_start_time} onChange={e => update('event_start_time', e.target.value)}>
  <option value="">— Select time —</option>
  {TIME_OPTIONS.map(t => (
    <option key={t.value} value={t.value}>{t.label}</option>
  ))}
</select>
```

Replace with:

```jsx
<TimePicker
  value={form.event_start_time}
  onChange={(v) => update('event_start_time', v)}
  minHour={6}
  maxHour={23}
/>
```

- [ ] **Step 3: Manual verify — create a proposal**

Step through to the event details step, pick a time, confirm the pricing preview fires. Submit.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(proposals): use TimePicker in proposal creation"
```

---

## Task 8: Swap in `ProposalDetail.js`

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js:33-42` (delete inline TIME_OPTIONS)
- Modify: `client/src/pages/admin/ProposalDetail.js:~1544-1549` (replace `<select>`)

- [ ] **Step 1: Add import, remove inline generator**

```js
import TimePicker from '../../components/TimePicker';
```

Delete the block at lines 33–42 (same TIME_OPTIONS loop as Task 7).

- [ ] **Step 2: Replace the `<select>`**

Find this block around line 1544:

```jsx
<select className="form-select" value={editForm.event_start_time} onChange={e => updateEdit('event_start_time', e.target.value)}>
  <option value="">— Select time —</option>
  {TIME_OPTIONS.map(t => (
    <option key={t.value} value={t.value}>{t.label}</option>
  ))}
</select>
```

Replace with:

```jsx
<TimePicker
  value={editForm.event_start_time || ''}
  onChange={(v) => updateEdit('event_start_time', v)}
  minHour={6}
  maxHour={23}
/>
```

- [ ] **Step 3: Manual verify — edit an existing proposal**

Open a proposal, click edit on the event details, change the time, save. Reload and confirm it persists. Confirm the "proposal price changes re-evaluate payment status" flow is unaffected (this is not a price change, but CLAUDE.md flags `event_start_time` changes as shift-sync — confirm linked shifts still reflect correctly).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ProposalDetail.js
git commit -m "feat(proposals): use TimePicker when editing event details"
```

---

## Task 9: Swap in `QuoteWizard.js`

**Files:**
- Modify: `client/src/pages/website/QuoteWizard.js:39-48` (delete inline TIME_OPTIONS)
- Modify: `client/src/pages/website/QuoteWizard.js:~800` (replace `<select>`)

- [ ] **Step 1: Add import, remove inline generator**

```js
import TimePicker from '../../components/TimePicker';
```

Delete the block at lines 39–48. (Same pattern as Task 7, but `for (let h = 8; h < 23; h++)` so last slot was `10:30 PM` — keep that range when configuring TimePicker: `minHour={8} maxHour={22}`.)

- [ ] **Step 2: Replace the `<select>` around line 797**

Find this block:

```jsx
<select id="wz-event_start_time" className="form-select" value={form.event_start_time}
  onChange={e => update('event_start_time', e.target.value)}>
  <option value="">-- Select --</option>
  {TIME_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
</select>
```

Replace with:

```jsx
<TimePicker
  id="wz-event_start_time"
  value={form.event_start_time}
  onChange={(v) => update('event_start_time', v)}
  minHour={8}
  maxHour={22}
/>
```

(The outer `<label htmlFor="wz-event_start_time">` stays — we preserve the id.)

- [ ] **Step 3: Manual verify — run the public quote wizard**

Walk the wizard on `/quote`. Confirm time picker appears on the event details step. Confirm dropdown shows only 8:00 AM–10:30 PM. Submit the wizard; check that the back-end receives `event_start_time` as `"HH:MM"`.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/website/QuoteWizard.js
git commit -m "feat(website): use TimePicker in quote wizard"
```

---

## Task 10: Swap in `ClassWizard.js`

**Files:**
- Modify: `client/src/pages/website/ClassWizard.js:11-20` (delete inline TIME_OPTIONS)
- Modify: `client/src/pages/website/ClassWizard.js:~418` (replace `<select>`)

- [ ] **Step 1: Add import, remove inline generator**

```js
import TimePicker from '../../components/TimePicker';
```

Delete the block at lines 11–20 (same as Task 9).

- [ ] **Step 2: Replace the `<select>` around line 415**

Find this block:

```jsx
<select className="form-select" value={form.event_start_time}
  onChange={e => update('event_start_time', e.target.value)}>
  <option value="">-- Select --</option>
  {TIME_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
</select>
```

Replace with:

```jsx
<TimePicker
  value={form.event_start_time}
  onChange={(v) => update('event_start_time', v)}
  minHour={8}
  maxHour={22}
/>
```

- [ ] **Step 3: Manual verify — book a class**

Walk `/classes` wizard. Confirm TimePicker works, blurs canonicalize typed input, submit succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/website/ClassWizard.js
git commit -m "feat(website): use TimePicker in class booking wizard"
```

---

## Task 11: Docs + pre-push review

**Files:**
- Modify: `CLAUDE.md` — add `TimePicker.js` line under the components list
- Modify: `README.md` — add `TimePicker.js` line under the components list

- [ ] **Step 1: Update CLAUDE.md folder tree**

In `CLAUDE.md`, find the `client/src/components/` block. Insert, alphabetically sorted:

```
│   │   │   ├── TimePicker.js    # Unified time input (type, arrows, dropdown — 30-min increments)
```

- [ ] **Step 2: Update README.md folder tree**

Same insertion in `README.md` under `client/src/components/`.

- [ ] **Step 3: Run the verification command**

```bash
cd client && npm test -- --watchAll=false timeOptions
```

Expected: all Jest cases pass.

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add TimePicker to component tree"
```

- [ ] **Step 5: Run pre-push review agents**

Per CLAUDE.md Pre-Push Procedure — this change touches >1 file and includes React component logic + CSS. Launch 5 agents in parallel (single message, 5 concurrent Agent tool calls):

- `consistency-check`
- `code-review`
- `security-review`
- `database-review`
- `performance-review`

(Skip `ui-ux-review` unless the user explicitly asks and `npm run dev` is running.)

Wait for all 5 reports, consolidate any blockers/warnings/suggestions, ask the user how to proceed before pushing.

- [ ] **Step 6: Push (only after user OK)**

```bash
git push origin main
```

---

## Verification checklist

Before declaring done, walk this list in a running dev server:

1. **Typing:** Admin shift form → type `"7p"` → blur → shows `7:00 PM`, value in state is `"19:00"`.
2. **Invalid:** Type `"25:00"` → blur → flashes red, reverts to prior value.
3. **Off-grid:** Type `"6:17 PM"` → blur → shows `6:17 PM`. Press ▲ → `6:30 PM`. Press ▼ from `6:17 PM` → `6:00 PM`.
4. **Clear:** Delete all text → blur → value becomes `""`, placeholder reappears.
5. **Bounds:** QuoteWizard → dropdown starts at `8:00 AM`, ends at `10:30 PM`. ▼ at `8:00 AM` is disabled.
6. **Persist:** Save a proposal / shift / class with a time. Reload the page. Value displays correctly.
7. **Keyboard:** Tab to input, Arrow-Up / Arrow-Down steps 30 min. Alt+Down opens dropdown. Enter inside dropdown selects highlighted row.
8. **Mobile:** DevTools mobile emulation — tap targets ≥28px wide, dropdown scrolls, blur works after virtual keyboard dismiss.
9. **Docs sync:** `CLAUDE.md` and `README.md` both show `TimePicker.js` in the components list.
