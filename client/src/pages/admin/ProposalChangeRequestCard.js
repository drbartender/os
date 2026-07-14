import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatMoneyDelta as fmt } from '../../utils/formatDelta';

const CR_FIELD_LABELS = {
  guest_count: 'Guests', event_duration_hours: 'Duration (hrs)', num_bars: 'Portable bars',
  num_bartenders: 'Bartenders', event_date: 'Event date', event_start_time: 'Start time',
  package_id: 'Package', venue_name: 'Venue', venue_street: 'Street', venue_city: 'City',
  venue_state: 'State', venue_zip: 'ZIP', addon_ids: 'Add-ons',
  addon_variants: 'Add-on options', addon_quantities: 'Add-on quantities',
};
const crFmt = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export default function ProposalChangeRequestCard({ proposalId, onChanged, onApply }) {
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [packageNames, setPackageNames] = useState({});
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.get(`/proposals/${proposalId}/change-requests`).then(r => {
    setRequests(r.data.requests || []);
    setPackageNames(r.data.package_names || {});
  }).catch(() => {}), [proposalId]);
  useEffect(() => { load(); }, [load]);
  const open = requests.find(r => r.status === 'pending');
  if (!open) return null;
  const pv = open.price_preview || {};
  // package_id diffs render the package NAME (id fallback if the server map
  // misses it) — the raw id means nothing to a human.
  const crVal = (k, v) => (k === 'package_id' && v != null && packageNames[v]) ? packageNames[v] : crFmt(v);
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
        <div className="meta-k">Requested changes</div>
        <div className="dl">
          {Object.keys(open.requested_changes || {}).map(k => (
            <React.Fragment key={k}>
              <dt>{CR_FIELD_LABELS[k] || k}</dt>
              <dd>{crVal(k, (open.baseline || {})[k])} → {crVal(k, open.requested_changes[k])}</dd>
            </React.Fragment>
          ))}
        </div>
        {open.note && <p><strong>Note:</strong> {open.note}</p>}
        {Number(pv.delta) < 0 && (
          <div className="client-alert client-alert-warning">
            This is a reduction (change {fmt(pv.delta)}). Handle any refund or credit through the existing tools, then record what you did in the decision note below before you apply or decline. Nothing auto-refunds.
          </div>
        )}
        <div className="cr-actions">
          {/* Imperative open (not a Link): the admin is already on /proposals/:id, so
              a query-only nav would not remount ProposalDetail and the mount-only
              edit/change_request_id state would never update. The parent opens the
              editor + selects this request directly. */}
          <button type="button" className="btn btn-primary" onClick={() => onApply?.(open)}>Apply in editor</button>
        </div>
        <div className="cr-decline">
          <textarea placeholder="Reason (required to decline)" value={reason} onChange={e => setReason(e.target.value)} rows={2} />
          <button type="button" className="btn btn-danger" onClick={decline}>Decline</button>
        </div>
      </div>
    </div>
  );
}
