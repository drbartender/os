# Assign-Position Default

Date: 2026-07-22
Status: approved, ready for plan

## Problem

Manually assigning a staff member to a shift makes the admin pick a position from scratch
every time, even though the answer is almost always "Bartender". The two surfaces that do it
disagree with each other, and one of them guesses wrong:

- **`ShiftDrawer`** (`client/src/components/adminos/drawers/ShiftDrawer.js:643`) opens the
  select on an empty `Position…` option and disables the Assign button until a role is
  chosen. Every assignment costs an extra click on a value that is predictable.
- **`AssignToEventModal`** (`client/src/pages/admin/userDetail/components/AssignToEventModal.js:41`)
  does default, but to `positions[0]`, whichever role happens to sit first in the roster
  array, with no regard for who is already approved. On a mixed roster where the bartender
  slots are full, it still preselects Bartender and the admin has to notice and correct it.

The desired behavior: preselect Bartender, fall back to whatever role actually has an open
slot when the bar is full, and keep the dropdown fully editable.

## Rule

One preference order, applied twice:

```
PREFERRED = [Bartender, Banquet Server, Barback]
```

1. Return the first role in `PREFERRED` that has **an open slot** on this shift
   (per-role `remaining > 0`).
2. If every role is full, return the first role in `PREFERRED` that **exists in the shift's
   roster**. The admin still gets the existing over-fill confirm before the POST lands.
3. If the roster is empty (legacy shift with no `positions_needed`), return `Bartender`.

Worked cases:

| Roster | Approved | Default | Why |
|---|---|---|---|
| 2 Bartender | 0 | Bartender | bar open |
| 2 Bartender, 1 Barback | 2 Bartender | Barback | bar full, only barback open |
| 1 Bartender, 1 Banquet Server, 1 Barback | 1 Bartender | Banquet Server | server beats barback |
| 2 Banquet Server | 0 | Banquet Server | no bar spots exist at all |
| 2 Bartender | 2 Bartender | Bartender | nothing open, rule 2 |
| (empty / legacy) | n/a | Bartender | rule 3 |

Rule 2 deliberately preselects rather than blanking. A fully-staffed shift being assigned
into is already an over-fill, which the existing `window.confirm` guards
(`ShiftDrawer.js:274`); making the admin also hunt for a role adds friction at a point where
the real decision, "am I over-filling this", is already being asked explicitly.

## Money seam

`position` is the column payroll's tip split keys on (`LOWER(position) = 'bartender'`).
L5 of the staffing-roster project deliberately removed position defaulting from the server:
`POST /shifts/:id/assign` returns 400 when `position` is absent, guarded by the test
`assign: missing position -> 400 (no Bartender default)`
(`server/routes/shifts.approval.test.js:319`).

**That stays exactly as it is.** This spec adds a default to the *dropdown*, not to the
route. The value is visible in the select before the admin clicks Assign, and it is
changeable. Payroll never receives a position that no human saw. The request body still
always carries an explicit canonical role.

The three source comments that currently read "position is never defaulted" / "NEVER defaults
to 'Bartender'" (`ShiftDrawer.js:34`, `:189`, `:268`) must be rewritten to say what is
actually true after this change: the server never defaults, the picker preselects.

## Scope: what changes

### 1. Shared helper

Add `defaultAssignRole(roster, remaining)` to `client/src/utils/staffingRoles.js`, returning
a canonical label per the rule above.

This file is a manual mirror of `server/utils/staffingRoles.js`. The helper is **client-only
by design** and is not added to the server mirror: defaulting a position is a UI affordance,
and putting a `defaultAssignRole` on the server would be a loaded gun aimed at the money
seam. The file header gets a line saying so, so a future sync pass does not "fix" the
asymmetry by copying it over.

Unit tests cover every row of the worked-cases table plus a non-canonical / malformed roster.

### 2. `ShiftDrawer` manual-assign picker

- Redefine `pickerPosition` as the admin's **explicit override**, `''` meaning untouched, and
  derive what the select shows: `pickerRole = pickerPosition || defaultAssignRole(roster, remaining)`.
  A hand-picked role wins; an untouched picker re-derives its default whenever the shift
  reloads. (Built this way rather than with a preselect effect plus a "touched" flag: same
  semantics, no new state, and no first-frame window where the select holds `''`.) The three
  existing `setPickerPosition('')` resets need no change; they now clear the override.
- Drop the empty `Position…` option; the select always holds a real role.
- The Assign button is no longer gated on `!pickerPosition`, only on `busy`, and its label
  reads `Assign as {role}` so the role being written is stated, not just selected.
- `handleManualAssign` keeps `canonicalizeRole` + its "Pick a position before assigning."
  guard as a belt-and-braces check. It should be unreachable now, not deleted.
- The over-fill confirm is unchanged.

The options list (`assignableRoles`) is unchanged: roster roles, falling back to all three
canonical labels on a roster-less shift. The default is always drawn from the roster, so it
is always present in the list.

### 3. `AssignToEventModal`

- Switch from `parsePositions` (`userDetail/helpers.js:56`) to `parsePositionsNeeded` from
  `utils/staffingRoles`. Two bugs fall out of this in passing: `parsePositions` maps a
  `{position, count}` entry to a **single** label, so a `[{position:'Bartender',count:2}]`
  roster currently renders "1 needed"; and it does not canonicalize, so a lowercase
  `bartender` row would produce a duplicate option next to `Bartender`.
- Default each shift's position to `defaultAssignRole(roster, remainingByRole(shift))`
  instead of `positions[0] || 'Bartender'`.
- Keep the current rule that the select renders only when the roster holds more than one
  distinct role. With one role there is nothing to choose, and the `Assign as {role}` button
  label already states what will be written.
- `parsePositions` in `userDetail/helpers.js` becomes dead once this is its last consumer.
  Delete it, leaving a comment pointing at `parsePositionsNeeded`, so the buggy version is
  not picked back up by the next surface that needs a roster.

### 4. `GET /shifts/unstaffed-upcoming` gains `approved_by_role`

The modal's feed (`server/routes/shifts.js:97`) returns only a flat `approved_count`, which
cannot distinguish a filled bartender slot from a filled barback slot. Without per-role
data the modal's default guesses wrong on exactly the mixed rosters this feature exists for
(`remainingByRole` falls back to attributing the whole flat count to `roster[0]`,
`components/adminos/shifts.js:99`).

Add the same `jsonb_object_agg(position, c)` lateral the other shift feeds already carry
(`server/routes/shifts.js:71-77` is the pattern to copy verbatim, including its
`status = 'approved' AND dropped_at IS NULL AND position IS NOT NULL` filter, so the
aggregate agrees row-for-row with the existing `approved_count`). Additive column on an
admin-only read; no other consumer of this endpoint changes.

## Explicitly out of scope

- **The "Approve into role…" override select** (`ShiftDrawer.js:559`) stays blank. It
  surfaces only when a pending request's own ranked roles are all full, i.e. precisely when
  the admin is placing someone somewhere they did not ask for. A conscious pick is the
  correct friction there.
- **`resolveApprovalPosition`** (`ShiftDrawer.js:190`) is untouched. Approving a request
  resolves the position from that staffer's ranked `requested_positions`, which is already
  the right answer and is not a "default".
- **The server-side assign route.** No defaulting, no new fallback. See Money seam.
- **`autoAssign`** is already bartender-scoped by design and is not a manual-assign surface.

## Testing

- Unit: `defaultAssignRole` against the worked-cases table, plus empty roster, malformed
  `positions_needed`, and a roster containing a non-canonical label.
- Server: `/shifts/unstaffed-upcoming` returns `approved_by_role` shaped as the other feeds
  do, `{}` for a shift with no approved requests, and excludes dropped requests.
- Manual: assign into a mixed-roster shift from both surfaces and confirm the preselected
  role matches the open slot, that changing the dropdown wins, and that the written
  `position` on the resulting `shift_requests` row is the role that was displayed.
