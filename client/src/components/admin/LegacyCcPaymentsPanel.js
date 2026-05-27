import React, { useState, useEffect } from 'react';
import api from '../../utils/api';

// Admin-only panel embedded in ProposalDetailPaymentPanel. Renders nothing
// unless this proposal has at least one Check-Cherry-imported payment row
// (proposal_payments.legacy_charge_id IS NOT NULL). Warns the operator that
// the built-in Refund button is wired to PaymentIntents and cannot reach
// these legacy Stripe charge IDs (ch_...) — a manual Stripe-dashboard refund
// + manual proposal_refunds row are required (spec §11).
//
// Gating happens server-side too: GET /api/proposals/:id/legacy-cc-payments
// uses adminOnly so a manager who reaches this component (e.g. via a stale
// page) sees an empty payments array and the panel collapses.
export default function LegacyCcPaymentsPanel({ proposalId, currentUserRole }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (currentUserRole !== 'admin' || !proposalId) return;
    setLoading(true);
    api.get(`/proposals/${proposalId}/legacy-cc-payments`)
      .then(r => setPayments(r.data.payments || []))
      .catch(() => setPayments([]))
      .finally(() => setLoading(false));
  }, [proposalId, currentUserRole]);

  if (currentUserRole !== 'admin') return null;
  if (loading) return null;
  if (payments.length === 0) return null;

  return (
    <section className="legacy-cc-payments-panel" style={{ marginBottom: 'var(--gap)' }}>
      <h3>Legacy CC payments (manual Stripe refund required)</h3>
      <p className="muted">
        These payments were imported from Check Cherry. The DRB OS Refund button is disabled for them
        because Stripe charge IDs (<code>ch_...</code>) do not pass to the PaymentIntent-based refund flow.
        To refund, use the Stripe dashboard directly and record a manual <code>proposal_refunds</code> row
        with <code>reason</code> starting with "Manual Stripe reconciliation".
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Paid on</th>
            <th>Amount</th>
            <th>Method</th>
            <th>Stripe charge ID</th>
          </tr>
        </thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id}>
              <td>{new Date(p.created_at).toLocaleDateString()}</td>
              <td>${(p.amount / 100).toFixed(2)}</td>
              <td>{p.payment_method || 'N/A'}</td>
              <td><code>{p.legacy_charge_id}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
