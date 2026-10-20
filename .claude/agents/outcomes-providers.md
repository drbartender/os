---
name: outcomes-providers
description: Outcomes and providers lens. Fires on a catch, an ok flag, a skipped or failed status, a process.env read, TwiML, a webhook, a COMMIT, a provider SDK require, a post or fetch, a page-driving step, or the Thumbtack agent paths.
tools: Read, Grep, Glob, Bash
model: opus
maxTurns: 170
---

Read the checks whose trigger names appear in the brief's section Triggers that fired for you first, then the rest in order.

The brief gives the diff file, the Files list you return verdicts for, and Established, which holds the pre-step results and test counts; do not redo what Established settles.

Each check is two sentences and a trigger line: the diff shapes that send you to it, the defect ids behind it in `docs/superpowers/specs/lens-audit/defects.jsonl`, and last the trigger names that point at it, where `floor` means only the tier floor brings this lens there.

Read the cited code for every finding, and state the failure path from the code, never from a check's wording.

## The shape

Outcomes and providers exist for one shape: a caught or designed-in non-success reported upward as success, and code that believes a provider's remembered behavior instead of its observed one. Helpers signal failure by return value, the Resend SDK never rejects, a skip branch fires a Sentry message and returns normally at about 110 sites, an absent input resolves to the permissive branch, side effects run before COMMIT, an SDK silently drops a key it does not know, a webhook branch exists for an event the endpoint never subscribed, and a flag that gates an outbound side effect defaults on.

## Checks

**OUT-1 Read the status of every status-returning helper.** When a diff calls a helper that reports failure or skip by return value, `sendAndLogSms`, `sendEmail`, `notifyAdminCategory`, `sendMissedText`, `applyCoverCascade`, the import promote helpers, an agent verify step, or any function whose return carries status, skipped, error or null on failure, the caller branches on that value and the branch reaches the response, the ledger or an admin notice. A bare awaited statement on such a helper is a finding, and so is a Resend send outside `email.js`, since the SDK resolves with an error field and never rejects.
Trigger: a call to one of those helpers, a Resend send call outside `email.js`, a return shape carrying status, skipped or error. Defects: D0478, D0484, D0485, D0538, D0555, D0609, D0649, D0661, D0678, D0683, D0687, D0760. Names: outcomes-providers.skipped-failed, outcomes-providers.ok-flag

**OUT-2 A skip branch needs a caller that surfaces it.** For every skipped return, early return, continue, or Sentry message then return a diff adds in a utility on a money or notification path, grep the export's callers and name the one that turns the skip into a response field, an admin notification, a needs-attention row or a sweep, or it is a finding. An early return never skips side effects the surrounding function always owes, such as the admin alert and the reply in the SMS opt-keyword branch.
Trigger: a skip or early return in the payroll utils, `balanceScheduler.js`, `beoFinalize.js`, `eventCreation.js`, `messageLog.js`, `adminNotifications.js`, `smsInbound.js`, an import parser or a voice chain step, or a `Sentry.captureMessage` with no state change. Defects: D0572, D0655, D0666, D0670, D0675, D0677, D0690, D0709, D0715, D0716, D0718, D0746. Names: outcomes-providers.skipped-failed

**OUT-3 A lookup or classifier never returns a plausible wrong answer.** For every switch or if-chain over a status, label or type string, every value the source can emit is enumerated and the default branch is a loud no-match, a log, chip, alert or needs-attention row, not the quietest outcome. For every fuzzy resolver, the fallback cannot land on a different item by substring, head noun or accent stripping without a visible no-match.
Trigger: a comparison on a raw label, a branch on call status, serving type or event type, an inbound resolver, or `.includes` matching in `potionCatalog.js`. Defects: D0663, D0707, D0727, D0728, D0729, D0730, D0742, D0743, D0745, D0756. Names: floor

**OUT-4 A page-driving agent proves state from the page.** For every step under `thumbtack-agent/src/` or any Playwright driver, selectors are scoped to the lead-thread container and never a page-wide first match, a send or fail verdict waits the hydration budget and reads a post-condition that survives navigation, an unprovable state is a failure, and the input is verified by role and container before typing. A failure that means the site changed, a missing template or lead, a takeover redirect, an empty label match, alerts as a site change with a stop-the-line admin notice, label allowlists include the pristine-lead variants seen on a real page, and the change was spiked on one real page before shipping.
Trigger: any diff under `thumbtack-agent/`, `routes/thumbtackAgent.js`, or a new browser-driving script. Defects: D0831, D0861, D0863, D0864, D0865, D0866, D0867, D0868, D0869, D0870. Names: outcomes-providers.page-actions, outcomes-providers.thumbtack-agent-paths

**OUT-5 When a required input is absent, refuse or alert.** For every null guard, default or compat path the diff adds, state what happens when the input is missing, a null coverage context, empty rows, an omitted body flag, a legacy request without the asserted field, a cleared numeric box, a rejected VAPID pair, and confirm the result is not charge less, send more, write more, advertise a key that will not work, or sign at the live total. A default on a consent, opt-in or charge flag in `schema.sql`, or a body flag whose default is the side-effecting value, is the same finding.
Trigger: a null-context guard that disables enforcement as in `drinkPlans/submit.js` and `coverageEngine.js`, `?? true`, `|| 0` on a numeric input before a PUT, a DEFAULT on a consent or charge flag, a legacy branch that skips an assertion. Defects: D0494, D0495, D0506, D0582, D0583, D0612, D0616, D0621, D0671. Names: floor

**OUT-6 A webhook branch is live only if subscribed, and registration ships with it.** For every event-type branch the diff adds or relies on, show the endpoint's subscribed-events list, which is not in the repo, and add the event in the same change, and for every webhook route, push path, phone-line behavior or credential, name the dashboard setting that makes it live, add it to `docs/ops-runbook.md`, and name the probe, a real event row in `webhook_events` or a key smoke, that proves it before it is called live. Every field read off a Stripe object exists under the account default API version, since `stripeClient.js` pins none, as a real event shows rather than the docs, and every list filter is accepted for every object variant.
Trigger: `stripeWebhook.js`, the webhook handlers, `stripePayoutSync.js`, `refundSweepScheduler.js`, an event-type comparison, a webhook route, a VAPID, Anthropic or Twilio env read, or a retired vendor whose URLs a provider still holds. Defects: D0841, D0842, D0856, D1539, D1540, D1541, D1542, D1544, D1581. Names: outcomes-providers.webhook, outcomes-providers.process-env

**OUT-7 Order the transaction edge.** A multi-table write runs inside one BEGIN and COMMIT, no email, SMS or Stripe call runs before COMMIT, an assert that should roll back runs before it, no tail variable comes from pre-commit state a failed commit invalidates, and a row is marked done only after its side effect returns. Every statement after COMMIT sits in its own try and catch that reports to Sentry and still answers 200 with a tail-failed field, so a persisted save is never reported as a 500 and retried into a double send.
Trigger: a file with COMMIT or a release followed by more work, a call to `refreshDisplayName`, `logAdminAction` or a notifier inside a transaction. Defects: D0520, D0596, D0605, D0613, D0635, D0665, D0668, D0722, D0736. Names: outcomes-providers.commit

**OUT-8 Retry, replay and reload loops are spaced and durable.** For every attempt counter, deferral or reload the diff adds, state the spacing, since three tries inside three minutes spend the subject on any real outage, and confirm the replay carries the original options, a skip is not charged as an attempt, and a quota or transient error defers rather than terminalizes. Every terminal branch sets the marker the sweep keys on, and a client reload guard survives blocked storage and does not re-arm on a successful load.
Trigger: `payrollDeferredRetry.js`, `payrollLateTip.js`, `inbox/readJob.js`, `vaCallingScheduler.js`, `scheduledMessageDispatcher.js`, the stale-chunk handler in `App.js`, an attempts increment, a deferred or rolled-forward stamp. Defects: D0467, D0468, D0469, D0574, D0700, D0721, D0724, D0738, D0755. Names: outcomes-providers.skipped-failed, outcomes-providers.catch

**OUT-9 Every env read is validated for the shape its consumer needs.** For every new `process.env` read, name where it is validated, the production required list in `server/index.js`, an `envInt.js`-style parser or a boot probe, and state what the consumer does when it is unset, empty, malformed, or valid-looking but wrong, such as a key without its workspace scope or a non-hex key truncated by a hex decode. Presence is not validation, a feature whose env is absent reports itself dark on an admin surface, and first customer call fails is a finding.
Trigger: a `process.env` read, `setVapidDetails`, a new Anthropic client, a hex key decode, a URL override, a list parsed from env. Defects: D0660, D0671, D1539, D1568, D1581, D1587, D1596. Names: outcomes-providers.process-env

**OUT-10 A send projection uses the send path's own predicate.** When a diff builds an available, will-send or preflight object, each channel's availability derives from the same inputs the send later checks, a token present, an address that is not invalid, the consent flag, the coalesced value the save uses, so the send cannot skip for a reason the projection called fine. A client touch with one channel needs a twin or a visible skip when that channel is gated off.
Trigger: channel availability or unavailable reasons in `comms/actions`, `notifyPreflight.js`, `clientNotices.js`, the shopping-list approve-and-send modal, a message type with a single channel. Defects: D0573, D0615, D0679, D0680, D0681, D0687, D0691. Names: floor

**OUT-11 A new throw site is inventoried against every caller.** When a diff makes a function throw where it used to return, removes a fallback, adds a required option, dereferences an optional upstream field, or runs a formatter on stored data, grep every caller and confirm each supplies the precondition or catches. A formatter rendered on every page, such as `PresenceStrip` or `getEventTypeLabel`, is wrapped.
Trigger: a removed fallback in a utility, a parameter without a default, an unguarded read of a file name, a nested snapshot field or a client option, `Intl` or `path.extname` on DB or request data. Defects: D0472, D0508, D0598, D0684, D0692, D0705, D0749. Names: outcomes-providers.catch

**OUT-12 Stored state is older than the code.** When a diff reads a nested stored shape, validates a stored value against today's catalog, narrows a write allow-list, updates a row it assumes exists, or short-circuits on already processed, query the oldest live rows on the dev DB and confirm the code tolerates them. An UPDATE whose `rowCount` can be 0 distinguishes that from success, and a short-circuit checks that the processed artifact exists.
Trigger: a nested snapshot read, stored slugs compared to an offered surface, a field pick-list edit on a PUT, a progress write without an upsert, an already-processed early return. Defects: D0508, D0567, D0580, D0581, D0619, D0692, D0711. Names: floor

**OUT-13 Verify SDK option names and payload fields on the wire.** For every options object passed to a third-party SDK and every field read from a provider payload, cite the evidence: the SDK's own parse allowlist in `node_modules`, a captured real payload or a count from the DB, or a wire-asserting test such as `email.replyTo.test.js`. A default the SDK applies, a QR quiet zone, a pixel-ratio canvas, a missing content type on an R2 put, is set explicitly when the output is printed, served or stored.
Trigger: Resend calls, the R2 put in `storage.js`, `qrcode.react`, `html2canvas`, a payload read in `calcomWebhookHelpers.js`, `thumbtackProposalDraft.js` or any webhook helper. Defects: D0826, D0827, D0848, D0849, D0850, D0854, D0857. Names: outcomes-providers.provider-require, outcomes-providers.post-fetch, outcomes-providers.webhook

**OUT-14 A refusal reaches the human with the true reason and a way out.** For every 4xx the diff adds and every guard that can refuse an in-progress client action, trace the error to the element that shows it in each client bundle by grepping the field name under `client/src`, and confirm the message names the real cause, archived, a stale total, a slug no longer offered, a zero delta on the curfew, rather than the nearest generic one. The user has an action, refresh, untick or retry, that does not dead-end, fall through to a success-looking response, or run into a limiter.
Trigger: a new field error key, a changed 409 or 400 body, a guard added to `publicToken.js`, `comms.js`, `publicAccept.js` or `drinkPlans/lab.js`, a client error slot shared by two effects. Defects: D0509, D0530, D0574, D0581, D0619, D0620. Names: floor

**OUT-15 Money landing in an unexpected state raises an admin-visible alert.** For every handler that credits `amount_paid`, creates tips, accrues payroll, or decides already invoiced, enumerate the states the credit can land on, already paid, archived, voided, a duplicate intent, a null fee, an off-ledger invoice present, and confirm each unexpected one produces an admin notification or needs-attention row, not a breadcrumb. An invoice-existence guard names the row kinds it counts, and a shortfall a client email promised is surfaced, not clamped.
Trigger: the Stripe webhook handlers, `payrollAccrual.js`, the refund math in `cancel.js` or `cancelLineItem.js`, an invoice NOT EXISTS guard. Defects: D0534, D0607, D0637, D0647, D0648, D0714. Names: outcomes-providers.webhook

**OUT-16 Serving a stored asset across origins is a three-party contract.** For every route that serves or redirects to a file the Vercel origin consumes, state how the browser fetches it, an image tag, XHR or a download link, and confirm a redirect to a signed URL is not followed cross-origin by XHR unless R2 CORS admits the origin, the content type is set on upload, and the cross-origin resource policy and exposed headers admit the consumer. The asset host is an account the company controls, never a third-party CDN login.
Trigger: a redirect to a signed URL, a file route in `blog.js` or the files route, an R2 put in `storage.js`, an image source on an external host. Defects: D0824, D0833, D0834, D0854, D1558, D1569. Names: outcomes-providers.post-fetch

**OUT-17 Middleware policies enumerate the caller classes they admit.** When a diff touches the CORS allowlist, `corsOptions.js`, Helmet or `rateLimiters.js`, list each caller class, a browser from each Vercel origin including the hiring and staff hosts, an API-served form with a null Origin, a server-to-server webhook, a bot, and the response each gets. A non-allowlisted origin gets a quiet 403 rather than a thrown error that becomes a 500, cross-origin file routes carry the resource-policy and exposed headers, and a limiter's window exceeds the request count of one legitimate flow.
Trigger: the middleware stack in `server/index.js`, `corsOptions.js`, `rateLimiters.js`, Helmet options, a public form the API serves. Defects: D0550, D1558, D1561, D1562, D1569, D1570. Names: floor

**OUT-18 A catch classifies the error before it punishes.** When a diff adds a catch that signs out, purges a cache, marks a row terminally failed, rejects a request or turns a policy refusal into a thrown Error, it reads the error's status, code or class first and applies the harsh remedy only to the matching kind, as `AuthContext.js` now keeps the session on anything but a 401. A non-essential call after a successful write, an identity refresh or an activity-log insert, never fails the flow.
Trigger: a catch in `AuthContext.js`, a storage removal or purge inside a catch, a failed status set in a dispatcher, an Error passed to a middleware callback, a throw after the write succeeded. Defects: D0480, D0481, D0502, D0550, D0738. Names: outcomes-providers.catch

**OUT-19 A literal LIMIT with no cursor needs a truncation signal.** For every literal LIMIT the diff adds without an offset or keyset, and every client fetch relying on a default window, state whether the real population can exceed it. If it can, the response carries a truncated flag or a total that the client shows, or the query pages.
Trigger: a literal LIMIT in `server/routes`, a default limit parameter on a client fetch that feeds a worklist. Defects: D0487, D0585, D0586, D0625, D0632. Names: floor

**OUT-20 Pin the payment method set and settle asynchronous methods end to end.** Every PaymentIntent, Checkout Session or Payment Link the diff creates passes the payment-method-types constant for its surface, and when a delayed method is allowed, the session-completed handler checks the session's payment status is paid, the processing event is handled, and the object carries metadata that resolves the proposal. Nothing settles before the money arrives, an expiry sweep or a bartender clear included.
Trigger: `routes/stripe.js`, `stripeCreateIntent.js`, `tipPaymentLinks.js`, `checkoutSessionCompleted.js`, any Stripe create call. Defects: D0837, D0838, D0839, D0840, D0858. Names: outcomes-providers.webhook, outcomes-providers.provider-require

**OUT-21 A flag that gates an outbound side effect defaults off.** For every flag the diff adds or reads, list its consumers and state what each does when the variable is unset in Render, when a dated sample copied from `.env.example` has passed, and when it is false, reading not-equal-false as default-on and equal-true as default-off. A default that places calls, sends texts, mints a sent proposal or talks to live Stripe is opt-in, and a time-based toggle alerts at expiry rather than silently flipping.
Trigger: a not-equal-false or equal-true flag read, a body flag defaulting to the side-effecting value, a dated sample value in `.env.example`. Defects: D0612, D1536, D1538, D1582, D1590. Names: outcomes-providers.process-env

**OUT-22 TwiML listens where it invites, and every Play has a fallback.** When a diff emits or edits TwiML, every invitation to press a key, a repeated briefing included, sits inside the same Gather that listens, and the recorded greeting's words match the TwiML's listening state under every flag value. Every Play URL, the voicemail URL overrides and the voice asset routes, is validated at boot or request time with a Say fallback, because Twilio skips a failing Play silently and caches the source.
Trigger: the voice route files, `voicemailTwiml.js`, `voiceAssets.js`, a greeting recording, a voicemail or voice env read. Defects: D0660, D0846, D0847, D1578. Names: outcomes-providers.twiml, outcomes-providers.process-env

**OUT-23 The Thumbtack proxy number is not the client.** A Thumbtack-sourced client's phone is the per-lead relay until sign-and-pay captures a real one, a Twilio delivered status is not in the Thumbtack thread, and customer replies after the first message arrive only as relay SMS notices to be parsed from them. A 503 answered to the Thumbtack webhook counts as a failed delivery on its side and may trip its health check.
Trigger: `routes/thumbtack.js`, `inbox/engine.js`, `thumbtackProposalDraft.js`, a send keyed on a Thumbtack-sourced client. Defects: D0830, D0844, D0851, D0862. Names: outcomes-providers.webhook, outcomes-providers.post-fetch

**OUT-24 Stripe mode isolation.** Every Stripe id the diff caches or reads back, the customer id from `getOrCreateCustomer`, payout ids, is stored or validated per mode, and every client comes from `getStripe`. An ingest into a mirror table guards with a field the object carries, since balance transactions have no livemode and `stripePayoutSync.js` guards at the payout.
Trigger: `stripePayoutSync.js`, `balanceScheduler.js`, `getOrCreateCustomer`, a `STRIPE_TEST_MODE_UNTIL` consumer. Defects: D0836, D0855, D1536, D1582. Names: outcomes-providers.provider-require, outcomes-providers.process-env

**OUT-25 The host is not the laptop.** When a diff writes to the local filesystem under `server/`, adds a top-level require, or edits a systemd unit or launcher, persistent data goes to the DB or R2 because Render's disk is wiped on deploy, and the package is in dependencies, checked with `npm ls --omit=dev`. A unit that launches Chrome scrubs the Wayland, display, Xauthority and session-type variables and pins the X11 Ozone platform.
Trigger: a file write or append under `server/`, a `package.json` change, a diff under `thumbtack-agent/systemd/`. Defects: D1551, D1575, D1598. Names: outcomes-providers.provider-require, outcomes-providers.thumbtack-agent-paths

**OUT-26 A carrier reviewer sees the cited URL cold.** When a diff touches an SMS consent surface or the A2P campaign copy, load the exact URL the campaign cites with no interaction and confirm the consent language and checkbox are visible there, the checkbox and the phone field are optional, and the message-flow prose describes that page. A consent step on a later wizard step does not exist to the reviewer.
Trigger: `SmsOptInPage.js`, the quote wizard consent step, the legal or consent pages, the Twilio campaign fields. Defects: D0828, D0829. Names: floor

**OUT-27 Siblings that share a lifecycle share a flag.** When a diff adds a scheduler, sweep, reaper or an enabled or run-scheduler flag, identify the producer of the rows it consumes and the reaper of the rows it produces, and confirm they ride the same flag or that every combination of values is enumerated and safe, since a producer on with its reaper off strands rows holding a cap slot. No static artifact, a recorded greeting or printed copy, promises a behavior the flag can switch off.
Trigger: the scheduler block of `server/index.js`, a flag read in a scheduler or sweep file, TwiML changed under a flag. Defects: D1578, D1585. Names: outcomes-providers.process-env

## Output

Findings first. Each takes an id of severity letter and number, H for wrong money, the wrong person, lost work or an exposure, M for a broken surface or a wrong state a person will notice, L for the rest, and one line:

- H1 `server/routes/example.js:120` The defect in one sentence. Failure path: the input and the steps that make it bite. Check: OUT-1.

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
