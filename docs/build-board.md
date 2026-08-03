# Build Board

Maintained by Claude as a byproduct of working, never by Dallas. It is the index: each ready item links to its spec and plan, so the thinking is one click away.

Note: this board carries titles and paths ONLY. Never paste spec or plan bodies here, and never a customer name, token, Stripe id, or any payload. Writes go through `scripts/board-write.sh`, which enforces a denylist before any commit. Keep the section headings below stable: the write helper anchors on them.

## Ready to build

<!-- plan written + reviewed, no lane cut. One line per item, linking its spec + plan. -->

- **service-extension** — on-site service extension, side-money model (rev 3 APPROVED 2026-07-26). [spec](superpowers/specs/2026-07-25-service-extension-design.md) / [plan](superpowers/plans/2026-07-26-service-extension.md)
- **phone-system-1a** — phone redesign phase 1a: call experience (spec rev 3, fleet folded). [spec](superpowers/specs/2026-07-26-phone-system-redesign-design.md) / [plan](superpowers/plans/2026-07-26-phone-system-1a-call-experience.md)
- **seniority-history-backfill** — hire dates + pre-migration event counts from CheckCherry. [spec](superpowers/specs/2026-07-26-seniority-history-backfill-design.md) / [plan](superpowers/plans/2026-07-26-seniority-history-backfill.md)
- **staff-display-name** — preferred name plus last initial across surfaces. [spec](superpowers/specs/2026-07-26-staff-display-name-design.md) / [plan](superpowers/plans/2026-07-26-staff-display-name.md)

## In flight

<!-- lane open and building. Stale-lane flags surface here. One line per item. -->

- **event-details-server** — BLOCKED: conflicts with main on server/db/schema.sql (sensitive path, stop-and-ask). STALE, cut 2026-07-22, 9 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **event-details-admin-ui** — admin menu-print upload block. Merges clean but must ship WITH the server lane. STALE, cut 2026-07-22, 2 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **event-details-staff-ui** — staff event-details page. Merges clean but must ship WITH the server lane. STALE, cut 2026-07-22, 2 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **email-designer** — drag-and-drop designed-email builder on the Marketing composer. Cut 2026-08-03, 2 commits, built by a separate session; NO spec doc, per-lane review owed before merge.

## Recently shipped

<!-- merged + shipped lanes, newest first. Ages off over time. One line per item. -->

- **invoice-derivation batch** — all 5 lanes merged 2026-07-28, pushed 2026-08-03; lane 1's derivation rewrite deliberately REVERTED same evening (monitor, void UI, netting kept); redo queued provenance-first. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **sms-optin** — standalone /sms opt-in page (A2P fix), shipped by cherry-pick 2026-07-30 ahead of the held batch. [spec](superpowers/specs/2026-07-30-sms-opt-in-page.md)
- **onboarding-upload-and-draft** — 4 lanes (upload-honesty, onboarding-drafts, document-visibility, submit-gate-relax) merged 2026-07-26..28, pushed 2026-08-03 with fleet fixes. [plan](superpowers/plans/2026-07-26-onboarding-upload-and-draft.md)
- **addon-quantity-semantics** — merged in the 2026-07-26 window, pushed 2026-08-03. [plan](superpowers/plans/2026-07-26-addon-quantity-semantics.md)
