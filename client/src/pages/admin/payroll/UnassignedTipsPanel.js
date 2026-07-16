import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

// event_date is a DATE column that serializes as a full ISO timestamp; slice to
// the date part before fmtDate (same idiom as the other payroll files).
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);
// tipped_at is a TIMESTAMPTZ instant, so it formats directly in local time
// (never sliced: its UTC calendar date can differ from the local one).
const fmtTippedAt = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

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
              <EntityLink to={tip.target_user_id ? `/staffing/users/${tip.target_user_id}` : null}>
                <div style={{ fontWeight: 600 }}>{tip.contractor_name}</div>
              </EntityLink>
              <div className="tiny muted">{fmt$fromCents(tip.amount_cents)} on {fmtTippedAt(tip.tipped_at)}</div>
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
                      {fmtDate(ymd10(c.event_date))} · {lbl}
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
