import React from 'react';

// Shared add-on controls — used by the admin proposal cockpit (ProposalCreate)
// and the proposal edit form (ProposalDetailEditForm). Extracted verbatim from
// ProposalCreate so the two surfaces stay byte-identical; no behavior change.

// Clamp a stepper value into the supported 1–10 quantity range. The cockpit and
// the edit form both bound addon_quantities with this — keep it the single
// source so the two never drift. (The server independently re-clamps via
// safeAddonQty; this is the UI-side guard.)
export const clampAddonQty = (n) => Math.min(10, Math.max(1, n));

// Greyed bundle badge — shared by selected rows and the quick-add dropdown.
export const BundleBadge = ({ text }) => (
  <span
    className="tiny mono"
    style={{
      marginLeft: 8, padding: '1px 6px', borderRadius: 3,
      background: 'var(--bg-2)', border: '1px solid var(--line-2)',
      color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}
  >
    {text}
  </span>
);

// Inline 1–10 quantity stepper for quantity-capable selected add-ons.
export const AddonQtyStepper = ({ value, onChange }) => {
  const qty = value || 1;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 10 }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        style={{ width: 20, height: 18, padding: 0 }}
        disabled={qty <= 1}
        onClick={() => onChange(qty - 1)}
        aria-label="Decrease quantity"
      >−</button>
      <span className="num tiny" style={{ minWidth: 14, textAlign: 'center', color: 'var(--ink-1)' }}>{qty}</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        style={{ width: 20, height: 18, padding: 0 }}
        disabled={qty >= 10}
        onClick={() => onChange(qty + 1)}
        aria-label="Increase quantity"
      >+</button>
    </span>
  );
};
