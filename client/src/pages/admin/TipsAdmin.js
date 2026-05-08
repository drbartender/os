import React, { useEffect, useState, useCallback, useMemo } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { fmt$fromCents } from '../../components/adminos/format';
import StatusChip from '../../components/adminos/StatusChip';

// Admin Tips Activity + Feedback queue.
//
// Backed by:
//   GET  /admin/tips                           — tip rows (filterable)
//   GET  /admin/tip-feedback?status=...        — feedback rows
//   POST /admin/tip-feedback/:id/review        — mark reviewed
//
// All three endpoints are auth + requireAdminOrManager (see
// server/routes/admin/users.js).

export default function TipsAdmin() {
  const [tab, setTab] = useState('tips');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Tips & Feedback</div>
          <div className="page-subtitle">Activity across all contractor tip pages and the unreviewed feedback queue.</div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Tips and Feedback tabs"
        style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 'var(--gap)' }}
      >
        <TabButton active={tab === 'tips'} onClick={() => setTab('tips')}>Tips</TabButton>
        <TabButton active={tab === 'feedback'} onClick={() => setTab('feedback')}>Feedback</TabButton>
      </div>

      {tab === 'tips' ? <TipsTab /> : <FeedbackTab />}
    </div>
  );
}

function TabButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '10px 16px',
        background: 'transparent',
        border: 0,
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        marginBottom: -1,
        color: active ? 'var(--ink-1)' : 'var(--ink-3)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontSize: 13,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function TipsTab() {
  const toast = useToast();
  const [tips, setTips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ from: '', to: '' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const qs = params.toString();
    api.get(`/admin/tips${qs ? `?${qs}` : ''}`)
      .then(r => { if (!cancelled) setTips(r.data?.tips || []); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load tips. Try refreshing.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.from, filters.to, toast]);

  const total = useMemo(
    () => tips.reduce((sum, t) => sum + Number(t.amount_cents || 0), 0),
    [tips]
  );

  return (
    <>
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Total in view</div>
          <div className="stat-value">{fmt$fromCents(total)}</div>
          <div className="stat-sub"><span>{tips.length} {tips.length === 1 ? 'tip' : 'tips'}</span></div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">From</span>
            <input
              type="date"
              value={filters.from}
              onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">To</span>
            <input
              type="date"
              value={filters.to}
              onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
            />
          </label>
          {(filters.from || filters.to) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setFilters({ from: '', to: '' })}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <h3>Activity</h3>
          <span className="k">{tips.length}</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Bartender</th>
                <th className="num">Amount</th>
                <th>Date</th>
                <th>Customer</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="muted">Loading…</td></tr>
              )}
              {!loading && tips.length === 0 && (
                <tr><td colSpan={4} className="muted">No tips in view.</td></tr>
              )}
              {!loading && tips.map(t => (
                <tr key={t.id}>
                  <td><strong>{t.bartender_name || `user ${t.target_user_id}`}</strong></td>
                  <td className="num">{fmt$fromCents(t.amount_cents)}</td>
                  <td>{t.tipped_at ? new Date(t.tipped_at).toLocaleString() : '—'}</td>
                  <td className="muted">{t.customer_email || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function FeedbackTab() {
  const toast = useToast();
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('unreviewed');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/admin/tip-feedback?status=${encodeURIComponent(status)}`)
      .then(r => { if (!cancelled) setFeedback(r.data?.feedback || []); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load feedback. Try refreshing.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, toast]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  async function markReviewed(id) {
    setBusyId(id);
    try {
      await api.post(`/admin/tip-feedback/${id}/review`);
      load();
    } catch (err) {
      toast.error(err?.message || 'Failed to mark reviewed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Status</span>
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="unreviewed">Unreviewed</option>
              <option value="reviewed">Reviewed</option>
              <option value="all">All</option>
            </select>
          </label>
          <span className="muted tiny">{feedback.length} {feedback.length === 1 ? 'item' : 'items'}</span>
        </div>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : feedback.length === 0 ? (
        <div className="card"><div className="card-body muted">No feedback in view.</div></div>
      ) : (
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {feedback.map(f => (
            <article key={f.id} className="card">
              <div className="card-head">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{f.bartender_name || `user ${f.target_user_id}`}</span>
                  <StatusChip kind={ratingKind(f.rating)}>{f.rating}/5</StatusChip>
                  {f.reviewed_at && <span className="muted tiny">reviewed</span>}
                </h3>
                <span className="muted tiny">
                  {f.created_at ? new Date(f.created_at).toLocaleString() : '—'}
                </span>
              </div>
              <div className="card-body">
                {f.comment
                  ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>"{f.comment}"</p>
                  : <p className="muted" style={{ margin: 0 }}>No comment.</p>}
                {f.submitter_email && (
                  <p className="muted tiny" style={{ marginTop: 8, marginBottom: 0 }}>
                    Customer: {f.submitter_email}
                  </p>
                )}
                {!f.reviewed_at && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId === f.id}
                      onClick={() => markReviewed(f.id)}
                    >
                      {busyId === f.id ? 'Marking…' : 'Mark reviewed'}
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function ratingKind(rating) {
  const r = Number(rating);
  if (r >= 4) return 'ok';
  if (r >= 3) return 'accent';
  if (r >= 2) return 'warn';
  return 'danger';
}
