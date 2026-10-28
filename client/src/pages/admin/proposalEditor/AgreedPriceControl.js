// Set agreed price: one dollar input and Apply beside + Discount / + Surcharge, gated on a fresh
// preview; a booking that still has an override shows it read-only

import React, { useState } from 'react';
import { fmt$2dp } from '../../../components/adminos/format';
import { SHARED_GRATUITY_LABEL } from '../../../utils/gratuityLabels';
import { parseAgreedCents, applyAgreedPrice, previewServiceCentsOf } from './agreedPrice';

// "Set agreed price" (spec 2026-10-16 section 5), the third button beside
// + Discount and + Surcharge. It opens one dollar input and Apply; Apply hands
// the lines from agreedPrice.js to onApply, so the line and the new total show
// in the form (and its live preview) before the save.
//
// Apply waits for a fresh preview: the math reads the preview's service total,
// so a stale or missing one would price against the wrong figure. A booking
// that still carries a price override shows it read-only instead: while the
// override stands the engine ignores the lines for the service total, and the
// conversion turns it into an agreed-price line (spec section 8).
const HELPER = 'Before gratuity. Gratuity is added on top.';

export default function AgreedPriceControl({ adjustments, preview, previewStale, override, onApply }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState('');
  const hasOverride = override !== null && override !== undefined && override !== '';
  const parsed = parseAgreedCents(text);
  const serviceCents = previewServiceCentsOf(preview);
  const canApply = !hasOverride && !parsed.error && !previewStale && serviceCents !== null;
  // Over-ratio bartenders carry the forced staffing gratuity inside the package
  // price (payrollMath.js pools it from the breakdown), so it is in the figure.
  const staffingGratuity = Array.isArray(preview?.breakdown)
    && preview.breakdown.some((row) => row && row.label === SHARED_GRATUITY_LABEL);

  const apply = () => {
    if (!canApply) return;
    const result = applyAgreedPrice({ adjustments, previewServiceCents: serviceCents, agreedCents: parsed.cents });
    if (result.error) { setRefusal(result.error); return; }
    onApply(result.adjustments);
    setOpen(false);
    setText('');
    setRefusal('');
  };

  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={hasOverride} aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setRefusal(''); }}>
        Set agreed price
      </button>
      {hasOverride && (
        <p className="agreed-price-note tiny">
          Price override: {fmt$2dp(override)}. It converts to an Agreed price adjustment line soon.
        </p>
      )}
      {open && !hasOverride && (
        <div className="agreed-price-panel">
          <div className="hstack" style={{ gap: 6 }}>
            <div className="agreed-price-input">
              <span aria-hidden="true">$</span>
              <input className="input" inputMode="decimal" placeholder="0.00" aria-label="Agreed price"
                value={text}
                onChange={(e) => { setText(e.target.value); setRefusal(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} />
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!canApply} onClick={apply}>
              Apply
            </button>
          </div>
          {parsed.error && <div className="agreed-price-msg tiny">{parsed.error}</div>}
          {refusal && <div className="agreed-price-msg tiny" role="alert">{refusal}</div>}
          <div className="tiny muted">{staffingGratuity ? `${HELPER} Includes staffing gratuity.` : HELPER}</div>
        </div>
      )}
    </>
  );
}
