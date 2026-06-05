import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function ProposalChangeRequestCard({ proposalId, onChanged }) {
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.get(`/proposals/${proposalId}/change-requests`).then(r => setRequests(r.data.requests || [])).catch(() => {}), [proposalId]);
  useEffect(() => { load(); }, [load]);
  const open = requests.find(r => r.status === 'pending');
  if (!open) return null;
  const pv = open.price_preview || {};
  const decline = async () => {
    if (!reason.trim()) { toast.error('Add a reason to decline.'); return; }
    try {
      await api.post(`/proposals/change-requests/${open.id}/decline`, { decision_note: reason });
      toast.success('Request declined.'); setReason(''); load(); onChanged && onChanged();
    } catch (e) { toast.error(e.message || 'Failed to decline.'); }
  };
  return (
    <div className="card">
      <div className="card-head"><h3>Change request {open.edit_window === 'inside_t14' && <span className="badge badge-danger">Within 2 weeks: verify staffing</span>}</h3></div>
      <div className="card-body">
        <div className="dl"><dt>Current total</dt><dd>{fmt(pv.current_total)}</dd>
          <dt>Estimated new total</dt><dd>{fmt(pv.estimated_total)}</dd>
          <dt>Client acknowledged</dt><dd>{fmt(open.acknowledged_total)}</dd></div>
        <pre className="cr-diff">{JSON.stringify(open.requested_changes, null, 2)}</pre>
        {open.note && <p><strong>Note:</strong> {open.note}</p>}
        {Number(pv.delta) < 0 && (
          <div className="client-alert client-alert-warning">
            This is a reduction (change {fmt(pv.delta)}). Handle any refund or credit through the existing tools, then record what you did in the decision note below before you apply or decline. Nothing auto-refunds.
          </div>
        )}
        <div className="cr-actions">
          <Link className="btn btn-primary" to={`/proposals/${proposalId}?edit=1&change_request_id=${open.id}`}>Apply in editor</Link>
        </div>
        <div className="cr-decline">
          <textarea placeholder="Reason (required to decline)" value={reason} onChange={e => setReason(e.target.value)} rows={2} />
          <button type="button" className="btn btn-danger" onClick={decline}>Decline</button>
        </div>
      </div>
    </div>
  );
}
