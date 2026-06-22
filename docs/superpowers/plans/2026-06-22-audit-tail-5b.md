---
plan: audit-tail-5b
created: 2026-06-22
status: proposed
parent: docs/superpowers/plans/2026-06-09-audit-findings-batch-plan.md
lanes:
  - id: 5b-notif-checkbox
    footprint:
      - client/src/pages/PreHireOnboarding.js
      - server/routes/auth.js
      - server/routes/admin/users.js
      - server/db/schema.sql
      - docs/tech-debt.md
    deps: []
    review: full-fleet   # auth.js sensitive (register routes)
  - id: 5b-gratuity-origin
    footprint:
      - client/src/pages/admin/ProposalDetailEditForm.js
    deps: []
    review: full-fleet   # gratuity area is sensitive
  - id: 5b-equipment-picker
    footprint:
      - client/src/  # shift create/edit component (exact file TBD at lane start)
    deps: []
    review: light + client-build gate
---

# Audit tail — Batch 5b dead-column fixes

The last substantive slice of the 2026-06-09 full-codebase audit. Re-baselined
against current `main` 2026-06-22 (4-agent workflow). Everything else in the
audit is shipped/live or accounted for:

- **F1 (Cal.com webhook heal), F1b (SMS strand heal)** — DONE, merged (F1b `2de67e6`, unpushed).
- **email-harvest (5b)** — handled in a PARALLEL window (almost ready); excluded here.
- **F3 (manager iCal feed)** — DEFERRED (UX model choice; low-urgency, pre-existing).
- **5b SMS-metadata** — MOOT: `sms_messages.metadata` is already wired + load-bearing
  (the `thumbtack_relay` suppression in `sms.js`); the `{from,to}` envelope + `opt_keyword`
  are audit-only by design. No change.

## Lanes (independent footprints → all three parallelizable)

### L1 — 5b-notif-checkbox: remove the lying "notifications_opt_in" checkbox  *(BUG FIX; PRODUCT LEAN)*
`users.notifications_opt_in` is write-only: written by both signup paths
(`auth.js:37,55-56,80,111-114`), SELECTed only for admin display
(`admin/users.js:36,68`), and **read by zero send/dispatch sites**. Real shift-SMS
gating is the `staff_notification_preferences` JSONB (`notificationChannelResolver.js`,
`coverBroadcast.js`), defaulting opted-IN. So the signup checkbox "Text me when new
shifts post (optional)" (`PreHireOnboarding.js:173-182`) toggles nothing — a lying checkbox.

**Recommendation: REMOVE the checkbox, do NOT wire it.** Wiring it to gate sends would
add a second, coarser opt-out over the existing granular per-category prefs AND, because
the column defaults `false`, silently flip every new hire to opted-OUT of shift SMS — a
comms regression (the exact risk the audit named). Removing the dead promise leaves the
working granular prefs as the single source of truth.

Edits: drop the checkbox + its form state + submit field (`PreHireOnboarding.js`); stop
destructuring/inserting it in both register routes (`auth.js`); drop it from the admin
SELECTs (`admin/users.js`) after verifying no admin component renders it; comment the
column `-- DEAD: superseded by *_notification_preferences; pending DROP` in `schema.sql`
+ log in `docs/tech-debt.md`. **Defer the actual `ALTER TABLE ... DROP COLUMN`** to a
separate follow-up migration after one clean deploy (users-column drops are hard to
reverse in prod).

> **NEEDS DALLAS:** removing a user-facing signup checkbox. Recommend remove; confirm.

### L2 — 5b-gratuity-origin: surface the gratuity-origin audit field  *(FEATURE WIRE; additive)*
`proposals.gratuity_rate_change_origin` (`NULL | 'staffing' | 'admin'`, DB-CHECKed) is
written in `crud.js` (`:594` admin rate change, `:630` staffing dollar move) and IS in
the API payload (`SELECT *` / `RETURNING *`) but **no client renders it**. Add a
read-only, **admin-only** audit chip in the proposal-detail gratuity section:
`'admin' → "Rate set by admin"`, `'staffing' → "Adjusted by staffing change"`, hidden
when null. No server/schema change (already in payload). Copy stays consistent with the
accepted gratuity client framing; no em dashes. Sensitive (gratuity) → full fleet, but
the change touches no money/label/payroll path (pure audit display).

### L3 — 5b-equipment-picker: let admins set a shift's equipment_required  *(FEATURE WIRE; PRODUCT LEAN)*
`shifts.equipment_required` (TEXT JSON, default `'[]'`) is persisted by the shift
create/update routes (`shifts.js:408/457/475`) AND consumed by the auto-assign scorer
(`autoAssign.js:139` `computeEquipmentScore`), but there is **no admin UI to set it**, so
it is permanently `'[]'` and the auto-assign equipment match never fires. Add a small
multi-select picker to the shift create/edit form (client-only; backend already accepts
+ consumes it). Not a sensitive path → light review + the client-build gate.

> **NEEDS DALLAS:** this enables a dormant auto-assign feature. Worth wiring, or leave
> `equipment_required` dead? Recommend wire (cheap, unlocks the scorer); confirm.

## Run order
All three lanes are independent (disjoint footprints) and can run in parallel. L2 is
purely additive (safe to start immediately). L1 and L3 each carry one product confirm
(above) before build.
