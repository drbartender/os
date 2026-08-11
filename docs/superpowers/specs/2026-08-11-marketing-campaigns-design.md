# Marketing Campaigns (Hand-Picked Recipients, Designed Emails)

**Date:** 2026-08-11
**Status:** Approved (section-by-section, 2026-08-11 brainstorm). **Rewritten same day** after the design-stage fleet returned 9 blockers against the first draft: Dallas cut scope to manual, non-recurring sends, which removes the dispatcher architecture that generated most of them. The compliance and file-size findings survive the cut and are folded in below.

## 1. Problem

Dallas wants to solicit repeat business, corporate first, by sending designed emails to hand-picked past clients and cold leads. He is fine with the email marketing section as it exists. He wants to choose the contacts for each campaign and send.

Two facts make this necessary rather than cosmetic.

**The blast tool is pointed at an empty table.** `server/routes/emailMarketing.js` has campaigns, a block builder, analytics, unsubscribe, and a Resend webhook. Its audience is hardcoded at `emailMarketing.js:457` to `SELECT id, email, name FROM email_leads WHERE status = 'active'`. `email_leads` holds 15 rows, of which 9 already exist as clients, 2 are internal test accounts, 1 is `test@drbartender.com`, and 1 is a typo'd dead address, leaving 4 real people. Lifetime sends through this engine: 1.

**The real audience is in `clients` and cannot be reached.** 49 clients with a booked proposal, 184 imported from Check Cherry (all mailable, all `marketing_enabled: true`), 198 who quoted and never booked. Roughly 233 people have paid Dr. Bartender and roughly 188 asked and walked. Nobody has ever asked any of them for a second event: of every client on a company email domain with a booked proposal, exactly one has more than one event date, and those two dates are consecutive.

**The picker pattern already exists but is wired to the wrong things.** `EmailCampaignDetail.js:41` sends a blast with no request body, so it fires at the whole targeted lead set with no selection. A contact picker sits at `:108`, wired to `/enroll` for sequences, over `email_leads`.

## 2. Scope

**Manual, non-recurring sends only.** Dallas picks the recipients for each campaign and presses send. No automation, no recurrence, no scheduling, no saved audiences.

**Explicitly not built:** the scheduled-message dispatcher path, saved segment definitions, daily send budgets, multi-day deferral, recurring or triggered campaigns, extending `retention_nudge` to the Check Cherry cohort, the ~970 Check Cherry dead-quote addresses, recovering Check Cherry event types, A/B testing, SMS, email visual design (Dallas is taking that to claude.ai/design), and a corporate landing page (decided: corporate traffic routes to the existing quote wizard).

The `email_leads` sequence engine stays untouched and still paused. Its legacy all-leads send path is addressed in section 6.

## 3. Suppression: two independent gates

**Gate 1, the client's own voice, exists and does not change.** `communication_preferences.marketing_enabled` is flipped false by the unsubscribe route (`emailMarketing.js:955-966`, already correct for the `{clientId, marketing}` token shape) and honored by `scheduledMessageDispatcher.js:514` and `channelFallback.js:48`. Nothing in this feature may set it back to true. Verified during review: no code path in the repo currently can. Keep it that way, with a regression test.

**Gate 2, the house rule, is new.** `clients.marketing_excluded BOOLEAN NOT NULL DEFAULT false`, plus `marketing_excluded_reason TEXT`, `marketing_excluded_at TIMESTAMPTZ`, `marketing_excluded_by INTEGER REFERENCES users(id)`. Reason is required when setting, enforced server-side. **Marketing only** (Dallas's explicit decision): an excluded client who books still receives proposals, invoices, and every operational message.

Gate 2 needs a dedicated endpoint. `PUT /api/clients/:id` (`clients.js:121-150`) destructures a fixed 5-field body and updates via `COALESCE($n, col)`, where null means "leave unchanged", so it structurally cannot clear the flag or null the reason. Write `marketing_excluded_by = req.user.id` and log to `admin_audit_log`.

**A third check, added by the fleet:** the mailability test must also honor `communication_preferences.email_enabled`, not only `marketing_enabled`. The first draft omitted it.

**Because sends are one-shot, there is no enqueue-versus-delivery gap.** Both gates and the deliverability checks are evaluated once, at send time, against the live rows. This is the main thing the scope cut bought.

**Not built: temporary event-scoped suppression.** The one historical instance was Luva Dorris (client 1651), a Check Cherry event transferred in on 2026-07-14 for an event on 2026-07-18, where Dallas killed automated comms so os would not duplicate messaging she had already received in Check Cherry. He retired it himself on 2026-08-06: "her event is over, none of this matters. If she does another event we'll want to send her all the things." Her row correctly reads all channels enabled. She is a target, not an exclusion.

## 4. The recipient picker

One screen, three parts, and a basket.

**Filters** narrow the candidate list: booked versus quoted-never-booked, months since last event, lifetime spend, `clients.source`, and a corporate flag. The corporate flag is an email-domain proxy, verified against real bookings (salesforce.com, mizkan.com, arthrex-chicago.com, omgorange.com, ima.global, wi-tronix.com, marxadvisory.com, sandowdesign.com, hoodieanalytics.com, harriscollect.com, esmproducts.com, lmhexperiences.com, rsbarcelona.com). `clients` has no company column; any address not on a consumer mail provider counts as corporate.

**A search box** finds any contact by name or email regardless of the active filter, so anyone can be added without first constructing a filter that reaches them.

**The basket is independent of the filter view.** Selections persist across filter changes, clears, and searches. Filter to corporate, check eight, clear the filter, search a name, add them, and the original eight remain. The basket shows a running count with a remove per row, and the basket is what sends. If a filter reset wiped selections the feature would be useless; this is the load-bearing behavior.

**Select-all-matching** applies to the current filtered set and adds to the basket rather than replacing it.

**Suppressed people never appear.** Anyone unsubscribed, `marketing_excluded`, `email_enabled: false`, missing an email, or with `email_status = 'bad'` is absent from both the filtered list and the search results. There is no path where a person who should not be emailed can be checked.

**Rows show why they qualified**: booked or quoted, months since last event, lifetime spend, corporate flag. This is derived data the resolver returns alongside membership, not a separate query.

**Data notes for the filters.** Check Cherry history comes from `legacy_cc_proposals`, joined on `lower(clients.email) = legacy_cc_proposals.client_email_normalized`, **not** on `client_id`, which is populated on only 197 of its 1,230 rows. Do not parse the `clients.notes` blurb. Event type is deliberately absent from the filter set: `legacy_cc_proposals.event_type` is NULL on all 1,230 rows and `package_name` / `service_name` describe the bar package, not the occasion, so an event-type filter would silently exclude the entire Check Cherry cohort. Normalize event-type casing anywhere `proposals.event_type` is read, since the import left both `corporate-event` and `Corporate Event`. Dedupe by lowercased email, since the same person can hold more than one client row (Ali Smith appears twice).

**Empty, loading, and error states** are required on the picker: a filter matching nobody, a search returning nothing, an in-flight resolve, and a failed resolve with a retry.

## 5. The send

`POST /email-marketing/campaigns/:id/send` accepts `client_ids` and sends the campaign's designed body to exactly those clients. The composer is unchanged: the block builder under `client/src/components/emailBuilder/`, plus the **server-side** `emailDesign.js` and `emailBlockRenderer.js`. Nothing here changes how an email looks.

**Sends are paced, not concurrent.** The current `sendBlastEmails` (`emailMarketing.js:508`) fires 100 Resend calls at once via `Promise.all`. Even a 40-person list would trip Resend's rate limit. Replace with a serial loop and a small inter-send delay.

**Quota behavior is not what the first draft claimed.** `email.js:81-86` already detects Resend quota rejection and throws `QuotaExceededError`; it does not fail silently. But only the dispatcher and `adminNotifications.js` handle it, so every direct `sendEmail` on a money path takes an unhandled throw to a 500. Consequences for this feature: the picker displays the selected count against the 100/day free-tier ceiling and warns above a threshold, and the send loop catches `QuotaExceededError`, stops, and reports how many were sent and who remains, rather than continuing to hammer an exhausted quota. Widening quota handling on the money paths is a real problem but a separate one, recorded in section 9.

**Per-recipient unsubscribe** uses the `{clientId, marketing: true}` JWT already built in `marketingHandlers.js:51-62`, signed with `UNSUBSCRIBE_SECRET || JWT_SECRET`, 365-day expiry. The unsubscribe route already branches correctly on this shape. Add a `typ` claim so payload shape is not the only thing separating token families.

**Recording.** `email_sends` gains `client_id INTEGER REFERENCES clients(id)`, and `lead_id` (currently `NOT NULL`) is relaxed to nullable with a CHECK that exactly one of the two is set, mirroring how `message_log.client_id` was relaxed at `schema.sql:3564-3580`. A campaign then shows its own send history: who received it, when, and delivery status from the existing Resend webhook.

**Not written to `message_log`.** `message_log.proposal_id` is `INTEGER NOT NULL` (`schema.sql:3542`) and `logClientMessage` returns early without one (`messageLog.js:88`), so the 254 proposal-less clients and the Check Cherry cohort would log nothing, while clients who do have proposals would have the blast silently filed against an unrelated recent event. `email_sends` is the record for campaigns. A client-keyed comms view that surfaces campaign history on the client record is worth doing later and is recorded in section 9.

**Auth.** Every route in `emailMarketing.js` uses `requireAdminOrManager`. Send and the exclusion endpoints must be **admin only**, named explicitly, so a manager cannot blast the client list or clear house-rule exclusions.

## 6. Compliance and correctness fixes that survive the scope cut

These were fleet blockers against the first draft and are not made moot by manual sending.

**Postal address in the footer.** `wrapMarketingEmail` (`emailTemplates.js:439-462`) renders only `Dr. Bartender &middot; drbartender.com` plus the unsubscribe link. CAN-SPAM requires a valid physical postal address in every commercial message. One line in the footer. **Dallas must supply the address to use** (see section 9).

**Unsubscribe must not be a bare GET.** `emailMarketing.js:940` flips the preference on GET with no confirmation, and the flip is deliberately irreversible. The audience for this feature is corporate work addresses, and corporate link scanners (Defender Safe Links, Proofpoint, Mimecast) prefetch inbound links, so a scanner can permanently destroy a client's marketing channel with no human involvement. Change to a confirmation page that renders on GET and performs the flip on POST, per RFC 8058. The existing `{leadId}` branch gets the same treatment.

**Retire the legacy all-leads send path.** `POST /campaigns/:id/send` with no body currently blasts every active lead. Once the route takes `client_ids`, an empty body must be rejected rather than falling back to the old behavior, or a stray click sends to whatever `email_leads` happens to contain.

**Test send.** The existing test path stamps `token=preview` into the unsubscribe URL, which 400s on click. Either mint a real token for the test recipient or render the footer link as visibly inert; do not ship a preview that misrepresents the real email.

## 7. Schema changes

All idempotent (`ADD COLUMN IF NOT EXISTS`), all in `schema.sql`, which replays on every boot.

- `clients`: `marketing_excluded`, `marketing_excluded_reason`, `marketing_excluded_at`, `marketing_excluded_by`. Default false, no backfill needed.
- `email_sends`: add `client_id`, relax `lead_id` to nullable, add a CHECK that exactly one recipient key is set.

No change to `scheduled_messages` at all. The first draft's entity-type CHECK amendment is gone with the dispatcher path, and with it the `lookupEntity` and `VALID_ENTITY_TYPES` gaps the fleet found.

## 8. File-size discipline

`server/routes/emailMarketing.js` is **987 lines** against the 1000-line hard cap. `scripts/check-file-size.js` blocks any staged commit that pushes an over-cap file longer. This feature adds a recipient-resolve endpoint, a revised send, and the exclusion endpoints, so something must come out first.

The natural extraction is the lead and sequence surface, which this feature does not touch: the `/leads` CRUD and import, and the sequence `/enroll`, `/enrollments`, `/activate`, `/pause` handlers. Moving those to sibling files behind the existing composition router follows the `server/routes/proposals/` precedent and leaves the campaign surface in the original file. Do the extraction as its own commit, verified behavior-inert, before any feature code lands.

## 9. Verified ground truth (do not re-derive)

Queried against prod (`round-tooth-34649976`, branch `br-noisy-frog-ad99sa6l`) and the working tree on 2026-08-11:

- Audience: 49 past clients with a booked proposal (47 mailable), 198 quoted-never-booked (188 mailable, 9 opted out), 254 with no proposal (173 mailable). By source: thumbtack 288, checkcherry 184, website 12, zola 7, direct 5, calcom 4, referral 1.
- Corporate 2026: 8 booked events, $5,423, against 58 booked and $39,303 overall. Average ticket $678 for both corporate and non-corporate, so corporate is not currently a premium segment.
- Corporate converts down. Where option sets were sent, the cheapest won every time: Gurnee Hyundai booked $760 with $9,850 and $7,750 archived; Salesforce booked $620 with $2,800 and $1,800 archived. Companies buy their own alcohol and want labor.
- Transactional email volume, trailing 60 days from `message_log`: 19.4/day average, 37 peak, 4 floor. **Treat as a floor, not a measurement.** `message_log` omits staff mail, admin alerts, and every `skipLog` send, all of which consume the same Resend quota.
- `email_sends`: `campaign_id` and `sequence_step_id` nullable, `lead_id` NOT NULL.
- The retention automation is correct and not due: 10 pending `retention_nudge` rows fire 2027-05-16 through 2027-07-05, 1 `new_year_hello` at 2027-01-02, `six_months_out` has zero rows because almost nothing books more than six months out. Do not "fix" it.
- Verified clean by the fleet: nothing in the repo can flip `marketing_enabled` back to true; the reschedule cascade filters to `entity_type = 'proposal'`; dead-lettering is scoped to staff recipients.
- `legacy_cc_proposals` population out of 1,230 rows: `package_name`/`service_name`/`source`/`total_cost_cents` 1230, `client_email_normalized` 1210 (1,154 distinct), `venue_name` 275, `client_id` 197, `estimated_guests` 4, `event_type` 0, `lead_type` 0. Booked 190. Range 2024-12-05 to 2027-12-04.

## 10. Open items

- **Postal address for the CAN-SPAM footer.** Needs Dallas's decision on which address to publish. Blocks section 6.
- **Quota handling on money paths.** `QuotaExceededError` is unhandled by every direct `sendEmail` in `proposals/crud.js`, `proposals/actions.js`, `invoices`, `agreement`, and `publicToken`, each of which becomes a 500 on an exhausted quota. Pre-existing, not caused by this feature, but this feature makes exhaustion more likely. Separate fix.
- **Sending-domain separation.** `FROM_EMAIL` is `no-reply@drbartender.com` (`email.js:10`), so bulk mail and invoices share a root domain with no `mail.` subdomain split, and a complaint spike degrades invoice deliverability. `sendEmail` also has no `headers` passthrough, so `List-Unsubscribe` / `List-Unsubscribe-Post` cannot be added without changing it.
- **Client-keyed campaign history.** Surfacing campaign sends on the client record, since `email_sends` is campaign-keyed and `message_log` cannot hold these rows.
- **Resend Pro.** $20/month removes the 100/day ceiling entirely. Not required for hand-picked sends of a few dozen; recorded because the ceiling is shared with invoices.
- **Documentation.** Per CLAUDE.md's Mandatory Documentation Updates table: new `clients` and `email_sends` columns go in ARCHITECTURE.md's schema section, new routes in its route table, and any new util or route files in README.md's folder tree.
- **Deferred from the cut:** recurring campaigns, saved segments, scheduled sends, extending `retention_nudge` to the Check Cherry cohort, the ~970 Check Cherry dead-quote addresses, Check Cherry event types from the 2026-07-06 exports, and a corporate landing page.
