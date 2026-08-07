// Admin-creatable duty kinds for the "Add duty line" control.
// MIRROR of server/utils/dutyLines.js DUTY_KIND_LABELS (EVENT kinds only —
// review money is never manually creatable), kept in sync manually, same
// convention as eventTypes.js / gratuityLabels.js server+client twins.
// Rendered duty lines always use the LABEL THE PAYLOAD CARRIES; this list
// exists only so the add-select can offer kinds before any line exists.
// out_of_area is deliberately NOT offered here: bonus money flows through the
// shift-level knob with its own cap and lock (spec §6), never free-typed.
// default_cents mirror the policy amounts (spec §2); hosted_supplies is a flat
// $50 (Dallas 2026-08-07; the old rate-based block is gone), same as derivation.
export const EVENT_KIND_OPTIONS = [
  { kind: 'bar_rental', label: 'Bar rental', default_cents: 2000 },
  { kind: 'parking', label: 'Parking', default_cents: 2000 },
  { kind: 'equipment_supplies', label: 'Equipment & supplies', default_cents: 2000 },
  { kind: 'hosted_supplies', label: 'Hosted supplies & load', default_cents: 5000 },
  { kind: 'menu_print', label: 'Menu print', default_cents: 500 },
];
