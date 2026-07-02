import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import MetricsFilterBar from '../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../hooks/useMetricsFilter';
import { fmt$, fmt$fromCents, fmtDate } from '../../components/adminos/format';
import ClickableRow from '../../components/ClickableRow';
import CcImportBadge from '../../components/admin/CcImportBadge';

const STATUS = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', confirmed: 'ok', completed: 'ok',
  declined: 'danger',
};
const LENS_LABEL = { booked: 'Booked', scheduled: 'Scheduled', paid: 'Paid' };

export default function FinancialsDashboard() {
  const toast = useToast();
  const filter = useMetricsFilter();
  const { from, to, basis, includeCc } = filter;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    if (includeCc && includeCc !== 'all') params.include_cc = includeCc;
    api.get('/proposals/financials', { params })
      .then(r => setData(r.data))
      .catch((err) => toast.error(err.message || 'Failed to load financial data. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [from, to, basis, includeCc, toast]);

  const summary = data?.summary;
  const proposals = data?.proposals;
  const recentPayments = data?.recentPayments;
  const booked = Number(summary?.booked || 0);
  const collected = Number(summary?.collected || 0);
  const outstanding = Number(summary?.outstanding || 0);
  const avgEvent = Number(summary?.avgEvent || 0);
  const unlinkedRefundsCents = Number(summary?.unlinkedRefundsCents || 0);
  const leadSpend = summary?.leadSpend || null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Financials</div>
          <div className="page-subtitle">Revenue, outstanding balances, and recent payments.</div>
        </div>
        <div>
          <Link to="/financials/payroll" className="btn btn-secondary btn-sm">
            Payroll →
          </Link>
        </div>
      </div>

      <MetricsFilterBar filter={filter} />

      {loading && <div className="muted">Loading…</div>}
      {!loading && !data && (
        <div className="chip danger">Couldn't load financial data. Try refreshing.</div>
      )}

      {!loading && data && (
        <>
          <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
            <div className="stat">
              <div className="stat-label">{LENS_LABEL[basis]}</div>
              <div className="stat-value">{fmt$(booked)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Collected</div>
              <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{fmt$(collected)}</div>
              <div className="stat-sub"><span>{booked > 0 ? Math.round((collected / booked) * 100) : 0}% of {LENS_LABEL[basis].toLowerCase()}</span></div>
            </div>
            <div className="stat">
              <div className="stat-label">Outstanding</div>
              <div className="stat-value" style={{ color: outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>{fmt$(outstanding)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Avg event</div>
              <div className="stat-value">{fmt$(avgEvent)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">TT lead spend</div>
              <div className="stat-value">{fmt$((leadSpend?.totalCents || 0) / 100)}</div>
              <div className="stat-sub">
                <span>
                  {fmt$((leadSpend?.attributedCents || 0) / 100)} tied to events · {leadSpend?.chargedLeads || 0} charged lead{(leadSpend?.chargedLeads || 0) === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
            <div className="card-head"><h3>Proposals</h3><span className="k">{data.pagination?.total ?? proposals?.length ?? 0}</span></div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Client</th><th>Event</th><th>Date</th><th>Status</th>
                    <th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(!proposals || proposals.length === 0) && (
                    <tr><td colSpan={7} className="muted">No proposals in this range.</td></tr>
                  )}
                  {proposals && proposals.map(p => {
                    const total = Number(p.total_price || 0);
                    const paid = Number(p.amount_paid || 0);
                    const bal = total - paid;
                    return (
                      <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                        <td>
                          <strong>{p.client_name || '—'}</strong>
                          <CcImportBadge ccId={p.proposal_cc_id} />
                        </td>
                        <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                        <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                        <td><StatusChip kind={STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                        <td className="num">{fmt$(total)}</td>
                        <td className="num muted">{fmt$(paid)}</td>
                        <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                          {bal > 0 ? fmt$(bal) : '—'}
                        </td>
                      </ClickableRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head"><h3>Payments in range</h3><span className="k">{recentPayments?.length || 0}</span></div>
            {unlinkedRefundsCents > 0 && (
              <div className="muted" style={{ padding: '0 var(--gap) var(--gap)', fontSize: '0.85em' }}>
                Collected is net of every refund, including {fmt$fromCents(unlinkedRefundsCents)} not tied to a specific
                payment here. The rows below net only each payment's own refunds, so they may not add up to Collected.
              </div>
            )}
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Client</th><th>Event</th><th>Type</th><th className="num">Amount</th><th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(!recentPayments || recentPayments.length === 0) && (
                    <tr><td colSpan={5} className="muted">No payments in this range.</td></tr>
                  )}
                  {recentPayments && recentPayments.map(pp => (
                    <ClickableRow key={pp.id} style={{ cursor: pp.invoice_token ? 'pointer' : 'default' }}
                      onActivate={() => pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank', 'noopener,noreferrer')}
                      title={pp.invoice_token ? 'View invoice' : ''}>
                      <td><strong>{pp.client_name || '—'}</strong></td>
                      <td>{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</td>
                      <td className="muted" style={{ textTransform: 'capitalize' }}>{pp.payment_type}</td>
                      <td className="num">
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
      )}
    </div>
  );
}
