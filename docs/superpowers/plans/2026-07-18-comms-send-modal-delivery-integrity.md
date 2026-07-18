---
spec: docs/superpowers/specs/2026-07-18-comms-send-modal-delivery-integrity.md
lanes:
  - id: comms-registry
    footprint:
      - server/utils/comms/registry.js          # new: action table
      - server/utils/comms/actions/*.js         # new: per-action resolveRecipient/buildMessages/execute
      - server/utils/comms/registry.test.js
      - server/routes/comms.js                  # new: POST /preview, POST /send
      - server/routes/comms.test.js
      - server/index.js                         # mount /api/comms
      - server/utils/messageLog.js              # always-log rule (spec 4.7)
      - server/utils/messageLog.test.js
      - server/utils/emailTemplates.js          # additive bodyText/cta exports
      - server/utils/lifecycleEmailTemplates.js
      - server/routes/drinkPlans.js             # approve route delegates to execute
      - client/src/components/SendModal/*.jsx   # new shared modal
      - client/src/components/ShoppingList/ShoppingListModal.jsx
      - client/src/components/ShoppingList/ShoppingListButton.jsx
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # client-comms plumbing + messageLog ledger; treat as sensitive
  - id: comms-proposal-sends
    footprint:
      - server/utils/comms/actions/*.js
      - server/routes/proposals/lifecycle.js    # initial send, resend, portal invite
      - server/routes/proposals/actions.js
      - server/routes/proposals/groups.js       # send-group
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/AlternativesPanel.js
      - client/src/pages/admin/EventDetailPage.js
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]
    review: full-fleet   # proposal lifecycle is money-adjacent
  - id: comms-remaining-sends
    footprint:
      - server/utils/comms/actions/*.js
      - server/routes/drinkPlans.js             # resend-nudge
      - server/routes/drinkPlanConsult.js       # consult recap
      - server/routes/invoices.js               # invoice send
      - server/routes/admin/ccImport/proposalActions.js  # reenroll nudge
      - server/utils/preEventHandlers.js        # scheduler live-recipient adoption (spec 6)
      - client/src/pages/admin/DrinkPlanDetail.js
      - client/src/pages/admin/EventsDashboard.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - README.md
      - ARCHITECTURE.md
    blockedBy: [comms-registry]
    review: full-fleet   # invoice send touches money
  - id: bounce-pipeline
    footprint:
      - server/routes/emailMarketingWebhook.js  # extend to message_log statuses
      - server/routes/emailMarketingWebhook.idempotency.test.js
      - server/utils/emailValidation.js         # new: typo-domain heuristic (shared with capture-validation)
      - server/utils/emailValidation.test.js
      - server/utils/emailTemplates.js          # admin bounce-alert template
      - client/src/pages/admin/*                # Messages card bounced badge + needs-attention row (locate exact feed files in Task B1; if outside this footprint, STOP and surface before editing)
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # webhook path is sensitive
  - id: approved-snapshot
    footprint:
      - server/db/schema.sql                    # shopping_list_approved_snapshot JSONB
      - server/routes/drinkPlans.js             # public route serves snapshot; execute writes it
      - server/routes/drinkPlans.snapshot.test.js
      - server/utils/comms/actions/*.js         # shopping_list_approve execute update
      - client/src/components/ShoppingList/ShoppingListModal.jsx  # re-approve tooltip copy
      - ARCHITECTURE.md
    blockedBy: [comms-registry, comms-remaining-sends]   # serializes drinkPlans.js edits
    review: full-fleet   # schema.sql is sensitive
  - id: capture-validation
    footprint:
      - server/routes/clients.js                # GET /api/clients/similar
      - server/routes/clients.similar.test.js
      - client/src/pages/admin/*                # TT create-proposal page email-blur wiring (locate exact page in Task C1)
      - README.md
      - ARCHITECTURE.md
    blockedBy: [bounce-pipeline]               # consumes emailValidation.js
    review: light
---

# Comms Send Modal + Delivery Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id above, checkpoint commits in-lane, squash merge to main. Run order: `comms-registry` first; then `comms-proposal-sends`, `comms-remaining-sends`, `bounce-pipeline` in parallel; then `approved-snapshot`; `capture-validation` after `bounce-pipeline`. The L0 ops steps below are NOT a lane: prod data changes, each individually approved by Dallas before running.

**Goal:** Every admin-click client send opens one compose-and-confirm modal (recipient shown, channels selectable, message editable) backed by a comms registry that resolves recipients live, always logs, and reports honestly; bounces become visible end to end; an approved shopping list never turns into a dead client link; address typos and duplicate clients get flagged at capture.

**Architecture:** Central action registry (`server/utils/comms/`) with `preview`/`send` endpoints; one shared `SendModal` component; side-effect actions (approve, invoice) execute inside `send` so Cancel means nothing happened. Bounce webhook extends the existing `emailMarketingWebhook.js` into `message_log`. Snapshot column decouples what the client sees from admin edit state.

**Tech Stack:** Express + raw SQL (`pool.query`, parameterized), React 18 CRA, `node:test` against the shared dev DB.

## Global Constraints

- Raw SQL only, parameterized; schema changes idempotent (`ADD COLUMN IF NOT EXISTS`).
- API JSON keys snake_case; JS camelCase. Client API calls via `client/src/utils/api.js` only.
- Server errors: throw `AppError` subclasses, never bare `res.status(4xx)`.
- Money untouched: no pricing/payment logic changes anywhere in this plan; `invoice_send` converts the SEND step only, invoice creation math stays byte-identical.
- No em dashes in any client-facing copy.
- Server test law: suites run ALONE against the shared dev DB: `node -r dotenv/config --test <file>`; every created row cleaned up in `after()`.
- Client gate: `cd client && CI=true npx react-scripts build` must pass.
- Git: explicit pathspec staging only; lane checkpoints squash-merged.
- Footprint discipline: a lane needing a file outside its declared footprint ABORTS and surfaces (two tasks below explicitly locate files first for this reason).

## L0: Prod data repair (ops, approval-gated, run before or alongside comms-registry)

Each step shown to Dallas and approved individually before execution. All statements against prod via Neon MCP, SELECT-verified before and after.

- [ ] R1. Fix Cathy's typo record: `UPDATE clients SET email = 'cmurphy@arthrex-chicago.com' WHERE id = 1436 AND email = 'cmurphy@arthrex-chicago.conm'` and same-guard update on `drink_plans SET client_email` for plan 76. Verify both. Note client #1427 stays as dormant dup for manual archive.
- [ ] R2. Re-send Cathy's shopping list (existing approve is idempotent; use a fresh send: simplest is edit-nothing re-approve after a status bump, or wait for comms-registry and use the modal; Dallas picks timing, event is 7/25).
- [ ] R3. Siddhant plan 91: Dallas confirms list content final, then re-approve so his emailed links show the list again (event 7/23; do NOT wait for the snapshot lane).
- [ ] R4. Backfill stale snapshots: `UPDATE drink_plans dp SET client_email = c.email FROM proposals p JOIN clients c ON c.id = p.client_id WHERE p.id = dp.proposal_id AND dp.client_email IS DISTINCT FROM c.email AND c.email IS NOT NULL` scoped to future events only; SELECT the affected rows first (expected: plan 86 Brandon, plan 57 Aaran, possibly others).
- [ ] R5. Dallas manual: register Resend webhook (dashboard) at `https://api.drbartender.com/api/email-marketing/webhook/resend`, events sent/delivered/bounced/complained; set `RESEND_WEBHOOK_SECRET` in Render. Precondition for bounce-pipeline verification, not for its code.

## Lane comms-registry

- [ ] T1. `server/utils/comms/registry.js` + `actions/shoppingListApprove.js`: action contract per spec 4.1 (`resolveRecipient`, `buildMessages`, `defaultChannels`, `execute`). Recipient resolution: proposal join to `clients` (live), fallback to `drink_plans` snapshot with `source: 'snapshot'` + warning. Port the approve route's atomic transition + hosted skip into `execute`; hosted returns email-unavailable with reason.
- [ ] T2. Template contract: add `shoppingListReadyParts()` (subject, bodyText, cta) to `lifecycleEmailTemplates.js`, re-wrap at send time (esc + paragraphs + ctaButton + signature inside `wrapEmail`). Existing exports untouched.
- [ ] T3. `messageLog.js` always-log rule (spec 4.7): insert with NULL `client_id` when `proposalId` supplied; keep early return only when both unresolvable. Extend `messageLog.test.js`: unresolvable-recipient-with-proposalId now logs; admin/marketing mail without proposalId still skips.
- [ ] T4. `server/routes/comms.js`: `POST /api/comms/preview` + `POST /api/comms/send` (auth + requireAdminOrManager), warnings per spec 4.2 (stale-snapshot mismatch, typo-domain via inline list until bounce-pipeline lands its shared util, missing email/phone). Mount in `index.js`. Route tests: preview shape, send executes approve exactly once (double-submit uses the atomic guard), per-channel skip reasons, edited body lands in sent payload.
- [ ] T5. `SendModal` component: preview fetch, To: line + warnings, channel checkboxes with defaults, editable subject/body/SMS with segment hint, fixed CTA block preview, result state with per-channel truth, Cancel = no-op. Vanilla CSS in `index.css` per house style.
- [ ] T6. Convert `ShoppingListModal.jsx` / `ShoppingListButton.jsx`: "Approve & Send to Client" opens SendModal (action `shopping_list_approve`); remove the direct PATCH call; approve-state copy driven by the send result ("Approved, emailed X" vs "Approved, no email sent: hosted"). Keep the PATCH route mounted and delegating to `execute` (API compat), marked deprecated in ARCHITECTURE.md.
- [ ] T7. Mid-lane review checkpoint: security-review agent on the new endpoints (IDOR: entityId access, role guards) + messageLog change; then client build gate; manual verify on dev (approve a scratch plan end to end, confirm ledger row with edited body, confirm cancel leaves status pending).
- [ ] T8. Docs: README folder tree (comms module, SendModal), ARCHITECTURE.md route table (/api/comms) + comms section.

## Lane comms-proposal-sends

- [ ] P1. Actions `proposal_send`, `proposal_resend`, `proposal_send_group`, `portal_invite` in `actions/`: reuse existing template builders via parts exports; recipient live-resolve; defaults per spec 4.5. `execute` wraps the existing route logic (send-group's AB-BA lock behavior unchanged).
- [ ] P2. Convert surfaces: ProposalDetail (resend, portal invite), AlternativesPanel (send-group), EventDetailPage (portal invite), initial-send path in the creation flow. Old direct endpoints delegate to `execute` for API compat.
- [ ] P3. Tests per action (send exactly-once, skip reasons); client build gate; manual verify resend + invite on a scratch proposal.
- [ ] P4. Docs rows for converted endpoints.

## Lane comms-remaining-sends

- [ ] N1. Actions `drink_plan_nudge`, `drink_plan_nudge_reenroll`, `event_reminder`, `invoice_send`, `consult_recap`. Invoice: creation math untouched, only the notification step moves into `execute` (draft-to-sent flip stays exactly as today, per CC-import flow).
- [ ] N2. Convert surfaces: DrinkPlanDetail, EventsDashboard, ProposalDetailPaymentPanel, EventDetailPage reenroll, consult save flow.
- [ ] N3. Scheduler live-recipient adoption in `preEventHandlers.js` for senders already reading snapshot columns (spec 6): switch to the shared resolver, behavior otherwise identical. No compose step for schedulers.
- [ ] N4. Tests + client build gate + manual verify (nudge resend + invoice send on scratch rows). Mid-lane review checkpoint after N1: money-path reviewer on invoice_send delta.
- [ ] N5. Docs rows.

## Lane bounce-pipeline

- [ ] B1. Locate the needs-attention feed implementation (commit dfe4afe) and the admin Messages card component; if either lives outside this lane's footprint, STOP and surface (footprint discipline) before editing.
- [ ] B2. `server/utils/emailValidation.js`: typo-domain heuristic per spec 4.8 (edit-distance-1 TLDs + provider confusables), pure, tested. Comms preview switches to it from the inline list (one-line change inside comms footprint overlap: `server/utils/comms/` is owned by other lanes; instead export and leave the preview switch as a follow-up noted in the fix-list if merge order makes it awkward).
- [ ] B3. Extend `emailMarketingWebhook.js`: on bounced/complained, update matching `message_log` row by `provider_id` (status, error_message); keep existing email_sends marketing processing and idempotency contract intact (extend the idempotency test).
- [ ] B4. Hard bounce on a row with `proposal_id`: needs-attention item + admin alert email (new template in `emailTemplates.js`; email only, no SMS). Alert includes client name, message type, bounced address, link to the client.
- [ ] B5. Messages card: red `bounced`/`complained` badge with error text.
- [ ] B6. Verification (needs R5 done): fire a Resend test webhook event at dev, confirm ledger flip + needs-attention row + alert email to a scratch inbox. Then full-fleet review (webhook is sensitive).
- [ ] B7. Docs: ARCHITECTURE webhook section, README env note (RESEND_WEBHOOK_SECRET now load-bearing in prod).

## Lane approved-snapshot

- [ ] S1. `schema.sql`: `ALTER TABLE drink_plans ADD COLUMN IF NOT EXISTS shopping_list_approved_snapshot JSONB`.
- [ ] S2. `shoppingListApprove.execute`: write snapshot in the same UPDATE that flips status. Re-approve overwrites.
- [ ] S3. Public token route: `pending_review` + snapshot present serves the snapshot with `ready: true`; pending screen only when no snapshot ever. Underscore-key stripping applies to the snapshot serve path too.
- [ ] S4. Backfill on deploy: one-time `UPDATE drink_plans SET shopping_list_approved_snapshot = shopping_list WHERE shopping_list_status = 'approved' AND shopping_list_approved_snapshot IS NULL` (idempotent, safe re-run) so currently-approved lists survive their next edit.
- [ ] S5. `ShoppingListModal.jsx` re-approve tooltip copy: client still sees the last approved version.
- [ ] S6. Tests: snapshot written on approve, served while pending, replaced on re-approve; schema idempotency. Full-fleet review (schema).
- [ ] S7. ARCHITECTURE schema section.

## Lane capture-validation

- [ ] C1. Locate the TT create-proposal page component (email capture per the harvester flow) plus any admin client-create form; if outside footprint, surface first.
- [ ] C2. `GET /api/clients/similar?email=&name=` (auth, admin): same-name match OR edit-distance-1 on email local part or domain; returns matches with id/name/email. Parameterized, tested.
- [ ] C3. Email-blur wiring: typo warning (emailValidation.js) + dup warning with link to existing client. Warn only, never block.
- [ ] C4. Client build gate; light review; README note.

## Verification (whole project)

- [ ] V1. End-to-end on dev: full Brandon replay (stale plan email + changed client email): modal shows live gmail + mismatch warning, send logs a row, bounce webhook test event flips it red.
- [ ] V2. Cathy replay: typo domain warned at preview; capture page warns on `.conm` entry and offers the existing client.
- [ ] V3. Revert replay: approve, edit, confirm client link still serves the approved list.
- [ ] V4. Push gate per house rules: push-time sweep + sensitive-path full fleet + /second-opinion on the batch (comms + webhook + schema are sensitive), money-smoke gate.
