import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import useUrlListState from '../../../hooks/useUrlListState';
import EntityLink from '../../../components/EntityLink';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDateTime } from '../../../components/adminos/format';
import { tipStatus, netCents } from './tipStatus';

const LEDGER_DEFAULTS = { from: '', to: '' };
const PAGE = 50;

// The cross-staff tip ledger, moved from the retired /tips page into Payroll
// (spec §7). Money columns are NET of refunds; the stat is labelled "in view"
// because it sums what is loaded (the read is cursor-paginated).
export default function TipsLedger() {
  const toast = useToast();
  const [filters, setFilters] = useUrlListState(LEDGER_DEFAULTS);
  const [tips, setTips] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // Retry cannot go through setFilters: useUrlListState DELETES keys equal to
  // their defaults, so re-setting empty filters changes nothing and the effect
  // never refires. A plain counter is the refetch signal.
  const [reloadKey, setReloadKey] = useState(0);
  // Every read is issued FOR one view. This counter bumps whenever the view
  // identity moves (a date filter, or a Retry that replaces the whole set), each
  // read is stamped with the generation current when it was issued, and a
  // response carrying a superseded stamp is dropped instead of applied.
  // Without it a "Load more" page read for filter A can land after the effect
  // has already swapped in filter B's first page, appending rows from OUTSIDE
  // the requested window and inflating "Net in view", which sums exactly what
  // is loaded. ONE click plus a filter change is enough, so the loadingMore
  // double-click guard below does not cover it.
  const viewGen = useRef(0);

  const fetchPage = (after) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (after) params.set('cursor', String(after));
    return api.get(`/admin/tips?${params.toString()}`);
  };

  useEffect(() => {
    viewGen.current += 1;
    const gen = viewGen.current;
    // A page read belonging to the view being left is about to be dropped, so
    // its finally will not clear this flag; clearing it here is what keeps the
    // new view's button from being born stuck on "Loading…".
    setLoading(true); setError(false); setLoadingMore(false);
    fetchPage(null)
      .then(r => { if (gen !== viewGen.current) return; setTips(r.data?.tips || []); setCursor(r.data?.next_cursor || null); })
      // A failed reload drops the rows it could not refresh: stale money under
      // a "could not load" line reads as current, and the stat above the table
      // would keep summing a view that is no longer on screen.
      .catch(() => { if (gen !== viewGen.current) return; setTips([]); setCursor(null); setError(true); })
      .finally(() => { if (gen === viewGen.current) setLoading(false); });
    // Unmount retires the generation too, so a late response never writes to a
    // view that is gone.
    return () => { viewGen.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from, filters.to, reloadKey]);

  // Guarded against a double click: the cursor comes off the render closure, so
  // a second click before the first read lands would refetch the SAME page,
  // append it twice (duplicate keys) and double its share of "Net in view".
  // The flag clears in finally so a failed page cannot wedge the button.
  const loadMore = () => {
    if (!cursor || loadingMore) return;
    const gen = viewGen.current;
    setLoadingMore(true);
    fetchPage(cursor)
      .then(r => { if (gen !== viewGen.current) return; setTips(t => [...t, ...(r.data?.tips || [])]); setCursor(r.data?.next_cursor || null); })
      // A failure the user can no longer act on is not worth a toast: the view
      // it was read for is off screen.
      .catch(() => { if (gen === viewGen.current) toast.error('Could not load more tips.'); })
      .finally(() => { if (gen === viewGen.current) setLoadingMore(false); });
  };

  const total = useMemo(() => tips.reduce((s, t) => s + netCents(t), 0), [tips]);

  return (
    <>
      {/* .stat-row is a five-track grid; this band holds ONE stat, so the track
          count is set here or the other four render as empty bordered cells.
          Artboard 1g sets it inline the same way (it draws three stats). */}
      <div className="stat-row" style={{ gridTemplateColumns: 'minmax(200px, 320px)' }}>
        <div className="stat">
          <div className="stat-label">Net in view</div>
          <div className="stat-value">{fmt$fromCents(total)}</div>
          <div className="stat-sub"><span>{tips.length} {tips.length === 1 ? 'tip' : 'tips'}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">From</span>
            <input className="input" type="date" value={filters.from} onChange={e => setFilters({ from: e.target.value })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">To</span>
            <input className="input" type="date" value={filters.to} onChange={e => setFilters({ to: e.target.value })} />
          </label>
          {(filters.from || filters.to) && (
            <button type="button" className="btn btn-ghost" onClick={() => setFilters({ from: '', to: '' })}>Clear</button>
          )}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Activity</h3><span className="k">{tips.length}</span></div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Bartender</th><th className="num">Amount</th><th>Date</th><th>Customer</th><th>Status</th></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
              {!loading && error && (
                <tr><td colSpan={5}><span className="muted">Could not load tips.</span>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReloadKey(k => k + 1)}>Retry</button></td></tr>
              )}
              {!loading && !error && tips.length === 0 && <tr><td colSpan={5} className="muted">No tips in view.</td></tr>}
              {!loading && tips.map(t => {
                const st = tipStatus(t);
                const refunded = Number(t.refunded_amount_cents) > 0;
                return (
                  <tr key={t.id}>
                    <td>
                      <EntityLink to={t.target_user_id ? `/staffing/users/${t.target_user_id}?tab=payouts` : null}>
                        <strong>{t.bartender_name || `user ${t.target_user_id}`}</strong>
                      </EntityLink>
                    </td>
                    <td className="num">
                      {fmt$fromCents(netCents(t))}
                      {refunded && <span className="muted tiny" style={{ marginLeft: 6, textDecoration: 'line-through' }}>{fmt$fromCents(t.amount_cents)}</span>}
                    </td>
                    <td>{fmtDateTime(t.tipped_at)}</td>
                    <td className="muted">{t.customer_email || '—'}</td>
                    <td><StatusChip kind={st.kind}>{st.label}</StatusChip>{st.hint && <span className="muted tiny" style={{ marginLeft: 6 }}>{st.hint}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {cursor && (
          <div className="card-body" style={{ paddingTop: 0 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
        {/* Artboard 1g puts this sentence inside the Activity card as a bordered
            card-body, not loose on the page ground: it describes the table above
            it. Copy is section 7's, unchanged. */}
        <div className="card-body tiny muted" style={{ borderTop: '1px solid var(--line-1)' }}>
          Tips are collected on each bartender's own sign and paid through the event's payout, pooled across the bartenders who worked it; this ledger is the cross-staff view. A staffer's Payouts tab shows where each one landed.
        </div>
      </div>
    </>
  );
}
