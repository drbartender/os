import React from 'react';

// Bank debit in flight (spec 2026-09-14 section 8.1). The one card every
// client surface shows while a bank payment is processing: the invoice page,
// the proposal page, and the drink-plan celebration screens (section 8.4).
// Every figure comes from the server's pending_payment or, on the invoice page
// in the seconds before the webhook lands, from Stripe's confirm result. The
// drink-plan rail knows no amount, so the amount clause is optional. It never
// claims the payment succeeded: a bank debit can still bounce.
// `bare` renders one paragraph without the card chrome, for a call site that
// already sits inside a card (PaidCard's paid branch). No em dashes in copy.
function formatCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// started_at is an instant (TIMESTAMPTZ). Instants format in the viewer's
// local time, the house rule the invoice page states above its formatDate;
// date-only columns are the ones that go through fmtDateOnly.
function formatStarted(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

export const PENDING_PAYMENT_TITLE = 'Your bank payment is processing.';

export function pendingPaymentCopy({ amountCents, startedAt }) {
  const dollars = formatCents(amountCents);
  const when = formatStarted(startedAt);
  return `We received your ${dollars ? `${dollars} ` : ''}bank payment${when ? ` on ${when}` : ''}. `
    + 'Bank payments take four to six business days to clear. You will get a receipt by email when it does, '
    + 'and nothing more is needed from you. If anything looks wrong, email contact@drbartender.com.';
}

export default function PendingPaymentCard({ amountCents, startedAt, bare = false }) {
  const body = pendingPaymentCopy({ amountCents, startedAt });
  if (bare) {
    return (
      <p className="proposal-paid-sub" role="status" aria-live="polite">
        <strong>{PENDING_PAYMENT_TITLE}</strong> {body}
      </p>
    );
  }
  return (
    <div className="proposal-paid-card is-pending" role="status" aria-live="polite">
      <h3 className="proposal-paid-title">{PENDING_PAYMENT_TITLE}</h3>
      <p className="proposal-paid-sub">{body}</p>
    </div>
  );
}
