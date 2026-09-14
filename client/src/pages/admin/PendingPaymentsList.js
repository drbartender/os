import React from 'react';

// Bank debit in flight (spec 2026-09-14 section 10): one line per payment
// still processing on the proposal, above the invoice list in the payment
// panel, so a "did my payment go through" call is answered without opening
// Stripe. amount_cents is cents; started_at is an instant and formats in
// local time like every other TIMESTAMPTZ on the admin side.
function dollars(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function started(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function PendingPaymentsList({ pendingPayments }) {
  if (!pendingPayments || pendingPayments.length === 0) return null;
  return (
    <div className="vstack" style={{ gap: 4, marginBottom: 8 }}>
      {pendingPayments.map((p, i) => {
        const amount = dollars(p.amount_cents);
        const when = started(p.started_at);
        const parts = [
          `Processing: ${amount ? `${amount} ` : ''}bank payment`,
          when ? `started ${when}` : null,
          p.invoice_number || null,
        ].filter(Boolean);
        return (
          <div key={`${p.started_at}-${i}`} className="tiny" style={{ color: 'var(--amber-700, #8a5a00)' }}>
            {parts.join(', ')}
          </div>
        );
      })}
    </div>
  );
}
