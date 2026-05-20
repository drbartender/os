# Automated Communication System — Design Spec

**Status:** Draft, awaiting review
**Date:** 2026-05-20
**Author:** Dallas + Claude

---

## 1. Overview

This spec defines every automated email and SMS that drb-os sends across the client and staff lifecycle, plus the infrastructure required to support it (two-way SMS, notification subscriptions, scheduling, cross-cutting rules).

The goal is a complete communication system from lead capture through post-event retention, with consistent tone, appropriate channel choice, no double-fires, and no message overload.

## 2. Scope

### In scope

- All automated lifecycle touches across four stages (lead, sign+pay, pre-event, post-event), client-side and staff-side
- Two-way SMS infrastructure (inbound webhook, admin UI threading, STOP keyword, response codes)
- Email reply routing to admin inbox
- Multi-admin notification subscription model
- A unified `scheduled_messages` table for idempotency and history
- Per-scheduler control + heartbeat for operational safety
- Cross-cutting rules: archived cascade, time zones, communication preferences, notification overlap prevention, delivery failure fallbacks, BYOB vs Hosted conditionals, refund notification, manual-lead-entry parity, reschedule handling

### Deferred to separate workstreams

Items called out during design that are real but live outside this spec. Captured in section 11.

---

## 3. Voice and tone conventions

Three message patterns, applied consistently:

### Client SMS

**Pattern:** open with personal greeting, content, friendly close.

```
Hi, Dallas here. [content]. Let me know if you have any questions or need any changes.
```

### Client email

**Pattern:** body content, sign-off close. No greeting hook needed (from-line and signature do that work).

```
[content]

[Optional: secondary lines, links, etc.]

Cheers, Dallas
```

### Staff messages (email or SMS)

**Pattern:** system-style with branded prefix. Different vibe so staff recognize the automation and don't try to use it for free-form chat (they have Dallas's direct line for that).

```
[Type] from Dr. Bartender: [content]. [Response codes where useful.]
```

Examples of `[Type]` prefix: "Shift Reminder", "Update", "BEO Ready", "Thanks".

### Response codes (staff inbound SMS only)

System parses inbound SMS from staff phones for the following codes (case-insensitive):

| Code | Effect |
|---|---|
| `CONFIRM` | Mark shift as staff-acknowledged |
| `CANT` | Flag shift for re-assignment, fire urgent SMS to admin |
| Anything else | Route to admin notification queue, no system action |

Vocabulary leaves room to add more codes later but only these two are defined now.

---

## 4. Channel strategy

Default posture, can be overridden per touch:

| Touch type | Channel |
|---|---|
| Initial transactional confirmations (sign+pay, payment receipt) | Email + SMS together |
| Urgent action required (payment failure, schedule conflict) | Email + SMS |
| Time-sensitive nudges (event-eve, late payment) | SMS |
| Routine reminders (balance T-3, event-week) | Email |
| Marketing / long-lead engagement (drip, retention, New Year) | Hybrid, alternating |
| Operational / system (staff reminders, BEO) | SMS (with email backup) |

Cost-conscious posture: SMS costs Twilio money, email is essentially free. Default to email when both would work; reserve SMS for genuinely time-sensitive or attention-grabbing touches.

---

## 5. Lifecycle touchpoint catalog

Each touch is defined by: trigger, recipient, channel(s), timing anchor, suppression conditions, and copy. Copy uses `[bracketed placeholders]` for merge tags.

### Stage 1 — Lead → Proposal

#### 1.1 Thumbtack lead arrival → auto-proposal generation

**Trigger:** Thumbtack webhook `POST /api/thumbtack/leads` receives a new lead.

**Process:**

1. Save the lead in `thumbtack_leads` and create/match `clients` row (existing behavior).
2. Fire admin notification (email).
3. Set `clients.email_harvest_status = 'pending'`.
4. Email harvester (Playwright on the office box, deferred workstream) picks up pending rows and retrieves email from Thumbtack's "Create Estimate" reveal. Alternatively, admin pastes the email via admin UI as MVP fallback.
5. Once email is available, auto-build a BYOB Classic proposal:
   - Event date, duration, location, guest count (high end of Thumbtack range) from webhook
   - Bar-rental addon auto-added if Thumbtack Q&A details indicate "need a bar = yes"
   - Default tier: BYOB Classic
   - Alternatives offered later if client asks
6. Send initial proposal touch (1.2).

#### 1.2 Initial proposal touch

**Trigger:** Proposal created and ready to send (Thumbtack auto-proposal completes OR wizard completes OR admin manually creates).

**Recipient:** Client.

**Channels:** Email + SMS together.

**Suppression:** None at this stage.

**Email** (uses existing `proposalSent` template, content unchanged for now):

Subject and body per the existing template.

**SMS:**

```
Hi, Dallas here. Just sent your proposal for the [event_type] on [event_date]. View and book here: [link]. Let me know if you have any questions or need any changes.
```

#### 1.3 Unsigned-proposal drip (5 touches)

**Trigger:** Proposal status is unsigned for the specified interval.

**Recipient:** Client.

**Suppression (stops all remaining touches):**
- `proposals.status = 'signed'` (sign+pay coupling means this implies paid too)
- `proposals.status = 'archived'` (admin archived for any reason)
- Client opted out via STOP keyword (SMS only) or unsubscribe (email only)

**Channels alternate per touch:**

| Touch | Timing | Channel | Angle |
|---|---|---|---|
| 1 | +1 day | SMS | Did you get the proposal? |
| 2 | +7 days | Email | Still thinking about your event? |
| 3 | +10 days | SMS | Want to tweak your package before it books up? |
| 4 | +14 days | Email | Following up, alternative packages mentioned |
| 5 | +21 days | Both (email + SMS) | Last call to secure the date |

**Copy templates:**

**Touch 1 (+1d, SMS):**
```
Hi, Dallas here. Did you get the proposal I sent for the [event_type] on [event_date]? Let me know if you have any questions.
```

**Touch 2 (+7d, Email):**
```
Subject: Still thinking about your [event_date] event, [client_first_name]?

Just checking in on your [event_type] coming up [event_date]. Your proposal is still good to go whenever you're ready: [link].

Let me know if you have any questions or want to talk anything through.

Cheers, Dallas
```

**Touch 3 (+10d, SMS):**
```
Hi, Dallas here. Quick thought on the [event_type] on [event_date]. Want to tweak anything before it books up? Easy to adjust: [link].
```

**Touch 4 (+14d, Email):**
```
Subject: Following up on your [event_date] booking, [client_first_name]

Wanted to check back in on your [event_type]. Your proposal as written is still here: [link].

A few things worth knowing: if BYOB isn't quite right, we also offer Hosted packages where we handle the alcohol. Happy to send an updated quote if you want to see numbers on that side.

Let me know if you have any questions or need any changes.

Cheers, Dallas
```

**Touch 5 (+21d, Email + SMS):**

Email:
```
Subject: Last call to secure [event_date], [client_first_name]

Wanted to do one last check-in on your [event_type] on [event_date]. We're still holding the date, but other bookings come in regularly for that weekend.

If you're ready to lock it in: [link]. If you'd rather walk away, no hard feelings, just reply to let us know.

Cheers, Dallas
```

SMS:
```
Hi, Dallas here. Last check on your [event_date] event. Want to lock it in before someone else grabs the date? [link]
```

**After Touch 5:** silence. No further touches. Proposal eventually auto-archives via the daily archive cron when `event_date < CURRENT_DATE` and unsigned.

#### 1.4 Long-lead-time New Year touch

**Trigger:** Proposal signed and paid (active booking), event date is in next calendar year, event is 60+ days after January 1 of the event year. Fires Jan 2-3.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived.

**Copy:**

```
Subject: Happy new year, [client_first_name] — looking forward to your event

Hi [client_first_name], happy new year from Dr. Bartender.

Just a quick hello to say we're looking forward to your [event_type] later this year on [event_date]. Everything's on the books and we'll be in touch with more details as we get closer.

Reach out anytime with questions or changes.

Cheers, Dallas
```

#### 1.5 Long-lead-time 6-months-out touch

**Trigger:** Booking lead time > 6 months. Fires at T-6 months from event date.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived, or event date now < 6 months out (already past the trigger).

**Copy:**

```
Subject: Six months out from your [event_date] event

Hi [client_first_name], we're now six months out from your [event_type] on [event_date]. Mostly just saying hi.

Whenever you're ready to start thinking about drinks, the Potion Planner is here: [link]. Or if you'd rather walk through it together, you can book a 15-minute consult: [scheduling link].

Cheers, Dallas
```

#### 1.6 Long-lead-time T-30 recap

**Trigger:** Booking lead time was 90+ days when made. Fires at T-30 days from event.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived. Drink plan or shopping list incomplete (the regular drink-plan nudge handles that case).

**Copy:**

```
Subject: Three weeks out from your [event_date] event

Hi [client_first_name], your event is in about 3 weeks. Quick recap of what you've got teed up:

Drinks: [drinks from drink_plan summary]

Shopping list: [link]

Reminder: best to do the actual shopping in the days leading up to the event so things stay fresh and unused items are still returnable.

Anything change? Reply here.

Cheers, Dallas
```

---

### Stage 2 — Sign+Pay → Orientation

In the canonical flow, signing and paying happen in the same flow. A standalone "signed but unpaid" state is rare in practice; the customer bails and starts over.

#### 2.1 Orientation (sign+pay confirmation)

**Trigger:** Sign+pay flow completes (Stripe webhook reports first successful payment for a newly-signed proposal). Replaces today's `signedAndPaidClient` standalone email.

**Recipient:** Client.

**Channels:** Email + SMS together.

**Suppression:** None (this is the moment they just paid; we want to confirm immediately).

**Email** (the comprehensive orientation):

Subject: `You're booked — [event_date] [event_type]`

Body includes:
- Greeting + "thanks for booking"
- **Booking block**: date, time, location, guest count, package (BYOB Classic etc.)
- **Receipt block**: deposit paid, balance remaining, balance auto-runs on [date] (or "due on [date]" if not autopay)
- **Potion Planner CTA**: link with "Pick your drinks here"
- **Timeline of what to expect**: 
  - Drink plan: due by [date], or any time
  - Balance: [auto-charges / due] on [balance_due_date]
  - Bartender assignment: ~N days before event (or already locked if last-minute)
  - Day-of: what time the bartender arrives, etc.
- **.ics calendar attachment** with the event details
- **Reply-To**: Dallas's inbox

Close: `Cheers, Dallas`

**SMS:**

```
Hi, Dallas here. You're booked for [event_date]! Confirmation email and Potion Planner link are coming your way. Reply here anytime if you have questions.
```

#### 2.2 Last-minute staffing confirmation

**Trigger:** Shift assignment finalizes (auto-assign or manual) for a proposal where booking-to-event window was <72 hours. One-shot per proposal.

**Recipient:** Client.

**Channels:** Email + SMS together.

**Suppression:** Already fired once for this proposal. Proposal archived.

**SMS:**

```
Hi, Dallas here. Your bartender for [event_date] is [bartender_name]. Their direct number is [bartender_phone]. They'll reach out the day of the event. Let me know if you have any questions.
```

**Email:**

Subject: `Your bartender for [event_date]`

```
Your bartender for [event_date] is [bartender_name]. Their direct number is [bartender_phone] if you need to reach them. They'll be in touch the day of the event.

Let me know if you have any questions or need any changes.

Cheers, Dallas
```

Note: this fires ONLY for last-minute (<72h) bookings. Normal-lead-time clients learn their bartender at T-24h via the event-eve SMS (touch 3.7).

---

### Stage 3 Client — Pre-event

#### 3.1 Balance reminder (autopay path)

**Trigger:** Proposal `autopay_enrolled = true`, balance > 0, T-3 days from `balance_due_date`.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Balance paid early, proposal archived, autopay disenrolled.

**Copy:**

```
Subject: Heads up — balance for your [event_date] event runs in 3 days

Hi [client_first_name], your remaining balance of $[balance_amount] for your [event_type] on [event_date] runs on [balance_due_date] on the card ending in [last4].

To use a different card or pay early, click here: [link]

No action needed otherwise. We'll send a receipt once it's charged.

Cheers, Dallas
```

#### 3.2 Autopay success receipt

**Trigger:** Stripe webhook reports successful autopay charge for the balance.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** None.

**Copy:**

Replaces or supplements today's `paymentReceivedClient` with autopay-specific framing:

```
Subject: Balance charged — you're paid in full for [event_date]

Hi [client_first_name], your remaining balance of $[amount] for your [event_type] on [event_date] just ran on the card ending in [last4]. You're paid in full.

Receipt: [link]

Looking forward to the event.

Cheers, Dallas
```

#### 3.3 Autopay failure / payment failure

**Trigger:** Stripe webhook reports failed charge. Applies to both autopay attempts and one-off charge failures.

**Recipient:** Client.

**Channels:** Email + SMS together (urgent).

**Suppression:** Proposal archived. Throttled to one notification per 24 hours per proposal (existing admin throttle pattern, applied to client side too).

**Email:**

```
Subject: Payment didn't go through for your [event_date] event

Hi [client_first_name], your payment for the [event_type] on [event_date] didn't go through on the card ending in [last4].

Update your payment method here: [link]

If you have any questions or need help, reply to this email or call me.

Cheers, Dallas
```

**SMS:**

```
Hi, Dallas here. Your payment for [event_date] didn't go through. Tap here to update your card: [link]. Reach out if you need help.
```

Existing admin throttled email (also fires at the same trigger) keeps running.

#### 3.4 Balance reminder (non-autopay path)

**Trigger:** Proposal `autopay_enrolled = false`, balance > 0, T-3 days from `balance_due_date`.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Balance paid early, proposal archived.

**Copy:**

```
Subject: Balance due in 3 days for your [event_date] event

Hi [client_first_name], a heads up that your balance of $[balance_amount] for your [event_type] on [event_date] is due on [balance_due_date].

Log in and pay here: [link]

Reach out if you have any questions.

Cheers, Dallas
```

#### 3.5 Balance due today (non-autopay)

**Trigger:** Proposal `autopay_enrolled = false`, balance > 0, `balance_due_date = CURRENT_DATE` (in event TZ).

**Recipient:** Client.

**Channels:** Email + SMS.

**Suppression:** Balance paid, proposal archived.

**SMS:**

```
Hi, Dallas here. Your balance for [event_date] is due today. Pay here: [link]. Let me know if you need anything.
```

**Email:**

```
Subject: Balance due today for your [event_date] event

Hi [client_first_name], the balance of $[balance_amount] for your [event_type] on [event_date] is due today.

Pay here: [link]

Reach out if you have any questions.

Cheers, Dallas
```

#### 3.6 Late balance reminders (non-autopay)

**Trigger:** Non-autopay, balance > 0, T+1 days and T+3 days past `balance_due_date`.

**Recipient:** Client.

**Channels:** Email + SMS.

**Suppression:** Balance paid, proposal archived.

**T+1 day (gentle):**

SMS:
```
Hi, Dallas here. Just a reminder, your balance for [event_date] is now 1 day past due. Pay here: [link].
```

Email:
```
Subject: Balance now 1 day past due for [event_date]

Hi [client_first_name], your balance of $[balance_amount] for [event_date] is 1 day past due.

Pay here: [link]

Reach out if you need help or want to talk this through.

Cheers, Dallas
```

**T+3 days (firmer):**

SMS:
```
Hi, Dallas here. Your balance for [event_date] is 3 days past due. Please pay here ASAP: [link]. Or call me so we can sort it out.
```

Email:
```
Subject: Balance 3 days past due for [event_date], please reach out

Hi [client_first_name], your balance of $[balance_amount] for [event_date] is now 3 days past due.

Pay here: [link]

If something has changed or you need to talk through options, please reach out directly so we can sort this out together.

Cheers, Dallas
```

After T+3 days the automation stops. Admin takes over manually.

#### 3.7 Drink plan / Potion Planner submission nudge

**Trigger:** T-21 days from event AND drink plan empty (no client selections AND no admin consult notes).

**Recipient:** Client.

**Channels:** Email + SMS together.

**Suppression (stops nudge):**
- `drink_plans.selections IS NOT NULL` (client submitted via Potion Planner), OR
- `drink_plans.consult_filled_at IS NOT NULL` (admin recorded consult notes)
- Proposal archived

**Email:**

```
Subject: Time to lock in drinks for your [event_date] event

Hi [client_first_name], time to lock in drinks for your [event_type] on [event_date]. Three ways to do it:

1. Potion Planner: [link] (about 5 min, easiest)
2. Book a 15-minute phone consult: [scheduling link]
3. Call or text us at [phone] and we'll walk through it together

Cheers, Dallas
```

**SMS:**

```
Hi, Dallas here. Time to lock in drinks for [event_date]. Use the Potion Planner: [link], or book a consult: [scheduling link]. Or just call us.
```

#### 3.8 Drink plan submitted confirmation

**Trigger:** Client submits drink plan via Potion Planner (`drink_plans.selections` populated).

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived.

**BYOB version (with shopping list timing warning):**

```
Subject: Got your drink list for [event_date]

Hi [client_first_name], got your drink list. We're prepping for [event_date].

We'll send your shopping list as soon as it's ready. When it lands, our recommendation is to hold off on the actual shopping until closer to your event date. That keeps ingredients fresh and any unused items stay within most stores' return windows.

[If balance changed: Updated balance: $[new_balance], runs on [balance_due_date].]

Cheers, Dallas
```

**Hosted version (no shopping):**

```
Subject: Got your drink list for [event_date]

Hi [client_first_name], got your drink list. We're prepping for [event_date].

[If balance changed: Updated balance: $[new_balance], runs on [balance_due_date].]

Cheers, Dallas
```

(Reuse existing `drinkPlanBalanceUpdate` template, expanded to always fire with conditional balance language.)

#### 3.9 Shopping list ready

**Trigger:** Admin marks shopping list ready. **BYOB events only.**

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Hosted events (no client shopping). Proposal archived.

**Copy:**

Existing `shoppingListReady` template, with new freshness warning added:

```
Subject: Your shopping list for [event_date]

Hi [client_first_name], your shopping list for [event_date] is ready: [link]

A heads up: best to do the actual shopping in the days leading up to your event so ingredients stay fresh and any unused items stay within most stores' return windows. No need to rush out today.

Reach out with any questions.

Cheers, Dallas
```

#### 3.10 Post-consult email

**Trigger:** Admin clicks "complete" / "save" on consult notes in `drink_plans.consult_selections` (existing UI).

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived.

**Copy:**

```
Subject: Drink plan recap for your [event_date] event

Hi [client_first_name], great talking through your drink plan. Here's what we landed on:

[consult_selections rendered as a list of drinks]

[Next-step line, e.g.: "We'll send your shopping list shortly." OR: "Your bartender will prep based on this."]

Let me know if anything needs to change.

Cheers, Dallas
```

#### 3.11 Event-week reminder

**Trigger:** T-7 days from event.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived.

**Copy:**

```
Subject: One week until your [event_date] event

Hi [client_first_name], can't wait for next week. Here's what we have on file:

Date: [event_date]
Time: [start_time]
Location: [location]
Guest count: [guest_count]
Package: [package]

Anything changed? Reply here or call.

Cheers, Dallas
```

#### 3.12 Event-eve reminder

**Trigger:** T-24h from event start time (in event TZ).

**Recipient:** Client.

**Channel:** SMS.

**Suppression:** Proposal archived. **Hard exception** to the daily-cooldown rule (always fires).

**Copy:**

```
Hi, Dallas here. Your bartender tomorrow at [start_time] [event_tz], [location] is [bartender_name]. Their direct number is [bartender_phone] if you need them. They'll arrive [setup_minutes] minutes before your start time to set up. Let me know if you have any questions or need any changes.
```

(`[setup_minutes]` rendered from actual scheduled setup time, not the loose 30-90 range.)

#### 3.13 Reschedule notification

**Trigger:** Admin updates `event_date`, `start_time`, or `location` on a proposal (post-sign+pay).

**Recipient:** Client.

**Channels:** Email + SMS together.

**Suppression:** Proposal archived.

**SMS:**

```
Hi, Dallas here. Your event has been updated. New details: [new_date] at [new_start_time], [new_location]. Full updated confirmation in your email. Let me know if you have any questions.
```

**Email:**

Subject: `Updated details for your event`

```
Hi [client_first_name], your event has been moved.

Old details: [old_date] at [old_start_time], [old_location]
New details: [new_date] at [new_start_time], [new_location]

Everything else stays the same:
- Package: [package]
- Guest count: [guest_count]
- Total: $[total]
- [Balance auto-charges / due] on [new_balance_due_date]

Let me know if you have any questions or need to discuss anything.

Cheers, Dallas
```

Reschedule also re-anchors all future scheduled messages (event-week, event-eve, balance reminder, etc.) to the new event date.

#### 3.14 Refund notification

**Trigger:** Admin issues a refund (full or partial) via admin UI.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** None.

**Copy:**

```
Subject: Refund issued for your account

Hi [client_first_name], we've refunded $[refund_amount] to your card ending in [last4]. Should arrive in 5-10 business days depending on your bank.

[If applicable: New balance: $[new_balance]. Or: Refund covers the full amount, no balance remaining.]

Let me know if you have any questions.

Cheers, Dallas
```

---

### Stage 3 Staff — Pre-event

#### 3.15 Day-before shift reminder

**Trigger:** T-24h before shift's event start time (in event TZ).

**Recipient:** Assigned staff member(s).

**Channel:** SMS.

**Suppression:** Shift cancelled, staff unassigned, proposal archived.

**Copy:**

```
Shift Reminder from Dr. Bartender: working [event_type] at [client_name] tomorrow at [start_time] [event_tz], [location]. Setup: [setup_arrival_time]. Drink plan + shopping list: [link]. Reply CONFIRM to acknowledge or CANT if you have a conflict.
```

#### 3.16 BEO finalized notification

**Trigger:** Admin clicks "Finalize BEO for [event]" in admin UI. (Depends on BEO feature being built — deferred.)

**Recipient:** Assigned staff member(s).

**Channels:** SMS + email.

**Suppression:** Shift cancelled, proposal archived.

**SMS:**

```
BEO ready from Dr. Bartender: [event_type] on [event_date]. Full brief: [link]
```

**Email:** Includes the full BEO content rendered (or link to portal).

#### 3.17 Schedule change notification (admin-toggled)

**Trigger:** Admin updates event date / time / location, **with `notify_assigned_staff` checkbox checked** during the edit.

**Recipient:** Assigned staff member(s).

**Channels:** Email and/or SMS depending on which sub-checkboxes admin selected. Both unchecked by default.

**Suppression:** Shift cancelled, staff unassigned, proposal archived.

**SMS:**

```
Update from Dr. Bartender: [event_type] on [event_date] has been changed. New: [details]. Reply CONFIRM to stay on the shift or call if there's a conflict.
```

**Email:** Full breakdown of what changed.

#### 3.18 Cancellation / unassignment notice (admin-toggled)

**Trigger:** Admin cancels shift or unassigns staff member, **with `notify_assigned_staff` checkbox checked**.

**Recipient:** Affected staff member.

**Channels:** Email and/or SMS depending on admin's checkbox selection. Both unchecked by default.

**Copy (SMS):**

```
Update from Dr. Bartender: [event_type] on [event_date] has been [cancelled / your shift is no longer needed]. Sorry for the disruption. Reach out with questions.
```

#### 3.19 Post-event thank-you

**Trigger:** Scheduled event end time + 30 minutes (i.e., `event_date + start_time + duration + 30 min`).

**Recipient:** Assigned staff member(s).

**Channel:** SMS.

**Suppression:** Already fired (one-shot per shift, tracked via `scheduled_messages`). Shift cancelled.

**Copy:**

```
Thanks from Dr. Bartender for working [event_type] tonight. Let me know if anything came up. Cheers
```

---

### Stage 4 — Post-event

No event-night touch to the client. Clients are sleeping, partying, or otherwise unavailable to business contact.

#### 4.1 Review request (T+2 days)

**Trigger:** T+2 days from scheduled event end.

**Recipient:** Client.

**Channel:** Email.

**Suppression:** Proposal archived. Client opted out of post-event communications.

**Copy:**

```
Subject: How was your [event_date] event?

Hi [client_first_name], thanks again for having us at your [event_type] last [day_of_week]. Hope you and your guests had a great time.

If you have a moment, we'd love to hear how it went: [link to feedback router page]

[For single-bartender events only:]
Also, in case you didn't get a chance to tip on the night (party too hard, QR sign went MIA, whatever): your bartender [bartender_name] takes tips at [venmo_handle] / [cashapp_handle] / [zelle_handle].

Cheers, Dallas
```

The feedback router page (reused from the bartender QR tip feedback pattern) presents a star or thumbs rating:

- 4-5 stars → redirect to Google review URL (`PUBLIC_GOOGLE_REVIEW_URL`)
- 1-3 stars → internal feedback form, submits to admin via email

Customer experiences a unified rating flow; routing is invisible.

For multi-bartender events, the tip-handles line is omitted (deferred decision on how to handle multi-bartender post-event tipping).

#### 4.2 Retention nudge (T+11 months)

**Trigger:** T+11 months from completed event, AND `event_type` is in the retention-eligible whitelist.

**Recipient:** Client.

**Channel:** Email.

**Suppression:**
- Client already has another upcoming event in the system (don't retention-nudge while they're actively booked)
- Proposal archived
- Client opted out of marketing communications

**Eligible event types** (configurable in admin):
- Holiday party
- Birthday party
- Corporate event
- Anniversary party (non-wedding)

**Excluded event types:**
- Wedding
- Engagement party
- Baby shower
- Graduation
- Retirement party
- Bachelor / bachelorette (referral territory, not retention)

**Copy:**

```
Subject: Almost a year since your [event_type], [client_first_name]

Hi [client_first_name], it's been almost a year since your [event_type] with us. If you're planning anything similar this year, we'd love to help. Same packages, same team. Reach out anytime.

Cheers, Dallas
```

#### 4.3 Staff review-forward

**Trigger:** Google review arrives (via deferred Google Reviews monitoring workstream), text contains the name of a bartender who worked an event in the past ~2 weeks.

**Recipient:** That bartender.

**Channel:** Email.

**Suppression:** None.

**Copy:**

```
Subject: Got a review for [event_date] you worked

Hey [bartender_first_name], a client just left this review for the [event_type] you worked on [event_date]. Thought you'd want to see it.

[Review text and rating]

Cheers, Dallas
```

Gated on the Google Reviews monitoring being built (deferred).

---

## 6. Admin notifications

### Real-time SMS to admin (urgent)

| # | Notification | Trigger |
|---|---|---|
| 1 | Last-minute booking alert | Booking <72h before event |
| 2 | Consult booked | Cal.com webhook fires |
| 3 | Staff CANT response | Staff replies CANT to shift reminder |
| 4 | Inbound client SMS | Client replies to any client-facing SMS |

All four go to all admin/manager users subscribed to the relevant category. Sent to `users.phone` for each subscribed admin.

### Real-time email to admin (individual)

| # | Notification | Trigger |
|---|---|---|
| 5 | Autopay charge failure | Stripe webhook reports failure (existing, throttled 24h) |
| 6 | Negative-rating feedback | Client submits low rating via post-event feedback form |
| 7 | Failed Thumbtack email harvest | Harvester fails N retries on a lead |
| 8 | Top-shelf class requested | Client requests during signing (existing) |
| 9 | New Thumbtack lead arrival | Thumbtack webhook fires (existing) |
| 10 | New staff application | Applicant submits (existing) |
| 11 | Shift request from staff | Staff applies for shift (existing) |
| 12 | New booking (consolidated) | `signedAndPaidAdmin` fires once for the coupled sign+pay flow |
| 13 | Balance payment received (non-deposit) | Stripe webhook for balance payment |
| 14 | Tip-page feedback | Guest submits via tip QR flow (existing) |
| 15 | Staff free-form SMS reply (pre-AI-responder) | Staff sends non-code SMS |

### Removed from admin notifications

- `newThumbtackMessageAdmin` — Thumbtack notifies directly
- `newThumbtackReviewAdmin` — Thumbtack notifies directly
- Separate `clientSignedAdmin` and `paymentReceivedAdmin` for the coupled flow — consolidated into the single `signedAndPaidAdmin` (existing standalone templates remain only for the rare non-coupled paths)

### In-app activity feed

All notifications also surface in an admin UI activity feed. Provides a place to browse history without depending on email being kept clean.

### Multi-admin subscription model

- `users.role` (existing) defines admin / manager / contractor
- New `users.notification_preferences` JSONB column with per-category subscriptions
- Notification categories: `urgent_booking`, `urgent_consult`, `urgent_staffing`, `urgent_client_reply`, `payment_failure`, `feedback`, `system_error`, `routine_admin`, `routine_thumbtack`, `routine_hiring`, `routine_finance`
- Default: all admins + managers subscribed to all categories
- Each user can toggle subscriptions per category
- Each notification declares which category it belongs to; system routes to all subscribed users

### Deferred: per-proposal manager assignment

Future state: a manager can be explicitly assigned to a proposal, and "this proposal" notifications route to that manager + admins. MVP: everyone subscribed to a category gets all events in that category.

---

## 7. Cross-cutting rules

### 7.1 Archived-proposal cascade

`proposals.status = 'archived'` is the terminal state replacing the existing `cancelled` status. New `proposals.archive_reason` column with enum values:

- `no_hire` — client went with someone else
- `client_cancelled` — client cancelled their event
- `we_cancelled` — we couldn't fulfill
- `event_completed` — auto-archive after event ran and balance paid (alternative: keep `completed` status and archive on a later schedule, design choice for implementation)
- `other` — free text

**Universal rule:** every scheduled message's WHERE clause excludes `proposals.status = 'archived'`. Drips, balance reminders, event-week/eve, post-event, retention nudge: all check this.

Existing `cancelled` status (if it exists in the data model today) migrates to `archived` with `archive_reason = 'client_cancelled'` or `we_cancelled` based on context.

### 7.2 Time zone handling

Every proposal gets `event_timezone` (text, e.g., `America/Chicago`, `America/New_York`). Default to admin's local TZ; derived from `location` lookup where possible.

**Scheduling rule:** all event-anchored scheduled jobs compute target send times in event TZ, then convert to UTC for the scheduler query.

**Rendering rule:** all event-time references in messages render in event TZ (e.g., "Setup at 5:00 PM Eastern").

Staff working out-of-zone events get event-local times in messages. Optionally double-render later if it becomes a pain point. Default: event-local only.

### 7.3 Communication preferences

New `clients.communication_preferences` JSONB with:
- `sms_enabled` (default true)
- `email_enabled` (default true)
- `marketing_enabled` (default true, controls retention nudges, New Year touch, 6-mo-out touch)

Sources of preference updates:
- Self-service preferences page (linked from orientation email footer)
- Admin UI client detail page (admin sets on client's verbal request)
- STOP keyword on SMS sets `sms_enabled = false` universally
- Unsubscribe link on marketing emails sets `marketing_enabled = false` (transactional emails keep firing per CAN-SPAM)

**Send-time check:** every client-facing message checks the relevant preference before sending.

**Channel fallback rule.** If a touch is scheduled on a channel the recipient has opted out of, the system attempts the alternate channel (when the recipient has it and hasn't opted out of that one either):

- **Operational and transactional touches** (balance reminders, payment failures, event-eve, reschedule, sign+pay, drink plan nudge, post-consult, refund, etc.): primary channel opted out → fall back to the other channel. If both channels are opted out, fire an admin alert ("no working channel for [client_name] on [touch_name]") and suppress.
- **Multi-channel touches** (orientation, last-minute staffing, payment failure): each channel is scheduled independently. If one is opted out, that row suppresses but the other still fires. No fallback substitution needed.
- **Marketing and retention touches** (drip, retention nudge, New Year, 6-mo-out): governed by `marketing_enabled`. If marketing is off, suppress entirely with no fallback. If marketing is on but the specific channel is opted out, fall back to the other channel.

Same rule applies symmetrically to staff. If a staff member has opted out of SMS (via STOP keyword), scheduled SMS touches to them (day-before shift reminder, post-event thank-you) fall back to email. See `users.communication_preferences` in 8.3 and 9.

### 7.4 Notification overlap prevention

**Hard rule:** maximum 1 scheduled message per channel per client per day.

**Priority ladder** (top wins when two touches collide on the same day):

1. Time-sensitive operational (event-eve, balance T-3, balance due, autopay failure, reschedule notification)
2. Action-required (drink plan nudge, late payment)
3. Lifecycle (post-event review, T-30 recap, orientation)
4. Drip touches
5. Marketing / retention (New Year, 6-months-out)

**Deferral logic:** when scheduler runs, before firing a message, check `scheduled_messages` for any sent_at within the last 24h for this client and channel. If conflict and the new message is lower priority, defer by 24h and re-evaluate the next day.

**Hard exceptions** (immune from cooldown):
- Event-eve (T-24h): must fire on its exact day
- Balance-due-today: must fire on its exact day
- Immediate event-triggered confirmations (orientation, autopay success/fail receipt) are not scheduled touches, fire on user/system events
- Intentionally-paired email+SMS (orientation, last-minute staffing) fire together by design

### 7.5 Delivery failure fallbacks

**Email hard bounce** (via Resend webhook → `email_webhook_events` table):
- Mark `clients.email_status = 'bad'` (new column)
- Fall back to SMS for future client touches
- Fire admin alert: "Email bouncing for [client_name]"

**SMS delivery failure** (via `sms_messages.status = 'failed'`):
- Mark `clients.phone_status = 'bad'` (new column)
- Fall back to email for future client touches
- Fire admin alert: "SMS failing to [client_name]"

**Both bad:**
- Admin gets immediate alert: "No working contact channel for [client_name], please update"
- All client automation suspended until admin updates contact info

### 7.6 BYOB vs Hosted conditional logic

`proposals.bar_option` (existing) drives:

**BYOB:**
- Shopping-list-ready email fires (3.9)
- Drink plan submitted confirmation includes shopping-list timing warning (3.8 BYOB version)
- Long-lead T-30 recap mentions shopping list (1.6)

**Hosted:**
- Shopping-list-ready email skipped entirely (we shop, not client)
- Drink plan submitted confirmation has no shopping-list timing warning (3.8 Hosted version)
- Long-lead T-30 recap omits the shopping-list line

Drink plan / Potion Planner applies to both. Only the shopping-side messaging is BYOB-conditional.

### 7.7 Manual lead entry parity

Admin's "Create Proposal" action (used for leads coming in via direct phone, email, Instagram DMs, referrals, etc.) triggers the full automation chain identical to Thumbtack/wizard origin:

- Drip enrollment on unsigned status
- Orientation on sign+pay
- Pre-event touches
- Etc.

No special branching for "manual" vs "automated" origin. The create-proposal flow is the unified entry point.

### 7.8 Reschedule handling

Reschedule is a distinct action from cancel/archive. New admin action: "Reschedule event."

On reschedule:
- Update `event_date`, `start_time`, optionally `location`, `balance_due_date`
- All scheduled messages re-anchor to the new event date (existing rows in `scheduled_messages` get their `scheduled_for` recomputed)
- Reschedule notification fires (3.13)

If event moves more than 90 days out, the long-lead-time eligibility re-evaluates: bookings that become 90+ days out trigger T-30 recap eligibility; New Year and 6-months-out touches re-anchor.

### 7.9 Email replies route to admin inbox

All client-facing emails set `Reply-To: <admin email>`. Replies land in admin's inbox via standard email flow. Zero additional infrastructure for MVP.

The existing `email_conversations` table may already track replies via Resend inbound webhook. Worth a small investigation during implementation to confirm what's wired and whether to lean into the structured threading.

### 7.10 Repeat customers

When a client books a second event:
- Same `clients` row, new `proposals` row
- Orientation email fires for the new proposal (it's for a new event with new details)
- Drip enrollment per-proposal (new drip if unsigned)
- Retention nudge anchors on the new event's completion date
- No "already a customer, skip" logic to suppress messages

---

## 8. Infrastructure

### 8.1 Two-way SMS

**Inbound webhook:** `POST /api/sms/inbound`, signature-verified per Twilio's pattern.

**On inbound:**
1. Parse `From` (sender phone), `Body` (message content)
2. Look up sender by phone:
   - Match against `clients.phone` → client conversation
   - Match against `contractor_profiles.phone` → staff conversation
   - No match → unknown sender, route to admin with "unknown number" flag
3. Store in `sms_messages` with `direction = 'inbound'` (new column)
4. Branch on sender type:
   - **Client:** fire admin SMS notification (urgent), surface in admin UI thread
   - **Staff:** parse body for response codes (CONFIRM, CANT). If matched, fire the appropriate action (acknowledge shift / flag re-assignment). If not matched, route to admin (or to AI responder once that's built).
5. Check body for `STOP` keyword (case-insensitive). If present:
   - Set `clients.communication_preferences.sms_enabled = false` (or staff equivalent)
   - Send Twilio-compliant confirmation reply ("You're unsubscribed from drb-os messages. Reply START to resubscribe.")

**Admin UI threading:**
- Per-client thread view showing all inbound and outbound messages in chronological order
- Reply box that fires outbound through the same Twilio number
- Unread count badge in admin nav

### 8.2 `scheduled_messages` table

Unified table for all scheduled message tracking. Replaces ad-hoc per-table flags. **One row per (recipient, channel)** so partial failures and multi-recipient sends are tracked correctly.

```sql
CREATE TABLE scheduled_messages (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('proposal', 'shift', 'client', 'consult')),
  message_type TEXT NOT NULL,    -- e.g., 'event_eve', 'balance_reminder_t3', 'drip_touch_1'
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('client', 'staff', 'admin')),
  recipient_id INTEGER NOT NULL, -- clients.id, users.id (staff), or users.id (admin)
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),  -- one row per channel
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed', 'deferred')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scheduled_messages_pending ON scheduled_messages(scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_scheduled_messages_entity ON scheduled_messages(entity_type, entity_id);
CREATE INDEX idx_scheduled_messages_recipient ON scheduled_messages(recipient_type, recipient_id);
```

**Row-creation pattern:**
- A touch that sends email + SMS to one client creates **two rows** (channel='email' and channel='sms', same entity)
- A touch that sends a day-before reminder to a 2-bartender shift creates **two rows** (one per bartender, channel='sms')
- A touch that fans out to all admins subscribed to a category creates **one row per admin** (recipient_type='admin', recipient_id per admin)

**Workflow:**
- On trigger event (proposal signed, shift assigned, etc.), system inserts pending rows for every (recipient, channel) combination applicable to the touch
- Scheduler picks up rows where `status = 'pending' AND scheduled_for <= NOW()`
- For each row, checks suppression conditions (proposal archived, comm prefs, overlap cooldown, channel fallback rule)
- Sends message, marks `sent_at` and `status = 'sent'`
- On failure, marks `status = 'failed'` with error. Retry policy applies per-row, so a partial-failure batch (email succeeded, SMS failed) only retries the failed half.
- Idempotency: never re-process a row where `sent_at IS NOT NULL` and `status = 'sent'`.

### 8.3 Multi-admin notification subscriptions

`users.notification_preferences` JSONB column. Schema:

```json
{
  "urgent_booking": true,
  "urgent_consult": true,
  "urgent_staffing": true,
  "urgent_client_reply": true,
  "payment_failure": true,
  "feedback": true,
  "system_error": true,
  "routine_admin": true,
  "routine_thumbtack": true,
  "routine_hiring": true,
  "routine_finance": true
}
```

Defaults: all true for users with role 'admin' or 'manager'.

Each notification specifies its category in code. Notification dispatcher queries `SELECT id, phone, email FROM users WHERE role IN ('admin', 'manager') AND notification_preferences->>'<category>' = 'true'`, sends to each.

Toggle UI in user profile settings.

### 8.4 Per-scheduler control + heartbeat

**Per-scheduler control:**

Replace `RUN_SCHEDULERS` env (currently all-or-nothing) with per-scheduler env vars:

- `RUN_AUTOPAY_SCHEDULER` (default true)
- `RUN_SEQUENCE_SCHEDULER` (default true)
- `RUN_SCHEDULED_MESSAGES_SCHEDULER` (default true)
- `RUN_AUTO_ASSIGN_SCHEDULER` (default true)
- `RUN_THUMBTACK_ARCHIVE_SCHEDULER` (default true)
- Etc.

Allows surgical disable of one scheduler without taking everything down.

**Heartbeat:**

New `scheduler_health` table:

```sql
CREATE TABLE scheduler_health (
  scheduler_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL,
  last_status TEXT NOT NULL,
  expected_interval_seconds INTEGER NOT NULL,
  consecutive_failures INTEGER DEFAULT 0
);
```

Each scheduler writes its `last_run_at` on every run. A monitoring job checks every 15 minutes: if `now() - last_run_at > 2 * expected_interval_seconds`, fires admin alert via Sentry + email.

### 8.5 STOP keyword handling

Subset of two-way SMS infrastructure. When inbound SMS body matches `^STOP$` (case-insensitive, possibly with whitespace) or known equivalents (`UNSUBSCRIBE`, `END`, `CANCEL`):

1. Look up the sender's phone number:
   - Match against `clients.phone` → set `clients.communication_preferences.sms_enabled = false`
   - Match against `users.phone` (staff or admin) → set `users.communication_preferences.sms_enabled = false`
   - No match → log and ignore (don't reply to unknown senders)
2. Send Twilio-compliant confirmation reply: *"You've been unsubscribed from Dr. Bartender messages. Reply START to resubscribe."*
3. Log opt-out in `sms_messages.metadata` for audit

On `START` keyword: same sender lookup, set the appropriate `sms_enabled = true`, confirmation reply.

Note: this is the runtime SMS opt-out. The existing `agreements.sms_consent` on staff signup is the initial opt-in at hire; these are separate concerns and both must be respected (signup didn't consent → never send; signup consented but later sent STOP → don't send until START).

### 8.6 Email Reply-To routing

All client-facing emails set `Reply-To: <admin_email>` header (uses `process.env.ADMIN_EMAIL` or per-recipient routing if per-proposal manager assignment is built later).

Replies land in admin inbox via standard email. No special parsing needed for MVP.

Optional V2: parse Resend's inbound webhook (if configured) to thread replies into `email_conversations` table and surface in admin UI alongside SMS threads.

### 8.7 Cal.com integration

Self-hosted Cal.com instance on the always-on office box (deferred workstream — see section 11). Webhook integration with drb-os:

- Cal.com fires `invitee.created` webhook on booking
- New endpoint: `POST /api/admin/cal-consult-booked`
- Verifies webhook secret
- Looks up client by email or phone
- Creates `consults` table row (id, client_id, scheduled_at, calendly_event_id, status='scheduled', notes=NULL, completed_at=NULL)
- Fires admin SMS notification: "Consult booked: [Client Name] at [time] for [event_date] event"

`consults` table is for Cal.com scheduling only. The actual call notes live on `drink_plans.consult_selections` and `drink_plans.consult_filled_at` (existing).

### 8.8 Thumbtack email harvester

Playwright-based Node script running on the always-on office box (deferred workstream). Details in deferred section.

For this spec: the harvester reports email back via `POST /api/admin/thumbtack/email-harvested`, with body `{negotiation_id, email}`. Server validates, updates `clients.email`, sets `clients.email_harvest_status = 'harvested'`, triggers auto-proposal generation.

Manual paste fallback: admin UI form for Thumbtack lead detail allows pasting the email directly, same effect.

---

## 9. Data model changes

### Schema additions

**`proposals` table:**
- `event_timezone` TEXT NOT NULL DEFAULT 'America/Chicago' (or admin-local default)
- `archive_reason` TEXT (enum: `no_hire`, `client_cancelled`, `we_cancelled`, `event_completed`, `other`)
- Migrate existing `status = 'cancelled'` rows to `status = 'archived'`, `archive_reason = 'client_cancelled'` (or `'we_cancelled'` based on activity log inspection)

**`clients` table:**
- `email_harvest_status` TEXT DEFAULT 'not_needed' (enum: `not_needed`, `pending`, `harvested`, `failed`)
- `email_harvest_attempted_at` TIMESTAMPTZ
- `email_status` TEXT DEFAULT 'ok' (enum: `ok`, `bad`)
- `phone_status` TEXT DEFAULT 'ok' (enum: `ok`, `bad`)
- `communication_preferences` JSONB DEFAULT `'{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'`

**`sms_messages` table:**
- `direction` TEXT DEFAULT 'outbound' (enum: `inbound`, `outbound`)

**`users` table:**
- `notification_preferences` JSONB DEFAULT `'{...all categories true...}'` (see 8.3)
- `communication_preferences` JSONB DEFAULT `'{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'` (parallels `clients.communication_preferences`; controls staff and admin opt-out for outbound messages and persists STOP-keyword state)

**`consults` table (new):**
```sql
CREATE TABLE consults (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  calendly_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

(Note: actual consult notes live on `drink_plans.consult_selections` per existing schema, not on this table.)

**`scheduled_messages` table (new):** see 8.2.

**`scheduler_health` table (new):** see 8.4.

### Schema modifications

**Events / shifts** — no fundamental changes for this spec; existing `event_date`, `start_time`, `duration` are sufficient. Time zone information comes from `proposals.event_timezone`.

### Status transitions

Proposal status machine becomes:

```
new → sent → signed → deposit_paid → confirmed → balance_paid → completed → archived
                                  ↘                                       ↗
                                    archived (with archive_reason)
```

`archived` is the terminal state. `cancelled` is deprecated and migrated.

---

## 10. Implementation phasing

Rolling out the full spec in a single deploy would be risky. Suggested order:

### Phase 0 — Foundation

- Create `scheduled_messages`, `scheduler_health`, `consults` tables
- Add new columns to `proposals`, `clients`, `sms_messages`, `users`
- Migrate `cancelled` → `archived` with reasons
- Per-scheduler env var controls
- Heartbeat for existing schedulers
- Archive cascade rule applied to existing schedulers (autopay, auto-complete, sequence, auto-assign)
- `event_timezone` populated for existing proposals (admin-local default, hand-tag known out-of-zone events)

### Phase 1 — Email-side touches (low risk, high value)

- Balance reminder T-3 days (autopay path)
- Non-autopay payment cycle (T-3d, due-date, T+1 late, T+3 late) — email side only initially
- Orientation email expansion (replaces `signedAndPaidClient` standalone, folds in `drinkPlanLink`, adds .ics, adds timeline)
- Drink plan submitted confirmation (always-fire with conditional balance)
- Shopping list ready (with freshness warning, BYOB only)
- Event-week reminder (T-7)
- Long-lead T-30 recap
- New Year touch
- 6-months-out touch
- Post-event review request (with feedback router page reusing tip QR pattern)
- Retention nudge (event-type restricted)
- Refund notification
- Post-consult email (triggered by admin "complete notes" button)
- Reschedule email
- Email Reply-To routing
- Admin notification consolidation (deprecate redundant Thumbtack notifs, consolidate sign+pay)

### Phase 2 — Two-way SMS infrastructure

- Twilio inbound webhook + signature verification
- `sms_messages.direction` column
- Admin UI thread view per client
- Response code parser (CONFIRM, CANT)
- STOP keyword handler
- Inbound notification to admin (real-time SMS)

### Phase 3 — Client-facing SMS

- Initial proposal SMS (paired with `proposalSent`)
- Sign+pay confirmation SMS
- Drip SMS touches (+1d, +10d, +21d pair)
- Drink plan nudge SMS
- Balance due / late SMS (non-autopay)
- Payment failure SMS
- Event-eve SMS
- Reschedule SMS

### Phase 4 — Staff-facing SMS and admin notification routing

- Day-before shift reminder SMS
- Post-event thank-you SMS (T+30 min)
- Schedule change SMS (admin toggle UI + backend)
- Cancellation/unassignment SMS (admin toggle UI + backend)
- Multi-admin notification subscription model
- Notification overlap prevention rule
- Delivery failure fallback rules

### Phase 5 — Integration touches (depend on external workstreams)

- Cal.com webhook + consult booked admin SMS (after Cal.com self-hosted is up)
- Last-minute bartender staffing confirmation (depends on assignment-trigger refactor)
- Thumbtack auto-proposal flow + harvester integration (depends on harvester deployment)

### Phase 6 — Deferred feature notifications

- BEO finalized notification (depends on BEO system build)
- Staff payout email receipt (depends on staff payment system)
- Staff review-forward (depends on Google Reviews monitoring)
- AI responder routing for staff free-form SMS (depends on AI responder build)

---

## 11. Deferred items

Items called out during design that live outside this spec, each its own workstream:

1. **BEO system** — drink plan to BEO generation, portal view, "Finalize BEO" admin action, schema additions
2. **Staff payment system** — weekly invoices (Tuesday-after-event payday), portal earnings view, payout pipeline, real-time gratuity tracking, year-end tax document delivery
3. **Cal.com self-hosted setup** — deployment on office box, including admin's Google Calendar sync and webhook configuration
4. **Thumbtack email harvester** — Playwright deployment on office box, including session management, polling, failure handling
5. **Always-on office box** — hardware setup, prerequisite for Cal.com self-hosting and harvester
6. **Google Reviews monitoring** — API integration or scraping, parsing for bartender names, forwarding to assigned staff
7. **Multi-bartender post-event tipping pipeline** — how late-arriving tips get pooled and split across the team
8. **Referral program** — incentives and tracking for one-time-per-host events where guests might become clients
9. **Admin permissions refactor** — what "manager" grants beyond notification subscriptions, granular permission categories
10. **AI responder for staff SMS** — Claude-powered agent for inbound staff inquiries, escalates to admin when needed
11. **Broader marketing campaigns** — newsletter, seasonal promos, announcements on the `email_campaigns` infrastructure
12. **Contractor onboarding flow audit** — separate spec to validate existing hiring lifecycle templates

---

## 12. Open items

Items not fully resolved during design that may need discussion before or during implementation:

1. **`completed` vs `archived` for finished events.** Should events that ran successfully transition from `completed` to `archived` immediately, after a grace period, or never (keeping `completed` as its own terminal state alongside `archived`)? Tentative answer: keep `completed` distinct from `archived`. Both terminal. Schedulers exclude both equally.

2. **Notification category defaults for new managers.** When a manager is added to the system, do they get all categories on by default, or do they need to opt in? Defaulting to all-on for now.

3. **AI responder timing.** Listed as deferred. But the staff free-form SMS route to admin email is awkward until it's built. Worth deciding whether to prioritize the AI responder for an early phase.

4. **Multi-bartender post-event tip handling.** Deferred but the review email's tip-handle inclusion conditionally requires a single-bartender event. Multi-bartender events get a less complete review email until the pooled-tip-pipeline is built.

5. **Self-service preferences page UX.** Mentioned in 7.3 but not designed. A separate small spec for the page itself when we get there.

6. **First-time vs repeat customer copy variants.** Considered briefly. Decision: not splitting copy for V1. May revisit if data shows it matters.

---

## Appendix A — Existing templates touched by this spec

Templates that get modified, deprecated, or consolidated:

| Template | Action | Notes |
|---|---|---|
| `proposalSent` | Unchanged | Still the email side of touch 1.2 |
| `proposalSignedConfirmation` | Deprecated for sign+pay-coupled flow | Standalone may still fire in rare paths |
| `signedAndPaidClient` | Expanded into orientation email (2.1) | Adds Potion Planner link, calendar invite, timeline |
| `signedAndPaidAdmin` | Becomes the single admin notification for sign+pay | Consolidates with deprecated `clientSignedAdmin` + `paymentReceivedAdmin` for the coupled flow |
| `clientSignedAdmin` | Deprecated for coupled flow | |
| `paymentReceivedAdmin` | Deprecated for coupled flow | Still fires for non-coupled balance payments |
| `paymentReceivedClient` | Modified for autopay-success specifics (3.2) | Tightened copy |
| `paymentReminderClient` | Auto-fired by new schedulers (3.1, 3.4) | Was manual-only before |
| `drinkPlanLink` | Folded into orientation (2.1) | Deprecated as standalone |
| `drinkPlanBalanceUpdate` | Expanded to always fire (3.8) | Conditional balance language |
| `shoppingListReady` | Updated with freshness warning (3.9) | BYOB-only conditional |
| `shiftRequestApproved` | Unchanged | Email side of existing staff assignment flow |
| `newThumbtackMessageAdmin` | Removed | Thumbtack notifies directly |
| `newThumbtackReviewAdmin` | Removed | Thumbtack notifies directly |
| `newThumbtackLeadAdmin` | Unchanged | Email on new Thumbtack lead arrival |
| `tipFeedbackAdminNotification` | Sibling template added for post-event review router | New template for low-rating feedback |

---

## Appendix B — Estimated message volume per booking

Rough per-event SMS and email count under this design, assuming typical 60-day lead time, autopay-enrolled, BYOB:

**Client side:**
- Initial proposal: 1 email + 1 SMS
- Drip (if needed before signing): up to 5 touches, mixed channels
- Sign+pay: 1 email + 1 SMS
- Drink plan nudge (if needed): 1 email + 1 SMS
- Drink plan submitted: 1 email
- Shopping list ready: 1 email
- Balance reminder T-3: 1 email
- Autopay success: 1 email
- Event-week reminder: 1 email
- Event-eve SMS: 1 SMS
- Post-event review: 1 email
- **Total**: ~8 emails, ~4 SMS

**Staff side (per assigned bartender):**
- Shift assignment confirmation: 1 email + 1 SMS
- Day-before shift reminder: 1 SMS
- Post-event thank-you: 1 SMS
- **Total**: 1 email, 3 SMS

At ~10 events/month with average 1 bartender, ~120 client SMS/month + ~30 staff SMS/month = ~150 SMS/month, well within budget.

---

## Sign-off

This spec is ready for review. Approval required before implementation planning.

Next step on approval: invoke writing-plans skill to produce phased implementation plans, starting with Phase 0.
