import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

// deferred_at is a TIMESTAMPTZ (full ISO), not a date-only string, so fmtDate
// (which assumes 'YYYY-MM-DD' and appends 'T12:00:00') would yield Invalid Date.
// Format the timestamp directly.
const fmtDeferredAt = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function DeferredTipsPanel() {
  const toast = useToast();
  const [tips, setTips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const refresh = () => {
    setLoading(true); setError(false);
    api.get('/admin/payroll/deferred-tips')
      .then(r => setTips(r.data.tips || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { data } = await api.post('/admin/payroll/deferred-tips/retry');
      const s = data.summary || {};
      if (s.skipped) {
        toast.info('A retry is already running. Refreshed the list.');
      } else {
        toast.success(`Retried ${s.scanned || 0}: resolved ${s.resolved || 0}, still stuck ${s.redeferred || 0}${s.errors ? `, errors ${s.errors}` : ''}.`);
      }
      setTips(data.tips || []);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (error) {
    return (
      <div className="card"><div className="card-body">
        <span className="muted">Failed to load deferred tips. </span>
        <button type="button" className="btn btn-sm" onClick={refresh}>Retry</button>
      </div></div>
    );
  }
  if (tips.length === 0) {
    return <div className="card"><div className="card-body muted">No deferred tips. Nothing is stuck.</div></div>;
  }

  return (
    <div className="vstack" style={{ gap: 8 }}>
      <div className="hstack" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny muted">{tips.length} tip{tips.length === 1 ? '' : 's'} waiting for an open pay period.</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={retrying} onClick={retry}>
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
      </div>
      {tips.map(t => {
        const lbl = t.event_date ? getEventTypeLabel({ event_type: t.event_type, event_type_custom: t.event_type_custom }) : '—';
        const amt = t.defer_kind === 'clawback' ? `−${fmt$fromCents(t.defer_target_cents || 0)} clawback` : `${fmt$fromCents(t.amount_cents)} tip`;
        return (
          <div key={t.id} className="card">
            <div className="card-body hstack" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>
                  {(t.staff && t.staff.length)
                    ? t.staff.map((name, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && ', '}
                          <EntityLink to={(t.staff_ids && t.staff_ids[i]) ? `/staffing/users/${t.staff_ids[i]}` : null}>
                            {name}
                          </EntityLink>
                        </React.Fragment>
                      ))
                    : '(no bartender on shift)'}
                </div>
                <div className="tiny muted">
                  {amt}
                  {t.event_date && (
                    <>
                      {' · '}
                      <EntityLink to={t.shift_id ? `/events/shift/${t.shift_id}` : null}>
                        {fmtDate(t.event_date)} {lbl}
                      </EntityLink>
                    </>
                  )}
                </div>
              </div>
              <div className="tiny muted" style={{ flex: 1 }}>
                deferred {fmtDeferredAt(t.deferred_at)}
                {t.stuck_reason === 'stubs' ? ' · stuck: bartender not on file (de-stub needed, Retry won\'t help)'
                  : t.stuck_reason === 'max_attempts' ? ' · stuck (needs attention)'
                  : ' · waiting for an open period'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
