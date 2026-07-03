import React, { useState, useEffect } from 'react';
import PrescriptionCard from './PrescriptionCard';
import { formatCurrency } from './helpers';

// Fixed bottom price bar for the quote wizard on phones (mobile-fixes plan,
// Task C2). Left: the live Prescription total, tap to open the full breakdown
// as a bottom sheet. Right: the step's primary action. CSS shows the bar at
// 900px and below and hides the desktop sidebar + in-flow primary button
// (scoped to #quote so the class wizard is untouched).
//
// LOAD-BEARING: on the final step, `onSubmit`/`submitting` MUST be the same
// guarded handler/state the in-flow button uses (QuoteWizard handleSubmit,
// disabled while submitting). Submit creates a real proposal and lead; a
// second unguarded button would let a mobile double-tap create duplicates.
export default function WizardPriceBar({ preview, isFinalStep, submitting, onContinue, onSubmit, hidden }) {
  const [sheetOpen, setSheetOpen] = useState(false);

  // Body scroll lock while the sheet is open.
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [sheetOpen]);

  // `hidden` = a text input is focused (the iOS keyboard fights fixed-bottom
  // bars). Also close the sheet if the bar goes hidden.
  useEffect(() => { if (hidden) setSheetOpen(false); }, [hidden]);
  if (hidden) return null;

  return (
    <>
      {sheetOpen && (
        <div className="wz-pricebar-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="wz-pricebar-sheet" role="dialog" aria-label="Price breakdown" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="wz-pricebar-sheet-close" onClick={() => setSheetOpen(false)}>Close</button>
            <PrescriptionCard preview={preview} />
          </div>
        </div>
      )}
      <div className="wz-pricebar">
        {preview ? (
          <button type="button" className="wz-pricebar-price" onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
            The Prescription · {formatCurrency(preview.total)}
          </button>
        ) : <span />}
        {isFinalStep ? (
          <button type="button" className="btn btn-primary wz-pricebar-cta" onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Submitting...' : 'Send proposal · See my quote'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary wz-pricebar-cta" onClick={onContinue}>
            Continue →
          </button>
        )}
      </div>
    </>
  );
}
