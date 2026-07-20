# Events List: Staffing Column Redesign

**Date:** 2026-07-19
**Status:** Approved (brainstorm, section-by-section)
**Surface:** `client/src/pages/admin/EventsDashboard.js`, Staffing column

## Problem

The Staffing column on the admin events list does not answer the two questions it is looked at for:

1. **What still needs to be staffed?** The red "N open" warning fails to fire whenever a pending applicant exists, because a pending request occupies a slot in the current model.
2. **Are there requests to work?** Requests are invisible on unstaffed events. They only surface once the event is full enough that requests exceed the remaining slots, at which point they are labelled "on waitlist."

As Dallas put it: there is no waitlist until somebody is staffed. Until then there are just multiple requests, and the column says nothing about them.

## Evidence (production, 2026-07-19)

Roster shape across all 55 events that have ever had a roster:

- Mixed-role events: **0**. Every event is single-role in practice.
- Max slots on any event: **2**. Average 1.29.

So per-role breakdown is dead weight, and the pill strip renders at most two dots.

The muted-warning bug is live on **7 of 24** upcoming events. Representative rows:

| Days out | Needed | Confirmed | Pending | Renders today | Should read |
|---|---|---|---|---|---|
| 19 | 1 | 0 | 2 | `0/1`, calm gray | 1 open (red), 2 requests |
| 26 | 1 | 0 | 2 | `0/1`, calm gray | 1 open (red), 2 requests |
| 82 | 2 | 0 | 2 | `0/2`, calm gray | 2 open (red), 2 requests |
| 5 | 2 | 1 | 0 | `1/2 · 1 open`, red | 1 open (red), no requests |
| 3 | 1 | 1 | 3 | `1/1` + `2 on waitlist` | `1/1`, 3 on waitlist |

A fully unstaffed event three weeks out currently renders calmer than a half-staffed one.

## Current behavior

`EventsDashboard.js:556-563` renders `<StaffPills positions={shiftPositions(e)} />` plus an optional waitlist chip.

`shiftPositions()` (`components/adminos/shifts.js:124-157`) builds one slot per required position, marks approved slots, then distributes `pendingCount()` into the remaining empty slots as `status: 'pending'`.

`StaffPills` then computes `shortBy = total - filled - pending`, so a pending applicant subtracts from the shortfall. `.staff-count.short` (the red/bordeaux styling) is applied only when `shortBy > 0`. This is the mechanism behind the missing warning.

The pill tooltip reads `"Bartender: Filled"` for approved slots. The literal string `'Filled'` is hardcoded because the list API returns no staffer names.

Waitlist derivation (`EventsDashboard.js:513-520`) subtracts approved and open slots from `request_count`. It deliberately reports 0 for roster-less legacy rows.

## Design

### Data model for the cell

- `needed` = `positions_needed.length`
- `confirmed` = requests with `status = 'approved'` and `dropped_at IS NULL`
- `pending` = requests with `status = 'pending'` (new, see Server below)
- `open` = `max(0, needed - confirmed)`

Pending never occupies a slot. Confirmed headcount alone determines the shortfall.

### Line 1: the fact (always rendered)

| Condition | Renders | Style |
|---|---|---|
| `open > 0` | `1/2 · 1 open` | ratio muted, `1 open` red semibold |
| `open === 0` and `needed > 0` | `2/2` | muted green |
| `needed === 0` | `No roster` | muted gray |

The ratio is retained. It communicates event size at a glance even though slot counts are small.

### Line 2: the chip (omitted when `pending === 0`)

Quiet neutral chip. The red text on line 1 owns urgency; the chip must not compete with it.

| Condition | Renders |
|---|---|
| `open > 0` and `pending > 0` | `2 requests` |
| `open === 0` and `pending > 0` | `3 on waitlist` |

One chip slot, and which word appears is decided purely by whether an open slot remains. This is the change that makes applicants visible on unstaffed events.

Singular forms: `1 request`, `1 on waitlist`, `1 open`.

### Past and cancelled events

When `event_date` is before today, or the shift `status` is `cancelled` or `completed`, line 1 renders muted with no red, and the chip is suppressed. A finished event at 1 of 2 is history, not a task. Today a cancelled shift still renders normal pills.

### Pills removed

`components/adminos/StaffPills.js` and `shiftPositions()` in `components/adminos/shifts.js` are used by nothing but this cell (verified by grep). Both are deleted, along with their CSS (`.staff-pills`, `.staff-pill`, `.staff-count` and skin variants in `index.css`, present in both the default/After Hours block and the light apothecary block).

The abstract three-color pill strip carried all its meaning in color with no on-screen legend, and at one or two slots a number states the same fact more directly.

## Server change

`server/routes/shifts.js:46-79`, the manager/admin list branch. The `rc` LATERAL gains a real pending count:

```sql
COUNT(*) FILTER (WHERE sr.status = 'pending') AS pending_count
```

Today the client derives pending as `min(needed - confirmed, request_count)`. `request_count` counts all non-denied requests, which includes approved rows and approved-then-dropped rows. When a confirmed staffer drops, `request_count` still counts them, and the cell invents a phantom applicant. A real `pending_count` removes the derivation entirely.

`parsePositionsCount`, `approvedCount`, `parseApprovedByRole` and `remainingByRole` in `shifts.js` are unaffected and stay. `pendingCount()` becomes unused once `shiftPositions` is deleted and is removed with it.

## Out of scope

Noted during exploration, not addressed here. These belong on the fix-list:

- `eventStatusChip` checks `e.shift_status`, but the list feed selects `s.*`, where the column is `status`. The Cancelled branch never fires from this feed.
- `buildStaffingItems` (`overview/queueItems.js`) hardcodes the noun "bartenders" regardless of the actual open role, and uses flat counts rather than per-role remaining.
- The client-side `unstaffed` tab count does not filter on `status = 'open'`, while the sidebar badge SQL does, so the two can disagree.
- Per-role display, staffer names in the cell, cover-requested and drop signals, and days-out urgency coloring are all deliberately excluded. The single-role reality makes per-role display pointless, and urgency already lives in the needs-attention strip.

## Testing

- Unit test the cell's state derivation across the matrix: `(needed, confirmed, pending)` covering 0/1/0, 0/1/2, 1/2/0, 1/1/3, 2/2/1, and `needed = 0`.
- Assert that pending never reduces `open`, which is the regression this whole change exists to prevent.
- Assert past and cancelled events render muted with no chip.
- Verify against the 24 live upcoming events that the 7 affected rows flip from calm to red.
