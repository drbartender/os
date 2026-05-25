import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

export default function UnassignedTipsPanel() {
  const toast = useToast();
  const [tips, setTips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({}); // tipId -> shiftId
  const [busy, setBusy] = useState({});

  const refresh = () => {
    setLoading(true);
    api.get('/admin/payroll/unassigned-tips')
      .then(r => setTips(r.data.tips || []))
      .catch(err => toast.error(err.message || 'Failed to load unassigned tips'))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const assign = async (tipId) => {
    const shiftId = Number(drafts[tipId]);
    if (!Number.isInteger(shiftId)) return;
    setBusy(b => ({ ...b, [tipId]: true }));
    try {
      const { data } = await api.patch(`/admin/payroll/tips/${tipId}/assign`, { shift_id: shiftId });
      if (data.frozen_period) {
        // ToastContext only exposes success/error, so use error for the frozen-period
        // case. The roll-forward (Task 17) handles the data; this toast just tells
        // the admin the assignment landed against a frozen period.
        toast.error('Assigned, but the matching period is already frozen. The tip is recorded and will roll forward to the next open period.');
      } else {
        toast.success('Tip assigned.');
      }
      setTips(prev => prev.filter(t => t.id !== tipId));
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setBusy(b => ({ ...b, [tipId]: false }));
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (tips.length === 0) {
    return (
      <div className="card"><div className="card-body muted">
        No unassigned tips. The matching ran on every tip; anything that didn't land an event shows up here.
      </div></div>
    );
  }

  return (
    <div className="vstack" style={{ gap: 8 }}>
      {tips.map(tip => (
        <div key={tip.id} className="card">
          <div className="card-body hstack" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 160 }}>
              <div style={{ fontWeight: 600 }}>{tip.contractor_name}</div>
              <div className="tiny muted">{fmt$fromCents(tip.amount_cents)} on {fmtDate(tip.tipped_at)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <select
                className="select"
                value={drafts[tip.id] || ''}
                onChange={(e) => setDrafts(d => ({ ...d, [tip.id]: e.target.value }))}
              >
                <option value="">— pick an event —</option>
                {(tip.candidate_shifts || []).map(c => {
                  const lbl = getEventTypeLabel({ event_type: c.event_type, event_type_custom: c.event_type_custom });
                  return (
                    <option key={c.shift_id} value={c.shift_id}>
                      {fmtDate(c.event_date)} · {lbl}
                    </option>
                  );
                })}
              </select>
              {(!tip.candidate_shifts || tip.candidate_shifts.length === 0) && (
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  No approved shifts in the ±14-day window. Either the bartender didn't work near this tip date, or shift assignment is missing.
                </div>
              )}
            </div>
            <button
              type="button" className="btn btn-primary btn-sm"
              disabled={!drafts[tip.id] || busy[tip.id]}
              onClick={() => assign(tip.id)}
            >
              {busy[tip.id] ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
