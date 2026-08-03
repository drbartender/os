# Build Board

Maintained by Claude as a byproduct of working, never by Dallas. It is the index: each ready item links to its spec and plan, so the thinking is one click away.

Note: this board carries titles and paths ONLY. Never paste spec or plan bodies here, and never a customer name, token, Stripe id, or any payload. Writes go through `scripts/board-write.sh`, which enforces a denylist before any commit. Keep the section headings below stable: the write helper anchors on them.

## Ready to build

<!-- plan written + reviewed, no lane cut. One line per item, linking its spec + plan. -->

## In flight

<!-- lane open and building. Stale-lane flags surface here. One line per item. -->

- **invoice-derivation** — lane 1: derivation rewrite, 14 tests. STALE, cut 2026-07-28, 2 checkpoint commits (unfinished). [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **invoice-fixes** — review-fleet blockers found in the derivation batch. STALE, cut 2026-07-28, 1 commit. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **overpayment-netting** — net overpayment by not-in-total, not by contract labels. STALE, cut 2026-07-28, 1 commit. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **overbill-monitor** — lane 2: alert-only balance monitor. BLOCKED: needs lane 1 merged first. STALE, cut 2026-07-28, 1 checkpoint. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **invoice-void-ui** — lane 3: void action on open invoices. Independent, client-only. STALE, cut 2026-07-28, 1 checkpoint. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **event-details-server** — BLOCKED: conflicts with main on server/db/schema.sql (sensitive path, stop-and-ask). STALE, cut 2026-07-22, 9 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **event-details-admin-ui** — admin menu-print upload block. Merges clean but must ship WITH the server lane. STALE, cut 2026-07-22, 2 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **event-details-staff-ui** — staff event-details page. Merges clean but must ship WITH the server lane. STALE, cut 2026-07-22, 2 commits. [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
## Recently shipped

<!-- merged + shipped lanes, newest first. Ages off over time. One line per item. -->
