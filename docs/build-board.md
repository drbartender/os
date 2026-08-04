# Build Board

Maintained by Claude as a byproduct of working, never by Dallas. It is the index: each ready item links to its spec and plan, so the thinking is one click away.

Note: this board carries titles and paths ONLY. Never paste spec or plan bodies here, and never a customer name, token, Stripe id, or any payload. Writes go through `scripts/board-write.sh`, which enforces a denylist before any commit. Keep the section headings below stable: the write helper anchors on them.

## Ready to build

<!-- plan written + reviewed, no lane cut. One line per item, linking its spec + plan. -->

- **phone-system-1a** — phone redesign phase 1a: call experience (spec rev 3, fleet folded). [spec](superpowers/specs/2026-07-26-phone-system-redesign-design.md) / [plan](superpowers/plans/2026-07-26-phone-system-1a-call-experience.md)

## In flight

<!-- lane open and building. Stale-lane flags surface here. One line per item. -->

- **staff-display-name** — preferred name plus last initial across surfaces; single serial lane, cut 2026-08-04 (plan rev 3, freshness-audited). [spec](superpowers/specs/2026-07-26-staff-display-name-design.md) / [plan](superpowers/plans/2026-07-26-staff-display-name.md)
## Recently shipped

<!-- merged + shipped lanes, newest first. Ages off over time. One line per item. -->

- **service-extension** — all 5 lanes built, merged, and PUSHED 2026-08-04 (plan rev 5.1); per-lane fleets caught two money blockers pre-merge (gratuity re-accrual on grace-window payments; stranded-alert storm throttle); push gate = integration sweep + gratuity/TT re-confirm + codex second opinion. [spec](superpowers/specs/2026-07-25-service-extension-design.md) / [plan](superpowers/plans/2026-07-26-service-extension.md)
- **event-details revival** — the three stale 7/22 staff event-details lanes revived onto fresh main as one lane, merged + PUSHED 2026-08-03; full fleet, push re-confirm, and cross-LLM second opinion (codex caught a cross-shift drop blocker, fixed pre-push). [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **invoice-derivation batch** — all 5 lanes merged 2026-07-28, pushed 2026-08-03; lane 1's derivation rewrite deliberately REVERTED same evening (monitor, void UI, netting kept); redo queued provenance-first. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **sms-optin** — standalone /sms opt-in page (A2P fix), shipped by cherry-pick 2026-07-30 ahead of the held batch. [spec](superpowers/specs/2026-07-30-sms-opt-in-page.md)
- **onboarding-upload-and-draft** — 4 lanes (upload-honesty, onboarding-drafts, document-visibility, submit-gate-relax) merged 2026-07-26..28, pushed 2026-08-03 with fleet fixes. [plan](superpowers/plans/2026-07-26-onboarding-upload-and-draft.md)
- **addon-quantity-semantics** — merged in the 2026-07-26 window, pushed 2026-08-03. [plan](superpowers/plans/2026-07-26-addon-quantity-semantics.md)
- **email-designer** — drag-and-drop designed-email builder on the Marketing composer (design_json → server-rendered html; upload/preview/test endpoints). Merged + pushed 2026-08-03 (a0632ae3) after full fleet re-confirmation + codex/gemini second opinion; no spec doc (patch import from a claude.ai/code session).
- **gratuity-election-at-payment** — Delara 665 root cause: checkout tip-jar election persisted before payment, baking "mandated" gratuity into abandoned quotes. 3 lanes (intent-webhook, admin-lockdown, copy-reset) merged 2026-08-04, UNPUSHED; election now rides intent metadata and persists only on payment success; admin preset removed; prod reset of ~14 rows gated on deploy + per-action approval. [spec](superpowers/specs/2026-08-03-gratuity-election-at-payment-design.md) / [plan](superpowers/plans/2026-08-03-gratuity-election-at-payment.md)
