# Build Board

Maintained by Claude as a byproduct of working, never by Dallas. It is the index: each ready item links to its spec and plan, so the thinking is one click away.

Note: this board carries titles and paths ONLY. Never paste spec or plan bodies here, and never a customer name, token, Stripe id, or any payload. Writes go through `scripts/board-write.sh`, which enforces a denylist before any commit. Keep the section headings below stable: the write helper anchors on them.

## Ready to build

<!-- plan written + reviewed, no lane cut. One line per item, linking its spec + plan. -->

## In flight

<!-- lane open and building. Stale-lane flags surface here. One line per item. -->

## Recently shipped

<!-- merged + shipped lanes, newest first. Ages off over time. One line per item. -->

- **duty-residuals** — built, reviewed, MERGED 2026-08-07 (not pushed): hosted supplies to a flat $50 duty line (supply-hours model retired), out-of-area knob no-op/auto-lock semantics, ShiftDrawer knob, serviceArea geocode throttle rework, 25P02 pre-screen in extension repricing. [plan-ref](fix-list-remaining-2026-07-02.md)
- **phone-system-1a** — built + full-fleet-reviewed + MERGED 2026-08-07 (not pushed): two-line call experience (1922 rings Dallas, per-line greetings/voicemail, press-1 escalation ships dark). Fleet caught a signature-order DoS, an advisory-cap race, a sweep starvation blocker — all fixed + re-verified; second opinion clean. SHIP-TIME: Render env (VM_PRIMARY_DIAL_TARGET, VM_TEXT_DESTINATION) BEFORE pointing the 1922 webhooks, same sitting as the push — checklist in plan Ops section. [spec](superpowers/specs/2026-07-26-phone-system-redesign-design.md) / [plan](superpowers/plans/2026-07-26-phone-system-1a-call-experience.md)
- **owner-no-draw** — both lanes (engine, ui) built, fleet-reviewed, and MERGED 2026-08-07 (not pushed); fleet caught a one-connection audit deadlock, an un-park finalize race, and a CI-fatal orphan; browser walks done both portals. SHIP-TIME: prod DDL + backfill (payouts 80/83/92/98, close period 72) BEFORE the push — checklist in plan. [spec](superpowers/specs/2026-08-07-owner-no-draw-payouts-design.md) / [plan](superpowers/plans/2026-08-07-owner-no-draw-payouts.md)
- **service-extension** — all 5 lanes built, merged, and PUSHED 2026-08-04 (plan rev 5.1); per-lane fleets caught two money blockers pre-merge (gratuity re-accrual on grace-window payments; stranded-alert storm throttle); push gate = integration sweep + gratuity/TT re-confirm + codex second opinion. [spec](superpowers/specs/2026-07-25-service-extension-design.md) / [plan](superpowers/plans/2026-07-26-service-extension.md)
- **event-details revival** — the three stale 7/22 staff event-details lanes revived onto fresh main as one lane, merged + PUSHED 2026-08-03; full fleet, push re-confirm, and cross-LLM second opinion (codex caught a cross-shift drop blocker, fixed pre-push). [spec](superpowers/specs/2026-07-22-staff-event-details-design.md) / [plan](superpowers/plans/2026-07-22-staff-event-details.md)
- **invoice-derivation batch** — all 5 lanes merged 2026-07-28, pushed 2026-08-03; lane 1's derivation rewrite deliberately REVERTED same evening (monitor, void UI, netting kept); redo queued provenance-first. [spec](superpowers/specs/2026-07-28-invoice-derivation-and-monitor-design.md) / [plan](superpowers/plans/2026-07-28-invoice-derivation-and-monitor.md)
- **sms-optin** — standalone /sms opt-in page (A2P fix), shipped by cherry-pick 2026-07-30 ahead of the held batch. [spec](superpowers/specs/2026-07-30-sms-opt-in-page.md)
- **onboarding-upload-and-draft** — 4 lanes (upload-honesty, onboarding-drafts, document-visibility, submit-gate-relax) merged 2026-07-26..28, pushed 2026-08-03 with fleet fixes. [plan](superpowers/plans/2026-07-26-onboarding-upload-and-draft.md)
- **addon-quantity-semantics** — merged in the 2026-07-26 window, pushed 2026-08-03. [plan](superpowers/plans/2026-07-26-addon-quantity-semantics.md)
- **email-designer** — drag-and-drop designed-email builder on the Marketing composer (design_json → server-rendered html; upload/preview/test endpoints). Merged + pushed 2026-08-03 (a0632ae3) after full fleet re-confirmation + codex/gemini second opinion; no spec doc (patch import from a claude.ai/code session).
- **gratuity-election-at-payment** — Delara 665 root cause: checkout tip-jar election persisted before payment, baking "mandated" gratuity into abandoned quotes. 3 lanes (intent-webhook, admin-lockdown, copy-reset) merged 2026-08-04, UNPUSHED; election now rides intent metadata and persists only on payment success; admin preset removed; prod reset of ~14 rows gated on deploy + per-action approval. [spec](superpowers/specs/2026-08-03-gratuity-election-at-payment-design.md) / [plan](superpowers/plans/2026-08-03-gratuity-election-at-payment.md)
- **staff-display-name + seniority-backfill + gate-fixes** — the 8/05 batch PUSHED 2026-08-06 (677baf95): display-name rollout, seniority baseline + CC import tooling, and the push-gate fix lane (SMS-tiebreak trigger fix, zeroing fix, omitted-name keep). Prod DDL + display-name backfill ran BEFORE the push (zero-outage order); codex/gemini second opinion clean. [spec](superpowers/specs/2026-07-26-staff-display-name-design.md) / [plan](superpowers/plans/2026-07-26-staff-display-name.md)
