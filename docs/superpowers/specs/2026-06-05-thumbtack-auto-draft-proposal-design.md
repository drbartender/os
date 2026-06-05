# Thumbtack Auto-Draft Proposal: Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm), pending implementation plan
**Author:** Dallas + Claude

## Problem

Thumbtack leads land via webhook and are written to `thumbtack_leads`, plus a
`clients` record is created and an admin email is sent. But `thumbtack_leads` is
effectively write-only: nothing in the admin UI reads it, and the rich detail
(guest count, event date, the Q&A answers) lives only in that table and in the
notification email. There is no path from a lead to a proposal. Today the admin
manually: edits the client to add an email, clicks "create proposal" from the
client record, picks The Core Reaction (BYOB), fills in guest count / date /
location, sends, then copies the proposal link into a Thumbtack message.

We want to remove the busywork: auto-create a ready-to-review draft proposal the
moment a lead arrives, so the admin's job collapses to "open, optionally add
email, Send, paste link into Thumbtack."

## Goals

- On every new Thumbtack lead, auto-create a **draft** proposal defaulting to
  **The Core Reaction**, prefilled from the lead data.
- Surface the lead's full context (description + Q&A + lead price + raw date) on
  the proposal itself, so the admin reviews in one place.
- Deep-link the admin notification straight to the draft for a fast review/send.
- Tag proposals by origin (`source`) so Thumbtack drafts are visible, filterable,
  and measurable (conversion tracking, and a foundation for future automation).
- Keep the real-money path (invoice creation, client email/SMS, `sent` status)
  completely untouched. The new code only ever creates inert drafts.

## Non-Goals (out of scope for this pass)

- Auto-sending proposals. The admin still clicks Send. (See "Future" below for
  the clean seam this design leaves.)
- Pulling the customer's email (Thumbtack never provides it).
- Outbound Thumbtack messaging via API (we still paste the link by hand).
- Threading Thumbtack messages into the proposal/client timeline.
- Backfilling `source` on other intake paths (Cal.com, website, direct). Only
  Thumbtack auto-drafts set `source` for now; everything else stays null.

## Current State (verified)

- `server/routes/thumbtack.js` `POST /leads`: parses V4/legacy payload via
  `parseLead`, dedupes on `negotiation_id`, calls `findOrCreateClient`, inserts
  into `thumbtack_leads`, commits, then best-effort sends the admin notification
  (`newThumbtackLeadAdmin`) with a CTA to `${ADMIN_URL}/clients/:id`.
- Proposal creation (`server/routes/proposals/crud.js` `POST /`) requires
  `package_id` and prices through `calculateProposal`
  (`server/utils/pricingEngine.js`). `package_id` is mandatory; pricing cannot
  compute without it. This is why a package default is required.
- The Core Reaction: slug `the-core-reaction`, `pricing_type 'flat'`,
  `bar_type 'service_only'`, `base_rate_4hr 350`, `extra_hour_rate 100`,
  `bartenders_included 1`. A 4-hour draft prices to $350 through the real engine.
- Admin proposal review/send page: `/proposals/:id` (`ProposalDetail`).
- Event-type taxonomy: `server/utils/eventTypes.js` (`EVENT_TYPES`, ids like
  `wedding-reception`, `birthday-party`, `corporate-event`; `getEventTypeLabel`
  falls back to `event`).
- `expireStaleQuoteDrafts` (the daily quote-draft-cleanup scheduler) operates on
  the separate `quote_drafts` table, **not** `proposals`. Auto-drafts are safe
  from it. No scheduler purges draft proposals.

## Design

### Flow (lead arrival)

In `POST /api/thumbtack/leads`, after the existing lead + client transaction
commits, add one **best-effort** step (its own try/catch, mirroring the existing
admin-notification step) that creates the draft:

1. Lead capture stays exactly as today and commits first. It is sacrosanct: a
   failure in proposal creation must never roll back or block lead capture.
2. If we have a `clientId` (we only create a client when the lead has a name or
   phone), call `createDraftProposalFromLead({ lead, clientId, negotiationId })`.
3. The returned `proposalId` (if any) is passed to `newThumbtackLeadAdmin` so the
   notification CTA deep-links to the draft.
4. On any error in step 2, log to Sentry, send the notification with the legacy
   client CTA, and return 200. The admin falls back to manual creation.

The webhook still responds 200 to Thumbtack regardless of draft outcome.

### New unit: `server/utils/thumbtackProposalDraft.js`

`createDraftProposalFromLead({ lead, clientId, negotiationId }) -> { proposalId } | null`

Owns its own DB transaction (BEGIN/COMMIT/ROLLBACK). Steps:

1. **Idempotency guard.** `SELECT proposal_id FROM thumbtack_leads WHERE
   negotiation_id = $1`. If already set, return that id without creating a second
   proposal. (The webhook already dedupes leads, so this is belt-and-suspenders.)
2. **Resolve package.** `SELECT * FROM service_packages WHERE slug =
   'the-core-reaction'`. If missing, throw (caught upstream as best-effort).
3. **Map lead -> proposal inputs** (see Field Mapping).
4. **Price.** `calculateProposal({ pkg, guestCount, durationHours: 4, numBars: 1,
   numBartenders: undefined, addons: [], syrupSelections: [] })`. Use
   `snapshot.total`, `snapshot.staffing.actual`, `snapshot.package.name`.
5. **Insert proposal** with `status 'draft'`, `source 'thumbtack'`,
   `created_by NULL`, `pricing_snapshot`, `total_price`, `admin_notes` (see
   Admin Notes), and the mapped event/venue fields.
6. **Activity log.** `INSERT INTO proposal_activity_log (proposal_id, action,
   actor_type, details) VALUES ($1, 'created', 'system', $2)` with
   `details = { source: 'thumbtack', negotiation_id }`.
7. **Link the lead.** `UPDATE thumbtack_leads SET proposal_id = $1 WHERE
   negotiation_id = $2`.
8. COMMIT, return `{ proposalId }`.

The Core Reaction base has no add-ons, so no `proposal_addons` rows are written.
This unit never creates an invoice, never sends email/SMS, never sets `sent`.

### Field Mapping (lead -> proposal)

| Proposal field | Source | Rule |
|---|---|---|
| `package_id` | The Core Reaction | resolved by slug |
| `guest_count` | `lead.guestCount` | already parsed by `extractGuestCount`; fall back to 50 |
| `event_date` | `lead.eventDate` | convert to `America/New_York`, take the date part; null if absent |
| `event_start_time` | `lead.eventDate` | ET time formatted like `6:00 PM`; null if absent |
| `event_duration_hours` | (not trusted) | always default `4`. Thumbtack's `event_duration` unit is ambiguous, so we ignore it and let the admin adjust |
| `venue_street` | `lead.locationAddress` | nullable |
| `venue_city` | `lead.locationCity` | nullable |
| `venue_state` | `lead.locationState` | nullable |
| `venue_zip` | `lead.locationZip` | nullable |
| `venue_name` | (none) | null; Thumbtack rarely provides it |
| `event_type` | category + Q&A | keyword map (see below); null when no match |
| `num_bars` | constant | 1 |
| `source` | constant | `thumbtack` |
| `created_by` | constant | null (system) |

**Timezone note:** the lead's `event_date` is `TIMESTAMPTZ` (UTC). A late-evening
ET event can fall on the next UTC day, so we convert to `America/New_York` before
splitting date and time. As a backstop, the raw lead date is always echoed in
`admin_notes` so the admin can catch any skew during review.

### Event-type keyword mapping

Scan the lowercased Thumbtack `category` plus all Q&A `answer` strings; first
match wins. Order matters (more specific before generic):

`rehearsal -> rehearsal-dinner`, `engagement -> engagement-party`,
`bridal shower -> bridal-shower`, `bachelor`/`bachelorette ->
bachelor-bachelorette`, `wedding -> wedding-reception`, `milestone ->
milestone-birthday`, `birthday -> birthday-party`, `anniversary -> anniversary`,
`graduation -> graduation-party`, `retirement -> retirement-party`, `baby shower
-> baby-shower`, `happy hour -> corporate-happy-hour`, `corporate`/`company`/
`office -> corporate-event`, `holiday -> holiday-party`, `fundraiser`/`gala ->
fundraiser-gala`, `cocktail party -> cocktail-party`, `housewarming ->
housewarming`, `block party -> block-party`, `dinner party -> dinner-party`,
`memorial`/`celebration of life`/`funeral -> celebration-of-life`, `mixology`/
`class -> cocktail-class`, `festival`/`outdoor -> festival-outdoor`. No match:
leave `event_type` null (admin picks). Mapped values must be valid ids from
`EVENT_TYPES`.

### Admin Notes content

A single text block written to `proposals.admin_notes` so the admin sees full
Thumbtack context on the proposal:

```
Auto-created from Thumbtack lead (negotiation <negotiationId>).
Category: <category or N/A>
Lead price / charge state: <leadPrice or N/A> / <chargeState or N/A>
Event date as received: <raw lead.eventDate or "not specified">

Customer description:
<description or "(none)">

Q&A:
- <question>: <answer>
- ...

Reminder: add the client's email if you are emailing the proposal, verify
package and details, then Send and paste the link into the Thumbtack message.
```

Description and Q&A answers are truncated defensively (the lead already truncates
on ingest). Avoid em dashes in this copy.

### `proposals.source` column, badge, and filter

- **Schema:** `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS source VARCHAR(30);`
  Nullable, no default. Auto-drafts set `'thumbtack'`; all other creation paths
  leave it null (treated as "Manual / Direct"). Generic for future intake
  sources.
- **List query:** add `source` to the `SELECT` in `proposals/crud.js` `GET /`.
- **UI badge:** in `client/src/pages/admin/ProposalsDashboard.js`, render a small
  "Thumbtack" badge on rows where `source === 'thumbtack'`.
- **UI filter:** add a source filter (All / Thumbtack / Manual) on the proposals
  dashboard. "Manual" matches null source. Client-side filtering is acceptable if
  the list is already fully loaded; otherwise add a `source` query param to
  `GET /`. Plan decides based on the existing list implementation.

### Admin notification deep-link

`newThumbtackLeadAdmin` (`server/utils/emailTemplates.js`) gains an optional
`proposalUrl`. When present, the primary CTA becomes "Review & Send Proposal"
linking to `proposalUrl`; otherwise it falls back to the existing "View Client"
CTA. Update both HTML and text variants. The "grab the email from Thumbtack"
reminder stays. Add one line noting a Core Reaction draft was created and is
ready for review. The webhook computes
`proposalUrl = proposalId ? ${ADMIN_URL}/proposals/${proposalId} : null`.

## Money-path isolation and the future auto-send seam

The new unit creates only `draft` proposals. Invoice creation, client
notifications, drip enrollment, and the `sent` transition all remain solely in
the existing Send action (`/proposals/:id` and the proposals lifecycle code),
which is unchanged. The day we want full automation, a scheduler invokes that
same Send path against these drafts. Nothing here needs rewriting to add
auto-send; this pass deliberately stops at the draft.

## Error Handling

- Draft creation is best-effort and post-commit. Lead capture never depends on it.
- All failures in `createDraftProposalFromLead` ROLLBACK its own transaction,
  are captured to Sentry (tags `{ webhook: 'thumbtack', step: 'draft' }`), and
  leave the lead intact for manual handling.
- Missing package, missing date, no client, anonymous lead: handled as defined
  (skip draft when no client; null date/time when absent). None throw to the
  webhook response.

## Edge Cases

- **Duplicate lead webhook:** existing `negotiation_id` dedupe means the draft
  step runs at most once; the idempotency guard is a second safety net.
- **Admin deletes the draft:** `thumbtack_leads.proposal_id` is
  `ON DELETE SET NULL`. The lead remains; we do not re-create (webhook fires once
  per lead).
- **`created_by` null:** verify `ProposalsDashboard` (list) and `ProposalDetail`
  tolerate a null creator (blank creator name). Fix display if needed.
- **No firm date:** very common for inquiries; draft has null date, admin fills.

## Schema Changes

```sql
ALTER TABLE thumbtack_leads
  ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS source VARCHAR(30);
```

Both idempotent. `thumbtack_leads.proposal_id` is added after the `proposals`
table exists in `schema.sql` ordering.

## Code Touchpoints

- **New:** `server/utils/thumbtackProposalDraft.js` (the draft builder + field
  mapping + event-type map + admin-notes builder).
- `server/routes/thumbtack.js`: call the builder best-effort in `POST /leads`;
  pass `proposalUrl` to the notification.
- `server/utils/emailTemplates.js`: `newThumbtackLeadAdmin` gains `proposalUrl`.
- `server/db/schema.sql`: the two ALTERs.
- `server/routes/proposals/crud.js`: add `source` to `GET /` SELECT (and an
  optional `source` filter param if server-side filtering is chosen).
- `client/src/pages/admin/ProposalsDashboard.js`: badge + source filter.
- Docs: `ARCHITECTURE.md` (Thumbtack integration section + new util),
  `README.md` (folder tree: new util) per the mandatory-docs table.

## Testing

Follow existing server-test patterns. Note the shared-dev-DB caveat: run server
suites one at a time.

- **Unit (`thumbtackProposalDraft`):** given a parsed lead + clientId, creates a
  `draft` proposal with package = Core Reaction, `source = 'thumbtack'`,
  populated `admin_notes`, correct total ($350 at 4h), activity-log row, and sets
  `thumbtack_leads.proposal_id`. Idempotency guard returns the existing id on a
  second call.
- **Field mapping:** event-type keyword map (specific-before-generic ordering);
  ET date/time split; missing date -> null; duration always 4.
- **Webhook integration:** new lead -> lead saved AND draft created AND
  notification carries `proposalUrl`; simulated draft failure -> lead still
  saved, 200 returned, Sentry captured; anonymous lead -> lead saved, no draft.
- **List/badge:** `GET /proposals` returns `source`; dashboard badges Thumbtack
  rows; filter narrows correctly.

## Future (not built now)

- Scheduler-driven auto-send against these drafts (the seam is left clean).
- Conversion analytics keyed on `proposals.source`.
- Optional gating of auto-draft by Thumbtack `leadType` / `chargeState` if draft
  clutter becomes a problem.
