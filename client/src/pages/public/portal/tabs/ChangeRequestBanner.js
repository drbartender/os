import React from 'react';
function fmt(n) { return `$${Number(n || 0).toFixed(2)}`; }
export default function ChangeRequestBanner({ request, onWithdraw }) {
  if (!request) return null;
  if (request.status === 'pending') {
    const pv = request.price_preview || {};
    return (
      <div className="client-alert" role="status">
        <strong>Change requested, pending review.</strong>{' '}
        Estimated new total {fmt(pv.estimated_total)}.{' '}
        <button type="button" className="btn-link" onClick={onWithdraw}>Withdraw request</button>
      </div>
    );
  }
  if (request.status === 'approved') return <div className="client-alert client-alert-success" role="status"><strong>Your changes are in.</strong> Check your updated total below.</div>;
  if (request.status === 'declined') return <div className="client-alert client-alert-error" role="status"><strong>We could not make that change.</strong> {request.decision_note} Reply to our email and we will help.</div>;
  return null;
}
