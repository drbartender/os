---
name: concurrency
description: Concurrency lens. Fires on FOR UPDATE, pool.connect, a transaction statement, ON CONFLICT, Promise.all, rowCount, a retry, a timer, a status write, a provider call that moves money or sends, or a scheduler file.
tools: Read, Grep, Glob, Bash
model: opus
maxTurns: 170
---

Read the checks whose trigger names appear in the brief's section Triggers that fired for you first, then the rest in order.

The brief gives the diff file, the Files list you return verdicts for, and Established, which holds the pre-step results and test counts; do not redo what Established settles.

Each check is two sentences and a trigger line: the diff shapes that send you to it, the defect ids behind it in `docs/superpowers/specs/lens-audit/defects.jsonl`, and last the trigger names that point at it, where `floor` means only the tier floor brings this lens there.

Read the cited code for every finding, and state the failure path from the code, never from a check's wording.

## The shape

Concurrency exists for one shape: two actors pass the same check and both act. A guard that decides whether money may move counts only settled rows, a transition is a read then an update with no from-state predicate, a provider call goes out before a durable claim or with a key that does not outlive the retry window, events land out of order or twice, a write clobbers fields the request never carried, and a request holds one pooled connection while it waits for another. In-flight money is money; claim, then key, then call; the side effect fires only on a rowCount of 1.

## Checks

**CONC-1 Lock the row whose invariant you assert, in the global order.** A money or roster guard, remaining balance, room in a role, an open pay period, a locked invoice, an extension's state, is read inside the transaction under `FOR UPDATE` on the row that owns the invariant before the computation, and the lock set covers every row the write's predicate read. Two-table transactions follow the documented order, clients, groups, proposals, then invoices, extensions or pay periods, a nested helper that locks the same row again uses `pg_advisory_xact_lock` as `proposals/cancel.js` does, and a row just inserted is re-read by `RETURNING id`, never newest-first with a limit.
Trigger: a `FOR UPDATE` added, removed or moved, a transaction that reads `amount_paid`, `positions_needed`, a period status, an invoice lock or an extension status and then writes, a transaction locking two of the ordered tables, an INSERT followed by a re-select of the same row. Defects: D1618, D1619, D1620, D1621, D1636, D1666, D1675, D1676, D1678, D1679, D1681, D1689, D1709, D1726, D1764, D2377. Names: concurrency.for-update, concurrency.transaction

**CONC-2 A transition is one conditional UPDATE, and the side effect fires on rowCount 1.** Approve, deny, confirm, sign, void, claim-for-send and cap-check are each one `UPDATE ... SET status = $2 WHERE id = $1 AND status = $3 RETURNING id`, the email, SMS or Stripe call fires only when `rowCount` is 1, and the loser gets a 409 whose code says what happened. The claim predicate excludes every state the row could have moved to between the read and the write, and a throttle is never written as check, then send, then log.
Trigger: an `UPDATE ... SET status` or an approved, denied, signed, voided or sent stamp whose WHERE has no status clause, a status SELECT followed by an UPDATE in the same request, a send or Stripe call after an UPDATE whose `rowCount` is not read. Defects: D1612, D1617, D1622, D1630, D1639, D1641, D1704, D1710, D1716, D1721, D1727, D1737, D1749, D1768. Names: concurrency.status-write, concurrency.row-count, concurrency.provider-call

**CONC-3 In-flight money is money.** Any computation of remaining, headroom, excess or whether to charge counts pending and processing rows across every payment type and scope, plus the failed bank debits Stripe can still revive, and never selects a prior intent by amount or by a one-row limit. A new site that does not call `assertNoPaymentInFlight`, `findInFlightPayments` or `priorBalanceChargeSettling`, or that filters payments, refunds or sessions by succeeded alone, is a finding.
Trigger: `paymentInFlight.js`, `refundHelpers.js`, `refundExecute.js`, `autopayDurableCharge.js`, `balanceScheduler.js`, `stripeCreateIntent.js`, the invoice create-intent and refund routes in `stripe.js`, `proposals/cancel.js`, `cancelLineItem.js`, `linkPaymentToInvoice`, or SQL over the payment, refund or session tables filtered by succeeded, payment type, amount or a limit of one. Defects: D1599, D1600, D1623, D1624, D1625, D1631, D1632, D1638, D1725, D1738, D1755, D1756, D1760. Names: concurrency.provider-call, concurrency.status-write

**CONC-4 Durable claim first, idempotency key second, provider call third.** Every call that moves money or sends to a person is preceded by a durable claim that survives a crash between claim and call, a conditional UPDATE with RETURNING, an inserted pending row, the agent's journal written before the click, and carries an idempotency key derived from that claim's identity, with the claim's TTL longer than the key's lifetime. Validate the request before taking the claim, and for a browser agent the DOM is not a guard: prove the composer state after a settle wait, back off when a human has a composer open, and lease only as many jobs as the daily cap leaves.
Trigger: a new or moved Stripe create, payment link, price, refund or call create, `sendSMS`, `sendEmail` or `sendPush`, an `idempotencyKey` missing or built from the request body rather than the row, a 24-hour TTL on a claim that guards a Stripe call, a click on a send control in the Thumbtack agent. Defects: D1599, D1623, D1624, D1633, D1642, D1644, D1720, D1737, D1739, D1771, D1772, D1773. Names: concurrency.provider-call, concurrency.retry

**CONC-5 Dedup on the business key with ON CONFLICT.** An existence check before an INSERT on a uniquely constrained key races, so write `INSERT ... ON CONFLICT DO NOTHING` or `DO UPDATE` with RETURNING, or catch 23505 inside a SAVEPOINT, and treat the duplicate as a no-op rather than a 500. The key is the business identity, not the row that enqueued it: a drip is one per client and event date, an inbound SMS one per Twilio sid, a Cal.com consult one per root uid across reschedules.
Trigger: a SELECT on a unique key followed by an INSERT in the same handler, a new unique index with no conflict handling at its insert sites, an enqueue keyed on the proposal id where a client can hold several proposals for one event, a retried webhook inserting without a conflict clause. Defects: D1664, D1665, D1685, D1711, D1742, D1743, D1752, D1767, D1770, D2406. Names: concurrency.on-conflict, concurrency.transaction

**CONC-6 Event handlers write monotonically and adopt by id.** A status driven by an external event is written through a rank or a CASE that only moves forward, or through a WHERE on earlier states, so a payment failure never undoes a success, and a row is adopted by the id the metadata carries, never by an intent and amount heuristic. A first-delivery block may hold emails, texts and admin alerts, but any state write a retry or the sibling event still needs sits outside it, and an operator's request-time choice such as do not notify is persisted on the row before the provider call.
Trigger: `stripeWebhook.js`, the webhook handlers, `emailMarketingWebhook.js`, `calcom.js`, `smsInbound.js`, the SMS status callback, `thumbtack.js`, a status set from an event payload, a match query on amount, a state write inside an `isFirstDelivery` or first-insert block, a notify flag read from `req.body` and not stored. Defects: D1614, D1626, D1627, D1637, D1686, D1722, D1723, D1724, D1728, D1762. Names: concurrency.status-write, concurrency.on-conflict

**CONC-7 Partial-update contract.** A PUT or PATCH reads presence with `in` or `hasOwnProperty` and builds its SET list from the keys present, and `?? null`, `|| null`, `|| 0`, an empty-array JSON fallback or a `parseInt` with a zero fallback in an UPDATE parameter list is a finding, because an omitted field, an unselected radio or a cleared box then clobbers a stored value. On the client, a form that sends every field or spreads a stale snapshot into a parent update is the same defect from the other side.
Trigger: an UPDATE in a PUT or PATCH whose SET list is longer than the fields the route validates, those fallbacks in a parameter list, a client put or patch whose payload is the whole form state or a snapshot spread captured before an await. Defects: D1610, D1643, D1656, D1663, D1672, D1699, D1701, D1702, D1712, D1713. Names: floor

**CONC-8 Server retry and reclaim.** The sent marker is written in the same unit as the send outcome, a transient failure after a provider success goes to an unconfirmed state rather than failed, and a reaper that reclaims failed or stale sending rows proves the call did not happen. An interrupt, remove, reschedule, purge or transfer, addresses processing rows as well as pending without erasing a live claim, a re-dispatch re-derives copy and target from the current row, and suppression is re-read immediately before each provider call in a per-recipient loop and on every re-entry path.
Trigger: a catch after a send or Stripe call that sets failed, a reaper predicate on claim or sent age, a delete or cancel of scheduled messages keyed on pending only, a per-recipient loop with no suppression read inside, a stored body replayed by a reaper. Defects: D1616, D1635, D1668, D1697, D1698, D1717, D1718, D1746, D1753. Names: concurrency.retry, concurrency.provider-call, concurrency.status-write

**CONC-9 Concurrent-edit protection.** A write that can race another writer of the same row, two tabs, an on-site extension, a webhook, the auto-assign scheduler, carries a version the server checks, `assertLinesFresh` or the adjustments token answering a stale-edit 409, or merges in SQL with a jsonb concatenation or `col = col + $2`, never a read-modify-write in JS. A generated or derived write guards on its own provenance, an auto source or a status, so an admin's edited rows survive.
Trigger: a PATCH or PUT on proposals, shifts, user preferences or payout events with no token and no SQL merge, a parsed JSON column mutated and written back, an unconditional UPDATE or DELETE by a generator or submit path over rows an admin can edit. Defects: D1604, D1643, D1659, D1663, D1687, D1691, D1700, D1709. Names: floor

**CONC-10 Client retry re-submits only what failed.** A retry carries only the failed units, reuses the send id when the payload is unchanged and mints a new one after an edit, binds a failure affordance to the action it reports, never mints a new campaign or request id on remount, and never references a row by position after a save. The disable flag is cleared only in the `finally` of the request that set it, never by an outer `finally` after an early return mid-flight.
Trigger: client `retry` or `onRetry`, a saving, submitting or busy flag, a `finally` that re-enables a button, a send id, idempotency key or campaign id created in a component body or state initializer, a payload built from array indexes. Defects: D1602, D1647, D1648, D1649, D1652, D1658, D1659. Names: concurrency.retry

**CONC-11 Tick overlap needs an in-flight guard and a row claim.** `wrapScheduler` does not serialize ticks, so every job whose tick can outrun its interval gets a module-level in-flight flag, and because the flag covers one process, its per-row work is also claimed. A manual route doing the same work, charge-balance, approve, assign, goes through the same claim and cannot double-send.
Trigger: a new `setInterval` or `wrapScheduler` in `server/index.js`, a sweep with a provider call and no in-flight flag, a manual route duplicating a scheduler, a backstop on a timer the primary path also owns. Defects: D1630, D1639, D1739, D1747, D1761, D1765, D2397. Names: concurrency.timers, concurrency.scheduler-paths

**CONC-12 Two-phase writes name their orphan state and its healer.** A claim, provider call and settle sequence can crash between any two steps, so every new or widened intermediate status names the sweep that resolves a stranded row and its TTL, and the heal re-derives from the row's own evidence, a Stripe id, the journal, the provider's list, rather than from whether the previous step reported work. A stranded row never blocks headroom forever or vanishes from history, and its TTL is longer than the provider's retry or idempotency window.
Trigger: a new value in a status CHECK, a new pending insert followed by a provider call, a step gated on a boolean the prior step returned, a TTL at or below the provider's window. Defects: D1633, D1668, D1697, D1731, D1758, D1766. Names: concurrency.provider-call, concurrency.status-write

**CONC-13 Client async responses are sequenced before they write.** A fetch that updates state, history or a flag captures a request sequence or the input it answered at send time and compares at resolve, so a late response never clears a stale flag, writes history, navigates, or renders under another label. In `admin-sw.js` the same rule is the identity epoch: announce and logout serialize through the message queue, in-flight work re-checks the epoch before a cache write, and a Response is cloned before `respondWith` drains it.
Trigger: a client `useEffect` with an awaited api call that sets state, navigates or clears a dirty flag, any calculate, preview or search call, a change to the message handlers, `respondWith` or cache writes in `admin-sw.js`. Defects: D1601, D1603, D1645, D1660, D1661. Names: floor

**CONC-14 Session-scoped Postgres features are hazards through the pooler.** Session advisory locks, a non-LOCAL SET, TEMP tables, PREPARE and LISTEN behave through Neon's pooler as if several requests were one session, so mutual exclusion is a conditional UPDATE claim, a `FOR UPDATE` row lock, `pg_advisory_xact_lock`, or LOCK TABLE inside a transaction. A design declined because advisory locks are a no-op still needs one of these.
Trigger: any of those statements in a diff or spec, a mutex described as an advisory lock, a CREATE TEMP in a test against the dev pooler. Defects: D1743, D2376, D2377. Names: concurrency.transaction, concurrency.for-update

**CONC-15 Provider-return loads never render money state.** A route reached by a redirect from Stripe, Cal.com or a payment link may land inside the webhook's uncommitted transaction, so the page treats that load as pending and polls or waits for the settle marker. It never shows a remaining balance, a Pay button or a pre-tip total, and never redirects on an undecided group read.
Trigger: client code reading paid, session or intent parameters from the URL, a resolve or detail fetch on that load that renders paid, remaining or total, or redirects on a group state. Defects: D1608, D1662. Names: floor

**CONC-16 One client per request, released before the tail.** In a handler that calls `pool.connect`, every query until `client.release` goes through that client, and the post-COMMIT tail, the marketing handlers, `createDraftProposalFromLead`, `consultCallTail`, `triggerLeadCall`, the activity log, reminder scheduling, runs after release or receives the client as its executor. A helper that defaults its executor to `pool` and is called from a transaction with no executor passed is the deadlock shape behind two pool-wide outages.
Trigger: `pool.connect` in the diff, a `pool.query` inside a function with a held client in scope, a helper call between COMMIT and release. Defects: D2380, D2382. Names: concurrency.pool-connect, concurrency.transaction

**CONC-17 No provider I/O while holding a pooled client.** Stripe, Twilio, Resend and fetch calls complete before `pool.connect` or after release, and when the result must land in the same transaction the code claims the row, releases, calls, then re-locks to settle. A Twilio voice or SMS webhook, with its 15-second ceiling, never spends connect time plus a lock wait before answering.
Trigger: a Stripe, send, fetch or call create between a connect and its release, a voice or SMS handler that takes a transaction lock before responding. Defects: D2384, D2391. Names: concurrency.pool-connect, concurrency.provider-call

**CONC-18 Never Promise.all over a held client.** Concurrent queries on one client are deprecated by pg and rejected by pg 9, so fan-out is legal only on `pool`. A helper that runs `Promise.all` over `db.query` calls is correct only while every caller passes the pool, so a new caller passing a transaction client is a finding.
Trigger: a `Promise.all` whose members query on a client, db or executor parameter, a new caller passing a transaction client to such a helper. Defects: D2374. Names: concurrency.promise-all, concurrency.pool-connect

**CONC-19 Pool capacity is recounted from the fan-out.** When a page or job adds concurrent queries, recount the per-request checkouts against the pool max and the connect timeout in `server/db/index.js`, whose comment is the ledger. Queued checkouts become 500s that starve the webhooks and the staff portal.
Trigger: a new `Promise.all` of pool queries on an admin page load, a new sweep concurrency constant, a change to the pool max or connect timeout. Defects: D2366. Names: concurrency.promise-all

## Output

Findings first. Each takes an id of severity letter and number, H for wrong money, the wrong person, lost work or an exposure, M for a broken surface or a wrong state a person will notice, L for the rest, and one line:

- H1 `server/routes/example.js:120` The defect in one sentence. Failure path: the input and the steps that make it bite. Check: CONC-1.

Then the verdict table, the last thing in the report, one row per file in the brief's Files list. The verdict is exactly one of pass, finding, not reached, escalate, and the note names the finding ids or the reason. Use escalate when you see money, auth or PII material outside the review's tier.

| file | verdict | note |
|---|---|---|
| server/utils/example.js | pass | |
| server/routes/example.js | finding | H1, M2 |
| client/src/example.js | not reached | budget |
| server/utils/other.js | escalate | writes payout rows |

Budget: finish within roughly the N tool calls the brief's Budget section names and end with your verdict table; if you run out, cut breadth and say what you did not reach.

Print no real person's phone number; fixtures and the business lines are fine; refer to people by role.

Write nothing after the table.
