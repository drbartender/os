---
spec: docs/superpowers/specs/2026-07-18-comms-send-modal-delivery-integrity.md
lanes:
  - id: comms-registry
    footprint:
      - server/db/schema.sql                    # ALL project schema deltas ship here (spec 4.0)
      - server/utils/comms/registry.js          # new: auto-discovers actions/*.js
      - server/utils/comms/actions/shoppingListApprove.js   # this lane owns ONLY this action file
      - server/utils/comms/registry.test.js
      - server/utils/emailValidation.js         # new: typo-domain heuristic (server)
      - server/utils/emailValidation.test.js
      - client/src/utils/emailValidation.js     # new: manually synced client mirror (eventTypes.js pattern)
      - server/routes/comms.js                  # new: POST /preview, POST /send
      - server/routes/comms.test.js
      - server/index.js                         # mount /api/comms
      - server/utils/messageLog.js              # always-log rule + sent_by/body_edited (spec 4.7)
      - server/utils/messageLog.test.js
      - server/utils/emailTemplates.js          # additive bodyText/cta exports
      - server/utils/lifecycleEmailTemplates.js
      - server/routes/drinkPlans.js             # SHRINKS: shopping-list routes extracted
      - server/routes/drinkPlans/shoppingList.js  # new: extracted routes (ratchet relief), approve delegates to execute
      - server/routes/drinkPlans/shoppingList.test.js
      - client/src/components/SendModal/*.jsx   # new shared modal
      - client/src/components/ShoppingList/ShoppingListModal.jsx
      - client/src/components/ShoppingList/ShoppingListButton.jsx
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # schema + comms plumbing + ledger; sensitive
  - id: comms-proposal-sends
    footprint:
      - server/utils/comms/actions/proposalSend.js
      - server/utils/comms/actions/proposalResend.js
      - server/utils/comms/actions/proposalSendGroup.js
      - server/utils/comms/actions/portalInvite.js
      - server/utils/comms/actions/paymentReminder.js
      - server/utils/comms/actions/drinkPlanNudgeReenroll.js
      - server/routes/proposals/crud.js         # initial send: draft-first split (spec 4.4)
      - server/routes/proposals/lifecycle.js
      - server/routes/proposals/actions.js      # send-reminder lives HERE (fleet-verified actions.js:90)
      - server/routes/proposals/groups.js
      - server/routes/admin/ccImport/proposalActions.js  # reenroll route
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/AlternativesPanel.js
      - client/src/pages/admin/EventDetailPage.js   # portal invite + reenroll: single-owner here
      - client/src/pages/admin/EventsDashboard.js   # payment_reminder surface
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]
    review: full-fleet   # proposal lifecycle is money-adjacent; initial-send transaction unchanged-shape is the review focus
  - id: comms-remaining-sends
    footprint:
      - server/utils/comms/actions/drinkPlanNudge.js
      - server/utils/comms/actions/invoiceSend.js
      - server/utils/comms/actions/consultRecap.js
      - server/routes/drinkPlans.js             # resend-nudge conversion only
      - server/routes/drinkPlanConsult.js       # consult recap: the second stale-snapshot sender
      - server/routes/invoices.js               # NEW draft-to-sent flip (status only; spec 4.4)
      - server/routes/invoices.test.js
      - client/src/pages/admin/DrinkPlanDetail.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]
    review: full-fleet   # invoice flip touches money status
  - id: bounce-pipeline
    footprint:
      - server/routes/emailMarketingWebhook.js  # ledger UPDATE inside processed-gated txn; alerts post-commit
      - server/routes/emailMarketingWebhook.idempotency.test.js
      - server/utils/adminAlertTemplates.js     # new small sibling: bounce alert template (keeps emailTemplates.js flat)
      - server/routes/admin/settings.js         # badge-counts bounced count
      - client/src/pages/admin/overview/queueItems.js   # new bounced builder + tab type
      - client/src/pages/admin/overview/NeedsYouStrip.js
      - client/src/pages/admin/OverviewPage.js  # fetch the new bounced source
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]   # schema deltas (status CHECK, provider_id index) land in comms-registry; also serializes emailTemplates-adjacent work
    review: full-fleet   # webhook path is sensitive
  - id: approved-snapshot
    footprint:
      - server/routes/drinkPlans/shoppingList.js  # snapshot write in approve execute + public serve (file exists after comms-registry)
      - server/routes/drinkPlans/shoppingList.test.js
      - server/utils/comms/actions/shoppingListApprove.js   # owned by comms-registry lane; serialized via blockedBy chain
      - server/scripts/backfillApprovedSnapshots.js  # one-time idempotent backfill (spec 4.9)
      - client/src/components/ShoppingList/ShoppingListModal.jsx  # re-approve tooltip copy
      - ARCHITECTURE.md
    blockedBy: [comms-registry, comms-remaining-sends]   # serializes drinkPlans.js + shoppingListApprove.js editors
    review: full-fleet   # prod-facing backfill
  - id: capture-validation
    footprint:
      - server/routes/clients.js                # GET /api/clients/similar (reuses clientDedup.js)
      - server/routes/clients.similar.test.js
      - client/src/pages/admin/*                # TT create-proposal page email-blur wiring (locate exact page in Task C1; STOP and surface if outside footprint)
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]                # consumes the client emailValidation mirror
    review: light
---

# Comms Send Modal + Delivery Integrity Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id, checkpoint commits in-lane, squash merge to main. Run order (encoded in blockedBy, which IS the run-order): `comms-registry` first; then `comms-proposal-sends`, `comms-remaining-sends`, `bounce-pipeline`, `capture-validation` in parallel; `approved-snapshot` last. The L0 ops steps are NOT a lane: prod data changes, each individually approved by Dallas. The comms-registry squash is large; its full-fleet review must chunk-by-file with a coverage manifest per house law.

**Rev 2 note:** rewritten after the 6-agent design fleet. Material changes: all schema deltas consolidated into comms-registry (message_log status CHECK widening was a fleet-found blocker); needs-attention surfacing rebuilt as a derived source (no insertable store exists); invoice_send re-scoped as new capability (no existing send seam); send-reminder renamed payment_reminder and moved to comms-proposal-sends with its true route home (proposals/actions.js); EventDetailPage.js and EventsDashboard.js single-owned by comms-proposal-sends; registry auto-discovery so downstream lanes never edit registry.js; emailValidation built in lane 1 with a client mirror; drinkPlans.js shopping-list extraction for the ratchet; partial-failure contract, validation parity, and double-submit lockout specified.

**Goal:** Every admin-click client send opens one compose-and-confirm modal (recipient shown live, channels selectable, message editable, per-channel honest results including partial failure) backed by a comms registry; bounces visible end to end; approved shopping lists never dead-link; typos and dup clients flagged at capture.

**Tech Stack:** Express + raw SQL (`pool.query`, parameterized), React 18 CRA, `node:test` against the shared dev DB.

## Global Constraints

- Raw SQL only, parameterized; schema changes idempotent; the status-CHECK widening uses drop-constraint-if-exists + re-add in one statement block.
- API JSON keys snake_case; JS camelCase. Client API calls via `client/src/utils/api.js` only.
- Server errors: throw `AppError` subclasses.
- Money untouched: `invoice_send` flips `status` from `draft` to `sent` only; never `amount_due`, `amount_paid`, or line items. Initial proposal send keeps its invoice+flip transaction in one atomic shape.
- Edited bodyText is HTML-escaped at render; recipient is server-resolved and non-overridable.
- No em dashes in any client-facing copy.
- Server test law: suites run ALONE against the shared dev DB: `node -r dotenv/config --test <file>`; cleanup in `after()`.
- Client gate: `cd client && CI=true npx react-scripts build`.
- Git: explicit pathspec staging; footprint discipline (out-of-footprint need = ABORT and surface).

## L0: Prod data repair (ops, approval-gated)

- [ ] R1. Cathy: `UPDATE clients SET email='cmurphy@arthrex-chicago.com' WHERE id=1436 AND email='cmurphy@arthrex-chicago.conm'`; same-guard update on plan 76 `drink_plans.client_email`. Verify before/after. #1427 stays dormant for manual archive.
- [ ] R2. Re-send Cathy's shopping list (Dallas picks timing; event 7/25).
- [ ] R3. Siddhant plan 91: Dallas confirms content, re-approve before 7/23. Do NOT wait for the snapshot lane.
- [ ] R4. Stale-email backfill, future events only, SELECT-first (expected: 86 Brandon, 57 Aaran). **Never touch Luva Dorris** (zero-comms CC import).
- [ ] R5. Dallas manual: register Resend webhook (sent/delivered/bounced/complained) + set `RESEND_WEBHOOK_SECRET` in Render. Precondition for bounce-pipeline VERIFICATION only.

## Lane comms-registry

- [ ] T0. Schema deltas (spec 4.0): widen `message_log.status` CHECK to include `bounced`/`complained` (mirror email_sends set); `idx_message_log_provider_id`; `message_log.sent_by` + `body_edited`; `drink_plans.shopping_list_approved_snapshot`. Verify in Neon dashboard on dev. **Checkpoint: database-review agent on this batch before any dependent code.**
- [ ] T1. Extract shopping-list routes from `drinkPlans.js` into `server/routes/drinkPlans/shoppingList.js` (composition-router pattern of `drinkPlans/submit.js`); byte-identical behavior; drinkPlans.js shrinks below the soft cap. Existing tests still pass.
- [ ] T2. `emailValidation.js` (server) + manually synced client mirror: typo heuristic per spec 4.8, pure, tested. Header comment in both citing the eventTypes.js manual-sync convention.
- [ ] T3. `server/utils/comms/registry.js` with actions/*.js auto-discovery + `actions/shoppingListApprove.js`: `resolveRecipient` (live proposal join, snapshot fallback + warning, email_status='bad' warning), `buildMessages` via new parts exports, `ensureSideEffects` (ports the atomic approve UPDATE + snapshot write), `dispatch` (per-channel send, always ledgered with sent_by/body_edited). Hosted returns email-unavailable. **Template ownership rule:** this task adds the additive `*Parts()` exports for ALL ten converted actions (shopping list, proposal sent, portal invite, nudge + reenroll, payment reminder, consult recap, send-group, plus the NEW invoice-ready template) in `emailTemplates.js` / `lifecycleEmailTemplates.js`, so the parallel downstream lanes consume templates without editing these files (they stay out of downstream footprints).
- [ ] T4. `messageLog.js`: always-log-when-proposalId rule + sent_by/body_edited params + skipLog honored for admin alerts. Extend messageLog.test.js (unresolvable-recipient-with-proposalId logs; no-proposalId non-client still skips).
- [ ] T5. `server/routes/comms.js`: preview + send per spec 4.2 (validation parity, adminWriteLimiter, per-channel result contract, side_effects_applied). Mount in index.js same task. Route tests: preview shape + warnings, send-exactly-once side effects on double-submit, edited body lands, empty-body rejection, partial-failure response shape (mock a dispatch failure).
- [ ] T6. `SendModal` component per spec 4.3 (loading/error/no-channel states, lockout, segment counter, Retry on failed channel). Vanilla CSS.
- [ ] T7. Convert ShoppingListModal/Button: Approve & Send opens SendModal; PATCH approve route kept mounted, delegating to the action (API compat), marked deprecated in ARCHITECTURE.md; approve-state copy driven by send result.
- [ ] T8. **Checkpoint: security-review agent** on comms endpoints (IDOR, role guards, recipient non-overridability, rate limit) + messageLog change. Client build gate. Manual verify on dev: approve a scratch plan end to end (edited body arrives, ledger row has sent_by + body_edited, cancel leaves pending, double-submit sends once, hosted shows Approve-only).
- [ ] T9. Docs: README tree + ARCHITECTURE routes (/api/comms), schema section (4 deltas), deprecated-PATCH note.

## Lane comms-proposal-sends

- [ ] P1. Actions: `proposalResend`, `proposalSendGroup` (email only), `portalInvite`, `paymentReminder` (wraps `POST /proposals/:id/send-reminder` logic from `proposals/actions.js:90`; it is a balance reminder, name honestly in modal copy), `drinkPlanNudgeReenroll` (route logic from `admin/ccImport/proposalActions.js`). Live recipient resolution throughout.
- [ ] P2. `proposalSend` (initial, spec 4.4): split create-flow into save-as-draft + modal; `ensureSideEffects` runs the existing invoice+flip-to-sent transaction unchanged in shape (crud.js:220 region); cancel leaves a draft (existing draft semantics + cleanup scheduler). **Checkpoint: code-review + consistency-check agents on this task** (the one place the plan touches a money-adjacent transaction).
- [ ] P3. Convert surfaces: ProposalDetail (resend, invite), AlternativesPanel (send-group), EventDetailPage (invite, reenroll), EventsDashboard (payment_reminder), creation flow (initial). Old endpoints delegate for API compat.
- [ ] P4. Tests per action; client build gate; manual verify resend + invite + draft-first initial send on scratch proposals.
- [ ] P5. Docs rows.

## Lane comms-remaining-sends

- [ ] N1. Actions: `drinkPlanNudge` (wraps resend-nudge in drinkPlans.js), `consultRecap` (converts the second stale-snapshot sender, drinkPlanConsult.js:255/295, to live resolution), `invoiceSend` (NEW capability per spec 4.4: draft-to-sent status-only flip, consuming the T3-created invoice-ready parts template + public invoice link; idempotent; never touches amounts). **Checkpoint: code-review + consistency-check agents on invoiceSend** before surfaces build on it.
- [ ] N2. Convert surfaces: DrinkPlanDetail (nudge), ProposalDetailPaymentPanel (invoice send), consult save flow (recap).
- [ ] N3. Sender audit (rescoped per fleet: nudge + preEventHandlers already resolve live): grep all senders for `dp.client_email` / `shifts.client_email` snapshot reads; expected result is consult recap only (handled in N1); document the audit result in the lane notes; convert any surprise finding or STOP if outside footprint.
- [ ] N4. Tests (invoice flip idempotency, status-only assertion diffing the row before/after on everything but status/updated_at) + client build gate + manual verify nudge and invoice send on scratch rows.
- [ ] N5. Docs rows.

## Lane bounce-pipeline

- [ ] B1. Read the needs-attention implementation (queueItems.js, NeedsYouStrip.js, OverviewPage.js, badge-counts in admin/settings.js) to bind the exact wiring; footprint already lists them; STOP if reality differs.
- [ ] B2. Webhook extension in `emailMarketingWebhook.js`: bounced/complained ledger UPDATE by provider_id INSIDE the processed-gated FOR UPDATE txn; marketing email_sends processing untouched; admin alert (adminAlertTemplates.js, skipLog) fired post-commit best-effort, never holding a pooled connection across the send. Extend the idempotency test: redelivered event does not re-alert. **Checkpoint: security-review agent on this task before B3+.**
- [ ] B3. Derived bounce source: admin endpoint returning client-facing bounced/complained message_log rows with no later successful same-type send for the same proposal (the later-success rule is the clear semantics); badge-counts gains the count.
- [ ] B4. queueItems.js builder + tab type + Messages card red badge with error text.
- [ ] B5. Verification: local POST of raw JSON `{type, data:{email_id,...}}` to the dev webhook works only when dev `.env` lacks RESEND_WEBHOOK_SECRET (signature skipped, verified in code at emailMarketingWebhook.js:23-25); if the secret is set locally, use a svix-signed payload harness; then with R5 done, a real Resend test event against prod-adjacent staging. Confirm: ledger flip, needs-attention item, alert email to scratch inbox, item clears after a successful re-send. Full-fleet review (webhook sensitive).
- [ ] B6. Docs: ARCHITECTURE webhook section, README note that RESEND_WEBHOOK_SECRET is load-bearing in prod.

## Lane approved-snapshot

- [ ] S1. Verify the T0 column exists (no schema work in this lane); snapshot write already ships in T3's ensureSideEffects. This lane completes the serve side: public token route in `drinkPlans/shoppingList.js` serves the snapshot when `pending_review` + snapshot present, with the same underscore-key strip as the live path; pending screen only when no snapshot ever.
- [ ] S2. `server/scripts/backfillApprovedSnapshots.js`: one-time idempotent backfill for currently-approved plans (spec 4.9). SELECT-first dry-run mode. **Checkpoint: database-review agent on the backfill before it runs anywhere.** Run on dev, verify, then prod with Dallas's approval.
- [ ] S3. ShoppingListModal re-approve tooltip copy: client still sees the last approved version.
- [ ] S4. Tests: snapshot written on approve, served while pending, replaced on re-approve, underscore keys stripped. Full-fleet review.
- [ ] S5. ARCHITECTURE schema note.

## Lane capture-validation

- [ ] C1. Locate the TT create-proposal page component + admin client-create form; STOP and surface if outside footprint.
- [ ] C2. `GET /api/clients/similar` (auth + requireAdminOrManager, explicitly never public): reuse `server/utils/clientDedup.js` normalization + edit-distance-1 on local part and domain. Parameterized, tested.
- [ ] C3. Email-blur wiring: client emailValidation mirror warning + dup warning with link. Warn only.
- [ ] C4. Client build gate; light review; README note.

## Verification (whole project)

- [ ] V1. Brandon replay on dev: stale plan email + changed client email; modal shows live gmail + mismatch warning; send ledgers with sent_by; simulated dispatch failure shows red channel + Retry; Retry does not re-flip status.
- [ ] V2. Cathy replay: `.conm` warned at preview and at capture entry; dup-client warning offers the existing record; simulated bounce flips ledger red, raises needs-attention, alert email arrives, re-send clears the item.
- [ ] V3. Revert replay: approve, edit, client link still serves approved content; re-approve swaps it.
- [ ] V4. Push gate per house rules: push-time sweep + sensitive-path full fleet + /second-opinion (comms, webhook, schema, invoice flip are sensitive) + money-smoke gate.
