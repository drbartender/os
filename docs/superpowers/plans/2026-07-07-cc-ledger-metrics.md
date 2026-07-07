---
lanes:
  - id: cc-demolition
    footprint:
      - scripts/cc-import.js
      - scripts/cc-import/**
      - server/routes/admin/ccImport/**
      - server/routes/admin/index.js
      - client/src/pages/admin/CcImport*.js
      - client/src/components/admin/LegacyCcPaymentsPanel.js
      - client/src/components/admin/CcImportBadge.js
      - client/src/pages/admin/ClientsDashboard.js
      - client/src/pages/admin/ClientDetail.js
      - client/src/App.js
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
      # widened at build time (surfaced per the footprint rule): CcImportBadge
      # had 5 more importers than the plan knew, plus the dead npm scripts.
      - client/src/pages/admin/ProposalsDashboard.js
      - client/src/pages/admin/EventDetailPage.js
      - client/src/pages/admin/ProposalDetailEditForm.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/FinancialsDashboard.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - package.json
    deps: []
    review: light + client build gate (deletion lane; grep-proven zero references)
    # Build-time carve-out (correct deviation): server/routes/admin/ccImport/
    # proposalActions.js + test SURVIVE — they serve two LIVE endpoints
    # (reenroll-drink-plan-nudge, reaccrue-payout) wired to live admin buttons;
    # not v1 code. Follow-up noted: crud.js /:id/legacy-cc-payments is now
    # clientless (dead endpoint in sensitive proposals/, cleanup later).
  - id: cc-ledger
    footprint:
      - scripts/cc-ledger-import.js
      - scripts/cc-ledger-import.test.js
      - server/db/schema.sql
    deps: []
    review: full fleet (schema.sql is a sensitive path; money-unit conversions)
  - id: cc-metrics
    footprint:
      - server/utils/metricsQueries.js
      - server/utils/metricsQueries.test.js
      - server/routes/proposals/metadata.js
      - client/src/pages/admin/Dashboard.js
    deps: [cc-ledger]
    review: full fleet (proposals route + money display)
---

# CC ledger + metrics blend — lane map, 2026-07-07

Spec: `docs/superpowers/specs/2026-07-07-cc-ledger-metrics-design.md`.

Run order: **cc-demolition** and **cc-ledger** are independent (parallel-safe;
demolition deletes only v1 code, ledger adds only new files + 2 idempotent
ADD COLUMNs). **cc-metrics** builds after cc-ledger merges (consumes the
loaded dev data for its tests). Page redesign is explicitly out of scope.

Prod runbook after push: deploy replays schema (new columns), then
`node scripts/cc-ledger-import.js --payments ... --expenses ... --events ...`
dry-run, then `--replace --apply` on Dallas's go (same gate discipline as the
phase-1 client import). Load verification must tie to the P&L files to the
penny or the transaction aborts.

Notes for the demolition lane: CcImportBadge is LIVE-visible on 187 prod
clients since the phase-1 apply (urgent); users.js/payroll.js grep hits on
cc_id are legit column references that STAY (only v1 UI/importer code dies);
tests under server/routes/admin/ccImport/ die with their routes; check
`docs/superpowers/specs/2026-05-25-checkcherry-import-design.md` +
`2026-05-30-cc-importer-v2-design.md` stay as historical record (docs never
deleted). README/ARCHITECTURE structural updates ride the lane per the
mandatory-docs rule.
