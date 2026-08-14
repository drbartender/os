# Marketing Section Redesign

**Date:** 2026-08-11
**Status:** Approved (section-by-section, 2026-08-11 brainstorm). **Third revision.** Draft 1 (dispatcher-based multi-day sends) drew 9 fleet blockers. Draft 2 (hand-picked manual sends) drew 12 more and became phase 2 of this document. Dallas then took the whole section to claude.ai/design and approved the returned IA, which supersedes both drafts.

**Design source:** claude.ai/design project `c41f6ef1-f03b-4a0e-84b9-de533b8af077`, file `Marketing - Redesign.dc.html`. Local copy at `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`. Design system: Dr. Bartender OS (`72035042-c993-47e2-9dc8-c452b7bf5fa4`), After Hours dark / House Lights light.

## 1. Problem

The Marketing section is scaffolding for a product nobody uses. Its four tabs (Leads, Campaigns, Analytics, Conversations) are all organized around `email_leads`, a table with 15 rows of which 4 are real people, the rest being duplicates of existing clients, two internal test accounts, `test@drbartender.com`, and one typo'd dead address. The audience query is hardcoded at `emailMarketing.js:457`. One marketing email has ever been sent.

The real contact base is in `clients` and the section cannot see it: 233 people have paid, 188 quoted and never booked, ~400 reachable by email. Nobody has ever asked a past client for a second event. Of every client on a company email domain with a booked proposal, exactly one has more than one event date, and those two dates are consecutive.

The deeper problem is that the section is organized around tools rather than around a job. The redesign reorganizes it around occasions that repeat.

## 2. The information architecture

Four tabs replace the old four: **Overview** (default), **Audiences**, **Compose**, **Sent**, plus a primary "New send" action. Page subtitle is live: "Tuesday, August 11 · 3 moments open · 66 sends left today".

**"Campaign" is no longer the primary object. "Moment" is.** Overview leads with moments open now, each carrying a closing window, an audience, a headcount, and authored reasoning. Its action is "Review recipients", which opens Compose with the audience already resolved. The screen answers "what should I do today" rather than "here is a list of things you made".

## 3. Build order

Driven by a date. The design's first moment reads "Holiday parties are booked in September. Send by Sep 5." Three things must exist for that send to leave safely: corporate clients tagged, an email composed, and a send that cannot damage the invoice channel. Nothing else is on the critical path.

- **Phase 1, the spine.** Tags, the Do-not-contact backing, the audience resolver, the Audiences tab, the contact drawer, and the client-keyed comms view. Unblocks Dallas to start classifying 184 contacts by hand while phase 2 is built.
- **Phase 2, sending.** Compose, send, and the compliance and safety fixes that must ship with it. Gets the September send out.
- **Phase 3, the payoff.** Overview with moments, the year-honestly numbers, the Needs You queue, and Sent with booked attribution.

## 4. Phase 1: tags, suppression, resolver, contacts

### 4.1 Tags

A general multi-tag system on clients, not a corporate boolean. The design's vocabulary is a fixed enum: **Corporate, Wedding, Birthday, Graduation, Thumbtack, Do not contact**. Contacts carry several at once.

Alongside human tags the UI shows **derived states** that are computed, never stored: `Paid client`, `Quoted only`, `Untagged`. Untagged means no human has ever set a tag, which is distinct from "tagged as not corporate".

Tags are edited inline in the contact table. Per the design's own copy: "Click any tag cell to change it. Edits save to the contact, not the audience."

**Corporate must be human-set, never inferred.** Measured across every client with a proposal:

| | corporate events only | personal events only |
|---|---|---|
| company email domain | 16 | 10 |
| free mail domain | 14 | 119 |

Of the 30 clients who have booked corporate work, 14 used a personal address; one is a community college booking from a gmail account. Of the 26 on company domains, 10 were booking their own weddings and birthdays. The domain heuristic is close to a coin flip in both directions and is disqualified as a classifier.

It survives as a **suggestion**. A contact carries suggestion text with its reasoning ("Booked a 180-guest event at a college address. Looks corporate.") and a one-click apply. Suggestions are computed from event history and domain together, are never auto-applied, and disappear once a human sets any tag.

### 4.2 Do not contact

Displayed as a tag, backed by dedicated columns. It is the only tag whose accidental removal results in emailing someone who explicitly asked not to be emailed, so it does not behave like a free-text label.

`clients.marketing_excluded BOOLEAN NOT NULL DEFAULT false`, `marketing_excluded_reason TEXT`, `marketing_excluded_at TIMESTAMPTZ`, `marketing_excluded_by INTEGER REFERENCES users(id)`. Setting it requires a reason, enforced server-side. Removing it takes a confirmation, not a click. Every other tag stays cheap and freely editable.

**Marketing only** (Dallas's explicit decision). An excluded client who books still receives proposals, invoices, and every operational message.

It needs a dedicated endpoint. `PUT /api/clients/:id` (`clients.js:121-150`) destructures a fixed 5-field body and updates via `COALESCE($n, col)`, where null means "leave unchanged", so it structurally cannot clear the flag or null the reason. Audit to `admin_audit_log` with the client id in `metadata` and `target_user_id` NULL, since that column FKs to `users` (`schema.sql:2532`) and a client is not a user.

**Not built: temporary event-scoped suppression.** The one historical instance was Luva Dorris (client 1651), a Check Cherry event transferred in 2026-07-14 for an event on 2026-07-18, where automated comms were killed so os would not duplicate messaging she had already received in Check Cherry. Dallas retired it himself on 2026-08-06: "her event is over, none of this matters. If she does another event we'll want to send her all the things." Her row correctly reads all channels enabled. She is a target, not an exclusion.

### 4.3 The audience resolver

One server-side module, named and shared, that every path goes through: audience previews, counts, the recipient list, and the send itself. No client-side reimplementation of the filters.

**Mailability is a single predicate.** A contact is mailable only when `marketing_enabled` is not false, `email_enabled` is not false, `marketing_excluded` is false, `email` is present and non-empty, `email_status` is not `'bad'`, the address is not an `emailValidation.isPlaceholderEmail` `.invalid` placeholder, and no `email_leads` row for the same address is `unsubscribed`. That last one matters because 9 of the 15 leads are also clients.

`communication_preferences` keys are tri-state in practice: every existing check in the codebase is `prefs.x === false`, and an absent key means enabled. SQL must match that, not `= true`.

**Suppression is visible, not silent.** An "Always held back" panel shows counts by reason (Do not contact, Unsubscribed, Bounced), and the pre-send screen repeats it. Held-back people never appear in a recipient list.

**Audiences are saved rule definitions**, re-resolved every time. The design ships seven: Past clients / corporate, Past clients / everyone, One year on (last event 11-13 months ago), Cold quotes / spring, Quoted never booked, Thumbtack in conversation, and Never classified. Each carries a human-readable rule string and an `includes` list of its criteria, both shown in the UI.

**Data notes.** Check Cherry history joins from `legacy_cc_proposals` on `lower(clients.email) = client_email_normalized`, **not** on `client_id`, which is populated on only 197 of its 1,230 rows. Money units differ across the two sources and must be normalized: `proposals.total_price` and `amount_paid` are `NUMERIC(10,2)` **dollars** (units legend at `schema.sql:575`), while `legacy_cc_proposals.total_cost_cents` and `package_amount_cents` are **cents**. A naive lifetime-spend SUM floats the entire 184-person Check Cherry cohort to the top at 100x. Normalize event-type casing everywhere `proposals.event_type` is read, since the import left both `corporate-event` and `Corporate Event`. Dedupe by lowercased email in the resolver **and** on the send, since one person can hold more than one client row.

### 4.4 Contacts surface

A table of contact, marketing tags, last event, lifetime, last contacted, with quick filters (All 421, Untagged 184, Corporate 30, Do not contact 4) and inline tag editing. Pagination or virtualization is required; the candidate list is ~700 rows and the only existing precedent (`AudienceSelector.js:29`) hard-codes `limit: 500` with no pagination and would silently truncate.

A contact drawer shows tags, event history with dates and amounts, source, lifetime value, and **every message that contact has received, automated ones included and marked as such**. This is load-bearing rather than nice-to-have: the design's promise that automations "show up on the contact's record so you never double-tap someone" rests entirely on it.

That view cannot be built on `message_log`. `message_log.proposal_id` is `INTEGER NOT NULL` (`schema.sql:3542`) and `logClientMessage` returns early without one (`messageLog.js:88`), so the 254 proposal-less clients and the Check Cherry cohort log nothing, while clients who do have proposals get sends filed against an unrelated recent event. The contact history is a union over `message_log`, `scheduled_messages` (for automated marketing and lifecycle touches), and `email_sends` (for campaigns).

## 5. Phase 2: compose and send

### 5.1 Compose

Three steps: **Design → Recipients → Send**.

Design reuses the existing block palette (`client/src/components/emailBuilder/`, plus the **server-side** `emailDesign.js` and `emailBlockRenderer.js`): Logo bar, Hero image, Heading, Text, Button, Divider, Image + text, Spacer, Footer. A per-block Format panel adds bold/italic/underline, size, alignment, line height, tracking, text color, padding, background, duplicate, move, delete.

New scope the current composer does not have: a **Look panel** with theme presets, heading and body font pickers, an accent color, and corner style (square / soft / pill). Brand kit is the default and every send starts there.

Recipients shows the resolved list with tags and per-person Remove. Removals apply to that send only and write nothing to the contact.

Send is a confirmation screen: recipient count, the daily budget broken into transactional versus this send, the held-back list, "Send test to me", and a send button reading "Send to N people. Goes out at once. No scheduling yet."

### 5.2 The send itself

`POST /email-marketing/campaigns/:id/send` takes `client_ids`.

**Backgrounded, with a durable record.** The current route responds before sending and runs `sendBlastEmails(...).catch(console.error)` (`emailMarketing.js:493`), keeping progress only in a loop variable. That stays backgrounded, but every recipient's outcome is written to `email_sends` as it happens, so a mid-send restart leaves a queryable record of who was reached and who was not, and the campaign's status reflects reality rather than being stuck at `sending`.

**Paced, not concurrent.** `sendBlastEmails` currently fires 100 Resend calls at once via `Promise.all`. Replace with a serial loop and an inter-send delay. Per CLAUDE.md's one-pooled-connection rule, the loop's per-recipient writes are autocommit and must not run inside a held `pool.connect()` client.

**Send-once guard.** The route validates only `type === 'blast'`, `subject`, and `html_body`; it never reads `campaign.status`. A double-click, a retry, or a second tab re-blasts the list. Add a status precondition under `FOR UPDATE`.

**Quota handling, corrected twice.** `email.js:25-38` `isQuotaError` matches any 429 **or rate-limit** response, so a serial loop trips its own quota-abort on Resend's per-second throttle. Distinguish a transient rate-limit (back off and continue) from a genuine daily-quota exhaustion (stop, record, report). Do not treat every 429 as terminal.

**Recording.** `email_sends` gains `client_id INTEGER REFERENCES clients(id)`, `lead_id` (currently `NOT NULL`, `schema.sql:1601`) is relaxed to nullable, and a CHECK requires exactly one recipient key. The FK's `ON DELETE` rule and that CHECK interact: `SET NULL` would violate the CHECK, and bare `NO ACTION` blocks the orphan-client delete `calcom.js:315` performs live. Resolve by making the CHECK tolerate a fully-detached row (both keys null = an orphaned historical send) and using `ON DELETE SET NULL` on both FKs.

**Consumers of the changed table** must be swept: the campaign send-history query INNER JOINs `email_leads` (`emailMarketing.js:337-346`) and would hide every client row; `emailMarketingWebhook.js:157-171` updates `email_leads WHERE id = <lead_id>` and needs a null guard; the analytics overview (`emailMarketing.js:826-835`) aggregates the whole table and would dilute lead metrics with campaign sends.

**Auth.** Every route in `emailMarketing.js` uses `requireAdminOrManager`. Send, the exclusion endpoints, and the contact-resolve endpoint (which returns names, emails, and spend across the whole client base) are **admin only**, via `adminOnly` from `server/middleware/auth.js:140`.

### 5.3 Compliance and safety, shipping with phase 2

**A marketing complaint must stop marketing without breaking billing.** `emailMarketingWebhook.js:186-200` flips `clients.email_status = 'bad'` on any hard bounce or spam complaint, and `messageSuppression.js:35` plus `channelFallback.emailUsable` then suppress or SMS-divert that client's proposals, invoices, receipts, and agreements. Nothing ever writes the flag back to `'ok'`. Today a recipient hitting "report spam" on a marketing email permanently breaks their own billing email, with no recovery outside raw SQL. The webhook must distinguish which kind of send the event belongs to: a complaint on a campaign sets `marketing_excluded` (reason: complained) and leaves `email_status` alone; a hard bounce still marks the address bad, since a dead address is dead for every purpose. Ship an admin control to clear `email_status = 'bad'`. **Dallas approved touching the webhook on 2026-08-11.**

**CAN-SPAM postal address.** `wrapMarketingEmail` (`emailTemplates.js:439-462`) renders only "Dr. Bartender · drbartender.com" and an unsubscribe link. A valid physical postal address is required in every commercial message. This footer is also used by the already-live `retention_nudge` and `new_year_hello` touches, so it ships independently and does not wait on this feature. **Dallas must supply the address** (section 9).

**Unsubscribe must not be a bare GET.** `emailMarketing.js:940` flips the preference on GET with no confirmation, irreversibly. Corporate link scanners prefetch inbound links, and the audience is corporate work addresses, so a scanner can destroy a client's marketing channel with no human involved. Render a confirmation page on GET, perform the flip on POST, as a plain `<form method="POST">` since Helmet's CSP (`server/index.js:144-153`) blocks inline JS. The POST stays public with the token as sole auth so one-click can be added later. Same treatment for the `{leadId}` branch. Note this is the scanner fix, not RFC 8058 compliance; `List-Unsubscribe` headers need a `headers` passthrough on `sendEmail` and stay in section 9.

**Unsubscribe token.** Reuse the `{clientId, marketing: true}` JWT from `marketingHandlers.js:51-62`. Add a `typ` claim to newly minted tokens, treated as **advisory on verification**, because every token already delivered carries no `typ` and requiring it would kill live unsubscribe links.

**Retire the legacy all-leads send path.** An empty `client_ids` body must be rejected rather than falling back to blasting every active lead. `POST /campaigns/:id/schedule` (`emailMarketing.js:561-572`) writes a status nothing reads and should be hidden while scheduling is out of scope.

**Test send.** The existing path stamps `token=preview` into the unsubscribe URL, which 400s on click. Mint a real token for the test recipient.

**File-size ratchet.** `server/routes/emailMarketing.js` is **987 lines** against the 1000-line hard cap (`scripts/check-file-size.js`). Extract first, as its own behavior-inert commit. There is no composition router in this file today; it is a flat `express.Router()` mounted at `server/index.js:365`, so this is a conversion to `server/routes/emailMarketing/` following the `server/routes/proposals/` pattern, with exact path preservation. Move the lead CRUD and import (`:30-258`), the sequence handlers (`:743-821`), the sequence-steps block (`:658-742`), and the lead-keyed conversations block (`:856-939`). The resolver is its own file from the start, never inside the route file.

## 6. Phase 3: Overview, moments, Sent

### 6.1 Moments

**The rule and the window are code. The words are data.** Each moment is a built-in definition with an id, a rule resolving to an audience, and a window. Title, window label, and the "why" prose ship as authored defaults.

Editing stores **only the fields changed**, so untouched copy keeps tracking the default while rewritten copy stays permanent even when the stock copy is later improved. A moment can be hidden. Dismissing a moment dismisses **that occurrence only**, so the September holiday push returns next September rather than vanishing because it was cleared once.

The three shipped moments, with the design's own copy as the starting default:

- **Holiday parties are booked in September.** Send by Sep 5. Corporate past clients. "Every corporate client you have ever had books in Q4 and none of them has ever come back. This is the one send with a repeat-revenue thesis behind it."
- **N people hit their one-year mark this month.** Rolling. Past clients 12 months on. "Anniversary of a finished event. The 11-month automated nudge already went out, this is the human follow-up nobody has ever sent."
- **N spring quotes said 'keep us in mind'.** Any time. Quoted never booked. Notes when the audience exceeds the daily cap and the send takes more than one pass.

### 6.2 Overview

Moments first. Then "The year, honestly" (marketing emails sent all time, past clients never asked back, repeat corporate bookings) putting the real numbers on the wall. Then "Needs you", a work queue: contacts never classified, someone who asked not to be emailed, addresses hard-bounced. Then the reachable base broken down, and today's send budget.

A "Runs without you" panel names the automations and states they are managed in Settings, not here, and that every one shows on the contact's record.

### 6.3 Sent

A table of name, date, audience, status, sent, opened, replied, **booked**. Booked attribution is defined as: a recipient created a proposal within **30 days** of receiving that campaign, attributed by client id. Both sides are local tables.

Below it, "Also reaching your contacts", listing the four automations with their triggers and 30-day counts: unsigned proposal drip (5 touches), review request (2 days after each event), retention nudge (11 months after an event), New Year touch (January 2). Read-only here; managed in Settings.

## 7. Schema changes

All idempotent. Note Postgres has **no `ADD CONSTRAINT IF NOT EXISTS`**, and `schema.sql` replays on every boot, so every CHECK addition uses the guarded `DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)` pattern already used at `schema.sql:933`, `:1141`, `:1332`. Existing constraint blocks end `EXCEPTION WHEN OTHERS THEN NULL`, which swallows a failed install silently, and `server/db/index.js:173-225` swallows `42710`/`42P16`, so each new constraint needs a post-apply assertion in the `CRITICAL_INDEXES` style.

- `client_tags` (client_id, tag, set_by, set_at) with the fixed tag enum, or an equivalent array column. One row per human-set tag; derived states are never stored.
- `clients`: `marketing_excluded`, `marketing_excluded_reason`, `marketing_excluded_at`, `marketing_excluded_by`.
- `email_sends`: add `client_id`, relax `lead_id` to nullable in **both** the `CREATE TABLE` at `schema.sql:1601` and a guarded `ALTER`, add the recipient CHECK, set `ON DELETE SET NULL` on both recipient FKs.
- `marketing_moment_overrides` (moment_id, field, value) for edited copy, and `marketing_moment_dismissals` (moment_id, occurrence_key, dismissed_at).
- `GET /api/clients` uses an explicit column allowlist (`clients.js:30-33`) that omits the new columns and needs updating.

No `scheduled_messages` change. The dispatcher path from draft 1 is gone.

## 8. Verified ground truth (do not re-derive)

Queried against prod (`round-tooth-34649976`, branch `br-noisy-frog-ad99sa6l`) and the working tree on 2026-08-11:

- Audience: 49 past clients with a booked proposal (47 mailable), 198 quoted-never-booked (188 mailable, 9 opted out), 254 with no proposal (173 mailable). Sources: thumbtack 288, checkcherry 184, website 12, zola 7, direct 5, calcom 4, referral 1.
- Corporate 2026: 8 booked events, $5,423, against 58 booked and $39,303 overall. Average ticket $678 for both corporate and non-corporate.
- Corporate converts down. Where option sets were sent, the cheapest won every time: Gurnee Hyundai booked $760 with $9,850 and $7,750 archived; Salesforce booked $620 with $2,800 and $1,800 archived. Companies buy their own alcohol and want labor.
- Transactional email, trailing 60 days from `message_log`: 19.4/day average, 37 peak, 4 floor. **A floor, not a measurement**: `message_log` omits staff mail, admin alerts, and every `skipLog` send, all of which consume the same Resend quota. The send-budget display needs a truer denominator or a conservative server-side cap.
- Resend is on the **free tier, 100/day**, shared with all transactional mail. Pro is $20/month and removes the ceiling.
- The retention automation is correct and not due: 10 pending `retention_nudge` rows fire 2027-05-16 through 2027-07-05, 1 `new_year_hello` at 2027-01-02, `six_months_out` has zero rows because almost nothing books more than six months out. Do not "fix" it.
- Verified clean by the fleet: nothing in the repo can flip `marketing_enabled` back to true; the reschedule cascade filters to `entity_type = 'proposal'`; dead-lettering is scoped to staff recipients.
- `legacy_cc_proposals`, 1,230 rows: `package_name`/`service_name`/`source`/`total_cost_cents` all populated, `client_email_normalized` 1,210 (1,154 distinct), `venue_name` 275, `client_id` 197, `estimated_guests` 4, `event_type` 0, `lead_type` 0. Booked 190. Range 2024-12-05 to 2027-12-04. Event type for the entire Check Cherry era does not exist in prod; `package_name` describes the bar package, not the occasion.

## 9. Open items

- **Postal address for the CAN-SPAM footer.** Needs Dallas's decision. Blocks the footer fix.
- **Quota handling on money paths.** `QuotaExceededError` is caught by the money-path callers, but `ensureSideEffects` still flips an invoice `draft` to `sent` before delivery fails, producing an invoice marked sent that nobody received. Pre-existing; this feature makes exhaustion likelier. Separate fix.
- **Sending-domain separation.** `FROM_EMAIL` is `no-reply@drbartender.com` (`email.js:10`), so bulk mail and invoices share a root domain with no `mail.` subdomain split. `sendEmail` has no `headers` passthrough, so `List-Unsubscribe` / `List-Unsubscribe-Post` cannot be added without changing it. Sequence the 184 never-opted-in Check Cherry addresses last and in small batches, after the warm 49.
- **Scheduled sends.** Out of scope; "Goes out at once. No scheduling yet." is in the design's own copy.
- **Recurring and triggered campaigns**, and extending `retention_nudge` to the Check Cherry cohort.
- **The ~970 Check Cherry dead-quote addresses**, ruled archive-only at import and still out.
- **Check Cherry event types** from the 2026-07-06 exports.
- **A corporate landing page.** None exists under `client/src/pages/website/`; corporate traffic routes to the generic quote wizard. Dallas's call 2026-08-11: acceptable for now.
- **Documentation.** Per CLAUDE.md's table: new columns and tables in ARCHITECTURE.md's schema section, new routes in its route table, new util and route files plus the new pages and components in README.md's folder tree, and the feature itself in README's Key Features.

## 10. Visual contract (added 2026-08-14)

Added after the phases shipped: the original revision carried the design only as the header citation above, no lane owned the visual system, and the section reached prod styled on the legacy stylesheet (the shell literally reused the old dashboard's `em-*` classes). This section is the missing contract. It governs the restyle and every future edit to `/marketing`.

**Benchmark.** `docs/design-artifacts/2026-08-11-marketing-redesign.dc.html`, verified byte-identical to the design project's current `Marketing - Redesign.dc.html` via a DesignSync pull on 2026-08-14 (project `c41f6ef1-f03b-4a0e-84b9-de533b8af077`). Per the "Design artifacts are contracts" convention, the working input is the DesignSync pull, not the snapshot alone: the design system's own CSS was pulled the same day and vendored beside the artifact under `docs/design-artifacts/_ds/`, so the artifact renders locally and the builder reads real DS rules (tokens, chips, drawer, queue, seg) instead of re-deriving them. The project's `Marketing - Today.dc.html` is a recreation of the OLD surface for before/after comparison: never build from it.

**Foundation.** The surface is built on the Admin OS layer that already exists in `index.css`, the same way HiringDashboard is: a `page` wrapper under `data-app="admin-os"`, both skins (After Hours dark, House Lights light). No new token systems. All styling uses the DS tokens (`--bg-*`, `--ink-*`, `--line-*`, `--accent`, hue vars, `--font-ui`/`--font-mono`) and the DS component classes already in `index.css`: `page-header`/`page-title`/`page-subtitle`/`page-actions`, `seg`, `card`/`card-head`/`card-body`/`k`, `tbl`/`tbl-wrap`/`num`/`shrink`, `queue-item`/`queue-icon`/`queue-title`/`queue-sub`/`queue-meta`, `chip` (with its hue kinds), `tag`, `input-group`, `hstack`/`spacer`/`muted`, `btn` variants, `drawer`/`drawer-scrim`/`drawer-head`/`drawer-body`, `section-title`, `stat-label`/`stat-value`/`stat-sub`.

Rules the review fleet added, each one a verified codebase fact:
- **Light skin is NOT free for hues.** The app defines the semantic hue vars once on `html[data-app="admin-os"]` and the House Lights blocks recolor per component with the `--ms-*` jewel tokens instead of flipping the vars. Every new marketing rule that uses a hue therefore ships with an explicit `[data-skin="light"]` companion, following the existing `.queue-icon`/`.chip` light-block pattern. The DS light hue values live in the vendored `_ds/tokens/colors.css` when a companion needs one the `--ms-*` set lacks (violet: `#4a2a5a`, matching the IN-APP light `.chip.violet`; the vendored DS carries an older `#5a3a6a`, and the app value wins).
- **All new marketing CSS is scoped `html[data-app="admin-os"]`**, like every DS rule. Unscoped globals are how the legacy tokens leaked into this surface in the first place.
- **The `em-dashboard` wrapper leaving this surface does nothing by itself.** The operative dark-skin token remap is the root block (`html[data-app="admin-os"][data-skin="dark"]` around `index.css:10832`); the de-legacying lever is converting or deleting the `mkt-*` rules themselves. Conversion order matters: components move onto DS classes BEFORE the wrapper and old rules go, so no intermediate state renders near-black-on-near-black.
- **`em-*` classes survive untouched.** `em-dashboard`/`em-header`/`em-tabs`/`em-tab`/`em-tab-active` and the rest of the `em-*` family are shared with the still-live `/email-marketing` surface. Delete only `mkt-*` rules, only after verifying zero consumers outside `client/src/pages/admin/marketing/`, and keep `.em-retired-send` (it sits inside the `mkt-*` block range at `index.css:19911` but is consumed by `EmailCampaignDetail.js`).
- **No `--em-*`, `swatch`, `em-select`, or `email-canvas` CSS in the restyle.** Those belong to the email canvas and Look panel, which are deferred feature work (see the Known functional gap below). They ship with that lane, scoped and named to avoid the legacy `em-*` grep-space.

**The governing rule, from the risk review: shipped machinery survives.** The artifact is a static mock that never had to hold pagination, cross-page selection, moment editing, a resume banner, or a send confirmation. Wherever the artifact omits shipped behavior, the behavior wins and receives the artifact's styling; matching the artifact by deleting working controls is the failure mode, not fidelity. The per-screen bullets below already fold the shipped machinery in; anything found later follows the same rule.

**Per-screen composition, artifact reconciled with the shipped build:**
- **Shell.** `page-header` with title "Marketing", a live subtitle ("Tuesday, August 14 · 3 moments open · 66 sends left today", from the layout's overview fetch, using the server's `today` and `open_moment_count`; on load or error it degrades to the bare title), and `page-actions` holding "Audiences" (secondary, routes to the tab) and "New send" (primary, routes to Compose). Below it one `hstack` row: the `seg` tab control and a `spacer` and the "Today's send budget" meter (uppercase label, 110px bar, mono text). The tabs stay NavLinks: `index.css` gains `.seg a` companions to the existing `.seg button` rules so anchor semantics and `aria-current` survive. The first tab keeps the label "Overview" (spec section 2 wins over the artifact's "This month"). The meter bar encodes used over cap, clamped at full; the mono text reads remaining ("66 / 100 left"); while the fetch is in flight or failed the meter is simply absent.
- **Fetch ownership.** `MarketingLayout` owns the single `GET /marketing/overview` and shares `{data, error, refresh, update}` through Outlet context. `OverviewTab` drops its own fetch and consumes the context; its moment edit and dismiss handlers write through the context setter so the subtitle and meter never go stale. Compose's budget bar reads the same context. This is the ONE accepted read-path change (the fetch now also runs on the Audiences, Compose, and Sent tabs); no mutating request or handler changes anywhere. The layout never gates rendering on the fetch: tabs render immediately, chrome that needs the data appears when it arrives, and a failed fetch shows the Overview tab's existing error-with-retry state while other tabs simply lack the meter.
- **Overview.** Two-column grid, `minmax(0,1fr) 340px`, collapsing to one column at 900px. Left: "Moments open now" (section-title plus the muted aside "Occasions repeat. Get ahead of them."), moment cards as zero-padding `card`s with a three-column grid: 4px hue spine, body (uppercase window eyebrow, 15px title, 12.5px why-prose capped at 52ch), and a bordered right rail (22px mono count over an "emailable" eyebrow, "Review recipients" secondary button). The shipped controls stay on the card, styled down: "Edit wording" and "Not this time" as small secondary buttons in the body footer, the inline three-field editor as the card's editing state, the "Wording edited:" line and the over-cap warning as `muted`/warn lines, and the shipped empty state when no moments are open. The artifact's audience `tag` on the card is dropped: moments carry only `audience_id` and labeling it would need a new fetch. Then "The year, honestly": one card, three stat blocks (`stat-label`/`stat-value`/`stat-sub` treatment; the sub lines render only facts the payload already carries, else are omitted). Right rail: "Needs you" card of `queue-item` rows (warn/danger/info icons, counts as `queue-meta`; rows render the shipped counts, not the artifact's named people), "Reachable base" card (rows of label, mono count, 5px hue bar, with explicit light-skin colors), "Runs without you" card keeping the SHIPPED copy and the server-fed automations list (the artifact's "fire from Settings → Automations" line is factually wrong and stays out).
- **Audiences.** Grid `288px minmax(0,1fr)`, collapsing at 900px. Left: zero-padding card listing "Everyone" plus the resolver audiences as `queue-item`s (name, rule subtitle, mono emailable count), selection shown by background plus accent stripe. Right: selected-audience card (`card-head` with the rule as `k` and a small primary "Use this audience" that routes to `/marketing/compose?audience=<id>`), card body laying out Include chips, a vertical rule, the held-back counts, a spacer, and the large mono emailable count. For "Everyone" the card renders name, the subtitle "The whole contact base", and the counts from the loaded view. The held-back region is the shipped `HeldBackPanel` restyled in place: all four buckets including `no_address`, the "N in this view" total, and the bucket-mismatch warning survive. Below: the search `input-group` with the muted tag-edit hint, the quick-filter `seg` with counts in the labels (labels render without counts until loaded, as today), and the contact `tbl` with the SHIPPED six-column set (stacked name over email, tag cells, last event, `num` lifetime, last contacted, and the do-not-contact control; row click opens the drawer, control clicks do not). The pager survives below the table, restyled.
- **Compose.** Step `seg` (Design, Recipients with the live selection count in its label, so the count stays visible while writing; this deliberately overrules the "three sections, not a wizard" comment in `ComposeTab.js`, whose stated reason the seg count satisfies) plus the muted draft-status line and a `spacer`. No Desktop / Mobile / Send test buttons: no route backs them (see the Known functional gap). The resume banner keeps its place above the steps, restyled as an accent `queue-item` row with its "Start fresh instead" action. Design step interim, until the canvas lane ships: a single centered column on the `bg-0` well holding the subject input, the HTML body textarea, the Save draft and Preview actions, and a primary "Continue to recipients"; the preview modal keeps its iframe and sandbox exactly and wears the DS drawer treatment. Recipients step: `minmax(0,1fr) 340px` grid. Left: the shipped picker in full, restyled: audience `select`, search, "Select all matching" with its cap notice, "Clear (N)", the checkbox rows (the artifact's per-row Remove model is NOT adopted; the checkbox model is the shipped selection behavior), and the pager. Right: the "Before you send" card: mono recipient count, the daily-budget bar (single stack from real data: campaign sends used today plus this send's selection against the cap; the artifact's transactional split has no data source and is out), the two-stage send confirm exactly as shipped (Send campaign, then the named confirmation with "Not yet" / "Send it" as the danger action), the send-result panel with its quota-stop copy, and the closing line "Goes out at once. No scheduling yet."
- **Sent.** The sends `tbl` with the SHIPPED column set styled to the artifact's treatment: stacked name over subject, sent date, status chip, `num` To / Opened / Clicked / Booked. No Audience column and no Replied count: neither exists in the data (`/marketing/sent` returns `clicked`; no audience is persisted per send). Below, the booked-definition caption survives as `muted`. Then the "Also reaching your contacts" card of automation `queue-item`s with the trigger as `queue-sub` and the 30-day counts as `queue-meta`.
- **Contact drawer.** The DS drawer CLASSES (`drawer-scrim`/`drawer`/`drawer-head`/`drawer-body` with the `.open` state toggled after mount so the slide-in actually plays), not the `adminos/Drawer.js` component. The shipped Escape handler, backdrop click, `role="dialog"`, `aria-modal`, and `aria-label` all survive.
- **Tags.** Marketing tag chips ride the DS `chip` class with its existing hue kinds, which carry light-skin overrides: Corporate `chip violet`, Wedding `chip info`, Birthday `chip warn`, Do not contact `chip danger`, Thumbtack `chip accent`, Paid client `chip ok`, Quoted only and Graduation `chip neutral`. Derived states (Untagged, held-back reasons) render as one new marketing addition, a dashed-border neutral chip variant, with a light companion. The moment card's window chip and the audience label chips on recipients stay `tag`/`chip neutral`.
- **States.** The `mkt-state` / `mkt-state-error` class names stay in the JSX with their `role`/`aria-live` attributes intact; their RULES are rewritten onto DS tokens in the new block (spinner, retry button as `btn btn-secondary`). Every shipped loading, empty, and error state survives, including `ContactTable`'s two distinct empty copies.

**Settled deviations, artifact vs approved IA.** The spec's four tabs win over the artifact's five: Contacts folds into Audiences as built, and its quick-filter `seg` and table treatment move there. The artifact's "+ New audience" button is omitted: audiences are fixed resolver outputs. The artifact's two Compose steps win over the spec's three: the Send step's content becomes the "Before you send" rail on Recipients, with zero endpoint or guard changes.

**Known functional gap, recorded 2026-08-14, widened after the fleet review.** The artifact's Design step depicts section 5.1's composer: the block palette, the email canvas, and the Look panel. The Compose that shipped has none of it, it is a plain subject plus HTML-body form, so 5.1 was under-delivered functionally as well as visually. The fleet found two more artifact elements with no code behind them: **Send test** (5.1 requires "Send test to me"; no test-send route exists on this surface, only the legacy designer's) and the **Desktop / Mobile** preview toggles. All of it is feature work owned by the deferred `mkt-compose-canvas` lane in the 2026-08-14 restyle plan, unscheduled until Dallas says go, along with the email canvas `--em-*` token block, the four theme presets, the accent and font lists, and the `swatch`/`em-select` CSS. The restyle applies the artifact's frame to the form that exists. The building blocks are real: `client/src/components/emailBuilder/` client-side (consumed today by `EmailCampaignCreate.js` and `EmailCampaignDetail.js`), `emailDesign.js` and `emailBlockRenderer.js` server-side.

**Definition of done, made checkable.** (1) No mutating request, endpoint, guard, or handler changes anywhere; the one accepted read-path change is the layout-owned overview fetch. (2) The non-JSX logic of `ComposeTab.js`, `RecipientPicker.js`, `TagCell.js`, `DoNotContactControl.js`, and `ContactTable.js` diffs clean: state shape, effects, handlers, guards, and the localStorage resume machinery byte-for-byte where possible, and reviewed line-by-line where JSX restructuring forces movement. (3) Both skins verified by an actual browser pass over all four tabs plus the drawer and the send confirm, dark and light, at 1280 and 900 and 375 wide. (4) `ui-ux-review` runs with the artifact as its benchmark per the agent's design-artifact adherence check, on the managed dev server after merge and before any push (the dev server serves main and the lane cannot bind its ports; this ordering is deliberate). (5) Every shipped loading, empty, and error state and every ARIA role present before the restyle is present after it.
