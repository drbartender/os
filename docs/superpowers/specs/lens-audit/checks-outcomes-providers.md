# Lens audit synthesis: error-handling, external-contract, config-env

Input: 167 defects (106 error-handling, 38 external-contract, 23 config-env) that no lens checklist as written would have flagged. The repo at /home/drbartender/projects/os was consulted read-only to name helpers, files and line numbers (as of 2026-10-19). Ids only; no names, no numbers.

## Lens assignment, up front

Two NEW lenses are proposed, because most of these defects are neither code quality nor OWASP, and the six existing agents never ask the question that would have caught them:

- **NEW: outcome-visibility.** For every side effect a change performs or skips (send, charge, credit, refund, cancel, accrue, notify), who learns the true result: the response, the ledger, an admin notice, a needs-attention row, or nobody. Five of the error-handling checks below belong here (1, 2, 3, 7, 12). This is the single largest mechanism in the record and it has no home today: code-review asks whether a try/catch exists, security-review A10 asks whether a catch is empty; none of these defects lacked a try/catch.
- **NEW: provider-contract.** What the third party actually does on the wire and in its dashboard: SDK option allowlists, the fields a payload really carries, event subscriptions, API version, live/test mode, TwiML listening state, a page's DOM, a proxy number's semantics, and the registration on the provider's side that makes a handler live. All but one external-contract check and one config-env check belong here.

The remaining config-env checks go to security-review A02 (which exists, but as written only greps `process.env.X || 'default'`) and one to consistency-check. Nothing was forced into code-review that is not about the code itself.

Money checks say whether the reviewer must read the row-truth rules. Those rules are moving to `docs/money-laws.md` (spec 2026-10-19, section 6.4); until that file lands they live in the memory glosses: acknowledged_total is row truth and create-intent's total is a projection; frozen rates; OFF_LEDGER_INVOICE_LABELS; the retainer survives full payment; which pay period is now is chicagoTodayYmd(), never SQL CURRENT_DATE.

---

## Class: error-handling (106 defects)

**Shape.** The dominant failure is not an uncaught exception; it is a caught or designed-in non-success reported upward as success. Helpers signal failure by return value rather than by throwing (`sendAndLogSms` returns `{ sid: null, status: 'skipped' }`, `sendEmail` returns `{ id: 'skipped-invalid' }`, `payrollAccrual` returns `{ skipped: true, reason: 'pay_period_not_open' }`, the cc-import promote helpers return `'errored'`), the Resend SDK never rejects, a skip branch fires `Sentry.captureMessage` and returns normally (110 such sites server-wide), and every caller up to the UI says "sent", "approved", 200. The second shape is fail-open on an absent input: a null coverage context, an empty roster, an omitted body flag, a legacy compat path, each resolving to the permissive branch (free mocktails and a free premium drink on proposal 728; a sent proposal with an invoice from an un-flagged create). Third, the transaction edge: side effects or their preconditions evaluated before COMMIT, and uncontained post-commit tails that 500 a persisted save and invite the admin to retry into a double send. Fourth, lookups and classifiers whose no-match branch returns a plausible wrong answer (a substring alias hit, `'custom'` falling to the unknown recipe, Twilio `'failed'` filed as a quiet `'missed'`). Fifth, stored state older than the code (legacy snapshots, rows that were never inserted, slugs that drifted out of the offered surface).

### Checks

1. **Read the status of every status-returning helper.** When a diff calls a helper that reports failure or skip by return value rather than by throwing, confirm the caller branches on that value and that the branch reaches the response, the ledger, or an admin notice; a bare `await helper(...)` statement on such a helper is a finding.
   Trigger: the diff adds or moves a call to `sendAndLogSms` (`server/utils/sms.js:222`; 13 bare-statement call sites exist today), `sendEmail` (`server/utils/email.js:60,67`), `notifyAdminCategory`, `sendMissedText`, `applyCoverCascade`, the cc-import promote helpers, a thumbtack-agent verify step, or any function whose return carries `status`, `skipped`, `error`, or null-on-failure; also any `resend.emails.send` / `.batch.send` outside `email.js` (the SDK resolves `{ data, error }` and never rejects).
   Lens: NEW: outcome-visibility.
   Defects: D0478, D0484, D0485, D0538, D0555, D0609, D0649, D0661, D0678, D0683, D0687, D0760 (12).

2. **A projection of what will be sent must be computed by the send path's own predicate.** When a diff builds an "available" / "will send" / preflight object, confirm each channel's availability derives from the same inputs the send later checks (token present, address not `.invalid`, consent flag, the COALESCE'd value the save uses) so the send cannot skip for a reason the projection called fine; a client touch with one channel needs a twin or a visible skip when that channel is gated off.
   Trigger: the diff touches `channels.<x>.available` / `unavailable_reason` in `server/utils/comms/actions/*.js`, `server/routes/proposals/notifyPreflight.js`, `server/utils/clientNotices.js`, the shopping-list approve-and-send modal, or adds a message type with a single channel.
   Lens: NEW: outcome-visibility.
   Defects: D0573, D0615, D0679, D0680, D0681, D0687, D0691 (7).

3. **A skip branch on a money or notification path needs a caller that surfaces it; `Sentry.captureMessage` is not a signal.** For every `return { skipped: true }`, early `return`, `continue`, or captureMessage-then-return the diff adds inside a utility, grep the export's callers and name the one that turns the skip into a response field, an admin notification, a needs-attention row, or a sweep; if none exists, it is a finding. An early return in a branch must not skip side effects the surrounding function always owes (the admin alert and the reply in the SMS opt-keyword branch).
   Trigger: the diff adds a skip or early return in `server/utils/payroll*.js`, `balanceScheduler.js` (`processEventCompletions` selects only `balance_paid`/`confirmed`, line 221), `beoFinalize.js`, `eventCreation.js`, `messageLog.js` (line 79 returns with no ledger row), `adminNotifications.js` (quota skip at line 199), `smsInbound.js`, an import parser, or any voice/VA chain step; or adds `Sentry.captureMessage` with no accompanying state change.
   Lens: NEW: outcome-visibility.
   Money: yes, read money-laws (which pay period is now; the payroll completion gate) before judging a payroll skip.
   Defects: D0572, D0655, D0666, D0670, D0675, D0677, D0690, D0709, D0715, D0716, D0718, D0746 (12).

4. **When a required input is absent, refuse or alert; never take the permissive branch.** For every null guard, default, or compat path the diff adds, state what happens when the input is missing (null context, empty rows, omitted body flag, legacy request without the asserted field, cleared numeric box, rejected VAPID pair) and confirm the result is not "charge less, send more, write more, advertise a key that will not work, or sign at the live total".
   Trigger: the diff adds `ctx !== null && enforce` or `if (!ctx) return []` (`server/routes/drinkPlans/submit.js:234-238` and `coverageEngine.js` are the standing example), `?? true`, `|| 0` on a numeric input before a PUT (107 such sites in `client/src` today), a `DEFAULT` on a consent, opt-in or charge flag in `schema.sql` (`communication_preferences` defaults `sms_enabled: true`, lines 2935 and 2991), a "legacy bundle" branch that skips an assertion, or a body flag whose default is the side-effecting value.
   Lens: security-review (A10 fail-closed, extended from `stripeClient.js` keys to every absent input).
   Money: yes, read money-laws (acknowledged_total is row truth; hosted coverage fails open while `package_items` is empty, an open trap).
   Defects: D0494, D0495, D0506, D0582, D0583, D0612, D0616, D0621, D0671, D0682 (10).

5. **Order the transaction edge: asserts and snapshots before COMMIT, side effects after it, every post-commit statement contained.** In any diff with `COMMIT` or `client.release()` followed by more work, confirm no email, SMS or Stripe call runs before COMMIT; no variable the tail reads was assigned from pre-commit state a failed commit would invalidate; any assert that should roll back runs before COMMIT; a row is marked done (`dispute_won_at`, a sent marker) only after the side effect returns; and every statement after COMMIT sits in its own try/catch that captures to Sentry and still answers 200 with a `tail_failed` field, so a persisted save is never reported as a 500 and retried.
   Trigger: the diff touches a file containing `'COMMIT'` (115 files; there is no `withTransaction` helper, and `cancelLineItem.js:159` "release BEFORE the tail" is the convention), calls `refreshDisplayName`, `logAdminAction` (whose never-throws contract is itself a thing to re-verify) or any notifier from inside a transaction.
   Lens: database-review (transaction safety, which today checks only that ROLLBACK exists).
   Defects: D0520, D0596, D0605, D0613, D0635, D0665, D0668, D0722, D0736 (9).

6. **A catch block classifies the error before it punishes.** When a diff adds a catch that signs out, purges a cache, marks a row terminally failed, rejects a request, or turns a policy refusal into a thrown Error, confirm it reads `err.status`, `err.code` or the error class first and applies the harsh remedy only to the matching kind (`AuthContext.js:17` now returns `'keep'` for anything but a 401; `scheduledMessageDispatcher.js:20` still flips any throw to `'failed'`, with quota deferred separately via `emailQuotaDefer.js`); a non-essential call after a successful write (a `/auth/me` refresh, an activity-log insert) must not fail the flow.
   Trigger: the diff adds `catch (err)` in `client/src/context/AuthContext.js`, a `removeItem`/purge inside a catch, `status = 'failed'` in a dispatcher, `cb(new Error(...))` in middleware, or a throw on a path where the write already succeeded.
   Lens: code-review.
   Defects: D0480, D0481, D0502, D0550, D0738 (5).

7. **A refusal reaches the human in a field the client renders, with the true reason and a way out.** For every 4xx the diff adds, and every guard that can refuse an in-progress client action, trace the error to the element that shows it in each client bundle (grep the field name under `client/src`), confirm the message names the real cause (archived, stale total, slug no longer offered, zero-delta on the curfew) rather than the nearest generic one, and confirm the user has an action (refresh, untick, retry) that does not dead-end, fall through to a success-looking response, or run into a limiter.
   Trigger: the diff adds `fieldErrors.<key>`, changes a 409/400 body, adds a guard to `publicToken.js`, `comms.js`, `serviceExtensions/publicAccept.js` or `drinkPlans/lab.js`, or adds a client error slot shared by two effects.
   Lens: NEW: outcome-visibility (the "is the field rendered" grep is a consistency-check step the lens runs itself).
   Defects: D0509, D0530, D0574, D0581, D0619, D0620 (6).

8. **A new throw site is inventoried against every caller.** When a diff makes a function throw where it used to return (removes a fallback, adds a required option, dereferences an optional upstream field, runs a formatter on stored data), grep every caller and confirm each supplies the precondition or catches; a formatter rendered on every page (`PresenceStrip`, `getEventTypeLabel`) must be wrapped.
   Trigger: the diff removes a `|| fallback` from a utility, adds a parameter without a default, reads `file.name`, `snapshot.package.x` or `client(opts).x` unguarded, or calls `Intl.*` / `path.extname` on DB or request data.
   Lens: consistency-check.
   Defects: D0472, D0508, D0598, D0684, D0692, D0705, D0749 (7).

9. **Missing or misordered bindings are a lint result, not a judgment call.** Run eslint with `no-undef` and `no-use-before-define` (the rule that caught D0491) over every changed JS file as the first step of the review and paste the count; an extraction that drops an import or a hook declared after the effect that reads it is caught here, not by reading.
   Trigger: any diff that moves code between files, extracts a route, or reorders hooks.
   Lens: code-review (mechanical step at the top of the run).
   Defects: D0491, D0645, D0739 (3; earns its place because two of the three threw ReferenceError on money routes at request time).

10. **A literal LIMIT with no cursor needs a truncation signal.** For every `LIMIT <literal>` the diff adds without OFFSET or keyset, and every client fetch relying on a default window, state whether the real population can exceed it; if it can, the response must carry `truncated` or a total and the client must show it, or the query must page.
    Trigger: `LIMIT [0-9]` in `server/routes` (34 such sites today, led by `shifts.js`, `emailMarketing/campaigns.js`, `shifts.queries.js`), or a `?limit=` default on a client fetch that feeds a worklist.
    Lens: database-review (query analysis; performance-review is becoming explicit-only and this is a correctness loss, not a speed one).
    Defects: D0487, D0585, D0586, D0625, D0632 (5).

11. **A lookup or classifier may not return a plausible wrong answer on no-match.** For every switch or if-chain over a status, label or type string, confirm every value the source can emit is enumerated and the default branch is a loud no-match (log, chip, alert, needs-attention), not the quietest outcome; for every fuzzy resolver, confirm the fallback cannot land on a different item (substring, head-noun, accent-stripped) without a visible no-match.
    Trigger: the diff adds `=== 'full_bar'`-style comparisons on a raw label, a `CallStatus` / `serving_type` / `event_type` branch, an inbound resolver, or any `.includes(` matching in `server/utils/potionCatalog.js` (`normalizeName` line 17, the alias-only index at line 117, the substring fallback at lines 143-167).
    Lens: code-review.
    Defects: D0663, D0707, D0727, D0728, D0729, D0730, D0742, D0743, D0745, D0756 (10).

12. **Money landing on a row in an unexpected state raises an admin-visible alert, and an existence guard names the row kinds it counts.** For every handler that credits `amount_paid`, creates tips, accrues payroll, or decides "already invoiced", enumerate the states the credit can land on (already paid, archived, voided, duplicate PaymentIntent, NULL `fee_cents`, an off-ledger invoice present) and confirm each unexpected one produces an admin notification or needs-attention row, not a breadcrumb; a shortfall a client email promised must be surfaced, not clamped.
    Trigger: the diff touches `server/routes/stripeWebhookHandlers/*`, `payrollAccrual.js`, refund math in `cancel.js` / `cancelLineItem.js`, or any `NOT EXISTS (SELECT ... FROM invoices ...)` guard.
    Lens: NEW: outcome-visibility.
    Money: yes, read money-laws (acknowledged_total row truth; any invoice-existence guard must join OFF_LEDGER_INVOICE_LABELS; refund scope).
    Defects: D0534, D0607, D0637, D0647, D0648, D0714 (6).

13. **Retry, replay and auto-reload loops: spaced beyond a plausible outage, replayed with full state, every terminal branch sets the marker the sweep keys on, and the guard is durable.** For every attempt counter, deferral or reload the diff adds, state the spacing (three tries inside three minutes spends the subject on any real outage), confirm the replay carries the original opts, confirm a skip is not charged as an attempt, confirm a quota or transient error defers rather than terminalizes, and confirm a client reload guard survives blocked storage and does not re-arm on a successful load.
    Trigger: the diff touches `payrollDeferredRetry.js`, `payrollLateTip.js`, `inbox/readJob.js`, `vaCallingScheduler.js`, `scheduledMessageDispatcher.js`, the stale-chunk handler in `client/src/App.js`, or adds `attempts + 1`, `deferred_at`, `rolled_forward_at`.
    Lens: code-review.
    Defects: D0467, D0468, D0469, D0574, D0700, D0721, D0724, D0738, D0755 (9).

14. **Stored state is older than the code: tolerate legacy shapes and rows that do not exist.** When a diff reads a nested stored shape, validates a stored value against today's catalog, narrows a write allow-list, UPDATEs a row it assumes exists, or short-circuits on "already processed", query the oldest live rows on the dev DB and confirm the code tolerates them; an UPDATE whose `rowCount` can be 0 must distinguish that from success (and from the other guards in its WHERE), and a short-circuit must check that the processed artifact exists.
    Trigger: the diff reads `snapshot.*.*`, compares stored slugs to an offered surface, edits a field pick-list on a PUT (`drinkPlans.js`), writes progress without an upsert (`onboardingProgress.js` now carries `ON CONFLICT DO NOTHING`), or adds `if (alreadyProcessed) return`.
    Lens: database-review (data integrity).
    Defects: D0508, D0567, D0580, D0581, D0619, D0692, D0711 (7).

**Not anticipable:**
- D0545: the process-level `unhandledRejection` / `uncaughtException` net was a one-time boot omission, present in `server/index.js` now; one line in security-review A10 ("both process-level handlers present") keeps it.
- D0566: an accepted scope gap (Cal.com strand-heal covers consult-creating events only), recorded as such in the ledger.
- D0740: a single missing fetch timeout; a timeout in the outbound-call convention beats a lens item.
- D0757: an off-box session dying silently is a monitoring gap on the box, not something a diff review sees.

---

## Class: external-contract (38 defects)

**Shape.** Every defect here is the code believing a provider's documented or remembered behavior rather than its observed one. Stripe: methods not pinned so any dashboard-enabled method could be offered, a completed session treated as paid without `payment_status`, events handled in code but never subscribed at the endpoint, an account API version that removed the `refunds` list the handler read (so `chargeRefunded.js` no-opped for its whole life), a list filter the provider rejects for manual payouts (156 throws since 2026-08-25), ids cached across modes. SDKs: a key the SDK silently drops (`reply_to` versus `replyTo`, seven months with no Reply-To), a default nobody passed (QR quiet zone), a canvas sized by device pixel ratio. Payload shapes: Cal.com wrapping values as `{ value, label }`, a numeric `rescheduleId` that is not the stored uid, a `booking.duration` real leads never send (0 of 157). Twilio: a prompt to press 1 outside the `<Gather>` that listens. And Thumbtack as a DOM contract: pristine-lead labels that differ from the allowlist, a Clear chip removed between two days, navigation on Send, a billing takeover page, a guessed URL that soft-404s; 40 of 40 leads failed for a month on one of these, all found in prod. No existing lens asks "what does the provider actually send or accept"; spec-risk asks what happens on a 5xx, which is not the failure mode.

### Checks

1. **Pin the payment method set and handle asynchronous settlement end to end.** For every PaymentIntent, Checkout Session or Payment Link the diff creates, confirm `payment_method_types` is the constant for that surface (`CHECKOUT_PAYMENT_METHOD_TYPES`, `PAYMENT_LINK_METHOD_TYPES`, `['card']` in `tipPaymentLinks.js`); if a delayed method is allowed, confirm `checkout.session.completed` checks `session.payment_status === 'paid'` (`checkoutSessionCompleted.js:157` does now), `payment_intent.processing` is handled, the object carries metadata that resolves the proposal, and nothing (an expiry sweep, a bartender clear) settles before the money arrives.
   Trigger: the diff touches `server/routes/stripe.js`, `stripeCreateIntent.js`, `server/utils/tipPaymentLinks.js`, `stripeWebhookHandlers/checkoutSessionCompleted.js`, or adds any `stripe.*.create(`.
   Lens: NEW: provider-contract.
   Money: yes, read money-laws (the `?paid=true` load beats the webhook; acknowledged_total is a projection at create-intent).
   Defects: D0837, D0838, D0839, D0840, D0858 (5).

2. **A webhook branch is live only if the endpoint subscribes to it, and a field exists only under the account's API version.** For every `event.type === '...'` branch the diff adds or relies on (today: `payment_intent.succeeded/processing/payment_failed`, `checkout.session.completed`, `refund.created`, `charge.refunded`, `charge.dispute.funds_withdrawn/reinstated`, `payout.paid/failed`; no `refund.failed`), show the endpoint's subscribed-events list (it is not in the repo; `docs/ops-runbook.md` carries one line) and add the event in the same change; for every field read off a Stripe object (`charge.refunds`, `payout.automatic`, `livemode`), confirm it is present under the account default version (`stripeClient.js` pins no `apiVersion`; endpoints inherit the account default) by reading a real event from `webhook_events`, not the docs; for every list filter, confirm the provider accepts it for every object variant.
   Trigger: the diff touches `server/routes/stripeWebhook.js`, `stripeWebhookHandlers/*`, `server/utils/stripePayoutSync.js`, or `refundSweepScheduler.js`.
   Lens: NEW: provider-contract.
   Money: yes, read money-laws (refund scope; tip clawback).
   Defects: D0841, D0842, D0856, plus config-env D1541, D1542 (3 + 2).

3. **Verify SDK option names and provider payload fields on the wire, not from memory.** For every options object passed to a third-party SDK and every field read from a provider payload, cite the evidence: the SDK's own parse allowlist in `node_modules` (Resend v6 reads `replyTo` and drops unknown keys), a captured real payload or a count from the DB (0 of 157 leads carried `booking.duration`), or a wire-asserting test (`email.replyTo.test.js` is the precedent); a default the SDK applies (`marginSize: 0`, a DPR-scaled canvas, no `ContentType` on `PutObject`) must be set explicitly when the output is printed, served or stored.
   Trigger: the diff calls `resend.*`, R2 `PutObject` in `storage.js`, `qrcode.react`, `html2canvas`, or reads `payload.*` in `calcomWebhookHelpers.js`, `thumbtackProposalDraft.js`, or any webhook helper.
   Lens: NEW: provider-contract.
   Defects: D0826, D0827, D0848, D0849, D0850, D0854, D0857 (7).

4. **TwiML: every invitation to press a key sits inside the `<Gather>` that listens, and every `<Play>` has a validated source or a `<Say>` fallback.** When a diff emits or edits TwiML, confirm a repeated briefing is inside the same `<Gather>` as the first reading; confirm each `<Play>` URL (the `VM_*_URL` overrides and the `voiceAssets.js` routes) is validated at boot or request time, because Twilio skips a failing `<Play>` silently and caches sources for the TTL; confirm the recorded greeting's words match the TwiML's listening state under every flag value.
   Trigger: the diff touches `server/routes/voice*.js`, `server/utils/voicemailTwiml.js`, `voiceAssets.js`, a greeting recording, or a `VM_*` / `VOICE_*` env read.
   Lens: NEW: provider-contract.
   Defects: D0846, D0847, plus error-handling D0660 and config-env D1578 (2 + 2).

5. **A page-driving agent proves state from the page, anchored to the thread, after hydration, and treats a site change as a site change.** For every step under `thumbtack-agent/src/` (or any Playwright driver: the GV spike, the harvester), confirm: selectors are scoped to the lead-thread container and never a page-wide `.first()` (a billing surface has Accept and Approve buttons); a send or fail verdict waits the hydration budget (`renderTimeoutMs`) and reads a post-condition that survives navigation (`sendVerify.js`; Thumbtack navigates away on Send); an unprovable state is a failure, never a success; a failure class that means the site changed (`template_not_found`, `lead_not_found`, a `/fullscreen-takeover` redirect, an empty label match) alerts as a site change with a stop-the-line admin notice, not as one lead's failure; label allowlists (`REPLY_CTA_LABELS`, `REPLY_CLEAR_LABELS`) include the pristine-lead variants observed on a real lead page; the change was spiked on one real page before shipping; the input the agent types into is verified by role and container before typing.
   Trigger: any diff under `thumbtack-agent/`, `server/routes/thumbtackAgent.js`, or a new browser-driving script.
   Lens: NEW: provider-contract.
   Defects: D0831, D0861, D0863, D0864, D0865, D0866, D0867, D0868, D0869, D0870 (10).

6. **Thumbtack's proxy number is not the client, and its webhook is not the thread.** When a diff reads `clients.phone` for a Thumbtack-sourced client, sends SMS to a lead, reads `thumbtack_messages` as the conversation, or returns non-2xx to the Thumbtack webhook, confirm: the number is treated as the per-lead relay until sign-and-pay captures a real one; a Twilio "delivered" is not read as "in the Thumbtack thread" (162 of 162 delivered, none in the thread); customer replies after the first message arrive only as relay SMS notices and must be parsed from them; a 503 answered to the provider counts as a failed delivery on its side and may trip its health check.
   Trigger: the diff touches `server/routes/thumbtack.js`, `server/utils/inbox/engine.js`, `thumbtackProposalDraft.js`, or any send keyed on a client whose source is thumbtack.
   Lens: NEW: provider-contract.
   Defects: D0830, D0844, D0851, D0862 (4).

7. **A carrier or compliance reviewer sees the cited URL cold, not the product flow.** When a diff touches an SMS consent surface or the A2P campaign copy, load the exact URL the campaign cites with no interaction and confirm the consent language and checkbox are visible there, the checkbox is optional, the phone field is optional, and the `message_flow` prose describes that page; a consent step on wizard step 2 does not exist to the reviewer.
   Trigger: the diff touches `client/src/pages/website/SmsOptInPage.js`, the QuoteWizard consent step, the legal or consent pages, or the Twilio campaign fields.
   Lens: ui-ux-review (page-level, with the A2P 10DLC rules as the artifact).
   Defects: D0828, D0829 (2; earns its place because three consecutive campaign rejections kept SMS unregistered in prod).

8. **Serving a stored asset across origins is a contract between the API, the browser and the asset host.** For every route that serves or redirects to a file consumed by the Vercel origin, state how the browser fetches it (`<img>`, XHR, `<a download>`) and confirm: a 302 to a signed URL is not followed cross-origin by XHR unless R2 CORS admits the origin; `Content-Type` is set on upload; `Cross-Origin-Resource-Policy` and `exposedHeaders` admit the consumer; and the asset host is an account the company controls (R2 under the company account, never a third-party CDN login).
   Trigger: the diff adds `res.redirect` to a signed URL, a file route in `server/routes/blog.js` or the files route, a `PutObject` in `storage.js`, or an `<img src>` to an external host.
   Lens: NEW: provider-contract (the middleware half is cross-referenced to config-env check 5).
   Defects: D0824, D0833, D0834, D0854, plus config-env D1558, D1569 (4 + 2).

9. **Stripe mode isolation: ids are mode-keyed, every client comes from `getStripe()`, and objects without `livemode` are guarded one level up.** For every Stripe id the diff caches or reads back (`stripe_customer_id` via `getOrCreateCustomer` in `stripeRouteHelpers.js`, payout ids), confirm it is stored or validated per mode; for every ingest into a mirror table, confirm the guard uses a field the object carries (balance transactions have no `livemode`; `stripePayoutSync.js:133` guards at the payout); grep the diff for `require('stripe')` or `new Stripe(` outside `stripeClient.js` (none today).
   Trigger: the diff touches `stripePayoutSync.js`, `balanceScheduler.js`, `getOrCreateCustomer`, or any `STRIPE_TEST_MODE_UNTIL` consumer.
   Lens: NEW: provider-contract.
   Money: no row-truth doc needed; the rule is mode isolation.
   Defects: D0836, D0855, plus config-env D1536, D1582 (2 + 2).

**Not anticipable:** none left uncovered. D0831 (the GV spike typing into the dialer) was a spike, not a shipped change, and is cited under check 5 only because "verify the target before typing" is the same rule.

---

## Class: config-env (23 defects)

**Shape.** Code on main was never the whole deploy. A handler existed but the provider dashboard never subscribed to the event (`charge.refunded`, `refund.failed`, the Resend bounce webhook, so the clawback handler had never once run from a live event); a Twilio number's `voice_url` still pointed at a retired vendor; VAPID and ADMIN_PHONE were "optional" and absent, so pushes and owner alerts were silently dark; a key was present but the wrong shape (an unscoped Anthropic key that 400s every call, a non-hex ENCRYPTION_KEY that truncated to unrecoverable ciphertext). Flags that gate outbound side effects default ON (`LEAD_CALL_ENABLED`; an expired `STRIPE_TEST_MODE_UNTIL` means LIVE), sibling features ride different flags so one half strands the other's rows, and middleware policies (the CORS allowlist, Helmet CORP, a 20-per-15-minute public limiter shared by three calls of one checkout) were written for one caller class and broke another. The consistency-check asks only ".env.example? render.yaml?"; security-review A02 greps `process.env.X || default`. Neither asks what unset, expired, wrong-shaped, or provider-side-unregistered does at runtime.

### Checks

1. **Every env read is validated at boot for the shape its consumer needs, and a feature whose env is absent reports itself dark on an admin surface.** For every new `process.env.X` in the diff, name where X is validated (the prod-only `requiredEnv` list in `server/index.js`, an `envInt.js`-style parser, a boot probe) and state what the consumer does when X is unset, empty, malformed, or valid-looking but wrong (a key without the workspace scope returns 400 on every call; a longer-than-64 or non-hex key truncates through `Buffer.from(key, 'hex')`; a URL that 404s makes Twilio play silence; an empty parsed allowlist burns retries; a rejected VAPID pair is still advertised); presence is not validation, and "first customer call fails" is a finding.
   Trigger: the diff adds a `process.env` read, a `setVapidDetails`, a `new Anthropic`, a `Buffer.from(key, 'hex')`, a URL override, or a list parsed from env.
   Lens: security-review (A02, boot validation).
   Defects: D1539, D1568, D1581, D1587, D1596, plus error-handling D0660, D0671 (5 + 2).

2. **A flag that gates an outbound side effect defaults OFF, and the unset, expired and false states are each named with their effect.** For every flag the diff adds or reads (`!== 'false'` is default-on: `CONSULT_CALL_ENABLED`, `VM_LISTEN_LINK_ENABLED`, `RUN_INBOX_READ_SCHEDULER`; `=== 'false'` as the only kill: `LEAD_CALL_ENABLED`; `=== 'true'` is default-off; a date cutoff expires), list the consumers (grep the name across `server/`) and state what each does when the var is unset in Render, when a dated sample copied from `.env.example` has passed, and when the value is false; a default that places calls, sends texts, mints a sent proposal, or talks to live Stripe must be opt-in, and a time-based toggle must alert at expiry rather than silently flip.
   Trigger: the diff adds `process.env.X !== 'false'`, `=== 'true'`, `|| <value>`, a body flag defaulting to the side-effecting value, or a dated sample value in `.env.example`.
   Lens: security-review (A02, defaults).
   Money: D1536 and D1582 reach live Stripe; no row-truth doc needed.
   Defects: D1536, D1538, D1582, D1590, plus error-handling D0612 (4 + 1).

3. **Siblings that share a lifecycle share a flag, and every on/off combination leaves every row terminal and every artifact truthful.** When a diff adds a scheduler, sweep, reaper, or `*_ENABLED` / `RUN_*_SCHEDULER` flag (about twenty scheduler flags exist, gated by `enabled()` in the scheduler block of `server/index.js`), identify the producer of the rows it consumes and the reaper of the rows it produces, confirm they ride the same flag or that each combination of values is enumerated and safe (producer on, reaper off strands rows holding a daily-cap slot), and confirm no static artifact (a recorded greeting, printed copy) promises a behavior the flag can switch off.
   Trigger: the diff touches the scheduler block of `server/index.js`, adds a flag read in `server/utils/*Scheduler.js` or `*Sweep.js`, or changes TwiML under a flag.
   Lens: consistency-check.
   Defects: D1578, D1585 (2; earns its place because both stranded live calls in prod and the mechanism recurs with every new scheduler flag).

4. **Provider-side registration ships in the same change as the handler, with a probe that proves it.** For every webhook branch, push path, phone-line behavior or provider credential the diff adds, name the dashboard setting that makes it live (the Stripe endpoint's subscribed events; the Resend webhook URL and svix secret; a Twilio number's `voice_url` / `sms_url`; Render and Vercel env), add the line to `docs/ops-runbook.md`, and name the probe that proves it before the feature is called live (a row in `webhook_events` or `email_webhook_events` from a real event; the key smoke for a new Anthropic key; a test call to the line); a handler that has never received its event in prod is dark, not done.
   Trigger: the diff adds `event.type === '...'`, a `/webhook` route, a `VAPID_*` / `ANTHROPIC_*` / `TWILIO_*` read, or retires a vendor whose URLs a provider still holds.
   Lens: NEW: provider-contract.
   Money: D1541 and D1542 are refund and clawback paths; read money-laws (refund scope; tip clawback).
   Defects: D1539, D1540, D1541, D1542, D1544, D1581 (6).

5. **Middleware policies enumerate the caller classes they must admit, and a policy refusal is a 4xx, not a thrown Error.** When a diff touches the CORS allowlist, `corsOptions.js`, Helmet or `rateLimiters.js`, list each caller class (a browser from each Vercel origin including the hiring and staff subdomains; an API-served form whose Origin is null; a server-to-server webhook with no Origin; a bot) and the response each gets; a non-allowlisted origin must get a quiet 403 (`cb(new Error('Not allowed by CORS'))` at `corsOptions.js:18` still becomes a 500 and an error-level Sentry event); cross-origin file and image routes need `Cross-Origin-Resource-Policy` and `exposedHeaders`; a limiter's window must exceed the request count of one legitimate flow (proposal load, resolve, create-intent and retries drew about 18 on 2026-08-28 against a 20-per-15-minute limiter).
   Trigger: the diff touches the middleware stack in `server/index.js`, `server/middleware/corsOptions.js`, `rateLimiters.js`, helmet options, or adds a public form the API itself serves.
   Lens: security-review (A02).
   Defects: D1558, D1561, D1562, D1569, D1570, plus error-handling D0550 (5 + 1).

6. **The host is not the laptop: ephemeral disk, production dependency scope, a scrubbed service environment.** When a diff writes to the local filesystem under `server/`, adds a top-level `require`, or edits a systemd unit or launcher, confirm: persistent data goes to the DB or R2 (Render's disk is wiped on deploy); the package is in `dependencies`, checked with `npm ls --omit=dev <pkg>`; the unit scrubs `WAYLAND_DISPLAY`, `DISPLAY`, `XAUTHORITY` and `XDG_SESSION_TYPE` and pins `OZONE_PLATFORM=x11` before launching Chrome.
   Trigger: `fs.writeFile` / `appendFile` under `server/`, a `package.json` change, or a diff under `thumbtack-agent/systemd/`.
   Lens: security-review (A02 for the host assumptions, A03 for dependency scope).
   Defects: D1551, D1575, D1598 (3).

**Not anticipable:** none left uncovered. D1598 is the weakest fit: it took two scrubs to find `XDG_SESSION_TYPE`, and a check can only say "scrub the known list", so expect it to recur with a new variable.

---

## Cross-class notes for the rewrite

- Ids cited in two classes (D0550, D0612, D0660, D0671, D1536, D1541, D1542, D1558, D1569, D1578, D1582) sit where the mechanism is, with the class of record noted; the rewrite should keep one home per check and let the other lens cross-reference it, so no lens double-reports.
- outcome-visibility should run on every tier that performs a side effect, which in this codebase is nearly every server diff; it is cheap (grep the helper's callers, trace one field to the UI) and it would have caught 42 of the 106 error-handling defects on its own.
- provider-contract needs two inputs the other lenses do not: read access to `node_modules` for SDK parse allowlists, and the dev DB for a real captured payload (`webhook_events`, `thumbtack_messages`, `email_webhook_events`); the brief should hand it both, and for Thumbtack DOM work the verdict table should carry a "spiked on a real page: yes/no" column, because a checklist cannot anticipate the next removed chip.
