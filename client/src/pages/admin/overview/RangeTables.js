import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/adminos/Icon';
import StatusChip from '../../../components/adminos/StatusChip';
import ClickableRow from '../../../components/ClickableRow';
import EntityLink from '../../../components/EntityLink';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt$2dp, fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { eraOverlaps } from './OverviewPage';

const STATUS_KIND = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', confirmed: 'ok', completed: 'ok',
  archived: 'neutral', declined: 'danger',
};

const ERA_NOTE = 'Rows are DRB records (May 2026 onward). Totals above also count the frozen ledger, which keeps no row-level records.';

// Client-side type filter over the ALREADY-returned payment rows (spec §6, no
// server change). deposit/balance match payment_type; refund matches any row that
// carries a succeeded refund.
const TYPE_CHIPS = [['deposit', 'Deposit'], ['balance', 'Balance'], ['refund', 'Refund']];
function matchesType(pp, key) {
  if (key === 'refund') return Number(pp.refunded_cents || 0) > 0;
  return pp.payment_type === key;
}

// Proposals-in-range (DOLLARS → fmt$2dp) + Payments-in-range (CENTS →
// fmt$fromCents) from the financials response. Rows are ClickableRow to the
// proposal detail; era notes are conditional footnotes (spec §9). Wide tables
// scroll in their own tbl-wrap; at 390px they collapse to the queue-item row
// pattern (B2.7b).
export default function RangeTables({ proposals = [], payments = [], summary = {}, from, to }) {
  const navigate = useNavigate();
  const [types, setTypes] = useState(() => new Set());
  const overlaps = eraOverlaps(from);
  const unlinkedRefundsCents = Number(summary.unlinkedRefundsCents || 0);
  const rq = (from && to) ? `&from=${from}&to=${to}` : '';

  const toggleType = (key) => setTypes((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const shownPayments = useMemo(() => {
    if (types.size === 0) return payments;
    return payments.filter(pp => [...types].some(k => matchesType(pp, k)));
  }, [payments, types]);

  return (
    <>
      <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
        <div className="card-head">
          <h3>Proposals in range <span className="k">{proposals.length}</span></h3>
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/proposals?axis=event${rq}`)}>
            View all <Icon name="right" size={11} />
          </button>
        </div>
        {overlaps && <div className="ov-era-note">{ERA_NOTE}</div>}
        <div className="tbl-wrap ov-tbl-collapse">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th><th>Event</th><th>Date</th><th>Status</th>
                <th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {proposals.length === 0 && (
                <tr><td colSpan={7} className="muted">No proposals in this range.</td></tr>
              )}
              {proposals.map(p => {
                const total = Number(p.total_price || 0);
                const paid = Number(p.amount_paid || 0);
                const bal = total - paid;
                return (
                  <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                    <td>
                      <EntityLink to={p.client_id ? `/clients/${p.client_id}` : null}>
                        <strong>{p.client_name || '—'}</strong>
                      </EntityLink>
                      <div className="sub ov-collapse-type">{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</div>
                    </td>
                    <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                    <td className="muted">{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                    <td><StatusChip kind={STATUS_KIND[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                    <td className="num ov-amt">{fmt$2dp(total)}</td>
                    <td className="num muted">{fmt$2dp(paid)}</td>
                    <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                      {bal > 0 ? fmt$2dp(bal) : '—'}
                    </td>
                  </ClickableRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" id="ov-payments" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <h3>Payments in range <span className="k">{shownPayments.length}</span></h3>
          <div className="metrics-seg" role="group" aria-label="Payment type">
            {TYPE_CHIPS.map(([key, label]) => (
              <button key={key} type="button"
                className={`metrics-seg-btn${types.has(key) ? ' is-active' : ''}`}
                aria-pressed={types.has(key)}
                onClick={() => toggleType(key)}>{label}</button>
            ))}
          </div>
        </div>
        {overlaps && <div className="ov-era-note">{ERA_NOTE}</div>}
        {unlinkedRefundsCents > 0 && (
          <div className="ov-era-note">
            Collected is net of every refund, including {fmt$fromCents(unlinkedRefundsCents)} not tied to a
            payment row here. These rows net only each payment's own refunds, so they may not add up to Collected.
          </div>
        )}
        <div className="tbl-wrap ov-tbl-collapse">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th><th>Event</th><th>Type</th><th className="num">Amount</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {shownPayments.length === 0 && (
                <tr><td colSpan={5} className="muted">No payments{types.size > 0 ? ' of this type' : ''} in this range.</td></tr>
              )}
              {shownPayments.map(pp => (
                <ClickableRow key={pp.id} to={pp.proposal_id ? `/proposals/${pp.proposal_id}` : undefined}>
                  <td>
                    <EntityLink to={pp.client_id ? `/clients/${pp.client_id}` : null}>
                      <strong>{pp.client_name || '—'}</strong>
                    </EntityLink>
                    <div className="sub ov-collapse-type">{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</div>
                  </td>
                  <td>{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</td>
                  <td className="muted" style={{ textTransform: 'capitalize' }}>{pp.payment_type}</td>
                  <td className="num ov-amt">
                    {fmt$fromCents(Number(pp.net_amount))}
                    {Number(pp.refunded_cents) > 0 && (
                      <span className="muted" style={{ display: 'block', fontSize: '0.85em' }}>
                        refunded {fmt$fromCents(Number(pp.refunded_cents))}
                      </span>
                    )}
                  </td>
                  <td className="muted">{fmtDate(pp.created_at && String(pp.created_at).slice(0, 10), { year: 'numeric' })}</td>
                </ClickableRow>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
