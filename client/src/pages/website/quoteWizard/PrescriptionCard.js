import React from 'react';
import { resolveGratuityDisplayLabel } from '../../../utils/gratuityLabels';
import { formatCurrency } from './helpers';

// The "Prescription" live-estimate card, extracted verbatim from the inline
// .wz-price-card block in QuoteWizard so the desktop sidebar and the mobile
// price-bar sheet render from one source (mobile-fixes plan, Task C1).
export default function PrescriptionCard({ preview }) {
  return (
    <div className="wz-price-card">
      <div className="kicker no-rule wz-price-kicker">Live Estimate</div>
      <h3 className="wz-price-name">The Prescription</h3>
      {preview ? (
        <>
          <div className="wz-price-total">{formatCurrency(preview.total)}</div>
          <div className="wz-price-sub">final · all-in · adjusts down for unused hours</div>
          <div className="divider-ornate wz-price-divider"><span>breakdown</span></div>
          <div className="wz-price-breakdown">
            {preview.breakdown.map((item, i) => (
              <div key={i} className="wz-price-line">
                <span>{resolveGratuityDisplayLabel(item.label, preview)}</span>
                <span>{formatCurrency(item.amount)}</span>
              </div>
            ))}
          </div>
          {preview.floor_applied && (
            <div className="wz-price-note">Small event minimum applies</div>
          )}
          <div className="wz-price-meta">
            {preview.staffing.actual} bartender{preview.staffing.actual !== 1 ? 's' : ''} included
          </div>
          <div className="wz-price-trust">
            <div className="wz-trust-item">
              <span className="wz-trust-mark" aria-hidden="true">⚗</span>
              <span>Stripe · sign &amp; pay electronically</span>
            </div>
            <div className="wz-trust-item">
              <span className="wz-trust-mark" aria-hidden="true">⚗</span>
              <span>General + liquor liability included</span>
            </div>
            <div className="wz-trust-item">
              <span className="wz-trust-mark" aria-hidden="true">⚗</span>
              <span>$100 deposit locks the date</span>
            </div>
          </div>
        </>
      ) : (
        <p className="wz-price-empty">Adjust your event details to see pricing</p>
      )}
    </div>
  );
}
