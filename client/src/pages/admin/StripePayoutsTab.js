import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import EntityLink from '../../components/EntityLink';
import { fmt$fromCents, fmtDate } from '../../components/adminos/format';
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
  return l.description || l.stripe_balance_txn_id;
}

export default function StripePayoutsTab() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null); // payout id
  const [lines, setLines] = useState({});         // payout id -> lines[]
  const [lineError, setLineError] = useState({}); // payout id -> true on detail-fetch failure
  const syncedOnce = useRef(false);

  const load = useCallback(() =>
    api.get('/stripe-payouts')
      .then(r => { setData(r.data); return r.data; })
      .catch(err => { toast.error(err.message || 'Could not load Stripe payouts. Try refreshing.'); return null; })
      .finally(() => setLoading(false)), [toast]);

  const syncNow = useCallback((force) => {
    setSyncing(true);
    return api.post('/stripe-payouts/sync', force ? { force: true } : {})
      .then(r => { if (r.data?.synced) return load(); })
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

  const toggle = (id) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (!lines[id]) {
      setLineError(prev => ({ ...prev, [id]: false })); // clear any prior failure on (re)fetch
      api.get(`/stripe-payouts/${id}`)
        .then(r => setLines(prev => ({ ...prev, [id]: r.data.lines })))
        .catch(err => {
          setLineError(prev => ({ ...prev, [id]: true }));
          toast.error(err.message || 'Could not load payout detail.');
        });
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="chip danger">Couldn't load Stripe payouts. Try refreshing.</div>;
  const s = data.summary || {};
  const nearestEta = (data.pending || []).map(l => l.available_on).filter(Boolean).sort()[0] || null;

  return (
    <>
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">In transit</div>
          <div className="stat-value">{fmt$fromCents(s.in_transit_cents || 0)}</div>
          <div className="stat-sub"><span>
            {(data.pending || []).length} settled charge{(data.pending || []).length === 1 ? '' : 's'} awaiting payout
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
            {syncing ? 'Syncing…' : (s.last_synced_at ? fmtDate(String(s.last_synced_at).slice(0, 10), { year: 'numeric' }) : 'not yet')}
          </div>
          <div className="stat-sub">
            <button className="btn btn-secondary btn-sm" onClick={() => syncNow(true)} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>
      </div>

      {(data.pending || []).length > 0 && (
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
                <td className="muted">{l.available_on ? fmtDate(String(l.available_on).slice(0, 10), { year: 'numeric' }) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Payouts</h3><span className="k">{(data.payouts || []).length}</span></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Arrived</th><th>Status</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net to bank</th><th className="num">Lines</th></tr></thead>
          <tbody>
            {(data.payouts || []).length === 0 && (
              <tr><td colSpan={6} className="muted">No payouts synced yet. Hit Sync now.</td></tr>
            )}
            {(data.payouts || []).map(p => (
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
                      created {fmtDate(String(p.created_at_stripe).slice(0, 10), { year: 'numeric' })}
                    </span>
                  </td>
                  <td>
                    <StatusChip kind={PAYOUT_STATUS[p.status] || 'neutral'}>{p.status.replace('_', ' ')}</StatusChip>
                    {p.failure_message && <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>{p.failure_message}</span>}
                  </td>
                  <td className="num">{fmt$fromCents(p.gross_cents)}</td>
                  <td className="num muted">{fmt$fromCents(p.fee_cents)}</td>
                  <td className="num"><strong>{fmt$fromCents(p.amount_cents)}</strong></td>
                  <td className="num muted">{p.line_count}</td>
                </tr>
                {expanded === p.id && lineError[p.id] && (
                  <tr><td colSpan={6} className="muted">Couldn't load payout detail.</td></tr>
                )}
                {expanded === p.id && !lineError[p.id] && !lines[p.id] && (
                  <tr><td colSpan={6} className="muted">Loading…</td></tr>
                )}
                {expanded === p.id && !lineError[p.id] && (lines[p.id] || []).map(l => (
                  <tr key={l.id} style={{ background: 'var(--paper-2, transparent)' }}>
                    <td className="muted" style={{ paddingLeft: '2em' }}>{lineLabel(l)}</td>
                    <td><StatusChip kind={KIND[l.matched_kind] || 'neutral'}>{l.matched_kind}</StatusChip></td>
                    <td className="num">{fmt$fromCents(l.amount_cents)}</td>
                    <td className="num muted">{fmt$fromCents(l.fee_cents)}</td>
                    <td className="num">{fmt$fromCents(l.net_cents)}</td>
                    <td />
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
