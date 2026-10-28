// StripePayoutsTab (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import EntityLink from '../../components/EntityLink';
import { ctDay, fmt$fromCents, fmtDate } from '../../components/adminos/format';
import { getEventTypeLabel } from '../../utils/eventTypes';

const PAYOUT_STATUS = { paid: 'ok', in_transit: 'info', pending: 'info', canceled: 'neutral', failed: 'danger' };
const KIND = { payment: 'ok', tip: 'accent', refund: 'warn', dispute: 'danger', adjustment: 'neutral', unmatched: 'warn' };

// Renders the identifying label for a payout/in-transit line with cross-links:
// gratuity → the staffer's profile (staff_user_id, from the tips join); payment
// lines → the owning proposal (proposal_id); the invoice number is a secondary
// affordance to the public invoice page only when the line carries a token
// (there is no admin invoice page). Returns JSX (used inside <strong>/<td>).
function lineLabel(l) {
  if (l.matched_kind === 'tip') {
    return (
      <>Gratuity: <EntityLink to={l.staff_user_id ? `/staffing/users/${l.staff_user_id}` : null}>{l.staff_name || 'staff'}</EntityLink></>
    );
  }
  if (l.client_name) {
    const ev = getEventTypeLabel({ event_type: l.event_type, event_type_custom: l.event_type_custom });
    return (
      <>
        <EntityLink to={l.proposal_id ? `/proposals/${l.proposal_id}` : null}>{l.client_name} ({ev}</EntityLink>
        {l.invoice_number && (
          l.invoice_token
            ? <>, <a href={`/invoice/${l.invoice_token}`} target="_blank" rel="noopener noreferrer">{l.invoice_number}</a></>
            : <>, {l.invoice_number}</>
        )}
        {')'}
      </>
    );
  }
  // A manual payout's debit, listed inside the automatic payout that followed
  // it; or, at amount 0, the fee on an automatic instant payout's own debit.
  if (l.txn_type === 'payout') return Number(l.amount_cents) === 0 ? 'Instant payout fee' : 'Manual payout sent earlier';
  return l.description || l.stripe_balance_txn_id;
}

export default function StripePayoutsTab({ show, onClearShow } = {}) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null); // payout id
  const [lines, setLines] = useState({});         // payout id -> { rows, v }, v = linesVersion at fetch
  const [lineError, setLineError] = useState({}); // payout id -> true on detail-fetch failure
  const [linesVersion, setLinesVersion] = useState(0); // bumped when a sync may have rewritten lines
  const fetchSeq = useRef(0);                     // only the latest detail request writes
  const syncedOnce = useRef(false);

  const load = useCallback(() =>
    api.get('/stripe-payouts')
      .then(r => { setData(r.data); return r.data; })
      .catch(err => { toast.error(err.message || 'Could not load Stripe payouts. Try refreshing.'); return null; })
      .finally(() => setLoading(false)), [toast]);

  const syncNow = useCallback((force) => {
    setSyncing(true);
    return api.post('/stripe-payouts/sync', force ? { force: true } : {})
      .then(r => {
        if (!r.data?.synced) return;
        // A sync can rewrite an already-synced payout's lines (the balance
        // heal). The open detail is fetched again with its rows kept on screen
        // until the new ones land, and an answer from before the sync is dropped.
        fetchSeq.current += 1;
        setLinesVersion(v => v + 1);
        return load();
      })
      .catch(err => toast.error(err.message || 'Sync failed. Try again in a minute.'))
      .finally(() => setSyncing(false));
  }, [load, toast]);

  useEffect(() => {
    // Stale-then-refresh: render DB data immediately; the server's 15-minute
    // staleness gate decides whether the background sync actually runs.
    load().then(d => {
      if (syncedOnce.current || !d) return;
      syncedOnce.current = true;
      syncNow(false);
    });
  }, [load, syncNow]);

  // Entering unmatched focus auto-expands the FIRST unmatched payout. The
  // detail model is single-expansion (one lazy fetch at a time), so the
  // plan's cap-at-10 multi-expand adapts to expanding the first row.
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (show !== 'unmatched' || autoExpanded.current || !data) return;
    const first = (data.payouts || []).find(p => Number(p.unmatched_count || 0) > 0);
    if (first) { autoExpanded.current = true; toggle(first.id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, data]);

  const toggle = (id) => {
    if (expanded === id) return setExpanded(null);
    setLineError(prev => ({ ...prev, [id]: false })); // re-opening retries a failed fetch
    setExpanded(id);
  };

  // Fetches the open payout's lines when none are cached or they predate the
  // last sync. Only the latest request writes, so a late answer cannot replace
  // a fresh one. A manual payout has no lines to fetch.
  useEffect(() => {
    if (expanded == null || lineError[expanded]) return;
    if (lines[expanded] && lines[expanded].v === linesVersion) return;
    const open = (data?.payouts || []).find(x => x.id === expanded);
    if (!open || open.automatic === false) return;
    const seq = ++fetchSeq.current;
    const id = expanded;
    const v = linesVersion;
    api.get(`/stripe-payouts/${id}`)
      .then(r => { if (seq === fetchSeq.current) setLines(prev => ({ ...prev, [id]: { rows: r.data.lines, v } })); })
      .catch(err => {
        if (seq !== fetchSeq.current) return;
        setLineError(prev => ({ ...prev, [id]: true }));
        toast.error(err.message || 'Could not load payout detail.');
      });
  }, [expanded, lines, lineError, linesVersion, data, toast]);

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="chip danger">Couldn't load Stripe payouts. Try refreshing.</div>;
  const s = data.summary || {};
  // An instant payout advance a deposit already claimed, still being repaid out
  // of the charges below; In transit nets it out, so it is listed with them.
  const advanceOwed = Number(s.advance_owed_cents || 0);
  // A pending manual payout debit is dated when it left; only the rest land later.
  const nearestEta = (data.pending || []).filter(l => l.txn_type !== 'payout')
    .map(l => l.available_on).filter(Boolean).sort()[0] || null;
  const unmatchedOnly = show === 'unmatched';
  const shownPayouts = unmatchedOnly
    ? (data.payouts || []).filter(p => Number(p.unmatched_count || 0) > 0)
    : (data.payouts || []);

  return (
    <>
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">In transit</div>
          <div className="stat-value">{fmt$fromCents(s.in_transit_cents || 0)}</div>
          <div className="stat-sub"><span>
            {(data.pending || []).length} line{(data.pending || []).length === 1 ? '' : 's'} awaiting payout
            {nearestEta ? ` · next lands ~${fmtDate(String(nearestEta).slice(0, 10), { year: 'numeric' })}` : ''}
          </span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Stripe fees (month)</div>
          <div className="stat-value">{fmt$fromCents(s.fees_mtd_cents || 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Stripe fees (YTD)</div>
          <div className="stat-value">{fmt$fromCents(s.fees_ytd_cents || 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Last synced</div>
          <div className="stat-value" style={{ fontSize: '1rem' }}>
            {syncing ? 'Syncing…' : (s.last_synced_at ? fmtDate(ctDay(s.last_synced_at), { year: 'numeric' }) : 'not yet')}
          </div>
          <div className="stat-sub">
            <button className="btn btn-secondary btn-sm" onClick={() => syncNow(true)} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>
      </div>

      {((data.pending || []).length > 0 || advanceOwed !== 0) && (
        <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
          <div className="card-head"><h3>In transit</h3><span className="k">{data.pending.length}</span></div>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>What</th><th>Type</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">Net</th><th>Est. payout</th></tr></thead>
            <tbody>{data.pending.map(l => (
              <tr key={l.id}>
                <td><strong>{lineLabel(l)}</strong></td>
                <td><StatusChip kind={KIND[l.matched_kind] || 'neutral'}>{l.matched_kind}</StatusChip></td>
                <td className="num">{fmt$fromCents(l.amount_cents)}</td>
                <td className="num muted">{fmt$fromCents(l.fee_cents)}</td>
                <td className="num">{fmt$fromCents(l.net_cents)}</td>
                <td className="muted">{l.available_on && l.txn_type !== 'payout' ? fmtDate(String(l.available_on).slice(0, 10), { year: 'numeric' }) : '—'}</td>
              </tr>
            ))}
            {advanceOwed !== 0 && (
              <tr>
                <td><strong>Instant payout advance still being repaid</strong></td>
                <td><StatusChip kind={KIND.adjustment}>adjustment</StatusChip></td>
                <td className="num">{fmt$fromCents(-advanceOwed)}</td>
                <td className="num muted">{fmt$fromCents(0)}</td>
                <td className="num">{fmt$fromCents(-advanceOwed)}</td>
                <td className="muted">—</td>
              </tr>
            )}</tbody>
          </table></div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Payouts</h3><span className="k">{shownPayouts.length}</span></div>
        {unmatchedOnly && (
          <div className="tiny muted" style={{ padding: '8px 16px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="chip warn">Unmatched only</span>
            {onClearShow && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClearShow}>Clear</button>
            )}
            {shownPayouts.length === 0 && (
              (data.pending || []).some(l => l.matched_kind === 'unmatched')
                ? <span>Unmatched lines are still in transit. See In transit above.</span>
                : <span>No unmatched payouts right now.</span>
            )}
          </div>
        )}
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Arrived</th><th>Status</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net to bank</th><th className="num">Lines</th></tr></thead>
          <tbody>
            {shownPayouts.length === 0 && !unmatchedOnly && (
              <tr><td colSpan={6} className="muted">No payouts synced yet. Hit Sync now.</td></tr>
            )}
            {shownPayouts.map(p => {
              // Instant or sent by hand: Stripe gives no line breakdown for it.
              const manual = p.automatic === false;
              return (
              <React.Fragment key={p.id}>
                <tr
                  onClick={() => toggle(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      if (e.key === ' ') e.preventDefault(); // stop Space from scrolling the page
                      toggle(p.id);
                    }
                  }}
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                  title="Show what made up this payout"
                >
                  <td>
                    <strong>{p.arrival_date ? fmtDate(String(p.arrival_date).slice(0, 10), { year: 'numeric' }) : '—'}</strong>
                    <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>
                      created {fmtDate(ctDay(p.created_at_stripe), { year: 'numeric' })}
                    </span>
                  </td>
                  <td>
                    <StatusChip kind={PAYOUT_STATUS[p.status] || 'neutral'}>{p.status.replace('_', ' ')}</StatusChip>
                    {p.failure_message && <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>{p.failure_message}</span>}
                    {manual && <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>manual payout</span>}
                  </td>
                  <td className="num">{manual ? <span className="muted">—</span> : fmt$fromCents(p.gross_cents)}</td>
                  <td className="num muted">{manual ? '—' : fmt$fromCents(p.fee_cents)}</td>
                  <td className="num"><strong>{fmt$fromCents(p.amount_cents)}</strong></td>
                  <td className="num muted">{manual ? '—' : p.line_count}</td>
                </tr>
                {expanded === p.id && manual && (
                  <tr><td colSpan={6} className="muted">Stripe gives no breakdown for a manual payout. Its amount, and any instant payout fee, show as a line in the next automatic payout.</td></tr>
                )}
                {expanded === p.id && !manual && lineError[p.id] && (
                  <tr><td colSpan={6} className="muted">Couldn't load payout detail.</td></tr>
                )}
                {expanded === p.id && !manual && !lineError[p.id] && !lines[p.id] && (
                  <tr><td colSpan={6} className="muted">Loading…</td></tr>
                )}
                {expanded === p.id && !manual && !lineError[p.id] && (lines[p.id]?.rows || []).map(l => (
                  <tr key={l.id} style={{ background: 'var(--paper-2, transparent)' }}>
                    <td className="muted" style={{ paddingLeft: '2em' }}>{lineLabel(l)}</td>
                    <td>
                      <StatusChip kind={KIND[l.matched_kind] || 'neutral'}>{l.matched_kind}</StatusChip>
                      {/* Acknowledged baseline (settled before payout tracking, 2026-07-02):
                          visible for history, excluded from every unmatched count. */}
                      {l.acknowledged_at && (
                        <>{' '}<StatusChip kind="neutral" dot={false}>pre-cutover</StatusChip></>
                      )}
                    </td>
                    <td className="num">{fmt$fromCents(l.amount_cents)}</td>
                    <td className="num muted">{fmt$fromCents(l.fee_cents)}</td>
                    <td className="num">{fmt$fromCents(l.net_cents)}</td>
                    <td />
                  </tr>
                ))}
              </React.Fragment>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
