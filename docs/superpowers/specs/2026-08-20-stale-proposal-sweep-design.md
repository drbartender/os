# Stale proposal sweep: auto-archive unbooked proposals after the event date

**Date:** 2026-08-20
**Status:** Design approved, revised after design-stage review fleet (grounding / gaps / risk)
**Scope:** Bounded. One new scheduler, one new `archive_reason` value, one client label.

## Problem

Nothing in the system ever closes out a quote that lost. A proposal that was
sent, viewed, and never booked sits in `viewed` or `sent` forever, past its own
event date, carrying live side effects.

Prod as of 2026-08-20:

| | |
|---|---|
| past-dated proposals in `draft`/`sent`/`viewed`/`modified`/`accepted` | 116 (103 `viewed`, 13 `sent`) |
| oldest event_date | 2026-05-02 |
| any `amount_paid` > 0 | 0 |
| open invoices attached (`draft`/`sent`/`partially_paid`) | 105 |
| pending `stripe_sessions` rows carrying a PaymentIntent id | 108 |
| pending `scheduled_messages` | 28 |
| live shifts | 0 |
| members of an option group | 8 |
| `accepted` and past-dated | 0 |

So 105 dunnable invoices and 28 queued client messages hang off events that came
and went without a booking. The admin funnel also undercounts Lost, because
`qLostValue` only sums `archived` proposals and nothing ever archived these.

The mirror case is already solved: `processEventCompletions`
(`server/utils/balanceScheduler.js:206`) auto-completes past, fully-paid events
hourly. This spec is its counterpart for the unbooked side.

**Residue this does not solve.** Proposals with `event_date IS NULL` are never
swept (prod currently has none), and future-dated rows in dead statuses still
sit forever. "Nothing ever closes a lost quote" is narrowed here, not solved.

## Decisions

From brainstorming, 2026-08-20:

1. **New `archive_reason` value `event_passed`.** Do NOT reuse the existing
   `event_completed`. That value is read by the client portal
   (`server/routes/clientPortal.js:65`) as "past events that happened" and
   bucketed alongside the client's real completed bookings. Writing it here
   would surface 116 dead quotes in clients' portals as events they had with
   us. `event_completed` currently has no writer anywhere and stays that way.
2. **Threshold: 48 hours past the event date.** The proposals were never
   booked, so there is nothing to reconcile and no reason to wait longer.
3. **Statuses swept: `draft`, `sent`, `viewed`, `modified`.** `accepted` is
   exempt.
4. **Full reap through the shared helpers**, identical to the manual Archive
   button, not a bare status UPDATE.
5. **No batch cap.** The first run takes the whole standing backlog in one tick.
6. **Email on skip.** When the sweep finds a past-dated `accepted` proposal it
   refused to touch, it emails the admin once per proposal.
7. **`event_passed` counts as Lost** in `qLostValue`. No metrics filter.

Added after the review fleet:

8. **Ships default-off.** The scheduler is opt-in, not opt-out, so deploy time
   is not execution time.
9. **Dry-run mode**, so the backlog can be inspected before it is touched.
10. **A runaway bound**, aborting and alerting rather than archiving an
    implausible number of rows in one tick.

### Why the `accepted` exemption is load bearing

It was decided as "a signed agreement with no deposit wants admin eyes." The
review found it is also the money guard. A fully refunded proposal is demoted by
`reconcileProposalPaymentStatus` (`server/utils/proposalStatus.js:26-28`): when
`paidCents <= 0` the status becomes `accepted`. So a refunded-to-zero booking has
`amount_paid = 0` and a real payment history, and the ONLY thing keeping it out
of this sweep, where it would be mislabeled `event_passed` (a lead that never
booked) rather than a cancelled booking, is the `accepted` exemption.

**Do not widen the status list to include `accepted` without solving that first.**

## Design

### New file: `server/utils/staleProposalSweep.js`

Exports `processStaleProposals`. The scheduler entry-point and export shape
follow `server/utils/shiftClosureSweep.js`; the per-proposal transaction body
follows `POST /proposals/:id/archive` (`server/routes/proposals/actions.js:440`).
Note that `shiftClosureSweep` itself is a single atomic `UPDATE ... FROM` with no
per-row transactions, so it is NOT the model for the loop.

**Selection query:**

```sql
SELECT id, client_id, status, event_date, total_price
  FROM proposals
 WHERE status IN ('draft','sent','viewed','modified')
   AND event_date IS NOT NULL
   AND ((event_date + INTERVAL '2 days') AT TIME ZONE event_timezone) < NOW()
   AND COALESCE(amount_paid,0) = 0
   AND id <> ALL($1)          -- LEGAL_HOLD_PROPOSAL_IDS
 ORDER BY id
```

Properties that are load bearing:

- `AT TIME ZONE event_timezone` mirrors `processEventCompletions`. A bare
  `CURRENT_DATE` comparison would be evaluated in the session timezone, which is
  GMT in prod and rolls at 19:00 Chicago, archiving a Saturday-night event's
  quote while the party is still running. The column is
  `TEXT NOT NULL DEFAULT 'America/Chicago'`, so no COALESCE is needed.
- It deliberately does NOT read `event_start_time`. That column is free-text
  VARCHAR with mixed legacy formats, and depending on it is exactly what
  silently blocked every auto-completion until the regex guard was added. By
  anchoring to midnight of `event_date + 2`, the sweep fires between 24 and 48
  hours after the event ends, which is the intended band.
- `COALESCE(amount_paid,0) = 0` is belt and braces. No proposal in these statuses
  should carry money, but the guard costs nothing.
- `LEGAL_HOLD_PROPOSAL_IDS = [600]`, a module constant with a comment pointing at
  the standing legal-hold rule. Proposal 600 is already excluded twice over (it
  is `confirmed`, and it carries $100), but the rule is "never sweep it," and
  that must not depend on a status filter a future edit could widen. The same
  constant is applied to the `accepted` skip query below.

**Hardening note:** `event_timezone` is unconstrained TEXT. A junk value raises
inside `AT TIME ZONE` and aborts the entire SELECT, which the per-proposal
transaction isolation does not cover, stalling every run. Prod holds exactly one
value today and `processEventCompletions` shares the exposure, so this is noted
rather than fixed here.

### Dry-run mode

When `STALE_PROPOSAL_SWEEP_DRY_RUN === 'true'`, the sweep runs the selection and
the `accepted` skip query, logs the full candidate list (id, status, event_date,
total_price) and the counts, and returns without writing anything, sending
anything, or calling Stripe. This is how the 116-row backlog gets inspected
before it is touched, and it is the answer to "there is no preview."

### Runaway bound

`MAX_ARCHIVES_PER_RUN = 200`. If the candidate count exceeds it, the sweep
archives NOTHING, logs, captures to Sentry, and sends the admin an alert naming
the count. The first run is about 115 and steady state after that is 0 to 3 rows
per day, so this never fires in normal operation; it exists so that a future edit
widening the date expression or the status list cannot burn the live pipeline in
one unattended tick. This is not a batch cap. It does not throttle the first run.

### Re-entrancy guard

A module-level in-flight boolean, following `scheduledMessageDispatcher.js:661`.
`wrapScheduler` does not serialize ticks, and the first run makes roughly 220
live Stripe calls, which can plausibly outlast an hourly interval. Without the
guard, two overlapping runs can both pass the `auto_archive_skipped` marker
check before either inserts, and double-send the skip email.

### Per-proposal transaction

One transaction per proposal, so a single bad row cannot abort the batch. Inside
each, in the same order as the archive endpoint:

1. Lock the client row (`SELECT id FROM clients WHERE id = $1 FOR UPDATE`) when
   `client_id` is not null, THEN the proposal row. This is the global lock
   hierarchy (clients, then proposal_groups, then proposals) and inverting it
   deadlocks AB-BA against a concurrent settle. No `proposal_groups` lock is
   needed: every group-archiving path hoists the client lock first, which is
   what serializes them.
2. Re-read `status` under the row lock. A proposal booked in the gap between
   selection and lock is skipped.
3. `UPDATE proposals SET status='archived', archive_reason='event_passed', updated_at=NOW()`.
4. `voidUnpaidProposalInvoice(id, dbClient)` (`server/utils/invoiceVoid.js:17`).
   This helper independently guards on `amount_paid = 0` at both the proposal
   and the invoice level, so it structurally cannot void an invoice anyone has
   paid against even if the status filter were wrong.
5. `reapShiftsForProposal(id, dbClient, 'event passed, never booked')`.
6. `DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND status='pending'`.
   DELETE rather than the `suppressed` status is deliberate, matching the archive
   endpoint and `cancel.js` exactly so the archive doors cannot drift. It is also
   unrecoverable; see Recovery below.
7. Insert `proposal_activity_log` with `action='archived'`, `actor_type='system'`,
   `details={archive_reason:'event_passed', via:'stale_proposal_sweep',
   voided_invoice_ids:[...], deleted_pending_messages:N, reaped_shift_ids:[...]}`.
   The extra detail is what makes "why did proposal X lose its invoice" answerable
   two weeks later.
8. COMMIT.
9. **Release the pooled connection.** This happens in a `finally`, BEFORE the
   post-commit tail below. Every tail helper acquires its own pooled connection,
   and holding the sweep's client across them is a deadlock CLAUDE.md records as
   twice-bitten. The archive route does the same thing at `actions.js:527-556`.

**Post-commit tail**, after release, each isolated so a failure never aborts the
batch: `cancelOpenInvoiceIntents` for the voided invoice ids,
`cancelMarketingForProposal`, `cancelPendingChangeRequestsForProposal`, and the
email-only staff notify for any reaped shift.

### Per-row failure policy

Each row's failure is caught so the batch continues, captured to Sentry with the
proposal id, and counted. **At the end of the run, if `failedCount > 0`, throw**
with the aggregate counts in the message.

This is not optional bookkeeping. `wrapScheduler` (`server/utils/schedulerHealth.js`)
records `failed` only when the function throws, which is why `balanceScheduler`
rethrows. Without the rethrow, the exact scenario the Schema section below warns
about, a partial boot leaving a narrowed CHECK and every row raising 23514, would
fail all 116 rows every hour while `scheduler_health` reads green forever.

The run also logs a one-line summary (archived count and ids, voided invoice
count, deleted message count, skipped count, failed count), matching
`shiftClosureSweep`.

### Stripe heal path

`cancelOpenInvoiceIntents` is a one-shot side effect on an already-committed row:
about 108 live PaymentIntents on the first run, and if Stripe 5xx's midway the
remainder is stranded forever, because an archived proposal is never re-selected.

Each tick therefore begins with a heal pass: re-run the intent cancellation for
`stripe_sessions` rows still `pending` whose proposal is `archived`. It is cheap
in steady state (the set is empty), and it converts a permanent stranding into a
self-correcting one.

Harm if the heal never ran is bounded and already handled, which is why this is a
heal and not a blocker: a voided invoice 404s at `create-intent-for-invoice`
(`server/routes/stripe.js:552`), an archived proposal 409s (`:564`), and a settle
on an already-open page hits the `archivedSettle` guard plus the
`payment_on_archived` admin alert.

### The `accepted` skip notice

A second query finds `accepted` proposals past the same threshold, minus the
legal-hold ids. For each with no existing `auto_archive_skipped` row in
`proposal_activity_log`, add it to the batch.

**Send first, then mark.** Call
`notifyAdminCategory({ category: 'routine_admin', subject, emailHtml, emailText })`
(`server/utils/adminNotifications.js:75`), then insert the `auto_archive_skipped`
markers **only if the returned `emailed` count is greater than zero.**

The ordering is the whole point. `notifyAdminCategory` never throws; it swallows
per-recipient failures and returns `{emailed: 0}`, and a `QuotaExceededError` on
the free 100/day Resend tier is only a Sentry breadcrumb. Marking first would
write the marker, send nothing, and then suppress every future attempt, so the
one case that explicitly wants admin eyes would go permanently silent. This
matches the autopay-failure precedent in `balanceScheduler.js`, which also sends
before marking.

`smsBody` is omitted, so it is email only. Subject and body carry no em dashes,
per the helper's contract. The check-then-insert is not atomic across processes,
which is acceptable only because prod is single-instance; the re-entrancy guard
covers the same-process case.

**Copy stays neutral.** A refunded-then-demoted booking lands in `accepted` too,
so the email must not assert "signed agreement, never paid a deposit." It should
say the proposal is past its event date in `accepted` and needs a look.

### Registration: `server/index.js`

```js
// Opt-in, unlike its default-on siblings: the first tick has large one-way
// side effects (invoice voids, live Stripe intent cancellations), and
// RUN_SCHEDULERS=true on a dev box would otherwise pull it along.
if (process.env.RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true' && !globalScheduleDisabled) {
  const { processStaleProposals } = require('./utils/staleProposalSweep');
  const wrapped = wrapScheduler('stale_proposal_sweep', 3600, processStaleProposals);
  setTimeout(wrapped, 150000);
  setInterval(wrapped, 60 * 60 * 1000);
} else if (!globalScheduleDisabled) {
  clearHealthRow('stale_proposal_sweep');
}
```

Two departures from the sibling schedulers, both deliberate:

- **Explicit `=== 'true'` rather than the shared `enabled()` helper**, which
  returns true unless the var is literally `'false'`. Deploying this default-on
  would make deploy time execution time: 115 archives, 104 invoice voids and
  roughly 220 live Stripe calls, unattended, 150 seconds after the deploy lands.
  The repo's precedent for risky one-shot side effects is ship-dark
  (`LEAD_CALL_ENABLED`, `VOICEMAIL_ENABLED`). Flip it deliberately, with the
  dry-run first, and watch the backlog run.
- This also closes the dev blast radius. `RUN_SCHEDULERS=true` is a documented
  local pattern for exercising other handlers, and this box talks to live Stripe
  by design, so a default-on sweep would ride along and cancel real live-mode
  PaymentIntents referenced by dev `stripe_sessions` rows.

150000ms is an unused boot offset (existing offsets include 15, 25, 30, 45, 60,
75, 90, 120, 180, 200, 210, 240, 270 and 300 seconds), keeping it out of the
startup burst.

### Schema

Add `'event_passed'` to the `proposals_archive_reason_check` CHECK in BOTH
places in `server/db/schema.sql` (about lines 2860 and 4146). The file's own
comment warns that the two definitions run as separate autocommit transactions,
so a partial boot with disagreeing lists leaves the narrower one live, or no
constraint at all. Widening cannot fail on existing rows (verified: no stray
`archive_reason` values in prod).

Add `'event_passed'` to the `proposals_archive_reason_check` entry in
`CONSTRAINT_CONTRACT` (`server/db/index.js:220`). It will have a live writer, so
a future narrowing must fail loudly at boot rather than throw 23514 at the sweep.

`proposal_activity_log.action` is an unconstrained `VARCHAR(50)`, so the new
`auto_archive_skipped` value needs no schema change.

### Client

One line in the archive-reason label map at
`client/src/pages/admin/ProposalsDashboard.js:43`: `event_passed: 'Event passed'`.

It is NOT added to the manual reason picker at
`client/src/pages/admin/ProposalDetail.js:889`, nor to the route allowlist
`ARCHIVE_REASONS` in `server/routes/proposals/actions.js:434`. This matches how
`event_completed` and `option_not_chosen` are auto-path-only markers. Verified:
these are the complete set of client-side archive-reason enumerations.

## Recovery, stated honestly

`archived -> draft` (`server/routes/proposals/lifecycle.js:103`) restores the
status and clears `archive_reason`. **That is all it restores.**

- Voided invoices are NOT un-voided. A recovered proposal mints a new invoice
  only on re-send via `createInvoiceOnSend`, and the previously emailed invoice
  link 404s forever.
- Deleted `scheduled_messages` rows are gone.
- There is no bulk un-archive. Recovery is one-by-one admin PATCH.

The first run is therefore effectively one-way across 116 rows. The dry-run mode
above exists so that it is inspected before it happens, and the default-off flag
exists so it happens while someone is watching. This is accepted, not mitigated.

## Blast radius on admin surfaces

The first run visibly moves more than the Lost tile. Expected, not a bug:

| surface | effect |
|---|---|
| `qLostValue` / Lost tile | +about $58,190, backdated by `sent_at` |
| `qPipelineOutstanding` | drops about 115 rows and about $58k |
| `qWinRate` pending count | drops about 115 |
| `archivedCount` (`metadata.js`) | +about 115 |
| `cohort=lost` list (`list.js:25`) | grows correspondingly |

Win-rate numerator and denominator are safe: the sent cohort keys on `sent_at`
and the accepted cohort requires `accepted_at`, which these rows lack.

Swept `draft` rows never enter Lost at all, since both `qLostValue` and the
`cohort=lost` predicate require `sent_at IS NOT NULL`.

## Accepted as-is

- **Direct proposal-token links.** 103 of the 116 clients hold live
  `viewed`-proposal links. The public GET (`server/routes/proposals/publicToken.js:59`)
  has no status filter and the client view has no `archived` branch, so the page
  still renders with live CTAs, and signing returns a misleading "This proposal
  has already been accepted" 409. This is pre-existing and identical for a manual
  archive, so it is out of scope here and logged to the backlog rather than fixed
  in this lane. Voided invoice links already fail gracefully (404 with
  "may have been voided" copy).
- **Client portal detail route.** `GET /api/client-portal/proposals/:token` has no
  status filter, so swept rows are unlisted rather than unreachable. Pre-existing
  and identical for manual archives.
- **`payment_on_archived` alert copy** asserts a cancellation refund already ran,
  which is false for an `event_passed` archive where nothing was ever paid. The
  refund instruction stays correct. Reason-aware copy is a backlog item.

## Deliberately untouched

- `server/utils/metricsQueries.js`. Counting `event_passed` as Lost is the
  decision; no filter is added.
- `server/routes/clientPortal.js`. Its archive bucket keeps its
  `archive_reason = 'event_completed'` filter, so swept rows stay unlisted for
  clients.

## Testing

New `server/utils/staleProposalSweep.test.js`:

1. Archives a `viewed` proposal 3 days past its event date, with reason `event_passed`.
2. Does NOT archive one 1 day past (threshold boundary).
3. Timezone: an event dated yesterday, evaluated during the GMT-rolled window,
   is NOT archived.
4. `accepted` past-dated is skipped, emailed once, and NOT re-emailed on a
   second run.
5. Skip-email failure path: `notifyAdminCategory` returns `{emailed: 0}`, no
   marker is written, and the NEXT run retries the send.
6. Voids the attached unpaid invoice and deletes pending scheduled messages.
7. Leaves a row with `amount_paid > 0` alone.
8. Leaves an `accepted` row alone (the refunded-to-zero guard).
9. Skips a proposal whose status changed between selection and lock.
10. Per-row failure isolation: one poisoned row does not stop the batch, AND the
    run throws at the end so `wrapScheduler` records `failed`.
11. Legal-hold id is excluded from both the sweep and the skip query.
12. Runaway bound: a candidate count over `MAX_ARCHIVES_PER_RUN` archives nothing
    and alerts.
13. Dry-run mode writes nothing, sends nothing, and calls no Stripe.
14. A `client_id IS NULL` proposal (the conditional client-lock branch).
15. An option-group member sweeps correctly (8 prod rows hit this on the first tick).
16. Post-commit tail: a `pending` `stripe_sessions` PI is canceled, a `processing`
    one is left alone.

Suites this change reaches, to be run after: `archive.test.js`, the webhook
`archivedSettle` suite, `crud.filters.test.js` (its `cohort=lost` predicate
mirror asserts against `qLostValue`), and `metadata.shapes.test.js`.

Dev DB, one suite at a time, from the repo root.

## Files

| file | change |
|---|---|
| `server/utils/staleProposalSweep.js` | new |
| `server/utils/staleProposalSweep.test.js` | new |
| `server/index.js` | register scheduler (opt-in) |
| `server/db/schema.sql` | CHECK value, both sites |
| `server/db/index.js` | CONSTRAINT_CONTRACT entry |
| `client/src/pages/admin/ProposalsDashboard.js` | label map line |
| `.env.example` | `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER`, `STALE_PROPOSAL_SWEEP_DRY_RUN` |
| `CLAUDE.md` | env var table rows |
| `README.md` | env var table rows + folder tree entry |
| `ARCHITECTURE.md` | scheduler section + schema CHECK note |
| `docs/fix-list-remaining-2026-07-02.md` | log the 3 accepted-as-is backlog items |

## Rollout

1. Deploy with the flag unset. Nothing runs.
2. Set `STALE_PROPOSAL_SWEEP_DRY_RUN=true` and
   `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER=true`. Read the candidate list.
3. Clear the dry-run flag. Watch the backlog tick, then confirm the admin funnel
   moved by the amounts in the blast-radius table.
