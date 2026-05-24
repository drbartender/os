import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';

export default function PayQRModal({
  payout, paymentMethod, payUrl, handle, onConfirm, onCancel, confirming,
}) {
  const amount = fmt$fromCents(payout.total_cents);
  const isQR = paymentMethod === 'venmo' || paymentMethod === 'cashapp';
  return (
    <div
      role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'grid', placeItems: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="card" style={{ maxWidth: 420, width: '100%' }}>
        <div className="card-head">
          <h3>Pay {payout.contractor_name}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>
        <div className="card-body vstack" style={{ gap: 12, alignItems: 'center' }}>
          <div className="stat" style={{ textAlign: 'center' }}>
            <div className="stat-label">Amount</div>
            <div className="stat-value">{amount}</div>
            <div className="tiny muted">via {paymentMethodLabel(paymentMethod)} → {handle || '—'}</div>
          </div>

          {isQR && payUrl && (
            <>
              <QRCodeSVG value={payUrl} size={220} bgColor="#FFFFFF" fgColor="#12161C" level="M" includeMargin />
              <div className="tiny muted" style={{ textAlign: 'center' }}>
                Scan with your phone. {paymentMethod === 'venmo'
                  ? 'Venmo sometimes drops the amount — confirm it reads $' + amount.replace('$','') + '.'
                  : 'Cash App fills the amount reliably.'}
              </div>
            </>
          )}
          {paymentMethod === 'paypal' && payUrl && (
            <a className="btn btn-primary" href={payUrl} target="_blank" rel="noopener noreferrer">
              Open PayPal →
            </a>
          )}
          {!isQR && paymentMethod !== 'paypal' && (
            <div className="muted tiny" style={{ textAlign: 'center' }}>
              No deep link for {paymentMethodLabel(paymentMethod)}. Handle the payment in your usual flow, then confirm below.
            </div>
          )}

          <div className="hstack" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={confirming}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={confirming}>
              {confirming ? 'Recording…' : 'Mark paid'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
