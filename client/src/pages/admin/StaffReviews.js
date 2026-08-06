import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import EntityLink from '../../components/EntityLink';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../components/adminos/format';

// Admin review log + quarterly contest (spec 2026-08-06 §7).
//
// Backed by:
//   GET   /admin/staff-reviews
//   POST  /admin/staff-reviews                  manual Google row
//   PATCH /admin/staff-reviews/:id              edit + set credits
//   POST  /admin/staff-reviews/:id/confirm      pays the $10 bounties
//   POST  /admin/staff-reviews/:id/dismiss
//   GET   /admin/staff-reviews/leaderboard?quarter=YYYY-QN
//   POST  /admin/staff-reviews/contest-award    one click, idempotent
//
// All amounts arrive from the server in integer cents. The page never embeds
// the bounty or pot figures; it renders what the payload carries.

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

const statusKind = (status) => {
  if (status === 'confirmed') return 'ok';
  if (status === 'dismissed') return 'warn';
  return 'accent';
};

export default function StaffReviews() {
  const [tab, setTab] = useState('log');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Reviews</div>
          <div className="page-subtitle">
            Confirm five-star reviews that name a staffer, tag who earned them, and award the quarterly contest.
          </div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Reviews tabs"
        style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 'var(--gap)' }}
      >
        <TabButton active={tab === 'log'} onClick={() => setTab('log')}>Review log</TabButton>
        <TabButton active={tab === 'leaderboard'} onClick={() => setTab('leaderboard')}>Leaderboard</TabButton>
      </div>

      {tab === 'log' ? <ReviewLogTab /> : <LeaderboardTab />}
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

// ─── Review log ───────────────────────────────────────────────────

function ReviewLogTab() {
  const toast = useToast();
  const [reviews, setReviews] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, roster] = await Promise.all([
        api.get('/admin/staff-reviews'),
        api.get('/admin/active-staff?limit=100'),
      ]);
      setReviews(list.data?.reviews || []);
      setStaff(roster.data?.staff || []);
    } catch (err) {
      setError(err?.message || 'Failed to load reviews.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Only the FIRST load blanks the tab. A reload after confirm or dismiss keeps
  // the list on screen instead of flashing the whole page back to "Loading".
  if (loading && reviews.length === 0) return <div className="muted">Loading…</div>;
  if (error) {
    return (
      <div className="card">
        <div className="card-body">
          <p style={{ marginTop: 0 }}>{error}</p>
          <button type="button" className="btn" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <LogReviewForm
        onCreated={(dupWarning) => { setDuplicateWarning(dupWarning); load(); }}
        onError={(msg) => toast.error(msg)}
      />

      {duplicateWarning && (
        <div className="card" style={{ marginBottom: 'var(--gap)', borderColor: 'var(--warn, var(--line))' }}>
          <div className="card-body">
            <strong>Possible duplicate.</strong>{' '}
            A Thumbtack review is already logged for that date. Check the list below before confirming both.
          </div>
        </div>
      )}

      {reviews.length === 0 ? (
        <div className="card"><div className="card-body muted">No reviews logged yet.</div></div>
      ) : (
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {reviews.map(r => (
            <ReviewCard
              key={r.id}
              review={r}
              staff={staff}
              onChanged={load}
              onError={(msg) => toast.error(msg)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LogReviewForm({ onCreated, onError }) {
  const [form, setForm] = useState({ review_date: '', stars: '5', excerpt: '' });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    const stars = Number(form.stars);
    if (!form.review_date) return onError('Pick the review date.');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return onError('Stars must be 1 to 5.');
    if (form.excerpt.length > 2000) return onError('Excerpt is over 2000 characters.');
    setSaving(true);
    try {
      const res = await api.post('/admin/staff-reviews', {
        review_date: form.review_date,
        stars,
        excerpt: form.excerpt || null,
      });
      setForm({ review_date: '', stars: '5', excerpt: '' });
      onCreated(!!res.data?.duplicate_warning);
    } catch (err) {
      onError(err?.message || 'Failed to log the review.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" style={{ marginBottom: 'var(--gap)' }} onSubmit={submit}>
      <div className="card-head"><h3>Log a Google review</h3></div>
      <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span className="muted">Review date</span>
          <input
            type="date"
            value={form.review_date}
            onChange={e => set('review_date', e.target.value)}
            required
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span className="muted">Stars</span>
          <select value={form.stars} onChange={e => set('stars', e.target.value)}>
            {[5, 4, 3, 2, 1].map(n => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, flex: '1 1 320px' }}>
          <span className="muted">Excerpt (optional, 2000 characters max)</span>
          <input
            type="text"
            value={form.excerpt}
            maxLength={2000}
            placeholder="Jane was dope behind the bar"
            onChange={e => set('excerpt', e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Log review'}
        </button>
      </div>
    </form>
  );
}

function ReviewCard({ review, staff, onChanged, onError }) {
  const initial = useMemo(
    () => (review.credits || []).map(c => String(c.user_id)),
    [review.credits]
  );
  const [selected, setSelected] = useState(initial);
  const [busy, setBusy] = useState(null);

  useEffect(() => { setSelected(initial); }, [initial]);

  const dirty = useMemo(() => (
    selected.length !== initial.length || selected.some(id => !initial.includes(id))
  ), [selected, initial]);

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError(err?.message || 'That action failed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const saveCredits = () => run('credits', () => api.patch(`/admin/staff-reviews/${review.id}`, {
    credited_user_ids: selected.map(Number),
  }).then((res) => {
    const frozen = res.data?.frozen_credit_removals || [];
    if (frozen.length) {
      onError('A bounty for this review is already paid, so it was left alone. An alert was raised for review.');
    }
  }));

  const confirm = () => run('confirm', () => api.post(`/admin/staff-reviews/${review.id}/confirm`));
  const dismiss = () => run('dismiss', () => api.post(`/admin/staff-reviews/${review.id}/dismiss`));

  return (
    <article className="card">
      <div className="card-head">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>{'★'.repeat(Number(review.stars) || 0)}</span>
          <StatusChip kind={statusKind(review.status)}>{review.status}</StatusChip>
          <span className="muted tiny">{review.source}</span>
        </h3>
        <span className="muted tiny">{fmtDate(String(review.review_date || '').slice(0, 10), { year: 'numeric' })}</span>
      </div>
      <div className="card-body">
        {review.excerpt
          ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>"{review.excerpt}"</p>
          : <p className="muted" style={{ margin: 0 }}>No excerpt.</p>}

        {review.proposal_id && (
          <p className="muted tiny" style={{ marginTop: 8, marginBottom: 0 }}>
            Linked event: <EntityLink to={`/proposals/${review.proposal_id}`}>proposal {review.proposal_id}</EntityLink>
          </p>
        )}

        <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, flex: '1 1 280px' }}>
            <span className="muted">Named staff (hold Ctrl or Cmd to pick several)</span>
            <select
              multiple
              size={Math.min(6, Math.max(3, staff.length))}
              value={selected}
              onChange={e => setSelected(Array.from(e.target.selectedOptions, o => o.value))}
            >
              {staff.map(s => (
                <option key={s.id} value={String(s.id)}>
                  {s.display_name || s.preferred_name || s.email}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={!dirty || busy !== null}
              onClick={saveCredits}
            >
              {busy === 'credits' ? 'Saving…' : 'Save names'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || review.status === 'confirmed'}
              onClick={confirm}
            >
              {busy === 'confirm' ? 'Confirming…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy !== null || review.status === 'dismissed'}
              onClick={dismiss}
            >
              {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
            </button>
          </div>
        </div>

        {Number(review.stars) === 5 ? (
          <p className="muted tiny" style={{ marginTop: 10, marginBottom: 0 }}>
            Confirming pays every named staffer their review bounty on the open pay period.
          </p>
        ) : (
          <p className="muted tiny" style={{ marginTop: 10, marginBottom: 0 }}>
            Only five-star reviews carry a bounty.
          </p>
        )}
      </div>
    </article>
  );
}

// ─── Leaderboard + contest award ──────────────────────────────────

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function LeaderboardTab() {
  const toast = useToast();
  const [quarter, setQuarter] = useState(currentQuarter());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [awarding, setAwarding] = useState(false);

  const validQuarter = QUARTER_RE.test(quarter);

  const load = useCallback(async (q) => {
    // Mirrors the server rule: a half-typed quarter is not a request.
    if (!QUARTER_RE.test(q)) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null); // never render one quarter's standings under another's label
    try {
      const res = await api.get(`/admin/staff-reviews/leaderboard?quarter=${encodeURIComponent(q)}`);
      setData(res.data);
    } catch (err) {
      setError(err?.message || 'Failed to load the leaderboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(quarter); }, [load, quarter]);

  const rows = useMemo(() => data?.rows || [], [data]);
  // Winners and the split are SERVER truth. The client renders the payload and
  // never recomputes them, so the dialog cannot disagree with what gets paid.
  const shares = useMemo(() => data?.shares || [], [data]);
  const rowsById = useMemo(
    () => Object.fromEntries(rows.map(r => [r.user_id, r])),
    [rows]
  );

  async function award() {
    setAwarding(true);
    try {
      let res;
      try {
        res = await api.post('/admin/staff-reviews/contest-award', { quarter });
      } catch (err) {
        // api.js rejects a FLATTENED envelope: read err.status and err.message.
        // There is no err.response here.
        if (err?.status === 409 && (err?.code === 'QUARTER_IN_PROGRESS' || String(err?.message || '').includes('still in progress'))) {
          const go = window.confirm(
            'This quarter is not over yet. Awarding now is permanent and cannot be revised later. Award anyway?'
          );
          if (!go) return;
          res = await api.post('/admin/staff-reviews/contest-award', { quarter, force: true });
        } else {
          throw err;
        }
      }
      if (res.data?.awarded_already) {
        toast.success('This quarter was already awarded. Nothing new was created.');
      } else {
        toast.success(`Awarded ${res.data?.awards?.length || 0} winner(s).`);
      }
      setDialogOpen(false);
      load(quarter);
    } catch (err) {
      toast.error(err?.message || 'The award failed. Try again.');
    } finally {
      setAwarding(false);
    }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Quarter</span>
            <input
              type="text"
              value={quarter}
              placeholder="2026-Q3"
              onChange={e => setQuarter(e.target.value.trim().toUpperCase())}
              style={{ width: 120 }}
            />
          </label>
          {!validQuarter && (
            <span className="muted tiny">Enter a quarter like 2026-Q3.</span>
          )}
          {validQuarter && data && (
            <span className="muted tiny">
              {data.start_date} to {data.end_date}. Qualifying takes at least {data.min_events_worked} events
              worked and {data.min_named_five_stars} named five-star reviews.
              {data.in_progress ? ' This quarter is still running.' : ''}
            </span>
          )}
          <button
            type="button"
            className="btn"
            disabled={!validQuarter || loading || shares.length === 0}
            onClick={() => setDialogOpen(true)}
          >
            Award the quarter
          </button>
        </div>
      </div>

      {loading && !data && <div className="muted">Loading…</div>}

      {!loading && error && (
        <div className="card">
          <div className="card-body">
            <p style={{ marginTop: 0 }}>{error}</p>
            <button type="button" className="btn" onClick={() => load(quarter)}>Retry</button>
          </div>
        </div>
      )}

      {validQuarter && !loading && !error && rows.length === 0 && (
        <div className="card"><div className="card-body muted">No qualifying staff this quarter.</div></div>
      )}

      {validQuarter && !loading && !error && rows.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3>Standings</h3>
            <span className="k">{rows.length}</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Staffer</th>
                  <th>Reviewed</th>
                  <th className="num">Rate</th>
                  <th>Qualifies</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={r.user_id}
                    style={r.eligible ? { background: 'var(--bg-2, transparent)', fontWeight: 500 } : undefined}
                  >
                    <td>
                      <EntityLink to={`/staffing/users/${r.user_id}`}>
                        <strong>{r.name}</strong>
                      </EntityLink>
                    </td>
                    <td>{r.named_five_stars} of {r.events_worked} events reviewed</td>
                    <td className="num">{(r.rate * 100).toFixed(0)}%</td>
                    <td>
                      {r.eligible
                        ? <StatusChip kind="ok">eligible</StatusChip>
                        : <span className="muted tiny">below the floor</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dialogOpen && (
        <AwardDialog
          quarter={quarter}
          shares={shares}
          rowsById={rowsById}
          inProgress={!!data?.in_progress}
          busy={awarding}
          onCancel={() => setDialogOpen(false)}
          onConfirm={award}
        />
      )}
    </>
  );
}

function AwardDialog({ quarter, shares, rowsById, inProgress, busy, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={`Award the ${quarter} review contest`}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center', padding: 16,
      }}
      data-app="admin-os"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460, maxWidth: '94vw',
          background: 'var(--bg-1)', color: 'var(--ink-1)',
          border: '1px solid var(--line-1)', borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '0.7rem 1rem', borderBottom: '1px solid var(--line-1)' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Award the {quarter} contest</h3>
        </div>
        <div style={{ padding: '1rem' }}>
          <p style={{ marginTop: 0 }}>
            This pays the winner{shares.length > 1 ? 's' : ''} below on the open pay period. It runs once:
            a second click creates nothing.
          </p>
          {inProgress && (
            <p style={{ marginTop: 0 }}>
              This quarter is still running, so you will be asked to confirm again. Events and reviews
              that land before it closes will not change the result.
            </p>
          )}
          <ul style={{ margin: '0 0 12px 0', paddingLeft: 18 }}>
            {shares.map(s => {
              const row = rowsById[s.user_id];
              return (
                <li key={s.user_id}>
                  {s.name}: {fmt$fromCents(s.amount_cents)}{' '}
                  {row && (
                    <span className="muted tiny">
                      ({row.named_five_stars} of {row.events_worked} events reviewed)
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" className="btn" onClick={onConfirm} disabled={busy}>
              {busy ? 'Awarding…' : 'Award now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
