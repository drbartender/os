# Staff Event Details redesign (retire the "BEO" framing)

Date: 2026-07-22
Status: approved in brainstorm (Dallas), section by section
Trigger: Shea's report that the staff detail page shows "like NO info" while the shift-request list card shows more. Root causes verified in code, see Problem.

## Problem

1. `ShiftDetail` (`/shifts/:shiftId`, the staff event page) hydrates entirely from `GET /api/beo/:proposalId`, and `authorize()` 403s any staffer without an approved shift_request on the proposal. A staffer browsing Available, or with a pending request, gets an error card and nothing else: zero info exactly when they are deciding whether to request.
2. The list card shows equipment tags and per-role fill that the detail page never renders, so "the request page has more info" is literally true even for assigned staff.
3. Until the client's drink plan is finalized, the BEO body cards all no-op and the page reads as empty. "BEO" is also jargon the crew does not parse.
4. New operational policy has no software surface: staff are responsible for printing the bar menu, bringing a frame, and leaving menu + frame with the client. They need the print file; admin needs somewhere to upload it.

## Decisions (locked during brainstorm)

- Any authenticated staff member can view event details for any event with a non-cancelled shift. No approval gate on viewing. Probing nonexistent or shift-less proposal ids still 404s.
- Held back until assigned to the event: client contact (phone / Call client button) and teammates' phone numbers (existing anti-harvest gate stays; names and roles show to everyone). Everything else ungates, including the drink menu, notes, logistics, host gratuity and tip jar.
- The shopping list card stays assigned-only (it links into a flow whose auth this project does not touch).
- All staff-facing "BEO" language becomes "Event details". The ack machinery is untouched: `beo_acknowledged_at`, the finalize gate on confirm, the unack nudges, and admin roster ack display all keep working; only words change. Internal ids/keys (`beo_finalized`, `beo_reminder_t3`, column names, route paths) do NOT change.
- Request actions move onto the detail page so staff can act where they read.
- Hosted-event requests get a warning step (see below).
- Bar menu print file feature ships in this project (schema + admin upload + staff download).
- Policy copy ships now even though duty PAY plumbing is Project B (see docs/staff-ops-backlog-2026-07-22.md): flat $5 for the menu print, frame required, tablet/iPad display allowed as an alternative (clean, on a stand, decent size; we plan around 8x10 for framed menus), menu + frame are left with the client, frames will be stocked at the Pilsen storage unit.
- Bar kit copy: the standard kit includes a small handled cooler (roughly 3 cases of beer plus ice, or 2x20lb ice bags with the lid ajar; mats, ice bins and tip jar ride inside it). We bring one even when the client has coolers.

## Server

### 1. Event-details endpoint

New route `GET /api/shifts/:shiftId/event-details` (auth, any staff/admin/manager). Resolves shift to proposal server-side and returns the full payload, killing the client-side three-layer proposalId resolver as a load-bearing path.

Payload = the existing BEO payload built by a builder function extracted from `server/routes/beo.js`, plus:

- `shifts`: every non-cancelled shift on the proposal: `id, event_date, start_time, end_time, location, guest_count, positions_needed, approved_by_role, equipment_required, supply_run_required, setup_minutes_before`, cover flags, and the viewer's own `my_request_id / my_request_status / my_position` per shift.
- `menu_print`: `{ status: 'ready' | 'not_required' | 'pending' }` derived from the new proposal columns (never the R2 key itself).
- `viewer`: gains `is_assigned` (approved + active on this proposal) alongside `is_admin`, `is_acknowledged`.
- `package` gains nothing new; `pricing_type` is already selected (drives the hosted warning).

Redaction when the viewer is NOT assigned (and not admin/manager): `client.phone` is null. Team roster phones already null via the existing `viewerApproved` gate; that logic stays. Client name remains visible (it is already on every list card).

`GET /api/beo/:proposalId` remains mounted (admin "View BEO" link and legacy nudge redirects) and shares the builder. `authorize()` loosens for BOTH routes to: 404 if the proposal does not exist or has no non-cancelled shift; otherwise any authenticated staff may read. 404-before-role ordering is preserved. The acknowledge route keeps its own assigned-only enforcement (the UPDATE predicates already require an approved active shift); the logo proxy adopts the loosened read auth since the custom menu is now visible to all staff.

`beoReadLimiter` applies to the new route.

### 2. Menu print file

Schema (`schema.sql`, idempotent):

- `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_print_key TEXT;`
- `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS menu_not_required BOOLEAN NOT NULL DEFAULT FALSE;`

Routes (admin/manager, on the proposals router):

- `POST /api/proposals/:id/menu-print`: file upload via express-fileupload, magic-byte validated (PDF, PNG, JPG), size capped by `MAX_FILE_SIZE`, stored in R2 under `menu-print/<proposalId>/<uuid>.<ext>`. Replaces any prior key; the old R2 object is orphaned, matching the drink-plan logo pattern (no delete util exists in storage.js). Uploading a file clears `menu_not_required`.
- `DELETE /api/proposals/:id/menu-print`: clears the key (R2 object orphaned, same pattern).
- `PATCH /api/proposals/:id/menu-print`: body `{ not_required: boolean }` to flip the no-menu flag. Setting true while a file exists is rejected (delete the file first) to keep the tri-state unambiguous.

Staff download: `GET /api/shifts/:shiftId/menu-print` (auth). Allowed for admin/manager, or a staffer with an approved active shift_request on the shift's proposal. Proxies R2 through a signed URL exactly like the BEO logo proxy (timeout, content-type passthrough) with `Content-Disposition: attachment`.

### 3. Copy in server templates

`staffBeoNudgeSms` rewords to event-details language, e.g. "Event details ready from Dr. Bartender: ... Tap to review and confirm: ...". Function and dispatch key names unchanged.

## Client, staff portal

### ShiftDetail rework (becomes "Event details")

Fetches `GET /api/shifts/:shiftId/event-details` directly. Nav-state fast-path may remain as a render-instant hint, but the page no longer depends on finding its row in list feeds.

Tier 1, the brief (every staff viewer):

- Header: client name, event type, package. No-tip-jar banner stays above the fold.
- Meta grid as today (date, service time, be there by, guests, venue + Get directions, dress code, load-in).
- New equipment card: `equipment_required` list and the supply-run flag from the shift, plus the bar-kit line (standard kit includes the small handled cooler, see Decisions).
- Roles + fill pills (Bartender 2/2 etc.) from `positions_needed` / `approved_by_role`.
- Gratuity and tips card moves up into the brief (host gratuity prepaid + tip jar): earnings-relevant before requesting.
- Drinks (signature, custom, mocktails), addons, client logistics, custom menu (with logo), notes from the lead, notes from the client, consult card: all visible to every staff viewer.

Tier 2, assigned-only extras:

- Call client button (client phone), teammate phone numbers on the roster card, shopping list card, drop/cover card, sticky confirm bar, bar menu card.

Action area by viewer state:

- Browsing, slots open: primary Request button opening the existing RequestSheet.
- Browsing, fully staffed: Join waitlist (same sheet flow as the list).
- Cover needed: Cover this.
- Pending: "Request pending review" (or waitlisted) chip + Withdraw.
- Assigned: confirm bar. Copy: "Confirm you've read the event details." Pre-finalize: "Details still being finalized. Confirm unlocks once the lead finalizes the plan." The finalize gate is unchanged.

Bar menu card (assigned tier), three states:

- ready: "Download print file" button (hits the download proxy) + responsibility copy: print it, frame it (frames at the Pilsen storage unit soon), menu and frame stay with the client after the event; flat $5 for the print; tablet/iPad on a stand is an acceptable alternative if clean and decent size; framed menus plan around 8x10.
- not_required: "No printed menu for this event."
- pending: "Print file not posted yet. Check back closer to the event."

### RequestSheet: hosted warning

When the event's package `pricing_type` is `per_guest` (hosted), the sheet shows a warning step before the submit controls: hosted events run 90 minutes of setup and up to 2.5 hours of supply handling; expect supply pickup and dropoff and possibly a grocery pickup or receiving a delivery; these events are usually handled by management and senior staff. The staffer must tick an "I understand" acknowledgment before Request submits. The staff open-shifts feed (`GET /api/shifts`) adds `package_pricing_type` to its rows so the sheet can gate from the list path too.

### Copy sweep (staff-facing words only, keys unchanged)

- ShiftsPage/HomePage chips: "Details confirmed" / "Details to confirm".
- HomePage CTA: "Confirm the {client} event details".
- NotificationsSection labels: "Event details ready to confirm", "Auto SMS if I haven't confirmed upcoming event details", critical-path explainer copy.
- Section title on the detail page: "Event details" (the words "Banquet Event Order" disappear).

## Client, admin portal

- EventDetailPage: "View BEO" link label becomes "View event details" (same href).
- New "Bar menu print" block on EventDetailPage: shows tri-state, upload/replace file, remove file, and a "No menu needed for this event" toggle. Plain admin styling consistent with neighboring blocks.

## Non-goals (captured for later projects in docs/staff-ops-backlog-2026-07-22.md)

- Per-person duty assignment (storage pickup, grocery run, receive delivery, bring bar, menu print) and the run-payroll attribution popup.
- Auto-added duty pay: the $20 Equipment and Supplies fee ($50-paid trigger), the $5 menu-print line, hosted hourly supply-handling pay.
- Receipt reimbursements.
- Staff directory and the SMS-over-WhatsApp comms shift.

## Edge cases and errors

- Shift cancelled or missing: 404 with the existing friendly copy.
- Legacy manual shifts with no proposal_id: the endpoint returns a shift-only payload (proposal null, client name from the shift row, menu_print null) so the brief still renders instead of 404ing a requestable shift.
- Menu upload: reject wrong magic bytes and oversize; admin sees inline error.
- Menu download by non-assigned staff: 403 (button never renders for them).
- Acknowledge by non-assigned staff: unchanged ConflictError path.
- Legacy `/events/:proposalId/beo` redirect keeps working (route untouched).
- Redaction is server-side only; the client never receives gated fields.

## Testing

- `server/routes/beo.test.js`: update auth matrix. New cases: pending staffer gets 200 with `client.phone` null and roster phones null; assigned staffer sees both; staff on a proposal with only cancelled shifts gets 404.
- New tests: menu-print upload validation (magic bytes, size, tri-state transitions) and download auth (assigned yes, unassigned no, admin yes).
- Feed test: `package_pricing_type` present on staff open-shifts rows.
- `CI=true npm --prefix client run build` green before merge.

## Docs

README key features + folder tree (new routes/components if any files are added); ARCHITECTURE route table (event-details, menu-print routes) and schema section (two new proposal columns).
