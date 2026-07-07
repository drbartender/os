---
lanes:
  - id: cc-transfer
    footprint:
      - server/db/schema.sql
      - scripts/cc-transfer-events.js
      - scripts/cc-transfer-events.test.js
      - scripts/cc-ledger-import.js
      - scripts/cc-ledger-import.test.js
      - server/utils/drinkPlanNudge.js
      - server/utils/eventCreation.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/getOne.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      # widened at build time (surfaced per the footprint rule): the money
      # reviewer found refreshUnlockedInvoices re-bills external_paid on
      # refreshed Balance/Full Payment invoices — netted there + DB test.
      - server/utils/invoiceLifecycle.js
      - server/utils/invoiceLifecycle.external.test.js
      - ARCHITECTURE.md
      - README.md
    deps: []
    review: full fleet (schema + money bookkeeping + comms guards) + /second-opinion at push
---

# CC event transfer — lane map, 2026-07-07

Spec: `docs/superpowers/specs/2026-07-07-cc-transfer-events-design.md`.

One lane; the pieces are too interlocked to split (the script consumes the
schema columns, the guards live where the script's writes land, the loader
skip pairs with the ledger-row delete).

Build order inside the lane:
1. Schema: `proposals.transferred_from_cc_id TEXT` (partial unique index) +
   `proposals.external_paid NUMERIC(10,2) NOT NULL DEFAULT 0` (whole-dollar
   proposals exception), idempotent.
2. Code study FIRST (max effort, seam doc re-read): the exact create+confirm
   path (crud.js POST, eventCreation.js, drink-plan hook), every
   sendEmail/scheduleMessage/SMS reachable from it, bookingWindow/last-minute
   trigger points, webhook status math on amount_paid-carrying proposals.
3. `scripts/cc-transfer-events.js`: manifest-driven, dry-run default,
   per-event transaction, drives the real creation helpers, then the
   transfer finalize (status/accepted_at/external_paid/amount_paid/
   balance_due_date/transferred_from_cc_id, drink plan with nudge
   suppression, ledger-row delete). Post-apply verification prints each
   event's computed balance + a zero-scheduled-comms assertion.
4. Loader: skip transferred cc_ids on reload + report count; adjust gates.
5. Payment panel: "Collected in CheckCherry" line when external_paid > 0.
6. Tests: pure mapping/guard units + a dev-DB transfer of one synthetic
   manifest entry asserting no scheduled messages, correct balance, correct
   status, ledger-row removal, and webhook-simulated balance payment math.

Prod runbook after push: deploy (schema rides initDb), dry-run against prod
with the real manifest, Dallas's go, apply, verify 13 proposals + balances +
zero scheduled comms, THEN Dallas turns off CC client notifications.
Manifest lives at ~/cc-archive/2026-07-07-transfer-manifest.json (PII off-repo).
