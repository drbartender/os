# Remove Event Title — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop `event_name` from the schema and UI. Display every event as two independent fields — `client_name` and a resolved `event_type` label — with a graceful `'event'` fallback when type is unset.

**Architecture:** Schema loses one column on three tables; two shifts/drink_plans gain denormalized type columns so they remain self-describing. A pair of mirrored helpers (`server/utils/eventTypes.js`, `client/src/utils/eventTypes.js`) expose `getEventTypeLabel({ event_type, event_type_custom })` that returns the label, the custom string, or `'event'`. Every caller of the old `event_name` pattern switches to these helpers.

**Tech Stack:** Node.js + Express, Neon PostgreSQL (raw SQL), React 18. No test runner in the repo — verification is manual via `node -e` smoke checks and the running dev server (`npm run dev`).

**Project conventions to honor:**
- **Git:** Trunk-only on `main`. Explicit file staging (`git add <path>`). A commit cue is required before each commit; a separate explicit push cue is required before any push. Every task below ends with a commit step that waits for the cue.
- **Schema migrations:** Idempotent (`IF NOT EXISTS`, `IF EXISTS`). All DDL lives in `server/db/schema.sql` and runs on app boot.
- **Docs:** Schema and cross-cutting changes require updates to `.claude/CLAUDE.md`, `README.md`, and `ARCHITECTURE.md` in the same change (per CLAUDE.md's Mandatory Documentation Updates).
- **Review agents:** Before pushing, run the five non-UI review agents in parallel per CLAUDE.md's Pre-Push Procedure. This plan includes that step.

**Design spec:** `docs/superpowers/specs/2026-04-16-remove-event-title-design.md`

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `client/src/data/eventTypes.js` | Modify | Add `cocktail-class` entry (id + label + category) |
| `client/src/utils/eventTypes.js` | Create | Export `getEventTypeLabel({ event_type, event_type_custom })` wrapping the data array |
| `server/utils/eventTypes.js` | Create | Server-side mirror of the id→label map + `getEventTypeLabel` helper |
| `server/db/schema.sql` | Modify | Add denormalized columns to shifts/drink_plans, backfill from linked proposal, drop `event_name` from all three tables |
| `server/db/seedTestData.js` | Modify | Replace `event_name` columns with `event_type` (+ `client_name` on shifts) in every INSERT |
| `server/utils/emailTemplates.js` | Modify | Replace `eventName` parameter with `eventTypeLabel` in all 10 template functions |
| `server/utils/eventCreation.js` | Modify | Copy `event_type`/`event_type_custom`/`client_name` from proposal into shifts and drink plans; stop writing `event_name` |
| `server/utils/autoAssign.js` | Modify | SMS uses `event_type_label` + `client_name` instead of `event_name` |
| `server/utils/autoAssignScheduler.js` | Modify | SELECT new columns; log lines use resolved label |
| `server/utils/balanceScheduler.js` | Modify | Stripe `description` uses `event_type_label` |
| `server/routes/proposals.js` | Modify | Drop `event_name` from all SELECT/INSERT/UPDATE/validation; pass `eventTypeLabel` to emails |
| `server/routes/shifts.js` | Modify | SELECT/INSERT/UPDATE use the denormalized shift columns; drop `event_name` |
| `server/routes/drinkPlans.js` | Modify | Drop `event_name`; change search filter to `client_name`/`client_email` |
| `server/routes/calendar.js` | Modify | ICS `SUMMARY` composed from `client_name` + `event_type_label` |
| `server/routes/clientPortal.js` | Modify | SELECT drops `event_name` |
| `server/routes/invoices.js` | Modify | SELECT drops `event_name` |
| `server/routes/messages.js` | Modify | SELECT drops `s.event_name AS shift_event_name`; compose display server-side when needed |
| `server/routes/stripe.js` | Modify | Payment descriptors use `event_type_label` |
| `client/src/pages/admin/ProposalCreate.js` | Modify | Remove `event_name` form field, Title display, and `event_type_custom → event_name` copy |
| `client/src/pages/admin/ProposalDetail.js` | Modify | Split heading into `client_name` + `event_type_label` subtitle |
| `client/src/pages/admin/EventsDashboard.js` | Modify | Delete `eventTitle()` helper; display client + type separately |
| `client/src/pages/admin/ShiftDetail.js` | Modify | Remove local `title` variable; use split heading |
| `client/src/pages/admin/ClientDetail.js` | Modify | Proposal/shift rows show both fields separately |
| `client/src/pages/admin/DrinkPlansDashboard.js` | Modify | Same pattern |
| `client/src/pages/admin/DrinkPlanDetail.js` | Modify | Same pattern |
| `client/src/pages/public/ClientDashboard.js` | Modify | Split heading; `'event'` fallback |
| `client/src/pages/proposal/ProposalView.js` | Modify | "Your {event_type_label} proposal" heading |
| `client/src/pages/invoice/InvoicePage.js` | Modify | Same heading pattern |
| `client/src/pages/plan/steps/WelcomeStep.js` | Modify | "Your drink plan for your {event_type_label}" |
| `client/src/pages/website/ClassWizard.js` | Modify | Remove event_name input; hard-code `event_type: 'cocktail-class'`, `event_type_category: 'class'` |
| `client/src/components/ShoppingList/ShoppingListPDF.jsx` | Modify | Header metadata includes `eventTypeLabel` next to the event date |
| `client/src/components/ShoppingList/ShoppingListModal.jsx` | Modify | Pass `eventTypeLabel` through to the PDF |
| `client/src/components/ShoppingList/ShoppingListButton.jsx` | Modify | Build the label and pass it to the modal |
| `.claude/CLAUDE.md` | Modify | Add cross-cutting rule about never concatenating client + type; remove any `event_name` references |
| `README.md` | Modify | Remove any `event_name` references from schema/entity descriptions |
| `ARCHITECTURE.md` | Modify | Update Database Schema section to reflect new columns and dropped column |

No new routes mounted. No env vars added.

---

## Task 1: Shared event-type helpers + cocktail-class entry

**Files:**
- Modify: `client/src/data/eventTypes.js`
- Create: `client/src/utils/eventTypes.js`
- Create: `server/utils/eventTypes.js`

**Intent:** Ship additive, non-breaking foundation first. No downstream file touches this yet, so the app keeps running as-is.

- [ ] **Step 1: Add the `cocktail-class` entry to the client data file**

Open `client/src/data/eventTypes.js`. Find the `// Other` section near the end (around line 36–38):

```js
  // Other
  { id: 'festival-outdoor', label: 'Festival / Outdoor Event', category: 'other' },
  { id: 'other', label: 'Other', category: 'other' },
```

Insert a new `class` group above `// Other` so the full change reads:

```js
  // Class
  { id: 'cocktail-class', label: 'Cocktail Class', category: 'class' },

  // Other
  { id: 'festival-outdoor', label: 'Festival / Outdoor Event', category: 'other' },
  { id: 'other', label: 'Other', category: 'other' },
```

- [ ] **Step 2: Create the client-side helper**

Create `client/src/utils/eventTypes.js` with exactly:

```js
// Resolves an event type id to a human label.
// Mirrors server/utils/eventTypes.js — keep both files in sync when adding types.

import EVENT_TYPES from '../data/eventTypes';

export { default as EVENT_TYPES } from '../data/eventTypes';

export function getEventTypeLabel({ event_type, event_type_custom } = {}) {
  if (event_type === 'other' && event_type_custom) return event_type_custom;
  const found = EVENT_TYPES.find(t => t.id === event_type);
  return found ? found.label : 'event';
}
```

- [ ] **Step 3: Create the server-side helper**

Create `server/utils/eventTypes.js` with exactly:

```js
// Resolves an event type id to a human label.
// Mirrors client/src/data/eventTypes.js — keep both files in sync when adding types.

const EVENT_TYPES = [
  { id: 'wedding-reception', label: 'Wedding Reception', category: 'wedding_related' },
  { id: 'rehearsal-dinner', label: 'Rehearsal Dinner', category: 'wedding_related' },
  { id: 'engagement-party', label: 'Engagement Party', category: 'wedding_related' },
  { id: 'bridal-shower', label: 'Bridal Shower', category: 'wedding_related' },
  { id: 'bachelor-bachelorette', label: 'Bachelor / Bachelorette Party', category: 'wedding_related' },
  { id: 'birthday-party', label: 'Birthday Party', category: 'celebrations' },
  { id: 'milestone-birthday', label: 'Milestone Birthday', category: 'celebrations' },
  { id: 'anniversary', label: 'Anniversary', category: 'celebrations' },
  { id: 'graduation-party', label: 'Graduation Party', category: 'celebrations' },
  { id: 'retirement-party', label: 'Retirement Party', category: 'celebrations' },
  { id: 'baby-shower', label: 'Baby Shower', category: 'celebrations' },
  { id: 'corporate-event', label: 'Corporate Event', category: 'corporate' },
  { id: 'corporate-happy-hour', label: 'Corporate Happy Hour', category: 'corporate' },
  { id: 'holiday-party', label: 'Holiday Party', category: 'corporate' },
  { id: 'fundraiser-gala', label: 'Fundraiser / Gala', category: 'corporate' },
  { id: 'cocktail-party', label: 'Cocktail Party', category: 'social' },
  { id: 'private-party', label: 'Private Party', category: 'social' },
  { id: 'housewarming', label: 'Housewarming', category: 'social' },
  { id: 'block-party', label: 'Block Party', category: 'social' },
  { id: 'dinner-party', label: 'Dinner Party', category: 'social' },
  { id: 'celebration-of-life', label: 'Celebration of Life / Memorial', category: 'memorial' },
  { id: 'cocktail-class', label: 'Cocktail Class', category: 'class' },
  { id: 'festival-outdoor', label: 'Festival / Outdoor Event', category: 'other' },
  { id: 'other', label: 'Other', category: 'other' },
];

function getEventTypeLabel({ event_type, event_type_custom } = {}) {
  if (event_type === 'other' && event_type_custom) return event_type_custom;
  const found = EVENT_TYPES.find(t => t.id === event_type);
  return found ? found.label : 'event';
}

module.exports = { EVENT_TYPES, getEventTypeLabel };
```

- [ ] **Step 4: Smoke-test the server helper**

Run:

```bash
cd C:/Users/dalla/DRB_OS/os && node -e "const { getEventTypeLabel } = require('./server/utils/eventTypes'); console.log(JSON.stringify({known: getEventTypeLabel({event_type:'wedding-reception'}), custom: getEventTypeLabel({event_type:'other', event_type_custom:'Pirate Birthday'}), missing: getEventTypeLabel({}), otherBlank: getEventTypeLabel({event_type:'other'})}))"
```

Expected output:

```json
{"known":"Wedding Reception","custom":"Pirate Birthday","missing":"event","otherBlank":"event"}
```

If any value is wrong, fix the helper before moving on.

- [ ] **Step 5: Start dev and confirm nothing broke**

Run `npm run dev` in one terminal. Confirm server starts and client compiles with no errors. Stop the server (Ctrl-C) when done.

- [ ] **Step 6: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/data/eventTypes.js client/src/utils/eventTypes.js server/utils/eventTypes.js
git commit -m "feat: add shared event-type label helper and cocktail-class entry"
```

---

## Task 2: Schema migration — add, backfill, drop

**Files:**
- Modify: `server/db/schema.sql` (three touch points: shifts section ~L205–220, drink_plans section ~L268–299, proposals section ~L670–700 and the ALTER block ~L930–940)

**Intent:** Add new columns first, backfill from linked proposals, then drop `event_name`. All idempotent so re-running is safe.

- [ ] **Step 1: Add denormalized columns to `shifts`**

In `server/db/schema.sql`, find the section of `ALTER TABLE shifts` additions (search for `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS proposal_id` around line 700). Add these `ALTER` statements **immediately after** the `idx_shifts_proposal_id` index creation:

```sql
-- ─── Event type denormalization on shifts (replaces event_name) ──
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS event_type VARCHAR(100);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);
```

- [ ] **Step 2: Add denormalized columns to `drink_plans`**

Find a suitable spot **after** the `CREATE TABLE IF NOT EXISTS drink_plans` block (around line 287). Add after the existing migrations block:

```sql
-- ─── Event type denormalization on drink_plans (replaces event_name) ──
ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS event_type VARCHAR(100);
ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS event_type_custom VARCHAR(255);
```

- [ ] **Step 3: Backfill from linked proposals**

Find the ALTER block near the event_type columns on proposals (around line 936, the comment reads `-- Event type (structured selector replaces free-text event_name)`). **After** the existing `ALTER TABLE proposals ADD COLUMN ... event_type_custom` lines (~L937–L939), insert:

```sql
-- ─── Backfill denormalized columns from linked proposals ──
UPDATE shifts s
   SET event_type        = p.event_type,
       event_type_custom = p.event_type_custom,
       client_name       = c.name
  FROM proposals p
  LEFT JOIN clients c ON c.id = p.client_id
 WHERE s.proposal_id = p.id
   AND s.event_type IS NULL;

UPDATE drink_plans d
   SET event_type        = p.event_type,
       event_type_custom = p.event_type_custom
  FROM proposals p
 WHERE d.proposal_id = p.id
   AND d.event_type IS NULL;
```

- [ ] **Step 4: Drop `event_name` from all three tables**

Immediately after the backfill block, append:

```sql
-- ─── Drop event_name now that type denormalization is in place ──
ALTER TABLE proposals   DROP COLUMN IF EXISTS event_name;
ALTER TABLE shifts      DROP COLUMN IF EXISTS event_name;
ALTER TABLE drink_plans DROP COLUMN IF EXISTS event_name;
```

- [ ] **Step 5: Remove the old `event_name VARCHAR(255) NOT NULL` from the `CREATE TABLE shifts` body**

In the `CREATE TABLE IF NOT EXISTS shifts` block (around line 206–219), delete the line:

```sql
  event_name VARCHAR(255) NOT NULL,
```

(The `CREATE TABLE` is guarded by `IF NOT EXISTS` so existing databases are unaffected, but fresh databases created after this change must not reintroduce the column.)

Also delete the `event_name VARCHAR(255),` line inside the `CREATE TABLE IF NOT EXISTS drink_plans` block (~L274).

Also delete the `event_name VARCHAR(255),` line inside the proposals `CREATE TABLE` block (~L673).

- [ ] **Step 6: Verify schema init runs without error**

**Do not commit yet.** Run `npm run dev` and let the server go through its boot-time schema init. Expected: clean startup, no SQL errors printed. If it fails, fix the statements before the commit step. Then Ctrl-C.

Sanity check in a psql shell (optional — use the Neon console if no psql locally):

```sql
\d shifts       -- confirms event_type, event_type_custom, client_name exist; event_name is gone
\d drink_plans  -- confirms event_type, event_type_custom exist; event_name is gone
\d proposals    -- confirms event_name is gone
```

- [ ] **Step 7: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/db/schema.sql
git commit -m "feat(db): add event-type denormalization, backfill, drop event_name"
```

---

## Task 3: Update seed data

**Files:**
- Modify: `server/db/seedTestData.js`

**Intent:** Fresh seeds must match the new schema.

- [ ] **Step 1: Replace every `event_name` column reference**

Open `server/db/seedTestData.js`. There are multiple INSERTs touching `proposals`, `shifts`, and `drink_plans`. For each one:

1. Remove `event_name` from the column list and the corresponding value from the VALUES list.
2. If the INSERT was to `proposals` and does not already set `event_type`, add `event_type` to the column list and a reasonable value to VALUES (e.g., `'wedding-reception'`, `'birthday-party'`, `'corporate-event'`). Vary by record so seed data looks realistic.
3. If the INSERT was to `shifts`, add `event_type`, `event_type_custom`, `client_name` columns (`NULL` or copied from the associated proposal's client is fine; free to hard-code a sensible string per record).
4. If the INSERT was to `drink_plans`, add `event_type` and `event_type_custom` columns (`NULL` is fine if the drink plan is standalone, otherwise copy from the associated proposal).

Grep to double-check no references remain:

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name" server/db/seedTestData.js
```

Expected: zero matches.

- [ ] **Step 2: Run the seed and confirm it succeeds**

```bash
cd C:/Users/dalla/DRB_OS/os && npm run seed
```

(If the project's seed script doesn't call `seedTestData.js` directly, skip this step and rely on the production dev server to execute seed logic on startup — check `server/db/seed.js` to confirm the invocation path.)

Expected: seed runs with no SQL errors. If errors mention missing columns, the schema in Task 2 needs to have been applied first.

- [ ] **Step 3: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/db/seedTestData.js
git commit -m "feat(seed): update seed data for event_type columns"
```

---

## Task 4: Backend utilities — emails, event creation, auto-assign, balance scheduler

**Files:**
- Modify: `server/utils/emailTemplates.js`
- Modify: `server/utils/eventCreation.js`
- Modify: `server/utils/autoAssign.js`
- Modify: `server/utils/autoAssignScheduler.js`
- Modify: `server/utils/balanceScheduler.js`

**Intent:** Change the internal API used by routes before the routes are touched. After this task, the routes won't compile cleanly until Task 5–8, so the commit for this task stands alone but the dev server may have runtime errors until routes are updated. That's acceptable since we're on a solo trunk.

- [ ] **Step 1: Update `emailTemplates.js` function signatures**

Open `server/utils/emailTemplates.js`. For each of the ten exported template functions that currently take `eventName`, rename the parameter to `eventTypeLabel` and replace the default:

| Function | Current param pattern | New pattern |
|---|---|---|
| `proposalSent` | `eventName` → `eventName \|\| 'your upcoming event'` | `eventTypeLabel = 'event'` → used directly as `your ${eventTypeLabel}` |
| `proposalSignedConfirmation` | same | same |
| `paymentReceivedClient` | same | same |
| `drinkPlanLink` | same | same |
| `drinkPlanBalanceUpdate` | same | same |
| `clientSignedAdmin` | `eventName \|\| 'Proposal #${proposalId}'` | `eventTypeLabel = 'event'` — subject uses `${eventTypeLabel} (Proposal #${proposalId})` |
| `paymentReceivedAdmin` | same as clientSignedAdmin | same |
| `shiftRequestAdmin` | `eventName \|\| 'a shift'` | `eventTypeLabel = 'event'` — body uses `a ${eventTypeLabel}` |
| `shiftRequestApproved` | `eventName \|\| 'an upcoming event'` | `eventTypeLabel = 'event'` — body uses `your ${eventTypeLabel}` |

Concrete example for `proposalSent` (current ~L54–L74):

```js
function proposalSent({ clientName, eventTypeLabel = 'event', proposalUrl, planUrl }) {
  const event = eventTypeLabel;
  // ... rest of function unchanged except every `${event}` reference now yields a clean phrase
}
```

Apply the same pattern to the other nine. Drop the `const event = eventName || 'your upcoming event'` line (or similar) in each — the default parameter handles the fallback.

- [ ] **Step 2: Verify every template function signature**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -nE "function (proposalSent|proposalSignedConfirmation|paymentReceivedClient|drinkPlanLink|drinkPlanBalanceUpdate|clientSignedAdmin|paymentReceivedAdmin|shiftRequestAdmin|shiftRequestApproved)" server/utils/emailTemplates.js
```

Expected: every line shows `eventTypeLabel` (not `eventName`) in the destructured args.

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "eventName" server/utils/emailTemplates.js
```

Expected: zero matches.

- [ ] **Step 3: Update `eventCreation.js`**

Open `server/utils/eventCreation.js`. Replace the current drink-plan INSERT (~L47–L56) and shift INSERT (~L120–L130) so they write the new columns instead of `event_name`.

Required edits:

a) At the top of the file (after existing requires), add:

```js
const { getEventTypeLabel } = require('./eventTypes');
```

b) Change the drink-plan INSERT block to:

```js
const drinkPlanResult = await client.query(
  `INSERT INTO drink_plans (client_name, client_email, event_type, event_type_custom, event_date, proposal_id, created_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7)
   RETURNING id, token`,
  [
    proposal.client_name,
    proposal.client_email,
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposal.event_date,
    proposal.id,
    proposal.created_by,
  ]
);
```

c) Replace the subsequent `const eventName = drinkPlan.event_name || ...` with:

```js
const eventTypeLabel = getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
```

…and update the email call site further down to pass `eventTypeLabel` instead of `eventName`.

d) Change the shift INSERT block to:

```js
const shiftResult = await client.query(
  `INSERT INTO shifts (event_type, event_type_custom, client_name, event_date, start_time, end_time, location, positions_needed, notes, status, proposal_id, created_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
   RETURNING id`,
  [
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposal.client_name || null,
    proposal.event_date,
    proposal.event_start_time,
    proposal.event_end_time,
    proposal.event_location,
    JSON.stringify(proposal.positions_needed || []),
    proposal.notes || null,
    'open',
    proposal.id,
    proposal.created_by,
  ]
);
```

e) Update the JSDoc at line 33 to drop `event_name` and add `event_type, event_type_custom, client_name`:

```js
 * @param {object} proposal - Proposal row (must include client_name, client_email, event_type, event_type_custom, event_date, created_by)
```

- [ ] **Step 4: Update `autoAssign.js`**

Open `server/utils/autoAssign.js`. At the top, add:

```js
const { getEventTypeLabel } = require('./eventTypes');
```

Find line 303 (the SMS message composition). Replace:

```js
const msg = `Hey ${name}! You've been approved for ${shift.event_name} on ${shift.event_date}.` +
```

with:

```js
const eventTypeLabel = getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom });
const eventCtx = shift.client_name ? `${eventTypeLabel} at ${shift.client_name}` : `${eventTypeLabel} event`;
const msg = `Hey ${name}! You've been approved for the ${eventCtx} on ${shift.event_date}.` +
```

Verify the SELECT that feeds `shift` earlier in the file pulls the new columns. Add `s.event_type, s.event_type_custom, s.client_name` to the SELECT's column list (or `shifts.event_type` etc. — follow the existing alias style) and remove `s.event_name` / `shifts.event_name` from the list.

- [ ] **Step 5: Update `autoAssignScheduler.js`**

Open `server/utils/autoAssignScheduler.js`. Line 14 currently reads:

```js
SELECT id, event_name, event_date, auto_assign_days_before
```

Change to:

```js
SELECT id, event_type, event_type_custom, client_name, event_date, auto_assign_days_before
```

At the top of the file, add:

```js
const { getEventTypeLabel } = require('./eventTypes');
```

Line 30 currently logs `${shift.event_name}`. Change it to:

```js
`[AutoAssignScheduler] Shift ${shift.id} (${getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })}): approved ${outcome.approved.length} of ${outcome.slots_remaining} slots`
```

- [ ] **Step 6: Update `balanceScheduler.js`**

Open `server/utils/balanceScheduler.js`.

a) At the top, add:

```js
const { getEventTypeLabel } = require('./eventTypes');
```

b) Line 16 currently selects `event_name`. Change the SELECT to:

```js
SELECT id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id, event_type, event_type_custom
```

c) Line 41 description uses `event_name`. Replace:

```js
description: `Balance Payment — ${proposal.event_name || 'Dr. Bartender Event'}`,
```

with:

```js
description: `Balance Payment — ${getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })} event`,
```

d) Line 79 `RETURNING id, event_name` — change to `RETURNING id, event_type, event_type_custom`. Update any downstream log line that consumed the returned `event_name` to use the same helper.

- [ ] **Step 7: Sweep for leftover references**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/utils/
```

Expected: zero matches across these files. If any remain in other util files (e.g., `email.js`, `sms.js`), address them now using the same helper pattern.

- [ ] **Step 8: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/utils/emailTemplates.js server/utils/eventCreation.js server/utils/autoAssign.js server/utils/autoAssignScheduler.js server/utils/balanceScheduler.js
git commit -m "refactor(utils): use event_type label helper in emails, auto-assign, balance scheduler"
```

---

## Task 5: `proposals.js` route

**Files:**
- Modify: `server/routes/proposals.js`

**Intent:** Proposals are the hub. This one file carries the most `event_name` references; each is surgical.

- [ ] **Step 1: Add the helper import at the top of the file**

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

- [ ] **Step 2: Remove `event_name` from every SELECT column list**

Use grep to find every line:

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name" server/routes/proposals.js
```

For each SELECT line, delete the `event_name` token (and the leading comma or trailing comma as appropriate). For each INSERT/UPDATE, delete the `event_name` column and the corresponding `$N` value in the parameter array, then decrement the subsequent `$N` numbers to keep them contiguous. Also remove `event_name` from any request-body destructuring (`const { event_name, ... } = req.body`).

Be meticulous: parameter index shifts are the most common source of bugs in this kind of edit.

- [ ] **Step 3: Delete the "Derive event_name from event type" block**

Around line 447, remove the block that derives `event_name` from `event_type_custom` or the matched label. The frontend no longer sends `event_name`, so the derivation is dead code.

- [ ] **Step 4: Update email call sites**

Find every call into `emailTemplates` functions (search for `emailTemplates.` or the bare function names). Each currently passes `eventName: someRow.event_name`. Replace with:

```js
eventTypeLabel: getEventTypeLabel({ event_type: someRow.event_type, event_type_custom: someRow.event_type_custom }),
```

Make sure the SELECT that produced `someRow` includes both `event_type` and `event_type_custom`.

- [ ] **Step 5: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/routes/proposals.js
```

Expected: zero matches.

- [ ] **Step 6: Verify the server starts and a proposal-list endpoint responds**

Start `npm run dev`. In a second terminal, log in via the admin UI, open `ProposalsDashboard`, and confirm proposals load without a 500. Watch the server log for SQL errors. (The UI may show "undefined" in titles — that's expected until Tasks 9–10.)

- [ ] **Step 7: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/routes/proposals.js
git commit -m "refactor(proposals): drop event_name from reads/writes, pass event_type_label to emails"
```

---

## Task 6: `shifts.js` route

**Files:**
- Modify: `server/routes/shifts.js`

**Intent:** Shifts are now self-describing via their own denormalized columns.

- [ ] **Step 1: Add helper import**

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

- [ ] **Step 2: Replace `event_name` in SELECTs**

For every SELECT that currently reads `s.event_name` or `event_name`, replace it with `s.event_type, s.event_type_custom, s.client_name` (or without the `s.` prefix if no alias).

- [ ] **Step 3: Replace `event_name` in INSERT/UPDATE**

The insert (~L302–L335) currently takes `event_name` from `req.body`. Destructure `event_type`, `event_type_custom`, `client_name` from `req.body` instead, and pass them to the INSERT. Same for any UPDATE statement.

- [ ] **Step 4: Update validation**

The validation "event_name and date are required" at ~L305 becomes:

```js
if (!event_date) return res.status(400).json({ error: 'event_date is required' });
```

Drop the `event_name` requirement entirely — `event_type` remains optional.

- [ ] **Step 5: Update email call sites**

At ~L269 (and any others) that build the email payload, replace `eventName: si?.event_name` with:

```js
eventTypeLabel: getEventTypeLabel({ event_type: si?.event_type, event_type_custom: si?.event_type_custom }),
```

- [ ] **Step 6: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/routes/shifts.js
```

Expected: zero matches.

- [ ] **Step 7: Verify**

Start `npm run dev`. Open the admin shifts view. Create a new shift with event_date only; confirm it saves. Open an existing shift; confirm no 500 in server logs.

- [ ] **Step 8: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/routes/shifts.js
git commit -m "refactor(shifts): read/write event_type columns, drop event_name"
```

---

## Task 7: `drinkPlans.js` route

**Files:**
- Modify: `server/routes/drinkPlans.js`

- [ ] **Step 1: Add helper import**

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

- [ ] **Step 2: Remove `event_name` from every SELECT and INSERT**

Same pattern as Task 5. Where a SELECT pulled `event_name`, now pull `event_type, event_type_custom`.

- [ ] **Step 3: Replace the search filter at ~L318**

Current:

```js
dp.event_name ILIKE $N
```

New:

```js
(dp.client_name ILIKE $N OR dp.client_email ILIKE $N)
```

Keep the same `$N` binding.

- [ ] **Step 4: Update any email call sites**

Same pattern as Task 5 — `eventName: x.event_name` becomes `eventTypeLabel: getEventTypeLabel({ ... })`.

- [ ] **Step 5: Allow the public submission to omit event_type**

The PUBLIC submit endpoint should continue to accept drink plans with no `event_type`. Make sure `event_type` is not validated as required in the public path.

- [ ] **Step 6: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/routes/drinkPlans.js
```

Expected: zero matches.

- [ ] **Step 7: Verify**

Start `npm run dev`. Open admin drink-plans view; confirm loads. (Public Lab flow re-tested in Task 11.)

- [ ] **Step 8: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/routes/drinkPlans.js
git commit -m "refactor(drinkPlans): drop event_name, search on client_name"
```

---

## Task 8: Remaining backend routes

**Files:**
- Modify: `server/routes/calendar.js`
- Modify: `server/routes/clientPortal.js`
- Modify: `server/routes/invoices.js`
- Modify: `server/routes/messages.js`
- Modify: `server/routes/stripe.js`

**Intent:** Small mechanical edits across five files.

- [ ] **Step 1: `calendar.js` — ICS summary**

At the top, add:

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

Update every SELECT that currently pulls `s.event_name` to pull `s.event_type, s.event_type_custom, s.client_name` instead (the SELECTs around `s.event_name` at L311, L388, L408 live inside queries higher up — find each query block by searching for `FROM shifts` or `shifts s`).

Lines 311 and 388 currently compose:

```js
summary = s.client_name ? `${s.event_name} — ${s.client_name}` : s.event_name;
```

Replace with (client-name first, label second):

```js
const eventTypeLabel = getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom });
summary = s.client_name ? `${s.client_name} — ${eventTypeLabel}` : eventTypeLabel;
```

Lines 314 and 391 currently read `summary = \`Bartending — ${s.event_name}\`;`. Replace with:

```js
summary = `Bartending — ${getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom })}`;
```

Line 408 (filename derivation): replace `s.event_name` with the resolved `summary` variable (computed just above on that code path) or with `getEventTypeLabel({ ... })`. Keep the existing sanitization regex.

- [ ] **Step 2: `clientPortal.js`**

Line 14 reads `SELECT id, token, event_name, event_date, status, total_price, amount_paid, created_at`. Change to `SELECT id, token, event_type, event_type_custom, event_date, status, total_price, amount_paid, created_at`.

Lines 35–36 read `p.event_name, p.event_date, ...`. Replace `p.event_name,` with `p.event_type, p.event_type_custom,`.

(No server-side label composition needed here — the frontend resolves via its helper.)

- [ ] **Step 3: `invoices.js`**

Find `p.event_name` SELECTs (~L25, L89, L93). Replace with `p.event_type, p.event_type_custom`. Frontend resolves the label.

- [ ] **Step 4: `messages.js`**

At the top, add:

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

Line 149 aggregates with `MIN(s.event_name) AS shift_event_name`. Change to:

```sql
MIN(s.event_type) AS shift_event_type, MIN(s.event_type_custom) AS shift_event_type_custom, MIN(s.client_name) AS shift_client_name
```

Lines 202, 225: change `s.event_name AS shift_event_name` to:

```sql
s.event_type AS shift_event_type, s.event_type_custom AS shift_event_type_custom, s.client_name AS shift_client_name
```

Line 245: change the SELECT column list `id, event_name, event_date, ...` to `id, event_type, event_type_custom, client_name, event_date, ...`.

Update any downstream consumer of `shift_event_name` (grep for it in this file — typically used in SMS body composition or JSON response shapes). Replace each use with:

```js
const label = getEventTypeLabel({ event_type: row.shift_event_type, event_type_custom: row.shift_event_type_custom });
const shiftCtx = row.shift_client_name ? `${label} at ${row.shift_client_name}` : label;
```

If the response JSON used to include `shift_event_name`, you may keep backward-compatible shape by adding a derived `shift_event_label` field in the JSON instead. The frontend (`EmailLeadsDashboard`, etc. — unrelated) doesn't read these response fields, so a simple rename is fine.

- [ ] **Step 5: `stripe.js`** — 16 touch points

At top, add:

```js
const { getEventTypeLabel } = require('../utils/eventTypes');
```

Define a small local helper near the top of the route file (after imports) to keep call sites readable:

```js
function eventLabelFor(row) {
  return getEventTypeLabel({ event_type: row?.event_type, event_type_custom: row?.event_type_custom });
}
```

Now touch each site:

| Line | Current | Replacement |
|---|---|---|
| 88 | `SELECT p.id, p.status, p.event_name, p.total_price, p.event_date,` | Drop `p.event_name`; add `p.event_type, p.event_type_custom` in its place. |
| 136 | `Full Payment — ${proposal.event_name \|\| 'Dr. Bartender Event'}` | `Full Payment — ${eventLabelFor(proposal)} event` |
| 137 | `Event Deposit — ${proposal.event_name \|\| 'Dr. Bartender Event'}` | `Event Deposit — ${eventLabelFor(proposal)} event` |
| 191 | `p.event_name, p.pricing_snapshot,` | Replace `p.event_name` with `p.event_type, p.event_type_custom`. |
| 300 | `Drink Plan Extras — ${data.event_name \|\| 'Dr. Bartender Event'}` | `Drink Plan Extras — ${eventLabelFor(data)} event` |
| 338 | `SELECT id, event_name FROM proposals WHERE id = $1` | `SELECT id, event_type, event_type_custom FROM proposals WHERE id = $1` |
| 344 | `const eventName = proposal.event_name \|\| 'Dr. Bartender Event';` | `const eventLabel = eventLabelFor(proposal);` |
| 350 | `product_data: { name: \`Event Deposit — ${eventName}\` },` | `product_data: { name: \`Event Deposit — ${eventLabel} event\` },` |
| 383 | `autopay_enrolled, status, event_name` | Replace `event_name` with `event_type, event_type_custom`. |
| 410 | `Balance Payment — ${proposal.event_name \|\| 'Dr. Bartender Event'}` | `Balance Payment — ${eventLabelFor(proposal)} event` |
| 438 | `p.id AS proposal_id, p.event_name, p.stripe_customer_id,` | Replace `p.event_name` with `p.event_type, p.event_type_custom`. |
| 527 | `SELECT p.event_name, c.name AS client_name, c.email AS client_email` | `SELECT p.event_type, p.event_type_custom, c.name AS client_name, c.email AS client_email` |
| 536 | `emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventName: pi.event_name, ... })` | `emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventTypeLabel: eventLabelFor(pi), ... })` |
| 543 | `emailTemplates.paymentReceivedAdmin({ ..., eventName: pi?.event_name, ... })` | `emailTemplates.paymentReceivedAdmin({ ..., eventTypeLabel: eventLabelFor(pi), ... })` |
| 728 | `SELECT p.event_name, c.name AS client_name` | `SELECT p.event_type, p.event_type_custom, c.name AS client_name` |
| 736 | `subject: \`Payment Failed — ${pi?.client_name \|\| 'Unknown'} (${pi?.event_name \|\| 'Event'})\`` | `subject: \`Payment Failed — ${pi?.client_name \|\| 'Unknown'} (${eventLabelFor(pi)})\`` |

After the edits, sweep this one file:

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/routes/stripe.js
```

Expected: zero matches.

- [ ] **Step 6: Sweep all five files**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name\|eventName" server/routes/calendar.js server/routes/clientPortal.js server/routes/invoices.js server/routes/messages.js server/routes/stripe.js
```

Expected: zero matches.

- [ ] **Step 7: Also sweep for any remaining backend references**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -rn "event_name\|eventName" server/
```

Expected: zero matches outside `schema.sql` (which may have comments referencing the old column — those are fine if they're historical comments).

- [ ] **Step 8: Verify**

Start `npm run dev`. Hit the admin dashboard, client portal (if you have a test client login), calendar subscription URL (view as raw in browser), and an invoice page. No 500s.

- [ ] **Step 9: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add server/routes/calendar.js server/routes/clientPortal.js server/routes/invoices.js server/routes/messages.js server/routes/stripe.js
git commit -m "refactor(routes): drop event_name from calendar, portal, invoices, messages, stripe"
```

---

## Task 9: `ProposalCreate.js` — remove Title input and display

**Files:**
- Modify: `client/src/pages/admin/ProposalCreate.js`

**Intent:** The only admin form that explicitly shows "Title". Biggest user-visible change; isolate it in its own commit.

- [ ] **Step 1: Remove `event_name` from the form state initializer**

Find the initial state (around line 32). Delete the `event_name: ''` entry from the state object.

- [ ] **Step 2: Remove the `event_type_custom → event_name` side-effect**

Around lines 248–262, the `event_type_custom` input has an `onChange` that sets both `event_type_custom` and `event_name`. Rewrite it to update only `event_type_custom`:

```jsx
{form.event_type === 'Other' && (
  <input className="form-input" value={form.event_type_custom}
    onChange={e => update('event_type_custom', e.target.value)}
    placeholder="Describe the event type"
    style={{ marginTop: '0.5rem' }}
  />
)}
```

- [ ] **Step 3: Remove the "Title:" display block (~L263–L267)**

Delete the entire block:

```jsx
{form.event_name && (
  <div style={{ marginTop: '0.35rem', fontSize: '0.85rem', color: 'var(--warm-brown)' }}>
    Title: {form.event_name}
  </div>
)}
```

- [ ] **Step 4: Remove `event_name` from the submit payload**

Find the submit handler (search for the POST to `/api/proposals` or similar). Delete `event_name: form.event_name` from the request body. The body now sends `event_type`, `event_type_category`, `event_type_custom` alongside other fields.

- [ ] **Step 5: Update the review/summary section**

Search the JSX for any place that renders `form.event_name` as a summary value. Either delete it or replace with a two-row display of client name + resolved event-type label:

```jsx
<div>Client: {form.client_name}</div>
<div>Event type: {getEventTypeLabel({ event_type: form.event_type, event_type_custom: form.event_type_custom })}</div>
```

Import the helper at the top:

```js
import { getEventTypeLabel } from '../../utils/eventTypes';
```

- [ ] **Step 6: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name" client/src/pages/admin/ProposalCreate.js
```

Expected: zero matches.

- [ ] **Step 7: Verify in browser**

Start `npm run dev`. Log in as admin. Open `/admin/proposals/new`. Confirm:
- No "Title" input or display anywhere
- Selecting an event type does not show a "Title:" line
- Selecting "Other" and typing a custom value does not show a "Title:" line
- Submitting creates a proposal successfully (check the proposal appears in the list)

- [ ] **Step 8: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/pages/admin/ProposalCreate.js
git commit -m "feat(admin): remove event title input from ProposalCreate"
```

---

## Task 10: Admin display updates — detail pages and dashboards

**Files:**
- Modify: `client/src/pages/admin/ProposalDetail.js`
- Modify: `client/src/pages/admin/EventsDashboard.js`
- Modify: `client/src/pages/admin/ShiftDetail.js`
- Modify: `client/src/pages/admin/ClientDetail.js`
- Modify: `client/src/pages/admin/DrinkPlansDashboard.js`
- Modify: `client/src/pages/admin/DrinkPlanDetail.js`

**Intent:** Consistent "client name primary, event type subtitle" pattern across all admin detail/list views.

- [ ] **Step 1: Shared import**

At the top of each of the six files, add:

```js
import { getEventTypeLabel } from '../../utils/eventTypes';
```

- [ ] **Step 2: `ProposalDetail.js` — split the heading (~L708)**

Current (approximately):

```jsx
<h1 className="event-title">{proposal.client_name} - {proposal.event_name}</h1>
```

Replace with:

```jsx
<h1 className="event-title">{proposal.client_name}</h1>
<div className="event-subtitle">{getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })}</div>
```

- [ ] **Step 3: `EventsDashboard.js` — delete `eventTitle()` helper (~L57–L62)**

Find the function that composes the display string from `event_name`. Delete it entirely. Then find each call site (around L267) and replace:

```jsx
<span className="event-title">{eventTitle(row)}</span>
```

with:

```jsx
<span className="event-title">{row.client_name || 'Event'}</span>
<span className="event-subtitle"> — {getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom })}</span>
```

- [ ] **Step 4: `ShiftDetail.js` — remove local `title` variable (~L115–L117)**

Delete the line that builds `const title = \`${shift.client_name} - ${shift.event_name}\``. Update the heading (~L124):

```jsx
<h1 className="event-title">{shift.client_name || 'Shift'}</h1>
<div className="event-subtitle">{getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })} on {shift.event_date}</div>
```

- [ ] **Step 5: `ClientDetail.js` — proposal/shift row rendering**

Search the file for any `proposal.event_name` or `shift.event_name` occurrence. Replace each with the resolved label via the helper. If a row currently shows a single "title" cell, split it into two columns or stack two lines.

- [ ] **Step 6: `DrinkPlansDashboard.js` and `DrinkPlanDetail.js`**

Same pattern. Replace any `plan.event_name` with:

```jsx
{plan.client_name || 'Client'} — {getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}
```

Use the two-line pattern in the detail view.

- [ ] **Step 7: Add `.event-subtitle` CSS**

Open `client/src/index.css`. Find `.event-title` (around line 2619). Add right after it:

```css
.event-subtitle {
  font-size: 0.95rem;
  color: var(--warm-brown, #6b4b2a);
  margin-top: 0.15rem;
}
```

- [ ] **Step 8: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -rn "event_name" client/src/pages/admin/
```

Expected: zero matches.

- [ ] **Step 9: Verify**

Start `npm run dev`. Open each of: proposals list, a proposal detail, events dashboard, a shift detail, a client detail, drink plans dashboard, a drink plan detail. Confirm each shows client name prominently with the event-type label beneath/beside it. No "undefined" strings, no raw IDs displayed.

- [ ] **Step 10: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/pages/admin/ProposalDetail.js client/src/pages/admin/EventsDashboard.js client/src/pages/admin/ShiftDetail.js client/src/pages/admin/ClientDetail.js client/src/pages/admin/DrinkPlansDashboard.js client/src/pages/admin/DrinkPlanDetail.js client/src/index.css
git commit -m "feat(admin): display client name + event type label across all detail views"
```

---

## Task 11: Public and client-facing pages

**Files:**
- Modify: `client/src/pages/public/ClientDashboard.js`
- Modify: `client/src/pages/proposal/ProposalView.js`
- Modify: `client/src/pages/invoice/InvoicePage.js`
- Modify: `client/src/pages/plan/steps/WelcomeStep.js`

**Intent:** Same display pattern for public/client users, with natural-sounding fallbacks.

- [ ] **Step 1: Add helper import to each file**

`ClientDashboard.js`, `ProposalView.js`, `InvoicePage.js`, `WelcomeStep.js`:

```js
import { getEventTypeLabel } from '../../utils/eventTypes';
```

(Adjust the relative path per file location — `WelcomeStep.js` is `pages/plan/steps/` so it's `../../../utils/eventTypes`.)

- [ ] **Step 2: `ClientDashboard.js` (~L111)**

Current:

```jsx
{p.event_name || 'Untitled Event'}
```

Replace with:

```jsx
<div className="event-title">{p.client_name || 'Event'}</div>
<div className="event-subtitle">{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })} · {p.event_date}</div>
```

- [ ] **Step 3: `ProposalView.js` (~L345)**

Current:

```jsx
{proposal.event_name || 'Your Event'}
```

Replace with (render as a heading):

```jsx
Your {getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })} proposal
```

- [ ] **Step 4: `InvoicePage.js` (~L165)**

Current:

```jsx
{invoice.event_name || 'Event'}
```

Replace with:

```jsx
{getEventTypeLabel({ event_type: invoice.event_type, event_type_custom: invoice.event_type_custom })}
```

Make sure the `clientPortal.js` / `invoices.js` routes already return `event_type` and `event_type_custom` on the invoice row (per Task 8). If they don't yet, add them.

- [ ] **Step 5: `WelcomeStep.js` (~L25–L27)**

Current:

```jsx
{plan?.event_name && (
  <div className="event-name">
    Event: {plan.event_name}
  </div>
)}
```

Replace with:

```jsx
<div className="event-subtitle">
  {plan?.client_name
    ? `${plan.client_name}'s ${getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}`
    : `Your ${getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}`}
</div>
```

- [ ] **Step 6: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -rn "event_name" client/src/pages/public/ client/src/pages/proposal/ client/src/pages/invoice/ client/src/pages/plan/
```

Expected: zero matches.

- [ ] **Step 7: Verify**

Start `npm run dev`. Using a test token or client login:
- Hit a proposal public view — heading reads naturally ("Your Wedding Reception proposal" or "Your event proposal" if unset).
- Hit an invoice page — shows the type label.
- Hit the Potion Planning Lab welcome step — shows "your event" fallback when type isn't set, or "Suzy's Wedding Reception" when both are set.
- Log in as a test client — dashboard shows client name + type.

- [ ] **Step 8: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/pages/public/ClientDashboard.js client/src/pages/proposal/ProposalView.js client/src/pages/invoice/InvoicePage.js client/src/pages/plan/steps/WelcomeStep.js
git commit -m "feat(public): use event_type label with graceful 'event' fallback"
```

---

## Task 12: `ClassWizard.js` — drop event_name, auto-set cocktail-class

**Files:**
- Modify: `client/src/pages/website/ClassWizard.js`

**Intent:** Cocktail classes get an automatic type instead of a free-text name.

- [ ] **Step 1: Remove `event_name` from form state initializer (~L46)**

Delete the `event_name: '',` line.

- [ ] **Step 2: Remove the `event_name` input (~L467–L468)**

Delete the entire form-group containing the `event_name` input and its label. Adjust surrounding markup if needed (e.g., if removing it leaves an empty row, reflow the grid).

- [ ] **Step 3: Update the submit payload (~L185–L202)**

Replace the three lines that send client event info with:

```js
event_type: 'cocktail-class',
event_type_category: 'class',
event_type_custom: null,
```

Remove `event_name: form.event_name || null,` from the body.

- [ ] **Step 4: Sweep**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -n "event_name" client/src/pages/website/ClassWizard.js
```

Expected: zero matches.

- [ ] **Step 5: Verify**

Start `npm run dev`. Navigate to the class-booking public route. Confirm there is no "event name" input and the submission succeeds. Check the resulting proposal in admin — its event type should be "Cocktail Class".

- [ ] **Step 6: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/pages/website/ClassWizard.js
git commit -m "feat(classes): auto-set cocktail-class event type, drop event_name input"
```

---

## Task 13: Shopping list PDF

**Files:**
- Modify: `client/src/components/ShoppingList/ShoppingListPDF.jsx`
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx`
- Modify: `client/src/components/ShoppingList/ShoppingListButton.jsx`

- [ ] **Step 1: `ShoppingListButton.jsx` — build and pass the label**

At the top:

```js
import { getEventTypeLabel } from '../../utils/eventTypes';
```

Where the button constructs `listData` for the modal, add:

```js
eventTypeLabel: getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom }),
```

- [ ] **Step 2: `ShoppingListModal.jsx` — pass through**

Where the modal calls `ShoppingListPDF`, include the new `eventTypeLabel` prop (or the value from `listData`) alongside `clientName` and `eventDate`.

- [ ] **Step 3: `ShoppingListPDF.jsx` — render in header**

Find the header metadata block (around L114–L116). Add a line below the event date:

```jsx
<Text style={styles.metaSmall}>Event type: {listData.eventTypeLabel || 'event'}</Text>
```

(Match the prevailing `styles.metaSmall` or create one inline if the style doesn't exist.)

- [ ] **Step 4: Verify**

Start `npm run dev`. Open a proposal with an event type, click "Shopping list", download the PDF, confirm it shows "Event type: {label}" in the header. Do the same on a proposal with no event_type — should read "Event type: event".

- [ ] **Step 5: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add client/src/components/ShoppingList/ShoppingListPDF.jsx client/src/components/ShoppingList/ShoppingListModal.jsx client/src/components/ShoppingList/ShoppingListButton.jsx
git commit -m "feat(shopping-list): include event type label in PDF header"
```

---

## Task 14: Documentation updates

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: `CLAUDE.md` — Cross-Cutting Consistency**

Find the "Cross-Cutting Consistency" section. Add a new bullet at the end:

```
- **Event identity** — client name and event type are separate, independent data points. Never concatenate them into a single "title" string or prompt for an `event_name`. Display uses `getEventTypeLabel({ event_type, event_type_custom })` with `'event'` as the graceful fallback.
```

- [ ] **Step 2: `CLAUDE.md` — folder tree**

Add `eventTypes.js` to the `client/src/utils/` folder tree (alphabetical order) and to the `server/utils/` folder tree. Use the one-line comment style the tree already uses:

```
│   │   │   ├── eventTypes.js      # Event type id→label resolver (mirrors server)
```

and

```
│   │   ├── eventTypes.js      # Event type id→label resolver (mirrors client)
```

- [ ] **Step 3: `README.md` — folder tree**

Add the same two `eventTypes.js` entries to README's folder tree. Remove any lingering `event_name` references in schema bullets.

- [ ] **Step 4: `ARCHITECTURE.md` — Database Schema section**

Find the entries for `proposals`, `shifts`, `drink_plans`. Remove `event_name` from each. Add `event_type`, `event_type_custom` to the listed columns on `shifts` and `drink_plans`, and `client_name` to `shifts`. Add a one-line note under the `proposals` entry:

```
- Event identity: proposals/shifts/drink_plans carry `event_type` (id) + optional `event_type_custom` (for "Other"). No free-text title. Display via `getEventTypeLabel` helper (mirrored in `client/src/utils/eventTypes.js` and `server/utils/eventTypes.js`).
```

- [ ] **Step 5: Commit** (wait for commit cue)

```bash
cd C:/Users/dalla/DRB_OS/os
git add .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs: record event-type cleanup in CLAUDE.md, README, ARCHITECTURE"
```

---

## Task 15: Final end-to-end verification and review agents

**Intent:** Full smoke test in the browser, then run the five non-UI review agents in parallel before a push.

- [ ] **Step 1: Start fresh**

Stop any running server. Delete any local DB dev caches if needed. Run:

```bash
cd C:/Users/dalla/DRB_OS/os && npm run seed
cd C:/Users/dalla/DRB_OS/os && npm run dev
```

- [ ] **Step 2: Manual smoke — admin flow**

In the browser:

- Open `/admin/proposals/new`. No Title input visible. Create a proposal: pick a client, pick event type "Wedding Reception", fill date/guest count, save. Proposal opens in detail view with "Smith" heading and "Wedding Reception" subtitle.
- Open `/admin/events`. Row shows client name + type correctly.
- Open `/admin/shifts`. Create a standalone shift (no proposal): set only `event_date`. Save. Detail view shows generic "Shift" or "Event" heading + "event on {date}".
- Open `/admin/drink-plans`. List shows client + type. Open a plan — header reads correctly.
- Send a proposal email to a test address. Subject and body read naturally.

- [ ] **Step 3: Manual smoke — public flow**

- Open the public proposal URL for the new proposal. Heading: "Your Wedding Reception proposal".
- Open the Potion Planning Lab via a test token. Welcome step reads correctly, including the "Suzy's event" fallback when only client_name is set.
- Submit a cocktail class via `ClassWizard`. Admin sees the proposal with type "Cocktail Class".
- Open an invoice page. Header shows "Wedding Reception" or the fallback.
- Download a shopping list PDF. Header includes the event type line.

- [ ] **Step 4: Calendar + auto-assign smoke**

- Subscribe to the iCal calendar in a calendar client (Google Calendar or Apple Calendar). Confirm `SUMMARY` reads "Smith — Wedding Reception".
- Trigger `auto-assign` for a shift (or wait for the scheduler). SMS body (check the logs if Twilio is stubbed) uses the new phrasing.

- [ ] **Step 5: Stripe smoke**

- Start a test-mode balance payment flow (per `STRIPE_TEST_MODE_UNTIL`). Confirm the Stripe PaymentIntent description contains the event type label.

- [ ] **Step 6: Sweep for any remaining references**

```bash
cd C:/Users/dalla/DRB_OS/os && grep -rn "event_name\|eventName" --include='*.js' --include='*.jsx' --include='*.sql' --include='*.md' | grep -v node_modules | grep -v docs/superpowers | grep -v "plan: remove" | grep -v "old column" | grep -v ".git/"
```

Expected: zero matches in live code. If historical comments or commit-message-like strings remain, judge whether to keep them.

- [ ] **Step 7: Launch the five non-UI review agents in parallel**

In a single message, dispatch: `consistency-check`, `code-review`, `security-review`, `database-review`, `performance-review`.

Each agent gets the diff range `origin/main..HEAD` and the design-spec path for context.

- [ ] **Step 8: Consolidate agent findings**

If all five are clean, proceed to push (waiting for the push cue). If any flag issues, present a consolidated report grouped by severity and wait for direction.

- [ ] **Step 9: Push** (wait for explicit push cue)

```bash
cd C:/Users/dalla/DRB_OS/os && git push origin main
```

Confirm Render + Vercel begin deploying. Report the list of commits shipped.

---

## Self-Review Notes

- Every task ends in a commit with an explicit staged path list; no blind `git add .`.
- Schema migration is idempotent and self-contained in one commit.
- Helpers mirror each other exactly — adding a new event type means adding it to both files (noted in the file header comments).
- Email templates keep their function signatures stable (same exported names); only one destructured parameter changes. Callers in Tasks 4–8 update accordingly.
- Fallback string `'event'` is embedded in the helper default and in the `getEventTypeLabel` return path, so no caller needs to specify it.
- Standalone shifts and drink plans (no linked proposal) stay functional — `event_type` NULL just means the UI renders "event".
- The `.event-subtitle` CSS is added once in `index.css` (Task 10) and used by every detail/list view after that.
- Documentation updates are bundled in Task 14 so the folder-tree updates match the actual new helper files.
- Review-agent pass precedes push, per CLAUDE.md Rule 6 and Pre-Push Procedure.
