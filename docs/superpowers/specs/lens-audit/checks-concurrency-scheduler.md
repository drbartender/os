# Lens audit synthesis: race-idempotency, pool-connection, scheduler-blast

Input: 136 defects (112 race-idempotency, 9 pool-connection, 15 scheduler-blast) that no lens checklist as written today would have flagged. Checks below are derived from the defects, named by mechanism, and point at the helpers and idioms the repo already has. Standing rule carried throughout: one pooled connection per request; every query on a held client goes through that client.

Two NEW lenses are proposed, because none of the six existing checklists has a line about claims, locks, idempotency keys, retries, pool holds or tick overlap:

- NEW: `concurrency-review`. Triggered by any diff that contains a status write, a `FOR UPDATE`, a `pool.connect()`, a provider call that moves money or sends a message, a retry affordance, or a partial update. Holds race checks 1 to 14 and pool checks 1 to 5. The three client-side checks (7, 8, 14) sit in a client section of the same lens; if another class proposes a client-state lens they move there.
- NEW: `scheduler-review`. Triggered by any diff to the scheduler block of `server/index.js`, any file under `server/utils/` named `*Scheduler*`, `*Sweep*`, `*Reaper*`, `*Prune*`, `*Dispatcher*` or `*Monitor*`, any `RUN_*` or `*_ENABLED` flag, any cap or throttle, and any `scripts/*.js` that accepts `--apply`. Holds scheduler checks 1 to 8.

Field key per check: wording, trigger (what in a diff makes the reviewer run it), lens, defects caught (ids, count), row-truth docs (whether the reviewer must read the money row-truth rule before judging).

---

## Class: race-idempotency (112 defects)

**Shape.** The same five shapes recur across every surface. (1) A guard that decides whether money may move counts only settled rows: refunds netted only `succeeded`, autopay counted only `payment_type = 'balance'`, a prior intent matched by amount with `LIMIT 1`, a processing bank debit invisible to `amount_paid`, a failed debit treated as dead when Stripe lets it retry. (2) A transition written as SELECT then UPDATE, or an UPDATE with no `AND status = <from>` predicate, so two actors both pass the check and both send, approve, deny, sign, void or charge. (3) A provider call (Stripe create, Resend, Twilio, a browser click on Send) issued before a durable claim exists or with an idempotency key that does not outlive the retry window, so a crash, a lost response or a second tab repeats real money or a real message. (4) Events applied out of order or twice: a bare status UPDATE that regresses a terminal state, a row adopted by (intent, amount) instead of the id carried in metadata, a first-delivery branch that also hides a state write a retry needed to see. (5) Writes that clobber: a PUT that treats an omitted field as cleared, a form that always sends every field, a stale snapshot spread back over the row, a derived write that overwrites rows it did not create. Client surfaces add their own flavor of each: a retry that re-sends the channels that already succeeded, a reused send id after an edit, an in-flight flag released by an early return, a late response rendering under the wrong label. 83 of the 112 touch money.

### Checks

**1. In-flight money is money.** Any computation of remaining, headroom, excess, or whether-to-charge must count `pending` and `processing` rows (and, for bank debits, `failed` rows still revivable at Stripe) across every `payment_type` and `total_scope`, and must never select a prior intent by amount or by `LIMIT 1`. Point at the existing helpers: `assertNoPaymentInFlight` / `findInFlightPayments` (`server/utils/paymentInFlight.js`), `priorBalanceChargeSettling` (`autopayDurableCharge.js`), and the `status IN ('succeeded', 'pending')` netting in `refundHelpers.js` (lines 87, 94, 754, 800); a new site that does not call one of them, or filters a payments/refunds/sessions table by `status = 'succeeded'` alone, is a finding.
- Trigger: diff touches `paymentInFlight.js`, `refundHelpers.js`, `refundExecute.js`, `autopayDurableCharge.js`, `balanceScheduler.js`, `stripeCreateIntent.js`, `stripe.js` (create-intent-for-invoice, `POST /refund/:id`), `proposals/cancel.js`, `cancelLineItem.js`, `invoiceHelpers.linkPaymentToInvoice`; or any SQL over `proposal_payments`, `proposal_refunds`, `stripe_sessions` with `status = 'succeeded'`, `payment_type = '...'`, `amount = $n`, or `LIMIT 1`.
- Lens: NEW `concurrency-review`.
- Defects caught (13): D1599, D1600, D1623, D1624, D1625, D1631, D1632, D1638, D1725, D1738, D1755, D1756, D1760.
- Row-truth docs: yes. The in-flight rule (a processing ACH debit does not move `amount_paid`; a failed debit row is a live intent) and acknowledged_total = row truth.

**2. Durable claim first, idempotency key second, provider call third.** Every call that moves money or sends to a person must be preceded by a durable claim that survives a crash between claim and call (a conditional UPDATE RETURNING, an inserted `pending` row, the agent's `first-reply-sent.journal` written before the click) and must carry an idempotency key derived from that claim's identity, with the claim's TTL longer than the key's lifetime (autopay: 72 h claim against Stripe's 24 h key). Validate the request before taking the claim, never after. For a browser agent, the DOM is not a guard: prove the composer state after a settle wait, back off when a composer is already open (a human is typing), and lease only as many jobs as the daily cap leaves.
- Trigger: any new or moved `stripe.<resource>.create(`, `paymentLinks.create`, `prices.create`, `refunds.create`, `calls.create`, `sendSMS(`, `sendEmail(`, `sendPush(`; the second argument lacks `{ idempotencyKey }` or the key is built from the request body rather than the row (`cancel-refund-${id}-${c.id}-${idempotency_key}` is the repo shape); any `INTERVAL '24 hours'` TTL on a claim that guards a Stripe call; any `page.click` on a send control in `thumbtack-agent/src/index.js`.
- Lens: NEW `concurrency-review`.
- Defects caught (12): D1739, D1720, D1644, D1633, D1623, D1624, D1599, D1737, D1771, D1772, D1773, D1642.
- Row-truth docs: yes for the Stripe sites (webhook credit is additive, never `= total_price`); no for the agent.

**3. A transition is one conditional UPDATE, and the side effect fires only on rowCount 1.** Approve, deny, confirm, sign, void, claim-for-send, cap-check: write `UPDATE ... SET status = <to> WHERE id = $1 AND status = <from> RETURNING id` and send the email, SMS or Stripe call only when `rowCount === 1`; a loser gets a 409 whose code says what happened (`request_changed`), never 'already sending'. The claim predicate must exclude every state the row could have moved to between the read and the write (an archived campaign still satisfies `status <> 'sending'`). Repo shapes to point at: `scheduledMessageDispatcher.js` claim (line 466) and `releaseClaim` (437), `marketingSend.js` `claimRun`, `claimEscalationUnderCap` (`voicemailEscalation.js`), `leadCallTrigger.claim(attemptId, from, to)`, `consultCallChain.claim`.
- Trigger: any `UPDATE ... SET status =` (or `approved_at`, `denied_at`, `signed_at`, `voided_at`, `sent_at`) whose WHERE has no `AND status` clause; any handler whose SELECT of a status is followed by an UPDATE in the same request; any `sendSMS` / `sendEmail` / `stripe.` call after an UPDATE whose `rowCount` is not read; any throttle written as check, send, then log.
- Lens: NEW `concurrency-review`.
- Defects caught (14): D1612, D1617, D1622, D1630, D1639, D1641, D1704, D1710, D1716, D1721, D1727, D1737, D1749, D1768.
- Row-truth docs: no.

**4. Lock the row whose invariant you assert, in the global order, and read what you wrote with RETURNING.** A money or roster guard (remaining balance, room in a role, open pay period, invoice locked, extension state) is read inside the transaction under `FOR UPDATE` on the row that owns the invariant (the proposal, not the client; the pay period as well as the proposal; the shift, not only the request), before the computation, and the lock set covers every row the write's predicate read. Two-table transactions follow the documented order: clients, then proposal_groups, then proposals, then invoices / service_extensions / pay_periods (`staleProposalSweep.js:208`, `proposalGroupCommit.js:97`, `invoiceLifecycle.js:460`, `serviceExtensionSettle.js:112`; email_leads, then enrollments, then clients in `unsubscribe.js:138`). When a nested helper will lock the same row again, use `pg_advisory_xact_lock` as `proposals/cancel.js:536` does, never a second plain `FOR UPDATE`. Re-read a row you just inserted by `RETURNING id`, never `ORDER BY created_at DESC LIMIT 1`.
- Trigger: any `FOR UPDATE` added, removed or moved; any `BEGIN` block that reads `amount_paid`, `positions_needed`, `period_status`, `invoices.locked`, `service_extensions.status` and then writes; any transaction locking two of the ordered tables; any `INSERT` followed by a re-select of the same row.
- Lens: NEW `concurrency-review` (database-review may hold the lock-order table as its reference).
- Defects caught (16): D1618, D1619, D1620, D1621, D1636, D1666, D1675, D1676, D1678, D1679, D1681, D1689, D1709, D1726, D1764, D2377.
- Row-truth docs: yes (the proposal row is the money truth; a stale `period_status` or `amount_paid` read outside the lock is the recurring defect).

**5. Dedup on the business key with ON CONFLICT, never SELECT-then-INSERT.** Existence checks before an INSERT on a uniquely constrained key race; write `INSERT ... ON CONFLICT (...) DO NOTHING/UPDATE RETURNING` (152 sites already) or catch `23505` inside a SAVEPOINT (`calcom.js:236`, `clientDedup.js:96`) and treat the duplicate as a no-op, not a 500. The key is the business identity, not the row that enqueued it: a drip is one per (client, event date), not one per proposal; an inbound SMS is one per `twilio_sid`; a Cal.com consult is one per root uid across reschedules.
- Trigger: any `SELECT ... WHERE <unique key>` followed by `INSERT` in the same handler; any new unique index in `schema.sql` with no `ON CONFLICT` or `23505` handler at the insert sites; any enqueue of a sequence or a record keyed by `proposal_id` where the client could hold several proposals for one event; any retry-able webhook (Twilio, Cal.com, Thumbtack) inserting without a conflict clause.
- Lens: NEW `concurrency-review`.
- Defects caught (10): D1664, D1665, D1685, D1711, D1742, D1743, D1752, D1767, D1770, D2406.
- Row-truth docs: no.

**6. Event handlers write monotonically, adopt by id, and gate only side effects on first delivery.** A status driven by an external event (Stripe, Resend, Cal.com, Twilio status callbacks) is written through a rank or a CASE that can only move forward (`STATUS_RANK` in `emailMarketingWebhook.js:142`, the monotonic CASE in `paymentIntentSucceeded.js:280`) or through `WHERE status IN (<earlier states>)`; a `payment_failed` can never undo a `succeeded`. A row is adopted by the id the metadata carries (`applyRefundReconciliation` now takes the row id), never by an (intent, amount) heuristic. An `isFirstDelivery` block (the `webhook_events` ledger, `proposal_payments ON CONFLICT`) may contain emails, SMS and admin alerts, but any state write a retry or the sibling event still needs to see (a `stripe_sessions` row flipping to `succeeded`, a legitimate second intent's credit) sits outside it. A choice the operator made at request time (don't notify) is persisted on the row before the provider call, so whichever path applies the event honors it.
- Trigger: diff in `stripeWebhook.js`, `stripeWebhookHandlers/*`, `emailMarketingWebhook.js`, `calcom.js`, `smsInbound.js`, the SMS status callback, `thumbtack.js`; any `UPDATE ... SET status = $n` where `$n` comes from an event payload; any match query with `amount = $n`; any state write inside an `if (isFirstDelivery)` or `inserted.rowCount === 1` block; any `notify_client` / `send` flag read from `req.body` and not stored.
- Lens: NEW `concurrency-review`.
- Defects caught (10): D1614, D1626, D1627, D1637, D1686, D1722, D1723, D1724, D1728, D1762.
- Row-truth docs: yes (the webhook credit is additive; a payment-state exclusion that drops a legitimate second credit is the D1723/D1724 shape).

**7. Client: every async response is sequenced before it writes.** A fetch that updates state, history or a flag captures a request sequence (or the input it answered) at send time and compares at resolve; a late or out-of-order response may never clear `previewStale`, write history, navigate, or render under a different quarter's label. In `admin-sw.js` the same rule is the identity epoch: `announce` and `logout` are serialized through `msgQueue`, in-flight closures re-check the epoch before `cache.put`, and a Response is `clone()`d before `respondWith` drains its body (lines 111 to 117, 265 to 270).
- Trigger: client diff with `useEffect` + `await api.*` that calls a setter, `navigate`, `history`, or clears a stale/dirty flag; any `/calculate`, `/preview`, `/search` call; any change to `client/public/admin-sw.js` message handlers, `respondWith`, `cache.put`, or `caches.open`.
- Lens: NEW `concurrency-review` (client section).
- Defects caught (5): D1601, D1603, D1645, D1660, D1661.
- Row-truth docs: no.

**8. Client: a retry re-submits only what failed, under the right token, and the in-flight flag is released only by its own request.** Retry carries the failed units only (`SendModal` `onlyChannels`), reuses the send id when the payload is unchanged and mints a new one when the user edited (`newSendId()`), binds a failure affordance to the action id it reports (a stale failure box must not re-run a staffing write), never mints a new campaign or request id on remount (that empties the server's duplicate defenses), and never references a row by position after a save. The disable flag is cleared only in the `finally` of the request that set it; an early `return` inside the try that lets the outer `finally` re-enable Save mid-flight is the D1658 shape (`ProposalEditorForm.js:388`, "await, not a bare return").
- Trigger: client diff containing `retry`, `Retry`, `onRetry`, `setSaving` / `setSubmitting` / `busy`, a `finally` that re-enables a button, `newSendId` / `idempotency_key` / `campaign_id` created in a component body or `useState` initializer, a payload built from array indexes (`adjustments[i]`, `targets[idx]`).
- Lens: NEW `concurrency-review` (client section).
- Defects caught (7): D1602, D1647, D1648, D1649, D1652, D1658, D1659.
- Row-truth docs: no.

**9. Server retry and reclaim: a provider success is recorded before any path can mark the row retryable, interrupts handle 'processing', and suppression is re-read at send time.** The sent marker is written in the same unit as the send outcome; a transient failure after a provider success goes to an unconfirmed state, never `failed` (a reaper that reclaims `failed` or stale `sending` rows must prove the call did not happen: provider id null, journal absent). An interrupt (Remove, reschedule, purge, transfer) must address rows in `processing`, not only `pending` (`shifts.js:723` deletes `status = 'pending'`; `eventEveSms.js:269` widened its DELETE to processing and erased a live claim), and must not leave an enqueue-then-purge gap a running dispatcher can fire through. A re-dispatch re-derives its copy and its target from the current row, not from what was stored at enqueue. Suppression (unsubscribe, `drip_stopped_at`, removed from roster) is re-read immediately before each provider call in a per-recipient loop and honored by every re-entry path (defer, `releaseClaim`, the stranded reaper, sibling hand-off), not only at enrollment (`marketingHandlers.js:106`).
- Trigger: a `catch` after `sendEmail` / `sendSMS` / `stripe.` that sets `status = 'failed'`; any reaper predicate (`claimed_at < NOW() - INTERVAL`, `sent_at < NOW() - INTERVAL '10 minutes'`); any `DELETE FROM scheduled_messages` or `UPDATE ... SET status = 'cancelled'` with `status = 'pending'` only; a `for (const recipient of ...)` loop with no suppression read inside it; a stored message body replayed by a reaper.
- Lens: NEW `concurrency-review`.
- Defects caught (9): D1616, D1635, D1668, D1697, D1698, D1717, D1718, D1746, D1753.
- Row-truth docs: no.

**10. Partial-update contract: write only the keys the body carries, and distinguish absent from null from empty.** A PUT/PATCH reads presence with `'k' in req.body` or `hasOwnProperty` (`admin/payroll.js:161`, `contractorTipPage.js:46`, `payrollDuty.js:173`, `packages.js:93`) and builds its SET list from present keys; `req.body.x ?? null`, `|| null`, `|| 0`, `|| '[]'`, `parseInt(x) || 0`, `JSON.stringify(x || [])` in an UPDATE parameter list are each a finding, because an omitted field, an unselected radio (`''`) or a cleared box (`0`) then clobbers a stored value. The repo has zero SQL-side `COALESCE($n, col)` keep-if-absent idioms, so the JS guard is the only defense. On the client, a form that sends every field (`...form`) or spreads a stale snapshot into a parent update is the same defect from the other side.
- Trigger: any `UPDATE ... SET` in a PUT/PATCH route whose SET list is longer than the fields the route validates; the fallback patterns above; a client `api.put`/`api.patch` whose payload is the whole form state or a `{ ...snapshot, ... }` captured before an await.
- Lens: NEW `concurrency-review`.
- Defects caught (10): D1610, D1643, D1656, D1663, D1672, D1699, D1701, D1702, D1712, D1713.
- Row-truth docs: yes where the clobbered column is money or gratuity (`tip_jar`, `gratuity_total`, payout handles): the admin PATCH accepts exactly one gratuity field.

**11. Concurrent-edit protection: a version or fingerprint on multi-writer rows, SQL-side merges, and derived writes that never overwrite rows they did not create.** A write that can race another writer of the same row (two tabs, an on-site extension, a webhook, the auto-assign scheduler) carries a version the server checks (`assertLinesFresh` / `adjustments_token` in `proposals/patchGuards.js`, 409 `STALE_EDIT`; the phone sheet's client-only guard does not count) or merges in SQL (`col = COALESCE(col, '{}'::jsonb) || $1::jsonb` at `me.js:347`, `col = col + $delta`) instead of read-modify-write in JS. A generated or derived write (auto shopping list, pair rows, seniority backfill) guards on its own provenance (`WHERE source = 'auto'` / status) so an admin's edited rows survive.
- Trigger: a PATCH/PUT on `proposals`, `shifts`, `users` preferences or methods, `payout_events`, that has no `*_token` / expected version and no SQL merge; `JSON.parse(row.col)` mutated and written back; an unconditional `UPDATE` or `DELETE` issued by a generator or a submit path over rows an admin can also edit.
- Lens: NEW `concurrency-review`.
- Defects caught (8): D1604, D1643, D1659, D1663, D1687, D1691, D1700, D1709.
- Row-truth docs: yes (D1604 rolls back worked hours and re-bills a paid hour; the extension row is the money truth).

**12. Tick overlap: a module-level in-flight guard AND a row claim, and the manual route shares the claim.** `wrapScheduler` (`schedulerHealth.js:54`) does not serialize ticks; 21 `setInterval` jobs boot in `server/index.js` and only three module-level flags exist (`_dispatchInFlight`, `staleProposalSweep.inFlight`, `payrollDeferredRetry.sweepInFlight`). Every job whose tick can outrun its interval gets the flag, and because the flag covers one process only, the per-row work is also claimed (`autopay_status = 'in_progress'`, dispatcher `processing`), so a second instance or the manual route doing the same work (charge-balance, approve, assign) goes through the same claim and cannot double-send.
- Trigger: a new `setInterval(` / `wrapScheduler(` in `server/index.js`; a sweep whose body has a provider call and no in-flight flag; a manual route that duplicates a scheduler's work; a sweep whose backstop fires on a timer the primary path also owns.
- Lens: NEW `concurrency-review` (cross-listed in `scheduler-review` check 2).
- Defects caught (6): D1630, D1639, D1739, D1747, D1761, D1765. Cross-class: D2397.
- Row-truth docs: no.

**13. Two-phase writes name their orphan state and its healer.** A claim-then-provider-then-settle sequence (`proposal_refunds` `pending`, `scheduled_messages` `processing`, autopay `in_progress`, campaigns `sending`, `menu_art_calls` `reserved`) can crash between any two steps. For every new or widened intermediate status the diff must point at the sweep that resolves a stranded row, its TTL, and show the heal re-deriving from the row's own evidence (a Stripe id, the journal, the provider's list filtered by intent) rather than from whether the previous step reported work (the `applyExtensionHours` touched-lines gate is the D1731 shape). A stranded row must not block headroom forever or vanish from history.
- Trigger: a new value in a status CHECK in `schema.sql`; a new `INSERT ... 'pending'` followed by a provider call; a step gated on a boolean returned by the prior step (`touched`, `changed`, `applied`); a TTL equal to or shorter than the provider's retry or idempotency window.
- Lens: NEW `concurrency-review`.
- Defects caught (6): D1633, D1668, D1697, D1731, D1758, D1766.
- Row-truth docs: yes (a pending refund row counts against headroom; the settle must reconcile against the proposal row, not the step's report).

**14. Provider-return loads never render or branch on money state.** A route reached by a redirect from Stripe, Cal.com or a payment link (`?paid=true`, `session_id`, a return URL) may land inside the webhook's uncommitted transaction; the page treats that load as "pending", polls or waits for the settle marker (a payment row, a group decision), and never shows a remaining balance, a Pay button, a pre-tip total, or bounces the client to `/compare` on an "undecided" read.
- Trigger: client diff reading `paid`, `session_id`, `payment_intent` from the URL; a `/resolve` or detail fetch on that load that renders `amount_paid`, `remaining`, `total`, or redirects on a group state.
- Lens: NEW `concurrency-review` (client section).
- Defects caught (2): D1608, D1662. Earns its place: D1608 was a client-visible wrong balance in production (proposal 774) and the rule is already a standing money law in the owner's notes.
- Row-truth docs: yes (never render money from the `?paid=true` load).

**Not anticipable:** D1770 (an operator re-armed the harvest before merging a duplicate client; a sequencing step on the box, not a code path a diff reviewer sees); D1666 (the record carries no mechanism beyond "lock scoping does not match accrual order", so it is cited under check 4 only provisionally).

---

## Class: pool-connection (9 defects)

**Shape.** Every pool defect is one of three things: a request that holds a pooled client and then needs a second one (a post-commit helper that calls `pool.query`, a tail that opens its own transaction, concurrent `query()` on the held client), a request that holds a client across something slow or deadline-bound (a Stripe call, a Twilio webhook with a 15 s ceiling and a lock wait), or a session-scoped Postgres feature used through Neon's PgBouncer pooler where sessions are shared (`pg_try_advisory_lock` was a no-op and could release another request's lock). Pool sizing sits underneath: one Money Board load is about 23 concurrent checkouts against a `max` that was 20.

### Checks

**1. One client per request, and release before the tail.** In any handler that calls `pool.connect()`, every query until `client.release()` goes through that client; the post-COMMIT tail (anything in `marketingHandlers.js`, `createDraftProposalFromLead`, `consultCallTail`, `triggerLeadCall`, `activityLog`, `schedulePreEventReminders(proposalId, executor)`) runs after `release()` or receives the client as its `executor`. Point at `thumbtack.js:437` and `:504` ("Release before the post-commit tail") as the shape.
- Trigger: `pool.connect()` in the diff; any `pool.query(` lexically inside a function that has `client` / `dbClient` in scope; any helper call between `COMMIT` and `release()`; a helper that takes `db = pool` and is called from a transaction with no executor passed.
- Lens: NEW `concurrency-review`.
- Defects caught (2): D2380, D2382. Earns its place: it is the repo's written invariant, and the two prior incidents behind that invariant (SERVER-17, the 2026-07-13 capture-lead deadlock) were pool-wide outages.
- Row-truth docs: no.

**2. No provider I/O while holding a pooled client, and no lock wait inside a webhook deadline.** Stripe, Twilio, Resend and `fetch` calls complete before `pool.connect()` or after `release()` (`refundSweepScheduler.js:22`, "ONE-CONNECTION RULE: stripe.refunds.list() completes BEFORE pool.connect()"); when the provider result must land in the same transaction, claim the row, release, call, then re-lock to settle. Seven files combine `pool.connect()` with a Stripe call today (`refundExecute.js`, `proposals/cancel.js`, `cancelLineItem.js`, `publicSwitch.js`, `paymentIntentProcessing.js`, `refundSweepScheduler.js`, `backfillExtrasInvoices.js`); each must show the call outside the hold or a comment saying why not. A Twilio voice or SMS webhook (15 s ceiling) must not spend connect time plus a lock wait before answering (`voicemailEscalation.js` connect plus `pg_advisory_xact_lock`).
- Trigger: `getStripe(` / `stripe.` / `sendSMS(` / `sendEmail(` / `fetch(` / `calls.create` between a `pool.connect()` and its `release()`; any `/api/voice/*` or `/api/sms/*` handler that takes a transaction lock before responding.
- Lens: NEW `concurrency-review`.
- Defects caught (2): D2384, D2391. Earns its place: D2384 is the invoice void money path; D2391 is a live phone call.
- Row-truth docs: no.

**3. Never `Promise.all` over a held client.** Concurrent `query()` calls on one client are deprecated by pg and rejected by pg@9; fan-out is legal only on `pool`. A helper that takes `db` as a parameter and runs `Promise.all([db.query(...), db.query(...)])` is correct only while every caller passes `pool` (`buildHostedCoveragePayload` is called with `pool` at `drinkPlans.js:94`; the sequential block above it at `coverageContext.js:27` is the fixed D2374 site). 26 files currently combine `Promise.all` with a parameterized executor.
- Trigger: `Promise.all([` whose members call `.query(` on `db`, `client`, `dbClient`, or `executor`; a new caller passing a transaction client to such a helper.
- Lens: NEW `concurrency-review`.
- Defects caught (1): D2374. Earns its place: the pg@9 upgrade turns every surviving instance into a runtime error on a money path.
- Row-truth docs: no.

**4. Session-scoped Postgres features are no-ops or hazards through the pooler.** `pg_try_advisory_lock` / `pg_advisory_lock` (session), non-LOCAL `SET`, `TEMP` tables, `PREPARE`, `LISTEN` behave as if several requests were one session (`marketingSend.js:197`: six checkouts shared one backend pid and two acquired the same lock). Mutual exclusion is a conditional UPDATE claim, a `FOR UPDATE` row lock, `pg_advisory_xact_lock` (transaction-scoped, `cancel.js:536`), or `LOCK TABLE ... IN EXCLUSIVE MODE` inside a transaction (`menuArtCap`). A design declined "because advisory locks are a no-op" (D1743) still needs one of these.
- Trigger: any of the session-scoped statements above in a diff or a spec; a mutex described as an advisory lock; a `CREATE TEMP` in a test that runs against the dev pooler.
- Lens: NEW `concurrency-review` (database-review carries the pooler fact as reference).
- Defects caught (3): D1743, D2376, D2377.
- Row-truth docs: no.

**5. Pool capacity is recounted from the fan-out.** When a page or job adds concurrent queries (`Promise.all` on `pool` in a dashboard route, a sweep `CONCURRENCY` constant, a webhook transaction that holds a client), recount the per-request checkouts against `max` (50) and `connectionTimeoutMillis` (10 s) in `server/db/index.js`; the comment there is the ledger (Money Board about 23; two admins about 46; autopay 5). Queued checkouts become 500s that starve webhooks and the staff portal.
- Trigger: a new `Promise.all` of pool queries in a route mounted on an admin page load; a new `CONCURRENCY` in a sweep; a change to `max` or `connectionTimeoutMillis`.
- Lens: NEW `concurrency-review` (performance-review may hold the recount).
- Defects caught (1): D2366. Earns its place: the starvation reaches the Stripe webhook, a money path.
- Row-truth docs: no.

**Not anticipable:** D2368 (a Neon-side drop of in-flight queries, `read ECONNABORTED`; the agent's re-poll is the right design and no diff check prevents a backend blip).

---

## Class: scheduler-blast (15 defects)

**Shape.** A job's reach is wider than its author pictured. The first tick, a flag flip or a redeploy processes the whole backlog (leads younger than an hour retro-enqueued, every instance running every scheduler, a dev process iterating the shared DB into Resend and Twilio); a cap counts a table that other code deletes from, so the ceiling never engages; a throttle window is reset by the thing it throttles; a stop is implemented as a row delete that the next PATCH re-enqueues; a script's filter parses to NaN and `--apply` mints every eligible proposal; a prune removes rows a cap still counts or orphans copies at the provider. Eight of the fifteen touch money or billed telephony.

### Checks

**1. First-run and flip-on blast radius is computed, bounded, and shipped dark.** For every new scheduler, sweep, flag, or widened predicate, state what the first tick does against the current production table (how many rows match today), ship behind an opt-in flag or a dry-run (`RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true'` plus `STALE_PROPOSAL_SWEEP_DRY_RUN` is the shape; the sweep's first run would have voided about 105 invoices), and age-bound the predicate so a flip or a redeploy does not retro-process the backlog (`firstReplySweepScheduler.js:151` re-enqueues rows younger than 60 minutes on a flag flip; a planned sweeper that lists refunds for rows with a NULL intent goes account-wide).
- Trigger: a new block in the scheduler section of `server/index.js`; a new `RUN_*` or `*_ENABLED` env var; a sweep SELECT with no `created_at >` / `scheduled_for >` bound; a path that enqueues historical rows when a flag turns on.
- Lens: NEW `scheduler-review`.
- Defects caught (5): D2394, D2397, D2399, D2400, D2412.
- Row-truth docs: yes for autopay and refund sweeps (what counts as paid or refundable before the job touches it).

**2. Who runs the job: environment gate, per-instance gate, and a row claim.** A scheduler registers only through `enabled('RUN_X_SCHEDULER')` behind `globalScheduleDisabled` (`server/index.js:498`), so a non-production process never fires and a secondary instance can be switched off; because `RUN_SCHEDULERS=false` is a stopgap, the per-row work is also claimed (race check 12) so N instances cannot double-charge or double-send even when the flag is wrong.
- Trigger: a timer started in the `app.listen` callback outside `enabled()`; a job that sends or charges with no conditional-UPDATE claim; a README or render config change to instance count.
- Lens: NEW `scheduler-review`.
- Defects caught (2): D2397, D2399. Cross-class: D1739, D1761, D1765. Earns its place: N instances running autopay is N real charges per client.
- Row-truth docs: no.

**3. Caps count an append-only ledger, and windows are anchored, not reset.** A daily or rolling cap sums rows no transition, reschedule, cancel or prune deletes (`call_audit` via `caps.legCapTripped` at `consultCallChain.js:787`, `menu_art_calls` reservations), never a state table (a reschedule clear that deletes skipped rows erased billed rings, 3 to 0); a cap that excludes `skipped%` rows must have a second counter on the billed act itself (`dialCap()`); a throttle window starts at the first event in the window and is not reopened by each stop. The cap's own comment names the ledger it counts.
- Trigger: any `COUNT(*)` or `SUM(` feeding a cap or throttle; the counted table appears in a `DELETE FROM` elsewhere (grep it); a `LIKE 'skipped%'` or status exclusion in a cap predicate; a window variable assigned inside the handler it bounds.
- Lens: NEW `scheduler-review`.
- Defects caught (3): D2403, D2404, D2405.
- Row-truth docs: no.

**4. Alerts from a loop are throttled per entity with a persisted, atomically claimed stamp.** A sweep that finds the same bad row every tick sends once per window, by claiming `alerted_at` in the UPDATE (`stripePayoutSync.js:217`, `WHERE alerted_at IS NULL RETURNING`) or a dated throttle row; an in-memory `_lastAlertAt` (`emailQuotaDefer.js:52`) is acceptable for Sentry noise only, never for a client or staff send, because it resets on restart and a check-then-send-then-log order lets concurrent retries both pass.
- Trigger: `notifyAdmin*`, `sendEmail`, `sendSMS`, `sendPush` inside a sweep loop or a webhook retry path; a 60-second sweep that can re-find a row; a throttle read, then send, then write.
- Lens: NEW `scheduler-review`.
- Defects caught (3): D1721, D2405, D2416.
- Row-truth docs: no.

**5. A missing or malformed filter aborts, never widens.** A `scripts/*.js` with `--apply` defaults to dry run, parses its filter through a strict parser (`readEnvInt` for env ints; a `--only` that yields NaN or empty aborts), prints the candidate count, and refuses `--apply` above the stated expectation without an explicit override (`cc-balance-invoice.js:42` records the NaN case). The same rule for provider list calls: stripe-node drops `undefined` params, so `refunds.list({ payment_intent: row.intent })` with a NULL intent lists the whole account; guard with `IS NOT NULL` in the SELECT (`refundSweepScheduler.js:228`) and refuse the call on a missing key. In SQL, `WHERE id = ANY($1)` with an empty array must short-circuit before any write.
- Trigger: `args.includes('--apply')` (ten scripts today); `parseInt(argv...)` feeding a WHERE; a `stripe.*.list({ ... })` whose filter value can be null; `ANY($n)` over an array built from input.
- Lens: NEW `scheduler-review`.
- Defects caught (3): D2394, D2396, D2412.
- Row-truth docs: yes for money scripts (which proposals are eligible is a row-truth question before the mint).

**6. A stop is a stamp the enqueuer honors, and the dedup key is the business identity.** Cancel, stop, remove and suppress write a durable marker on the parent (`drip_stopped_at` via `stopDrip.js`, `status = 'suppressed'` / `'suppressed_by_sibling'`) that every enqueue path checks (`schedulePreEventReminders` re-enqueues on every proposal PATCH through `insertIfMissing`; `scheduleEventEve`; `scheduleDripForProposal`) and every resurrect path checks (`handOffDripToSibling`, the stranded reaper, cooldown defer); deleting pending rows is never the suppression. A sequence is one per (client, event date), decided by `hasLiveSiblingDrip`, not one per proposal.
- Trigger: `DELETE FROM scheduled_messages` used as a stop; a new call to any `schedule*` helper from a PATCH; a hand-off or re-enroll path; an enqueue keyed on `proposal_id`.
- Lens: NEW `scheduler-review`.
- Defects caught (6): D1717, D1752, D1753, D2406, D2407, D2411.
- Row-truth docs: no.

**7. A backstop arm defers, never preempts, and a re-dispatch re-derives.** A sweep that re-fires work an in-process timer owns (the first-reply call delay, the T-24 send) fires only when the primary provably died (stale claim, missing heartbeat), defers by at least the primary's own delay (`FIRST_REPLY_CALL_DELAY_SECONDS`: Arm A defers by delay plus 60 s), and recomputes copy and timing from the current row (an eve SMS redispatched for an event now days out must not say "tomorrow"). A reschedule DELETE excludes `processing` rows so it never erases a live claim.
- Trigger: a sweep arm whose predicate is "row unfinished" rather than "primary dead"; a stored message body replayed by a reaper; a reschedule or purge DELETE whose status list includes `processing`.
- Lens: NEW `scheduler-review`.
- Defects caught (4): D1635, D1746, D1747, D2408.
- Row-truth docs: no.

**8. Prune and retention jobs name the external copies and the counters they feed.** A `DELETE FROM` in a prune (`pendingCall.js:160` `call_audit`, `webhookEventsPruneScheduler.js`, the 30-day voicemail ledger) states whether the provider-side object (a Twilio recording) is also deleted or deliberately retained, keeps its retention longer than any cap window that counts the table (24 h caps over `call_audit` under a 30-day prune), and never deletes rows a healer or a hold still reads (positive payroll adjustments in the orphan sweep).
- Trigger: `DELETE FROM` in any `*Scheduler*`, `*Sweep*`, `*Prune*` file or in `payrollAccrual.js`; a change to an `INTERVAL '30 days'` style retention; a new cap counting a pruned table.
- Lens: NEW `scheduler-review`.
- Defects caught (3): D2394, D2403, D2420.
- Row-truth docs: yes for the payroll sweep (held lines preserve `adjustment_cents`; the structure, not the provenance, decides).

**Not anticipable:** none; every scheduler defect in the record maps to one of the mechanisms above.

---

## Counts

- race-idempotency: 14 checks (112 defects; 2 listed as not anticipable, both still cited provisionally).
- pool-connection: 5 checks (9 defects; 1 not anticipable).
- scheduler-blast: 8 checks (15 defects; 0 not anticipable).
- NEW lenses: `concurrency-review` (race 1 to 14, pool 1 to 5), `scheduler-review` (scheduler 1 to 8). No check was forced into security-review, database-review, consistency-check, code-review or ui-ux-review; the lock-order table (race 4) and the pooler fact (pool 4) are the only items database-review should carry as reference.
