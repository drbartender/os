# Marketing Campaigns (Manual Sends to Real Clients)

**Date:** 2026-08-11
**Status:** Approved (section-by-section, 2026-08-11 brainstorm)

## 1. Problem

Dallas wants to solicit repeat business: campaigns to past clients and to cold leads who quoted and walked, timed to get ahead of recurring occasions (holiday parties, birthdays). The trigger was corporate specifically, but the ask widened to all past clients during the brainstorm.

The system already contains a complete campaign tool and a complete retention-automation layer. Neither one can do this today, for different reasons.

**The retention automation is not broken, it is not due.** `marketingHandlers.js` registers `retention_nudge` (event date + 11 months), `new_year_hello` (Jan 2 of the event year), and `six_months_out` (event date - 6 months), all gated on `communication_preferences.marketing_enabled`, all with working unsubscribe. Prod holds 10 pending `retention_nudge` rows with `scheduled_for` between 2027-05-16 and 2027-07-05, and 1 pending `new_year_hello` at 2027-01-02. Zero have sent because none are due. `six_months_out` has zero rows because it requires booking lead time strictly greater than six months and almost nothing books that far out. This layer covers ten people and does nothing for another nine months. It is not the answer.

**The campaign tool is pointed at an empty table.** `server/routes/emailMarketing.js` has campaigns, sequences, a block builder, analytics, an unsubscribe route, and a Resend webhook. Its audience query is hardcoded at `emailMarketing.js:457`:

```sql
SELECT id, email, name FROM email_leads WHERE status = 'active'
```

`email_leads` holds 15 rows. Lifetime sends through this engine: 1. The two campaigns that exist are "Abandoned Quote Followup" (sequence, paused since 2026-04-10) and "Summer Cocktails" (blast, still draft).

**The actual audience lives in `clients` and is invisible to that tool.** 49 clients with a booked proposal, 184 imported from Check Cherry (every one mailable, every one `marketing_enabled: true`), 198 who quoted and never booked (188 mailable, 9 opted out). Roughly 233 people have paid Dr. Bartender and roughly 188 asked and walked.

**And nobody has ever asked a past client for a second event.** Of every client on a company email domain with a booked proposal, exactly one has more than one event date: Jesse Burns at hoodieanalytics.com, on 2026-06-16 and 2026-06-17, which is one engagement across two days. There are no corporate repeat bookings at all.

## 2. Goals and non-goals

**Goal:** Dallas composes a campaign, picks a saved segment, sees exactly who is on the list, drops anyone he wants, and sends. Sending is durable, throttled, never starves transactional mail, and is measurable against bookings.

**Explicitly manual.** Automation comes only after several manual sends have been watched end to end. Dallas's reasoning: he must be able to exclude people he does not have a good relationship with, and he wants to see the first couple hundred emails leave his domain before anything sends on its own.

**Non-goals for this spec:** automated or recurring campaigns; extending `retention_nudge` to the Check Cherry cohort; the ~970 Check Cherry dead-quote addresses; recovering Check Cherry event types from the 2026-07-06 exports; A/B testing and open-rate tooling; SMS (costs money, wrong channel, see `feedback_notification_cost`); email visual design (Dallas is taking that to claude.ai/design); a corporate landing page (decided: corporate traffic routes to the existing quote wizard for now); the `email_leads` sequence engine, which stays untouched and still paused.

## 3. Suppression: two independent gates that never touch each other

**Gate 1, the client's own voice, already exists and does not change.** `communication_preferences.marketing_enabled` is flipped by the unsubscribe link and honored by `scheduledMessageDispatcher.js:514` and `channelFallback.js:48`. It stays writable only by the client's own unsubscribe action. No admin UI may flip it back to true. Un-unsubscribing someone is the one move in this system that is actually illegal.

**Gate 2, the house rule, is new.** `clients.marketing_excluded BOOLEAN NOT NULL DEFAULT false`, plus `marketing_excluded_reason TEXT`, `marketing_excluded_at TIMESTAMPTZ`, `marketing_excluded_by INTEGER REFERENCES users(id)`. Admin sets and clears it. The reason is required when setting. It means "we do not solicit this person."

**Scope of gate 2 is marketing only** (Dallas's explicit decision). An excluded client who somehow books still receives proposals, invoices, payment reminders, and every other operational message. Only `category: 'marketing'` sends are blocked.

**Not built: temporary, event-scoped suppression.** The one historical instance was Luva Dorris (client 1651), a Check Cherry event transferred into os on 2026-07-14 for an event on 2026-07-18, where Dallas killed all automated comms so os would not duplicate messaging she had already received inside Check Cherry. That was a migration artifact, and Dallas retired it himself on 2026-08-06: "her event is over, none of this matters. If she does another event we'll want to send her all the things." Her row correctly reads all three channels enabled. She is a marketing target, not an exclusion. The temporary kind has proven it can be handled by hand; do not build a mechanism for it until something forces one.

**Per-send drops are not suppression.** The review screen (section 6) lets Dallas uncheck anyone for that one send. Drops are not remembered and do not write anything to the client row. Dropping the same person twice is the signal to set the flag.

## 4. Segments

A segment is a **saved, named set of filters**, not a frozen list of people. "Past corporate clients" is re-resolved at send time and means something correct each time.

**One resolver serves every path.** Every campaign, preview, count, and send goes through it, so the two suppression gates and the deliverability checks apply by construction rather than by remembering. A person is mailable only when all of the following hold: `marketing_enabled` is not false, `marketing_excluded` is false, `email` is present and non-empty, and `email_status` is not `'bad'`.

**Recipients come from `clients` only.** `email_leads` is not an audience source. Verified row by row: of its 15 rows, 9 already exist as clients, 2 are internal test accounts (`client@drbartender.com`, `zul@drbartender.com`), 1 is `test@drbartender.com`, 1 is a typo'd dead address (`cmurphy@arthrex-chicago.conm`), leaving 4 real people who are leads and not clients. A second identity store buys four people and costs two unsubscribe token shapes, two suppression surfaces that can disagree, and a dedupe pass on every send.

**Filters available across everyone:** booked versus quoted-never-booked; date of last event; months since last event; lifetime spend; `clients.source`; corporate flag.

**The corporate flag is an email-domain proxy.** `clients` has no company column and will not get one cheaply. The domain is a verified-reliable signal: every real corporate booking used a work address (salesforce.com, mizkan.com, arthrex-chicago.com, omgorange.com, ima.global, wi-tronix.com, marxadvisory.com, sandowdesign.com, hoodieanalytics.com, harriscollect.com, esmproducts.com, lmhexperiences.com, rsbarcelona.com). Any address not on a consumer mail provider counts as corporate. This works identically for both cohorts, which event type does not.

**Check Cherry history comes from the ledger, not from parsing notes.** `legacy_cc_proposals` holds 1,230 CC-era events with real `event_date`, `total_cost_cents`, `package_name`, `service_name`, `source`, and `status`; 175 of its `client_email_normalized` values match a current client. Join on `lower(clients.email) = legacy_cc_proposals.client_email_normalized`, **not** on `client_id`, which is populated on only 197 of the 1,230 rows. Do not regex the `clients.notes` blurb ("Past events: 1 (last 10-2025). Venues: X. Lifetime paid: $Y.") when the ledger has the same facts structurally.

**Event type is the one dimension that does not span both cohorts.** `legacy_cc_proposals.event_type` is NULL on all 1,230 rows, and `package_name` / `service_name` describe the bar package ("The Core Reaction", "Dry Lab Configurations"), not the occasion. Event type for the entire Check Cherry era does not exist in prod. Consequences: an event-type filter silently reduces the audience to the os-native slice (49 booked, 198 quoted), and the UI must say so where the filter is set. Segments should lean on recency and the corporate flag; treat event type as a narrowing extra.

**Normalize event-type casing in the resolver.** The Check Cherry import left prod with both `corporate-event` and `Corporate Event`, and both `wedding-reception` and `Wedding Reception`. A filter matching one casing silently drops a large share of the audience.

**Dedupe by lowercased email** even within `clients`, since the same person can hold more than one client row (Ali Smith appears twice in the Check Cherry import).

## 5. Send architecture: enqueue to the dispatcher, do not send inline

`sendBlastEmails` (`emailMarketing.js:508`) fires 100 Resend calls at once via `Promise.all`, sleeps 600ms, repeats, keeps its progress only in a local loop variable, and is launched with a bare `.catch(console.error)`. At 15 recipients none of that matters. At 233 across several days it fails three ways: the burst trips Resend's rate limit, a Render deploy mid-send kills the blast with no record of who received it, and there is no concept of a daily ceiling.

**A campaign send enqueues one `scheduled_messages` row per recipient. The existing dispatcher delivers them.** That inherits durability across restarts, retries, dead-lettering, per-row status, the marketing-preference gate, and priority, all already in production and already tested. Throttling becomes a scheduling problem instead of a sleep loop.

Rows are shaped `entity_type: 'campaign'`, `entity_id: <campaign_id>`, `recipient_type: 'client'`, `recipient_id: <client_id>`, `channel: 'email'`, `message_type: 'campaign_blast'`.

**Schema change, and it has a landmine.** `'campaign'` must be added to `scheduled_messages_entity_type_check`, currently `CHECK (entity_type IN ('proposal','shift','client','consult'))` at `schema.sql:2653`. It must be edited **into that live definition in place**. Appending a second drop-and-re-add block later in `schema.sql` is what broke the Check Cherry import: schema.sql replays on every boot, and a later block makes the earlier VALIDATE fail forever once rows exist. `recipient_type` needs no change; `'client'` is already allowed.

**New handler** `campaign_blast`, registered via `registerHandler` with `{ category: 'marketing', offsetFromEventDate: null, anchor: 'created_at', priority: 5 }`. `category: 'marketing'` means the unsubscribe gate applies with no new gating code. Priority 5 matches the existing lowest tier (`retention_nudge`, `new_year_hello`, `six_months_out`); operational sends sit at 3 and below, and lower numbers win. The handler loads the campaign, renders `campaign.html_body` through `wrapMarketingEmail` with a per-client unsubscribe URL, and sends.

**The reschedule cascade must not touch these rows, and twice over it cannot.** `anchor` is deliberately `'created_at'` rather than `'event_date'`: the W2 contract in `marketingHandlers.js` routes any type registered `{ anchor: 'event_date', offsetFromEventDate: null }` to a per-type recompute helper, and a campaign has no event date to recompute against. Independently, the cascade is driven by proposal date edits and selects on proposal entities, so `entity_type: 'campaign'` rows are never in its result set.

**Unsubscribe token shape is the client one that already exists**: `jwt.sign({ clientId, marketing: true }, UNSUBSCRIBE_SECRET || JWT_SECRET, { expiresIn: '365d' })`, as built in `marketingHandlers.js:51-62`. The unsubscribe route already branches on token shape and flips `marketing_enabled`. The `{leadId}` shape at `emailMarketing.js:516` stays for the legacy lead path and is not used here.

**The natural key gives idempotency for free.** `scheduled_messages` upserts on `(entity_id, entity_type, message_type, recipient_id, recipient_type, channel)`, so re-running a campaign send cannot double-send to anyone who already has a row.

**Campaign emails are logged to the client record.** Unlike lead blasts, which pass `meta: { skipLog: true }` at `emailMarketing.js:528`, campaign sends write a `message_log` entry tagged as campaign so the comms views can collapse them. Emailing a client and leaving their record blank is how you end up on the phone with someone with no idea what they received.

## 6. Compose, review, send

The composer is reused as-is: the block builder under `client/src/components/emailBuilder/`, `emailDesign.js`, `emailBlockRenderer.js`, and the existing campaign editor. Nothing in this spec changes how an email looks. Dallas is taking visual design to claude.ai/design separately.

Before anything enqueues, the send screen shows the **resolved recipient list**: name, email, why they qualified (booked / quoted, months since last event, corporate flag), with a checkbox per person. Unchecking drops that person from this send only. The screen also states the resolved count, the daily budget, and the resulting number of days the send will take.

A **test send to Dallas's own address** renders the campaign exactly as a recipient would receive it, including the unsubscribe footer. It does not consume the campaign's enqueue and does not write `message_log` entries against a client.

## 7. Throttle: marketing always yields to the money path

Resend is on the **free tier, 100 emails per day**, and that ceiling is shared with every proposal, invoice, balance reminder, review request, and drip touch.

Measured transactional volume over the trailing 60 days: **19.4 emails/day average, 37 peak, 4 floor.** Recent daily counts: 22, 9, 21, 17, 18, 27, 12, 20, 19, 25.

On a 37-email day a marketing batch of 70 does not get throttled, it eats the ceiling and transactional mail starts failing. It fails silently: the Resend SDK returns `{data: null, error}` rather than throwing (see `reference-resend-never-throws`), so a quota rejection lands in code that assumed success. That is the failure mode where a client never receives an invoice and nothing looks broken.

Three rules, in priority order:

1. **A fixed daily marketing budget, default 40, configurable.** Leaves 60 for transactional against a historical peak of 37.
2. **A preflight count immediately before each batch.** If today's `message_log` email count plus the pending batch size would exceed **85**, the batch defers to tomorrow rather than partially sending into the wall. The 15-email gap below the cap is deliberate headroom for transactional mail generated later the same day. Deferral is a status the dispatcher already understands, so nobody is skipped, they are moved.
3. **Marketing rows carry lower dispatcher priority than every operational message type**, so if the two contend inside one tick, the invoice wins.

Accepted consequence, confirmed by Dallas: a 233-person past-client campaign takes about **six days** to fully land. The corporate slice is small enough to go out in one.

**Recommendation on record, not blocking:** Resend Pro is $20/month and removes this entire section. Given the downside is silently unsent invoices, it is the cheapest risk reduction in the system. The budget is a number to raise on upgrade.

## 8. Measurement

A per-campaign result view listing recipients who created a proposal within 30 days of receiving the campaign, with the resulting booked count and dollar value. Both sides are local tables, so this is nearly free.

Without it there is no way to answer whether any of this worked, and the entire goal is more repeat business. A campaign tool that cannot tell you whether it produced a booking is just a way to spend sending quota.

## 9. Verified ground truth (do not re-derive)

Queried against prod (`round-tooth-34649976`, branch `br-noisy-frog-ad99sa6l`) on 2026-08-11:

- Audience buckets: 49 past clients with a booked proposal (47 mailable), 198 quoted-never-booked (188 mailable, 9 opted out), 254 with no proposal at all (173 mailable). By source: thumbtack 288 (198 mailable), checkcherry 184 (184 mailable), website 12, zola 7, direct 5, calcom 4, referral 1.
- Corporate in 2026: 8 booked events totaling $5,423, against 58 booked and $39,303 overall. Average ticket $678 for both corporate and non-corporate.
- Corporate converts down. Where option sets were sent, the cheapest was chosen every time: Brianna Modugno / Gurnee Hyundai booked $760 with $9,850 and $7,750 archived; Drew Mathew / Salesforce booked $620 with $2,800 and $1,800 archived. Companies buy their own alcohol and want labor.
- `email_sends` is keyed on `lead_id` only, with no client recipient column. Campaign sends record through `scheduled_messages` and `message_log`, so `email_sends` needs no change for this spec.
- `clients` has no company column. `proposals` carries `event_type`, `event_type_category`, `event_type_custom`.
- `legacy_cc_proposals` field population out of 1,230 rows: `package_name` 1230, `service_name` 1230, `source` 1230, `total_cost_cents` 1230, `client_email_normalized` 1210 (1,154 distinct), `venue_name` 275, `client_id` 197, `estimated_guests` 4, `event_type` 0, `lead_type` 0. Booked: 190. Date range 2024-12-05 to 2027-12-04.

## 10. Open items

- **The ~970 Check Cherry dead-quote addresses.** Ruled out of the client import as archive-only, and ruled out of v1 here. They are the oldest and coldest addresses on file and the fastest way to damage the domain that carries invoices. They are also the single largest untapped list if that changes.
- **Check Cherry event types.** Recoverable only from the 2026-07-06 exports at `~/cc-archive/2026-07-06/`. Its own project, and only worth doing if event-type segmentation on the pre-migration cohort turns out to matter.
- **Corporate landing page.** No corporate page exists under `client/src/pages/website/`. Corporate campaign traffic routes to the generic quote wizard, which is built around a consumer describing a private event. Dallas's call on 2026-08-11: acceptable for now, revisit in the site redesign.
- **Automation phase 2.** Recurring campaigns and extending `retention_nudge` to the Check Cherry cohort, after several manual sends have been observed.
