# Comms Send Modal + Delivery Integrity

**Date:** 2026-07-18
**Status:** Approved in brainstorm (Dallas, 7/18). Sections approved conversationally; this doc is the byproduct.
**Companion plan:** `docs/superpowers/plans/2026-07-18-comms-send-modal-delivery-integrity.md`

## 1. Why (incident summary, verified)

Brandon Martin's wedding (7/18) shopping list never reached him. Verified chain, from prod data + Sentry traces:

1. Approve clicked 7/16 18:29 UTC. Route ran on prod (Sentry-sampled PATCH trace), status flipped, email **was sent** (`POST https://api.resend.com/emails` span present) to `drink_plans.client_email`, a stale Apple relay address frozen at plan creation (6/29). His real email changed to gmail ~7/1 on the client record; nothing syncs plan rows.
2. `logClientMessage` silently skipped the ledger row: `messageLog.js:69` returns when the recipient matches no client, and the same staleness that killed delivery also killed the lookup. No log row, no error.
3. Bounce invisible: `email_webhook_events` has zero rows ever. The Resend webhook handler exists and fails closed, but Sentry shows its missing-secret path never fired in 90 days: **the webhook was never registered in the Resend dashboard.**
4. Modal showed "Approved & Sent."

Same class, other clients (verified in prod):

- **Cathy Murphy** (event 7/25): duplicate client records #1427 (`cmurphy@arthrex-chicago.com`, real) and #1436 (`...conm`, typo, nonexistent TLD). Booking hangs off the typo record. All 4 shopping-list sends plus every email since 7/4 went to `.conm`, all marked "sent."
- **Siddhant Khaitan** (event 7/23): 5 shopping-list emails delivered, but post-approve edits reverted the list to `pending_review`; every link in his inbox shows the pending screen.
- **Aaran Varatharajan** (6/6, historical): same stale-relay signature as Brandon.
- Plans approved with no email on file (Tabitha Lopez, Michael Sawula): silent no-send behind an "Approved & Sent" button.

Five holes: (1) bounce blindness, (2) no capture-time address validation or dup detection, (3) stale `drink_plans.client_email` snapshots, (4) the approved-then-edited revert trap, (5) sends that silently skip while the UI claims success.

## 2. Goals

- Every admin-click client send passes through one compose-and-confirm modal: recipient visible, channels selectable, message editable, result honest.
- Recipient is resolved live from the client record at preview and at send.
- Every send attempt leaves a `message_log` row, success or failure, resolvable client or not.
- Bounces become visible: ledger status, needs-attention row, admin alert email.
- An approved shopping list never turns into a dead link for the client.
- Obvious address typos and duplicate clients get caught at capture time.

## 3. Non-goals

- Scheduler-driven sends (event eve, one week, balance reminders) keep firing automatically. They adopt the shared live-recipient resolver but get no compose step.
- Staff SMS blast (`Messages.js`) and marketing campaigns keep their existing compose UIs.
- No raw HTML editing. Prose only; brand shell and action links stay fixed.
- No client-record merge tooling. Cathy's dup is repaired by hand (L0); a merge feature is out of scope.

## 4. Design

### 4.1 Comms registry (server)

New module `server/utils/comms/` with one registered action per admin-click send. Each action declares:

| Field | Meaning |
|---|---|
| `key` | e.g. `shopping_list_approve`, `proposal_resend`, `invoice_send` |
| `resolveRecipient(entityId)` | Live lookup: client name, email, phone via the proposal join; falls back to the entity snapshot only when no client is linked (standalone lead plans). Returns `source` (`client` or `snapshot`) and `warnings[]` |
| `buildMessages(entity)` | Returns `{ email: { subject, bodyText, cta: { label, url } }, sms: { body } }`. `bodyText` is editable prose; `cta` renders as the fixed link block |
| `defaultChannels` | Per action, see 4.5 |
| `execute(entityId, message, channels)` | Performs side effects (status flip, invoice create) then sends, in that order, and always logs |

Existing template builders in `emailTemplates.js` / `lifecycleEmailTemplates.js` are reused: builders gain an additive export of `{ subject, bodyText, cta }` alongside the current `{ subject, html, text }` so untouched callers (schedulers) keep working.

### 4.2 Endpoints

- `POST /api/comms/preview` `{ action, entityId }` (auth, admin/manager) returns:
  `{ recipient: { name, email, phone, source }, warnings: [], channels: { email: { available, default }, sms: { available, default } }, email: { subject, bodyText, cta }, sms: { body } }`
- `POST /api/comms/send` `{ action, entityId, channels, email: { subject, bodyText }, sms: { body } }` executes the action and returns:
  `{ ok, emailSent, smsSent, recipientEmail, recipientPhone, skipped: { email: reason|null, sms: reason|null } }`

Warnings surfaced at preview: recipient email domain looks like a typo (see 4.8 list), entity snapshot differs from the live client record, recipient email missing, phone missing or unparseable, hosted package (email skipped by design, see 4.6).

Send is not idempotent-by-accident: `execute` reuses each action's existing guards (e.g. the approve route's atomic transition) so double-submits cannot double-send.

### 4.3 SendModal (client)

One shared component (`client/src/components/SendModal/`). Opens on any converted send button, calls `preview`, renders:

- To: line with name, email, phone, and any warnings (amber inline text)
- Channel checkboxes, defaults preselected
- Editable subject + message body (email), editable SMS body, character/segment hint on SMS
- Fixed link block shown below the email body as a non-editable preview
- Send and Cancel. Cancel means nothing happened, including side effects
- Result state on completion: exactly what went where ("Emailed martinjuly18@gmail.com. SMS sent to (801) 513-6378."), or the skip reason per channel

### 4.4 Compose-first for side-effect actions

Shopping-list approve and invoice send move their side effects into `execute`. Clicking "Approve & Send" opens the modal; the status flip happens only on confirm. The approve route's atomic pending-to-approved guard is preserved inside `execute`.

### 4.5 Converted actions and defaults

| Action | Surface(s) | Default channels |
|---|---|---|
| `proposal_send` (initial) | proposal creation flow | email + sms |
| `proposal_resend` | ProposalDetail | email + sms |
| `proposal_send_group` | AlternativesPanel | email + sms |
| `portal_invite` | ProposalDetail, EventDetailPage | email |
| `drink_plan_nudge` | DrinkPlanDetail (resend-nudge) | email + sms |
| `drink_plan_nudge_reenroll` | EventDetailPage | email + sms |
| `event_reminder` | EventsDashboard | email + sms |
| `invoice_send` | ProposalDetailPaymentPanel | email |
| `shopping_list_approve` | ShoppingListModal | email |
| `consult_recap` | drink plan consult save | email |

### 4.6 Honest results

`execute` returns per-channel truth. Hosted-package shopping lists: modal opens with email unavailable and reason "Hosted package: DRB does the shopping, no client email applies"; the confirm button reads "Approve" not "Send." No-email-on-file: email checkbox disabled with reason, SMS still offered if a phone exists. The button label in every converted surface reflects reality ("Approved, emailed X" vs "Approved, no email sent").

### 4.7 Ledger: always log (messageLog change)

`logClientMessage` rule change: when the entry carries a `proposalId` (all registry sends do), the row is inserted even if the recipient resolves to no client (`client_id` NULL). The line-69 early return applies only when there is neither a resolvable client nor a supplied `proposalId` (true non-client mail: admin notifications, marketing). `message_log.client_id` is already nullable; no schema change.

### 4.8 Bounce pipeline

- **Manual step (Dallas):** register the webhook in the Resend dashboard pointing at `https://api.drbartender.com/api/email-marketing/webhook/resend`, events: sent, delivered, bounced, complained; set `RESEND_WEBHOOK_SECRET` in Render.
- Webhook processing extends to the transactional ledger: on `email.bounced` / `email.complained`, match `message_log.provider_id = data.email_id` and set `status = 'bounced'` (or `'complained'`), `error_message` from payload. `status` is varchar; no schema change.
- Hard bounce on a client-facing row (has `proposal_id`) additionally: creates a needs-attention item (reuse the existing needs-attention mechanism from the 7/14 tabs feature) and sends an admin alert email (email only, no SMS, per notification-cost rule) with client, message type, and the bounced address.
- Messages card renders `bounced` / `complained` rows with a red badge and the error.
- Typo-domain heuristic (shared client+server util): flag TLDs that are one edit from `.com`/`.net`/`.org` (`.con`, `.conm`, `.cmo`, `.ocm`, `.vom`) and domains one edit from major providers (`gmail`, `yahoo`, `hotmail`, `outlook`, `icloud`: catches `hmail`, `gamil`, `yaho`). Warn only, never block.

### 4.9 Approved snapshot (kills the revert trap)

- New column: `drink_plans.shopping_list_approved_snapshot JSONB` (idempotent `ADD COLUMN IF NOT EXISTS`).
- On approve, `execute` copies the current list into the snapshot in the same UPDATE that flips status.
- Public route `GET /api/drink-plans/t/:token/shopping-list`: when status is `approved`, serve live list (current behavior). When status is `pending_review` but a snapshot exists, serve the snapshot with `ready: true`. Pending screen only when no snapshot has ever existed.
- Re-approve overwrites the snapshot. Admin edits keep reverting status exactly as today (admin-side truth unchanged); the client just never loses their list.
- The admin modal's "Re-approve & Send" copy updates to say the client still sees the last approved version, not the pending screen.

### 4.10 Capture-time validation

Thumbtack create-proposal page (and any admin client-create form): on email blur, run the typo-domain heuristic (warn inline) and call a small dup-check endpoint (`GET /api/clients/similar?email=&name=`) that flags an existing client with the same name or a near-identical email (case/edit-distance-1 on the local part or domain). Warn with a link to the existing client; never block. This is what Cathy's `.conm` twin needed.

## 5. Data repair (L0, prod, each step individually approved before running)

1. Client #1436 email `cmurphy@arthrex-chicago.conm` to `.com`; same fix on `drink_plans` 76 snapshot. Note #1427 as the dormant dup (no merge tooling; leave for manual archive).
2. Re-send Cathy's shopping list (after 1).
3. Siddhant plan 91: re-approve once Dallas confirms list content is final, so his 5 emailed links work again.
4. Backfill stale `drink_plans.client_email` where a linked client's email differs (Brandon 86, Aaran 57, sweep for others).
5. Not touched: Luva Dorris (zero-comms CC import, manual by design), hosted plans, past events.

## 6. Out-of-band notes

- `labrat_purge` "Scheduler stale" Sentry noise every 15 min: leftover from labrat removal, unrelated to this project, cheap standalone fix.
- Schedulers adopt the shared live-recipient resolver opportunistically (where the call site already joins the client, keep; where it reads a snapshot column, switch), in L3's footprint but only for the senders already being touched.
