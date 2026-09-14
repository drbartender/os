import React from 'react';
import { PENDING_PAYMENT_TITLE, pendingPaymentBody, PendingPaymentContact } from '../../../components/PendingPaymentCard';

// The box the drink-plan celebration screens (v1 and v2) show after a Stripe
// return. Bank debit in flight (spec 2026-09-14 section 8.4): Stripe appends
// redirect_status to the return URL, and processing or pending means the
// money has not moved yet, so the box must not call the payment received.
// The amount is not known on this rail. Renders nothing without a return.
const boxStyle = (accent) => ({
  marginTop: '1rem', padding: '0.75rem', borderRadius: '8px',
  background: `rgba(${accent}, 0.08)`, border: `1px solid rgba(${accent}, 0.2)`,
});

// Same reading as the proposal page's readRedirect: only `failed` is a
// failure (the return URL carries paid=true before the outcome is known, so
// the flag alone proves nothing); processing and pending mean not yet.
export function readPaymentReturn(search) {
  const params = new URLSearchParams(search || '');
  const returned = params.get('paid') === 'true';
  const status = params.get('redirect_status');
  const failed = returned && status === 'failed';
  const pending = returned && !failed && ['processing', 'pending'].includes(status);
  return { paid: returned && !failed, pending, failed };
}

export default function PaymentReturnNotice({ paid, pending, failed = false }) {
  if (failed) {
    return (
      <div role="status" style={boxStyle('183, 65, 14')}>
        <p style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>That payment did not go through.</p>
        <p className="text-muted text-small">Nothing was charged. Your selections are saved, and we will be in touch about payment.</p>
      </div>
    );
  }
  if (pending) {
    return (
      <div role="status" style={boxStyle('193, 125, 60')}>
        <p style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>{PENDING_PAYMENT_TITLE}</p>
        <p className="text-muted text-small">{pendingPaymentBody({ amountCents: null, startedAt: null })} <PendingPaymentContact /></p>
      </div>
    );
  }
  if (!paid) return null;
  return (
    <div role="status" style={boxStyle('46, 125, 50')}>
      <p style={{ fontWeight: 600, color: '#2e7d32', marginBottom: '0.25rem' }}>Payment Received</p>
      <p className="text-muted text-small">Your payment was processed successfully. You'll receive a confirmation email shortly.</p>
    </div>
  );
}
