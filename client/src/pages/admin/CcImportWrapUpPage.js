import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

/**
 * CC-Import: Bucket B wrap-up worklist.
 *
 * Surfaces CC-imported, completed, past-date proposals so the operator can
 * fire the `post_event_wrap_up_email` for events that pre-date the
 * importer cut-over. Lists candidates, lets the user multi-select up to
 * 50 at a time, runs a pre-flight preview (`/preview`) for the confirm
 * modal, then commits via `/enqueue` which writes scheduled_messages rows
 * + audit + activity log.
 *
 * URL state (?page, ?filter, ?range) preserves selection across refresh.
 */

const MAX_BATCH = 50;
const OUTCOME_LABEL = {
  enqueued: 'Queued',
  already_enqueued: 'Already sent',
  no_email: 'No usable email',
  invalid_target: 'Not eligible',
  error: 'Error',
};

function formatMoneyCents(totalDollars) {
  if (totalDollars == null) return '—';
  const n = Number(totalDollars);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString();
}

export default function CcImportWrapUpPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const filter = params.get('filter') === 'all' ? 'all' : 'needs-wrapup';
  const range = params.get('range') === 'last-30' ? 'last-30' : 'since-import';

  const [data, setData] = useState({ items: [], counts: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { ids, preview }
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null); // last enqueue response

  const updateParams = useCallback((patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  }, [params, setParams]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/admin/cc-import/wrap-up', {
        params: { page, filter, range },
      });
      setData(res.data);
      setSelected(new Set()); // reset selection on any reload
    } catch (err) {
      setError(err.message || 'Failed to load worklist.');
    } finally {
      setLoading(false);
    }
  }, [page, filter, range]);

  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => data.items || [], [data.items]);
  const counts = useMemo(
    () => data.counts || { total_bucket_b: 0, needs_wrapup: 0, last_30: 0 },
    [data.counts]
  );

  const selectableIds = useMemo(
    () => items.filter(i => !i.wrap_up_done).map(i => i.id),
    [items]
  );

  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  function toggleOne(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH) next.add(id);
      else toast.error(`Cannot select more than ${MAX_BATCH} at a time.`);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => {
      if (allSelected) return new Set();
      // Cap at MAX_BATCH.
      const cap = Math.min(selectableIds.length, MAX_BATCH);
      const next = new Set();
      for (let i = 0; i < cap; i++) next.add(selectableIds[i]);
      if (selectableIds.length > MAX_BATCH) {
        toast.info(`Selected first ${MAX_BATCH} eligible rows.`);
      }
      return next;
    });
  }

  async function openConfirm() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setResults(null);
    try {
      const ids = Array.from(selected);
      const res = await api.post('/admin/cc-import/wrap-up/preview', { proposal_ids: ids });
      setConfirm({ ids, preview: res.data });
    } catch (err) {
      toast.error(err.message || 'Pre-flight failed.');
    } finally {
      setSubmitting(false);
    }
  }

  function closeConfirm() {
    setConfirm(null);
  }

  async function commitEnqueue() {
    if (!confirm) return;
    setSubmitting(true);
    try {
      const res = await api.post('/admin/cc-import/wrap-up/enqueue', { proposal_ids: confirm.ids });
      setResults(res.data.results || []);
      setConfirm(null);
      const enqueued = (res.data.results || []).filter(r => r.outcome === 'enqueued').length;
      if (enqueued > 0) toast.success(`Queued ${enqueued} wrap-up email${enqueued === 1 ? '' : 's'}.`);
      await load();
    } catch (err) {
      toast.error(err.message || 'Enqueue failed.');
    } finally {
      setSubmitting(false);
    }
  }

  const totalSelected = selected.size;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">CC-Import wrap-up</div>
          <div className="page-subtitle">
            Send the post-event wrap-up email to Bucket B events imported from Check Cherry.
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Total Bucket B</div>
          <div className="stat-value">{counts.total_bucket_b}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Need wrap-up</div>
          <div className="stat-value">{counts.needs_wrapup}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Last 30 days</div>
          <div className="stat-value">{counts.last_30}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Filter</span>
            <select
              value={filter}
              onChange={e => updateParams({ filter: e.target.value, page: 1 })}
            >
              <option value="needs-wrapup">Needs wrap-up only</option>
              <option value="all">All Bucket B</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Range</span>
            <select
              value={range}
              onChange={e => updateParams({ range: e.target.value, page: 1 })}
            >
              <option value="since-import">Since import</option>
              <option value="last-30">Last 30 days</option>
            </select>
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted tiny">
              {totalSelected} selected (max {MAX_BATCH})
            </span>
            <button
              type="button"
              className="btn"
              disabled={totalSelected === 0 || submitting}
              onClick={openConfirm}
            >
              {submitting ? 'Working…' : 'Send wrap-up'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-body" style={{ color: 'var(--danger, #b00020)' }}>
            {error}
            <button type="button" className="btn btn-ghost" style={{ marginLeft: 12 }} onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-head">
            <h3 style={{ margin: 0, fontSize: 14 }}>Last batch results</h3>
            <button type="button" className="btn btn-ghost" onClick={() => setResults(null)}>
              Dismiss
            </button>
          </div>
          <div className="card-body">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {results.map(r => (
                <li key={r.proposal_id} style={{ marginBottom: 4 }}>
                  Proposal #{r.proposal_id}: <strong>{OUTCOME_LABEL[r.outcome] || r.outcome}</strong>
                  {r.message ? <span className="muted tiny" style={{ marginLeft: 8 }}>{r.message}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="card-body muted">
            {filter === 'needs-wrapup'
              ? 'All Bucket B wrap-ups have been sent. Toggle off to see the full list.'
              : 'No Bucket B proposals in this range.'}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line, #ddd)' }}>
                  <th style={{ width: 36, padding: '8px 6px' }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectableIds.length === 0}
                      onChange={toggleAll}
                      aria-label="Select all eligible"
                    />
                  </th>
                  <th style={{ padding: '8px 6px' }}>Event date</th>
                  <th style={{ padding: '8px 6px' }}>Client</th>
                  <th style={{ padding: '8px 6px' }}>Email</th>
                  <th style={{ padding: '8px 6px' }}>Type</th>
                  <th style={{ padding: '8px 6px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '8px 6px' }}>Status</th>
                  <th style={{ padding: '8px 6px' }}>CC ID</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const isDone = !!it.wrap_up_done;
                  const isBadEmail = it.email_status === 'bad';
                  const isPlaceholder = it.email && /^cc-import-noemail-.*@drbartender\.local$/i.test(it.email);
                  return (
                    <tr key={it.id} style={{ borderBottom: '1px solid var(--line, #eee)' }}>
                      <td style={{ padding: '8px 6px' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          disabled={isDone}
                          onChange={() => toggleOne(it.id)}
                          aria-label={`Select proposal ${it.id}`}
                        />
                      </td>
                      <td style={{ padding: '8px 6px' }}>{formatDate(it.event_date)}</td>
                      <td style={{ padding: '8px 6px' }}>{it.client_name || '—'}</td>
                      <td style={{ padding: '8px 6px' }}>
                        {it.email || '—'}
                        {(isBadEmail || isPlaceholder) && (
                          <span className="muted tiny" style={{ marginLeft: 6 }}>
                            ({isBadEmail ? 'bad' : 'placeholder'})
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        {it.event_type_custom || it.event_type || '—'}
                      </td>
                      <td style={{ padding: '8px 6px', textAlign: 'right' }}>{formatMoneyCents(it.total_price)}</td>
                      <td style={{ padding: '8px 6px' }}>
                        {isDone ? <span className="muted">Sent</span> : <span>Pending</span>}
                      </td>
                      <td style={{ padding: '8px 6px' }}><code className="tiny">{it.cc_id}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="muted tiny">
              Page {page} · showing {items.length} of {filter === 'needs-wrapup' ? counts.needs_wrapup : counts.total_bucket_b}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={page <= 1}
                onClick={() => updateParams({ page: page - 1 })}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={items.length < 50}
                onClick={() => updateParams({ page: page + 1 })}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cc-confirm-title"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          }}
          onClick={closeConfirm}
        >
          <div
            className="card"
            style={{ maxWidth: 480, width: 'calc(100% - 32px)', background: 'white' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="card-head">
              <h3 id="cc-confirm-title" style={{ margin: 0, fontSize: 16 }}>
                Send wrap-up email
              </h3>
            </div>
            <div className="card-body">
              <p style={{ margin: '0 0 12px' }}>
                You are about to enqueue <strong>{confirm.preview.total}</strong> wrap-up
                email{confirm.preview.total === 1 ? '' : 's'}.
              </p>
              <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>
                <li>Will send: <strong>{confirm.preview.breakdown.proceed}</strong></li>
                <li>No usable email: <strong>{confirm.preview.breakdown.no_email}</strong></li>
                <li>Suppressed (opted out, etc.): <strong>{confirm.preview.breakdown.suppressed}</strong></li>
              </ul>
              <p className="muted tiny" style={{ margin: 0 }}>
                Sending happens on the next dispatcher tick. Already-sent and not-eligible
                items in the batch are skipped. See results panel after submit.
              </p>
            </div>
            <div className="card-body" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={closeConfirm} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={commitEnqueue}
                disabled={submitting || confirm.preview.breakdown.proceed === 0}
              >
                {submitting ? 'Sending…' : 'Confirm and queue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
