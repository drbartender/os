import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import EntityLink from '../../EntityLink';

const CT = { timeZone: 'America/Chicago' };
function fmtMs(ms) {
  const m = Math.round((ms || 0) / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
function fmtTs(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { ...CT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
function fmtSpan(iv, nowMs) {
  const end = iv.ended_at ? new Date(iv.ended_at).getTime() : nowMs;
  return fmtMs(end - new Date(iv.started_at).getTime());
}

export default function PresenceDrawer({ open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    api.get('/admin/presence/log')
      .then(r => setData(r.data))
      .catch(() => setErr('Could not load history'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  return (
    <Drawer open={open} onClose={onClose} crumb={<span className="drawer-crumb">Time clock</span>}>
      {loading && <div className="presence-drawer-status">Loading…</div>}
      {err && !loading && (
        <div className="presence-drawer-status">
          {err}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button>
        </div>
      )}
      {!loading && !err && data && (
        <div className="presence-drawer-body">
          <div className="presence-totals">
            {data.users.map(u => (
              <div key={u.id} className="presence-totals-card">
                <div className="presence-totals-name"><EntityLink to={`/staffing/users/${u.id}`}>{u.name}</EntityLink></div>
                <div className="presence-totals-row">
                  <span>This week</span>
                  <span>{fmtMs(u.week.desk_ms)} desk · {fmtMs(u.week.available_ms)} avail</span>
                </div>
                <div className="presence-totals-row">
                  <span>This month</span>
                  <span>{fmtMs(u.month.desk_ms)} desk · {fmtMs(u.month.available_ms)} avail</span>
                </div>
              </div>
            ))}
          </div>
          {data.intervals.length === 0 ? (
            <div className="presence-drawer-status">No history yet</div>
          ) : (
            <table className="presence-log-table">
              <thead>
                <tr><th>Who</th><th>State</th><th>Started</th><th>Ended</th><th>For</th><th>Leads</th></tr>
              </thead>
              <tbody>
                {data.intervals.map(iv => (
                  <tr key={iv.id}>
                    <td><EntityLink to={iv.user_id ? `/staffing/users/${iv.user_id}` : null}>{iv.user_name}</EntityLink></td>
                    <td>
                      <span className={`presence-dot presence-dot--${iv.state}`} /> {iv.state}
                      {iv.ended_reason === 'auto_flip' && <span className="presence-auto-badge">auto</span>}
                    </td>
                    <td>{fmtTs(iv.started_at)}</td>
                    <td>{iv.ended_at ? fmtTs(iv.ended_at) : 'now'}</td>
                    <td>{fmtSpan(iv, Date.now())}</td>
                    <td>{iv.taking_leads ? 'on' : 'off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Drawer>
  );
}
