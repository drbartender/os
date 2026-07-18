# Comms Send Modal + Delivery Integrity

**Date:** 2026-07-18 (rev 2, post design-review fleet: 6 agents, all findings incorporated)
**Status:** Approved in brainstorm (Dallas, 7/18); rev 2 folds in spec-grounding, spec-gaps, spec-risk, plan-fidelity, plan-decomposition, plan-feasibility findings.
**Companion plan:** `docs/superpowers/plans/2026-07-18-comms-send-modal-delivery-integrity.md`

## 1. Why (incident summary, verified)

Brandon Martin's wedding (7/18) shopping list never reached him. Verified chain, from prod data + Sentry traces:

1. Approve clicked 7/16 18:29 UTC. Route ran on prod (Sentry-sampled PATCH trace), status flipped, email **was sent** (`POST https://api.resend.com/emails` span present) to `drink_plans.client_email`, a stale Apple relay address frozen at plan creation (6/29). His real email changed to gmail ~7/1 on the client record; nothing syncs plan rows.
2. `logClientMessage` silently skipped the ledger row: `messageLog.js:69` returns when the recipient matches no client, and the same staleness that killed delivery also killed the lookup. No log row, no error.
3. Bounce invisible: `email_webhook_events` has zero rows ever. The Resend webhook handler exists and fails closed, but Sentry shows its missing-secret path never fired in 90 days: **the webhook was never registered in the Resend dashboard.**
4. Modal showed "Approved & Sent."

Stale-snapshot senders (verified by fleet): the shopping-list approve email AND the consult recap (`drinkPlanConsult.js:255/295`, sends to `dp.client_email`). The drink-plan nudge and the pre-event handlers already resolve the live client email via the proposal join (`drinkPlans.js:719`, `drinkPlanNudge.js:103`, `preEventHandlers.js:29`) and are NOT affected.

Same class, other clients (verified in prod):

- **Cathy Murphy** (event 7/25): duplicate client records #1427 (`cmurphy@arthrex-chicago.com`, real) and #1436 (`...conm`, typo, nonexistent TLD). Booking hangs off the typo record. All 4 shopping-list sends plus every email since 7/4 went to `.conm`, all marked "sent."
- **Siddhant Khaitan** (event 7/23): 5 shopping-list emails delivered, but post-approve edits reverted the list to `pending_review`; every link in his inbox shows the pending screen.
- **Aaran Varatharajan** (6/6, historical): same stale-relay signature as Brandon.
- Plans approved with no email on file (Tabitha Lopez, Michael Sawula): silent no-send behind an "Approved & Sent" button.

Five holes: (1) bounce blindness, (2) no capture-time address validation or dup detection, (3) stale `drink_plans.client_email` snapshots (approve email + consult recap), (4) the approved-then-edited revert trap, (5) sends that silently skip or fail while the UI claims success.

## 2. Goals

- Every admin-click client send passes through one compose-and-confirm modal: recipient visible, channels selectable, message editable, result honest, including the partial-failure case.
- Recipient is resolved live from the client record at preview and at send.
- Every send attempt leaves a `message_log` row, success or failure, resolvable client or not, with who sent it and whether the copy was edited.
- Bounces become visible: ledger status, needs-attention surfacing, admin alert email.
- An approved shopping list never turns into a dead link for the client.
- Obvious address typos and duplicate clients get caught at capture time.

## 3. Non-goals

- Scheduler-driven sends keep firing automatically, no compose step. (Fleet verified they already resolve recipients live; no scheduler changes needed beyond the consult recap, which is a converted action anyway.)
- Staff SMS blast (`Messages.js`) and marketing campaigns keep their existing compose UIs.
- No raw HTML editing. Prose only; brand shell and action links stay fixed. Edited `bodyText` is HTML-escaped at render (via the existing `esc`), so markup cannot be injected.
- No client-record merge tooling. Cathy's dup is repaired by hand (L0). Note: after R1 both #1427 and #1436 hold the same `.com` address, making `logClientMessage`'s `LOWER(email) LIMIT 1` lookup nondeterministic between them; tolerable because the registry resolves via the proposal join, and #1427 is slated for manual archive.
- No sms_messages/thread integration change: registry SMS uses the exact send+log path each converted route uses today (`sendSMS` + `message_log`). Two-way thread ledger (`sms_messages`) is untouched.
- Edited message bodies are not stored in the ledger (PII/bloat); the ledger records that the body was edited (`body_edited`) and by whom (`sent_by`).

## 4. Design

### 4.0 Schema deltas (all shipped together in the first lane, idempotent)

- Widen `message_log.status` CHECK from `('sent','failed')` to `('sent','failed','bounced','complained')` via idempotent constraint drop/re-add, mirroring the `email_sends` status set (schema.sql:1492). **Fleet-verified blocker: without this every bounce write throws 23514.**
- `CREATE INDEX IF NOT EXISTS idx_message_log_provider_id ON message_log(provider_id)` (webhook matches by `provider_id`; currently a sequential scan).
- `ALTER TABLE message_log ADD COLUMN IF NOT EXISTS sent_by INTEGER` (admin user id, NULL for automated sends) and `ADD COLUMN IF NOT EXISTS body_edited BOOLEAN NOT NULL DEFAULT false`.
- `ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS shopping_list_approved_snapshot JSONB`.

### 4.1 Comms registry (server)

New module `server/utils/comms/` with one registered action per admin-click send. `registry.js` **auto-discovers** `actions/*.js` at boot (so later lanes add action files without editing the registry). Each action declares:

| Field | Meaning |
|---|---|
| `key` | e.g. `shopping_list_approve`, `proposal_resend`, `invoice_send` |
| `resolveRecipient(entityId)` | Live lookup: client name, email, phone via the proposal join; falls back to the entity snapshot only when no client is linked. Returns `source` (`client` or `snapshot`) and `warnings[]` |
| `buildMessages(entity)` | Returns `{ email: { subject, bodyText, cta: { label, url } }, sms: { body } }`. `bodyText` is editable prose, escaped at render; `cta` renders as the fixed link block |
| `defaultChannels` | Per action, see 4.5 |
| `ensureSideEffects(entityId)` | Idempotent side effects (status flip, invoice flip). Safe to call twice; second call is a no-op |
| `dispatch(entityId, message, channels, adminUserId)` | Sends on each selected channel, always ledgers each attempt (`sent_by`, `body_edited`) |

`execute` = `ensureSideEffects` then `dispatch`. Because side effects are idempotent, a failed dispatch can be retried by calling send again without double-applying side effects.

Existing template builders are reused: builders gain an additive export of `{ subject, bodyText, cta }` alongside the current `{ subject, html, text }` so untouched callers keep working.

### 4.2 Endpoints

- `POST /api/comms/preview` `{ action, entityId }` (auth, admin/manager) returns:
  `{ recipient: { name, email, phone, source }, warnings: [], channels: { email: { available, default, unavailable_reason }, sms: { ... } }, email: { subject, bodyText, cta }, sms: { body } }`
- `POST /api/comms/send` `{ action, entityId, channels, email: { subject, bodyText }, sms: { body } }` runs `execute` and returns per-channel truth:
  `{ ok, email: 'sent'|'failed'|'skipped', sms: 'sent'|'failed'|'skipped', skip_reasons: {...}, recipient_email, recipient_phone, side_effects_applied: true }`

Recipient is resolved server-side only; the request cannot override the destination address or number.

Preview warnings: typo-looking domain (shared heuristic, 4.8), entity snapshot differs from the live client record, `clients.email_status = 'bad'` (the marketing webhook already sets this on hard bounce; surface it here), recipient email missing, phone missing or failing `normalizePhone`, hosted package.

Server-side validation on send (mirrored client-side): subject and bodyText non-empty after trim when email channel selected; SMS body non-empty and capped at 4 segments (640 chars) when SMS selected; at least one channel selected. `POST /api/comms/send` sits behind `adminWriteLimiter` like other admin writes.

Partial failure contract (the incident case): side effects commit first and stay committed; each channel's outcome is reported truthfully; every attempt is ledgered including `failed`. The modal renders a failed channel red with the error and a Retry button; Retry re-calls send, `ensureSideEffects` no-ops, dispatch re-attempts.

### 4.3 SendModal (client)

One shared component (`client/src/components/SendModal/`). Opens on any converted send button, calls `preview`, renders:

- Loading state while preview fetches; explicit error state with Retry if preview fails (deleted entity, 404, network); a no-channel state when both email and phone are unavailable (message: fix the client record first, with a link)
- To: line with name, email, phone, and warnings (amber inline text)
- Channel checkboxes, defaults preselected; unavailable channels disabled with the reason
- Editable subject + message body (email), editable SMS body with segment counter, client-side validation matching 4.2
- Fixed link block below the email body as a non-editable preview
- Send disabled while a send is in flight (double-submit lockout; several actions are inherently repeatable so the guard is mandatory, not cosmetic)
- Cancel means nothing happened, including side effects
- Result state: per-channel truth ("Emailed martinjuly18@gmail.com" / "SMS failed: <error> [Retry]"), or skip reasons

### 4.4 Compose-first for side-effect actions

Side effects run inside `ensureSideEffects` on confirm, never on modal open.

- `shopping_list_approve`: the atomic pending-to-approved UPDATE (including the snapshot write, 4.9) moves into `ensureSideEffects`.
- `invoice_send`: **fleet finding: there is no existing send step to move.** Today `POST /invoices/proposal/:proposalId` only creates `status='draft'` rows; no invoice email template or draft-to-sent flip exists server-side. This action is therefore new, minimal, money-guarded work: `ensureSideEffects` flips `draft` to `sent` (only from `draft`, idempotent, touches `status` alone, never `amount_due`/`amount_paid`/line items); `dispatch` sends a new invoice-ready email template with the existing public invoice link. Serves the CC-import balance invoices directly.
- `proposal_send` (initial): **fleet finding: the current initial send is one atomic create+invoice+`status='sent'` transaction (crud.js:220).** To fit compose-first: the create flow first saves the proposal as `draft` (draft proposals already exist in the system via TT auto-draft, with their own cleanup scheduler), then opens the modal; `ensureSideEffects` performs the existing invoice+flip-to-sent transaction unchanged; `dispatch` sends. Cancel leaves a draft proposal (normal, visible, cleaned up like any draft). The invoice+sent flip never splits from its transaction.

### 4.5 Converted actions and defaults

| Action | Surface(s) | Default channels |
|---|---|---|
| `proposal_send` (initial, draft-first) | proposal creation flow | email + sms |
| `proposal_resend` | ProposalDetail | email + sms |
| `proposal_send_group` | AlternativesPanel | email only (fleet: current group send has no SMS; offering one would be net-new behavior) |
| `portal_invite` | ProposalDetail, EventDetailPage | email |
| `drink_plan_nudge` | DrinkPlanDetail (resend-nudge) | email + sms |
| `drink_plan_nudge_reenroll` | EventDetailPage | email + sms |
| `payment_reminder` (fleet: the EventsDashboard "reminder" is `POST /proposals/:id/send-reminder` in `proposals/actions.js`, a balance reminder; named accordingly) | EventsDashboard | email + sms |
| `invoice_send` (new capability, 4.4) | ProposalDetailPaymentPanel | email |
| `shopping_list_approve` | ShoppingListModal | email |
| `consult_recap` | drink plan consult save | email |

### 4.6 Honest results

Per-channel truth everywhere (4.2 contract). Hosted-package shopping lists: modal opens with email unavailable, reason "Hosted package: DRB does the shopping, no client email applies," confirm button reads "Approve." No-email-on-file: email disabled with reason, SMS offered if a phone exists. Converted surfaces reflect reality ("Approved, emailed X" / "Approved, no email sent: hosted" / "Approved, email FAILED").

### 4.7 Ledger: always log (messageLog change)

When the entry carries a `proposalId`, the row is inserted even if the recipient resolves to no client (`client_id` NULL; column verified nullable). The early return remains only when there is neither a resolvable client nor a supplied `proposalId`. Registry dispatches populate `sent_by` and `body_edited`. Admin-facing alert emails (4.8) pass `skipLog` (or carry no `proposalId`) so they never pollute a client's ledger and can never recurse.

### 4.8 Bounce pipeline

- **Manual step (Dallas):** register the webhook in the Resend dashboard pointing at `https://api.drbartender.com/api/email-marketing/webhook/resend`, events: sent, delivered, bounced, complained; set `RESEND_WEBHOOK_SECRET` in Render (env var already documented in CLAUDE.md).
- Webhook processing extends to the transactional ledger: on `email.bounced` / `email.complained`, match `message_log.provider_id = data.email_id` (new index, 4.0) and set `status` + `error_message`. **Transaction placement (fleet):** the ledger UPDATE runs inside the existing processed-gated `FOR UPDATE` transaction (so Resend redeliveries cannot double-fire alerts); the admin alert email and any other network side effect run post-commit, best-effort, never holding a pooled connection across a network call (pool invariant).
- Hard bounce on a row with `proposal_id`: post-commit, send an admin alert email (new template; email only; `skipLog`) with client, message type, bounced address, link.
- **Needs-attention surfacing (fleet: the 7/14 mechanism is a derived client-side aggregation over admin endpoints, `queueItems.js` + `OverviewPage`/badge-counts; there is no insertable store).** Bounce surfacing is therefore a new derived source: a small admin endpoint returning recent client-facing `message_log` rows with status `bounced`/`complained` that have no later successful send of the same `message_type` for the same proposal (that later-success rule IS the clear semantics: re-send fixes it, nothing to manually dismiss), plus a new `queueItems.js` builder + tab type. Badge-counts gains the same count.
- Messages card renders `bounced`/`complained` rows with a red badge and the error.
- Typo-domain heuristic: one server util (`server/utils/emailValidation.js`) plus a manually synced client mirror (`client/src/utils/emailValidation.js`), following the existing `eventTypes.js` ESM/CJS manual-sync pattern (CRA cannot import server files). Flags TLDs one edit from `.com`/`.net`/`.org` (`.con`, `.conm`, `.cmo`, `.ocm`, `.vom`) and domains one edit from major providers (catches `hmail`, `gamil`, `yaho`). Warn only, never block. Built in the first lane (comms preview needs it); bounce pipeline and capture validation consume it. No inline duplicates anywhere.

### 4.9 Approved snapshot (kills the revert trap)

- Column per 4.0. On approve, `ensureSideEffects` copies the current list into the snapshot in the same UPDATE that flips status.
- Public route `GET /api/drink-plans/t/:token/shopping-list`: `approved` serves the live list (current behavior); `pending_review` with a snapshot serves the snapshot with `ready: true`; pending screen only when no snapshot has ever existed. The snapshot serve path applies the same underscore-key strip as the live path (the stored blob deliberately retains generation diagnostics; serving them raw would leak internals).
- One-time backfill on deploy: `shopping_list_approved_snapshot = shopping_list` for currently-approved plans with a NULL snapshot (idempotent), so existing approved lists survive their next edit; without this the trap persists for every already-approved plan.
- Re-approve overwrites the snapshot. Admin edits keep reverting status exactly as today; the client just never loses their list. Modal re-approve copy updates accordingly.

### 4.10 Capture-time validation

Thumbtack create-proposal page (and admin client-create form): on email blur, run the client-mirror typo heuristic (warn inline) and call `GET /api/clients/similar?email=&name=` (auth + admin/manager guard, explicitly not public: unauthenticated it would be an enumeration vector). The endpoint reuses the existing `server/utils/clientDedup.js` normalization rather than reimplementing it, adding edit-distance-1 matching on local part and domain. Warn with a link to the existing client; never block.

## 5. Data repair (L0, prod, each step individually approved before running)

1. Client #1436 email `.conm` to `.com`; same fix on `drink_plans` 76. #1427 stays dormant for manual archive (see 3, nondeterminism note).
2. Re-send Cathy's shopping list (after 1).
3. Siddhant plan 91: re-approve once Dallas confirms content, before 7/23.
4. Backfill stale `drink_plans.client_email` from the live client record, future events only (expected: plan 86 Brandon, plan 57 Aaran; sweep for others). **Do not touch Luva Dorris** (zero-comms CC import, manual by design).
5. Dallas manual: Resend webhook registration + `RESEND_WEBHOOK_SECRET` in Render.

## 6. Out-of-band notes

- `labrat_purge` "Scheduler stale" Sentry noise every 15 min: unrelated leftover, cheap standalone fix.
- File-size ratchet pressure (fleet-measured): `drinkPlans.js` 793 (over soft cap; three lanes would grow it), `emailTemplates.js` 701, `ProposalDetail.js` 857, `ShoppingListModal.jsx` 674. The first lane extracts the shopping-list routes from `drinkPlans.js` into `server/routes/drinkPlans/shoppingList.js` (the composition-router pattern already used by `drinkPlans/submit.js`); the bounce alert template goes in a small new admin-templates sibling, not into `emailTemplates.js`.
- Documentation updates per the CLAUDE.md mandatory table ride each lane (README folder tree + npm, ARCHITECTURE route table + schema + webhook sections).
