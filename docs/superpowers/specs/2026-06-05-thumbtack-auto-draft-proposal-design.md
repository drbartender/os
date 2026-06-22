# Thumbtack Auto-Draft Proposal: Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm), reviewed (4-reviewer design fleet), pending implementation plan
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
moment a lead arrives, so the admin's job collapses to "open, add email, Send,
paste link into Thumbtack."

## Goals

- On every new Thumbtack lead, auto-create a **draft** proposal defaulting to
  **The Core Reaction**, prefilled from the lead data.
- Surface the lead's full context (description + Q&A + lead price + raw date) on
  the proposal itself, so the admin reviews in one place.
- Deep-link the admin notification straight to the draft for a fast review/send.
- Tag proposals by origin (`source`) so Thumbtack drafts are visible, filterable
  server-side, and measurable (conversion tracking, and a foundation for future
  automation).
- Guard the Send action: if the client has no email, confirm before sending so
  email is never skipped by accident.
- Keep the real-money path (invoice creation, the `sent` transition) logically
  intact. The draft builder only ever creates inert drafts.

## Non-Goals (out of scope for this pass)

- Auto-sending proposals. The admin still clicks Send. (See "Future" for the
  clean seam this design leaves.)
- Scraping the customer's email. Thumbtack never provides it in the webhook, so
  the admin enters it manually before Send for now; automated scraping is a
  planned later project.
- Outbound Thumbtack messaging via API (we still paste the link by hand).
- Threading Thumbtack messages into the proposal/client timeline.
- Backfilling `source` on other intake paths (Cal.com, website, direct). Only
  Thumbtack auto-drafts set `source = 'thumbtack'`; everything else stays null,
  which means "manual / direct" by contract, permanently (never "unknown").

## Current State (verified)

- `server/routes/thumbtack.js` `POST /leads`: parses V4/legacy payload via
  `parseLead`, dedupes on `negotiation_id`, calls `findOrCreateClient`, inserts
  into `thumbtack_leads`, commits, then best-effort sends the admin notification
  via `notifyAdminCategory({ category: 'routine_thumbtack', ... })` (NOT
  `sendEmail` directly) using the `newThumbtackLeadAdmin` template, with a CTA to
  `${ADMIN_URL}/clients/:id`.
- Proposal creation (`server/routes/proposals/crud.js` `POST /`) requires
  `package_id`, composes `event_location` from the structured venue fields via
  `composeVenueLocation`, prices through `calculateProposal`
  (`server/utils/pricingEngine.js`), then inserts the proposals row (24 columns),
  bulk-inserts `proposal_addons` from the snapshot, and writes a `created`
  activity-log row. On `status='sent'` it also creates the first invoice
  (`createInvoiceOnSend`) and best-effort emails the client.
- The Core Reaction: slug `the-core-reaction`, `pricing_type 'flat'`,
  `bar_type 'service_only'`, `base_rate_4hr 350`, `extra_hour_rate 100`,
  `bartenders_included 1`. The seed INSERT does not set `first_bar_fee`
  (so it takes the column default; the plan must confirm that default prices a
  service_only Core Reaction at the expected rate, since manual Core Reaction
  proposals already price correctly today through the same engine).
- The send path (`server/routes/proposals/lifecycle.js`): `createInvoiceOnSend`
  runs unconditionally and does not read `client_email`; the post-commit email
  step (`sendProposalSentEmail`) silently skips email when `client_email` is null
  and falls through to the initial-proposal SMS, which fires to the client's
  phone (Thumbtack leads DO have a phone). This is the behavior the new Send
  guard front-ends.
- Admin proposal review/send page: `/proposals/:id` (`ProposalDetail`,
  `client/src/App.js:505`).
- Proposals list (`crud.js` `GET /`) is **paginated server-side**
  (`page`, `limit` default 50) with an explicit PII-aware column allowlist (not
  `SELECT *`). `ProposalsDashboard` fetches tab counts once on mount from a stats
  endpoint and post-filters only the free-text search client-side.
- Event-type taxonomy: `server/utils/eventTypes.js` (`EVENT_TYPES` with `id` and
  `category` per entry; ids like `wedding-reception`, `birthday-party`,
  `corporate-event`; `getEventTypeLabel` falls back to `event`). All 22 ids the
  keyword map targets exist (verified).
- `expireStaleQuoteDrafts` (the daily quote-draft-cleanup scheduler) operates on
  the separate `quote_drafts` table, NOT `proposals`. Auto-drafts are safe from
  it. No scheduler purges draft proposals.
- `proposals.created_by` is nullable and joined with `LEFT JOIN users`
  (`crud.js`), so a null creator is structurally safe.
- `admin_notes` is already excluded from both public surfaces
  (`proposals/publicToken.js`, `clientPortal.js` allowlisted SELECTs).

## Design

### Shared proposal-insert helper (resolves drift)

Extract the proposals-row creation from `crud.js` `POST /` into one shared helper
so the manual route and the Thumbtack util produce identical, complete rows. This
is a deliberate refactor of a money-path file, done with full test coverage,
because a separate raw INSERT in the new util would otherwise drift (missing
`composeVenueLocation`, `event_type_category`, and any future columns).

**New:** `server/utils/proposalInsert.js`
`insertProposalRecord(dbClient, fields) -> proposalRow`

- Composes `event_location` via `composeVenueLocation(venue)` with the legacy
  single-string fallback.
- Inserts the `proposals` row with the full column set (now including `source`
  and `admin_notes`).
- Bulk-inserts `proposal_addons` from `fields.snapshot.addons` when present.
- Returns the inserted proposal row.

It does NOT price, create invoices, send email/SMS, write the activity log, or
transition status. Pricing stays in each caller (each computes its own snapshot);
the activity-log row and all send-specific logic stay in the callers. `crud.js`
`POST /` is refactored to build its `fields` and call this helper, then do its
existing invoice/email/drip work unchanged (status `sent`/`draft`, `source` null,
`admin_notes` null, `actor_type 'admin'`). Behavior for the manual path is
identical; existing `crud.test.js` plus new tests guard the refactor.

### Flow (lead arrival)

In `POST /api/thumbtack/leads`, after the existing lead + client transaction
commits, add one best-effort step (its own try/catch, mirroring the existing
notification step) that creates the draft:

1. Lead capture commits first and is sacrosanct: a failure in proposal creation
   must never roll back or block lead capture.
2. If we have a `clientId`, call
   `createDraftProposalFromLead({ lead, clientId, negotiationId })`.
3. The returned `proposalId` (if any) is passed to `newThumbtackLeadAdmin` (via
   the existing `notifyAdminCategory` call) so the CTA deep-links to the draft.
4. On any error in step 2, capture to Sentry, send the notification with the
   legacy client CTA, and return 200. The admin falls back to manual creation.
   Note: because the webhook dedupes the lead and returns 200 before this step, a
   crash mid-draft will not be re-driven by a Thumbtack retry (the retry sees the
   lead and short-circuits). That is acceptable: the admin notification still
   fires and manual creation is the fallback. (Optional later hardening: allow a
   lead whose `proposal_id` is null to be reprocessed.)

The webhook still responds 200 to Thumbtack regardless of draft outcome. The
draft step is a handful of fast queries; it is awaited (so `proposalUrl` is ready
for the notification) but must stay cheap enough not to threaten the webhook 200.

### New unit: `server/utils/thumbtackProposalDraft.js`

`createDraftProposalFromLead({ lead, clientId, negotiationId }) -> { proposalId } | null`

Owns its own DB transaction. Steps, all inside one transaction so they commit
atomically (no window where a proposal exists but the lead is unlinked):

1. **Idempotency guard with row lock.**
   `SELECT proposal_id FROM thumbtack_leads WHERE negotiation_id = $1 FOR UPDATE`.
   If already set, return that id without creating a second proposal.
2. **Resolve package.** `SELECT * FROM service_packages WHERE slug =
   'the-core-reaction'`. If missing, throw (caught upstream as best-effort).
3. **Map lead -> fields** (see Field Mapping), build `admin_notes` (see Admin
   Notes).
4. **Price.** `calculateProposal({ pkg, guestCount, durationHours, numBars,
   numBartenders: undefined, addons: [], syrupSelections: [] })` where
   `durationHours` is the lead's real event duration (revised 2026-06-22: see
   Field Mapping; originally a hardcoded `4`) and `numBars`
   is 0 for a `service_only` package (The Core Reaction) and 1 otherwise. A
   `service_only` package rents no physical bar, and any `numBars >= 1` makes the
   engine add `first_bar_fee` (`Number(pkg.first_bar_fee || 50)`, i.e. $50 even
   when the column is 0).
5. **Insert** via the shared `insertProposalRecord(dbClient, fields)` with
   `status 'draft'`, `source 'thumbtack'`, `created_by NULL`.
6. **Activity log.** `INSERT INTO proposal_activity_log (proposal_id, action,
   actor_type, details) VALUES ($1, 'created', 'system', $2)` with
   `details = { source: 'thumbtack', negotiation_id }`.
7. **Link the lead.** `UPDATE thumbtack_leads SET proposal_id = $1 WHERE
   negotiation_id = $2`.
8. COMMIT, log success (`console.log` with proposalId + negotiationId), return
   `{ proposalId }`.

This unit never creates an invoice, never sends email/SMS, never sets `sent`.

### Field Mapping (lead -> proposal)

| Proposal field | Source | Rule |
|---|---|---|
| `package_id` | The Core Reaction | resolved by slug |
| `guest_count` | `lead.guestCount` | parsed by `extractGuestCount`; fall back to 50 |
| `event_date` | `lead.eventDate` | convert to `America/New_York`, take the date part; null if absent |
| `event_start_time` | `lead.eventDate` | ET time like `6:00 PM`; null if absent |
| `event_duration_hours` | event window | **Revised 2026-06-22:** derived from the lead's scheduled window (`proposedTimes[0].end - .start`, in hours) via `computeDurationHours`; falls back to `4` only when the window is absent/implausible. The original "always 4" punted on a scalar `booking.duration` whose unit was ambiguous, but real V4 payloads carry an unambiguous start/end pair instead. |
| `event_location` | venue fields | composed by `insertProposalRecord` via `composeVenueLocation` |
| `venue_street/city/state/zip` | `lead.location*` | nullable |
| `venue_name` | (none) | null |
| `event_type` | category + Q&A | keyword map (below); null when no match |
| `event_type_category` | matched `EVENT_TYPES` entry | set to that entry's `category` when `event_type` matched; else null |
| `num_bars` | by `bar_type` | 0 for `service_only` (The Core Reaction), else 1; `service_only` rents no bar and `numBars >= 1` adds `first_bar_fee` |
| `num_bartenders` | (none) | undefined; engine derives from package + guests |
| `source` | constant | `thumbtack` |
| `created_by` | constant | null (system; attribution in activity log) |

**Pricing note:** the draft is priced by the real engine, not a hard-coded
number. For The Core Reaction at <=100 guests with no extra bartenders it lands
at roughly $350; it correctly scales up for longer durations or guest counts that
cross the 1:100 bartender ratio. The spec does not assume a literal flat $350.
Because `num_bars` is 0 for the `service_only` Core Reaction, no bar-rental fee
applies (the engine would otherwise add `first_bar_fee || 50` for any
`num_bars >= 1`). A unit test pins the total at a controlled guest count.

**Timezone:** the lead's `event_date` is `TIMESTAMPTZ` (UTC); a late-evening ET
event can fall on the next UTC day, so convert to `America/New_York` before
splitting date and time. The raw lead date is always echoed in `admin_notes` as a
backstop.

### Event-type keyword mapping

Scan the lowercased Thumbtack `category` plus all Q&A `answer` strings; first
match wins, specific before generic:

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
`event_type` and `event_type_category` stay null. Mapped values must be valid ids
from `EVENT_TYPES`.

### Admin Notes content

A single text block written to `proposals.admin_notes`:

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

Reminder: add the client's email before sending if you want them emailed, verify
package and details, then Send and paste the link into the Thumbtack message.
```

Description and Q&A answers are truncated defensively. No em dashes in this copy.
`admin_notes` is already excluded from public-token and client-portal SELECTs; a
test asserts it stays excluded for a Thumbtack-sourced proposal.

### Send-time no-email guard

Thumbtack gives no email, and the intended flow is that the admin enters the
email (manually now, scraped later) before sending. To prevent an accidental
email-less send, `ProposalDetail` front-ends its existing Send action: when the
proposal's client has no email, show a confirm dialog, "No email on file. Send
via SMS only?" Confirm proceeds with the existing send (invoice, `sent`,
initial-proposal SMS to the client's phone, which we keep because it aids
new-lead conversion); Cancel aborts so the admin can add the email first. This is
a client-side guard; the server send endpoint is unchanged. It applies to any
proposal with no client email, not only Thumbtack ones.

### `proposals.source` column, badge, and server-side filter

- **Schema:** `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS source VARCHAR(30);`
  with `CHECK (source IS NULL OR source IN ('thumbtack'))` (widen the allowlist
  later as new sources are added). Nullable; auto-drafts set `'thumbtack'`, all
  other paths leave it null ("manual / direct").
- **List query:** add `p.source` to the explicit allowlisted SELECT in
  `crud.js` `GET /`, and accept an optional `source` query param that filters the
  list **server-side** (so Thumbtack drafts beyond page 1 are never missed).
- **Counts:** apply the same `source` filter to the tab-count / stats query the
  dashboard loads, so the counts stay consistent with the filtered list (avoids
  the once-on-mount desync). The source-scoped path returns ONLY the tab-count
  fields (`pipeline` / `paidCount` / `archivedCount`); the full-KPI cards never
  pass `source`, so this thinned shape is the documented contract for a
  source-filtered stats request.
- **UI:** in `client/src/pages/admin/ProposalsDashboard.js`, render a "Thumbtack"
  badge on rows where `source === 'thumbtack'`, and add a source filter
  (All / Thumbtack / Manual) that drives the `source` query param. "Manual"
  filters null source.
- **Consumer audit:** the plan greps every `proposals` SELECT to confirm no
  consumer assumes a non-null `source`; the contract is null = manual/direct.

### Admin notification deep-link

`newThumbtackLeadAdmin` (`server/utils/emailTemplates.js`) gains an optional
`proposalUrl`. When present, the primary CTA becomes "Review & Send Proposal"
linking to `proposalUrl`; otherwise it falls back to the existing "View Client"
CTA. Update both HTML and text variants and add one line noting a Core Reaction
draft was created. The webhook computes
`proposalUrl = proposalId ? ${ADMIN_URL}/proposals/${proposalId} : null` and
passes it through the existing `notifyAdminCategory` call.

## Money-path isolation and the future auto-send seam

The Thumbtack util creates only `draft` proposals. Invoice creation, client
notifications, drip enrollment, and the `sent` transition remain in the existing
send path, which is unchanged except for the client-side no-email confirm. The
shared `insertProposalRecord` helper covers only the row/addons INSERT shape, not
pricing or send logic. The day we want full automation, a scheduler invokes the
existing Send path against these drafts; nothing here needs rewriting.

## Error Handling

- Draft creation is best-effort and post-commit. Lead capture never depends on it.
- All failures in `createDraftProposalFromLead` ROLLBACK its own transaction, are
  captured to Sentry (tags `{ webhook: 'thumbtack', step: 'draft' }`), and leave
  the lead intact for manual handling. Success is logged.
- Missing package, missing date, no client, anonymous lead: handled as defined
  (skip draft when no client; null date/time when absent). None throw to the
  webhook response.

## Edge Cases

- **Duplicate / concurrent lead webhook:** the `thumbtack_leads.negotiation_id`
  UNIQUE constraint already prevents a second lead insert, so only one delivery
  reaches the draft step; the `FOR UPDATE` idempotency guard is the second net.
- **Admin deletes the draft:** `thumbtack_leads.proposal_id` is
  `ON DELETE SET NULL`. The lead remains; we do not re-create.
- **`created_by` null:** verified safe (LEFT JOIN). UI shows a blank creator.
- **No firm date:** common; draft has null date, admin fills.
- **Guest count > 100:** the draft prices correctly above the base via the
  bartender ratio; expected, not a bug.

## Schema Changes

```sql
ALTER TABLE thumbtack_leads
  ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS source VARCHAR(30);
-- add the CHECK idempotently (guarded DO block) so re-runs are safe:
--   CHECK (source IS NULL OR source IN ('thumbtack'))
```

Both idempotent. `thumbtack_leads.proposal_id` is added after the `proposals`
table exists in `schema.sql` ordering.

## Code Touchpoints

- **New:** `server/utils/proposalInsert.js` (`insertProposalRecord`, shared by
  the manual route and the Thumbtack util).
- **New:** `server/utils/thumbtackProposalDraft.js` (draft builder + field
  mapping + event-type map + admin-notes builder).
- `server/routes/proposals/crud.js` `POST /`: refactor to call
  `insertProposalRecord`; add `p.source` to `GET /` SELECT + an optional
  server-side `source` filter param; apply `source` to the counts/stats query.
- `server/routes/thumbtack.js`: call the draft builder best-effort in
  `POST /leads`; pass `proposalUrl` to the notification.
- `server/utils/emailTemplates.js`: `newThumbtackLeadAdmin` gains `proposalUrl`.
- `server/db/schema.sql`: the two ALTERs + the `source` CHECK.
- `client/src/pages/admin/ProposalsDashboard.js`: badge + source filter wired to
  the `source` param.
- `client/src/pages/admin/ProposalDetail.js`: no-email Send confirm.
- Docs: `ARCHITECTURE.md` (Thumbtack integration + new utils),
  `README.md` (folder tree: new utils).

## Testing

Follow existing server-test patterns; the dev DB is shared, so run server suites
one at a time.

- **`insertProposalRecord`:** composes `event_location`, inserts the full column
  set incl `source`/`admin_notes`, inserts addons from the snapshot; the manual
  `crud.js` path is unchanged (existing `crud.test.js` must stay green).
- **`thumbtackProposalDraft`:** given a parsed lead + clientId, creates a `draft`
  proposal with package = Core Reaction, `source = 'thumbtack'`, populated
  `admin_notes`, `event_location` composed, correct total at a controlled guest
  count, activity-log row, and sets `thumbtack_leads.proposal_id`. The idempotency
  guard returns the existing id on a second call.
- **Field mapping:** event-type + category map (specific-before-generic); ET
  date/time split; missing date -> null; duration always 4.
- **Pricing:** pin `snapshot.total` and `snapshot.staffing.total` for the
  controlled-guest Core Reaction draft; confirm no unexpected bar-rental fee for
  `service_only` (`num_bars` is 0 for it).
- **Webhook integration:** new lead -> lead saved AND draft created AND
  notification carries `proposalUrl`; simulated draft failure -> lead still saved,
  200 returned, and the failure logged (`console.error`; Sentry too when
  `SENTRY_DSN_SERVER` is set); anonymous lead -> lead saved, no draft.
- **Source filter:** `GET /proposals?source=thumbtack` returns only Thumbtack
  rows across pages; counts reflect the filter; dashboard badges Thumbtack rows.
- **PII:** `admin_notes` is not returned by the public-token route (`/t/:token`)
  for a Thumbtack-sourced proposal (automated regression). The client-portal
  proposal surface excludes it via the same allowlist (see Current State); it is
  not separately re-tested.
- **Send guard:** Send on a no-email proposal prompts the confirm; confirming
  proceeds, cancelling aborts.

## Future (not built now)

- Scheduler-driven auto-send against these drafts (seam left clean).
- Email scraping to populate the client email automatically pre-send.
- Conversion analytics keyed on `proposals.source`.
- Optional gating of auto-draft by Thumbtack `leadType` / `chargeState`.
