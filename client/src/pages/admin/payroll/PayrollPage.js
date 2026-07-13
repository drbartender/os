import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import useUrlListState from '../../../hooks/useUrlListState';
import PayrollHeader from './PayrollHeader';
import PayoutRow from './PayoutRow';
import UnassignedTipsPanel from './UnassignedTipsPanel';
import DeferredTipsPanel from './DeferredTipsPanel';
import HistoryView from './HistoryView';
import TaxTotalsTab from './TaxTotalsTab';

const TABS = [
  { id: 'current', label: 'Current period' },
  { id: 'history', label: 'History' },
  { id: 'unassigned', label: 'Unassigned tips' },
  { id: 'tax', label: '1099 / tax' },
];
const TAB_IDS = ['current', 'history', 'unassigned', 'tax'];
const PAYROLL_DEFAULTS = { tab: 'current', period: '' };

export default function PayrollPage() {
  const [listState, setListState] = useUrlListState(PAYROLL_DEFAULTS);
  const tab = TAB_IDS.includes(listState.tab) ? listState.tab : 'current';
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Payroll</div>
          <div className="page-subtitle">Weekly payroll worklist, history, and stray tips.</div>
        </div>
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/dashboard')}>
            ← Overview
          </button>
        </div>
      </div>

      <div className="hstack" style={{ gap: 4, marginBottom: 'var(--gap)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setListState({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'current' && <CurrentTab />}
      {tab === 'history' && <HistoryTab initialPeriodId={listState.period} />}
      {tab === 'unassigned' && <UnassignedTab />}
      {tab === 'tax' && <TaxTotalsTab />}
    </div>
  );
}

function CurrentTab() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set());
  const [processing, setProcessing] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.get('/admin/payroll/periods/current')
      .then(r => setData(r.data))
      .catch(err => toast.error(err.message || 'Failed to load current period'))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const processPeriod = async () => {
    if (!data?.period?.id) return;
    setProcessing(true);
    try {
      await api.post(`/admin/payroll/periods/${data.period.id}/process`);
      toast.success('Period frozen. Ready to pay.');
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setProcessing(false);
    }
  };

  const onLineSaved = (updatedEvent, payoutTotal) => {
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        payouts: prev.payouts.map(po =>
          po.id !== updatedEvent.payout_id ? po : {
            ...po,
            total_cents: payoutTotal,
            // Merge instead of replace: Task 4's PATCH returns SELECT * from
            // payout_events only, so it doesn't carry the proposal-join fields
            // (event_date, event_type) that the row needs to render its label.
            events: po.events.map(e => e.id === updatedEvent.id ? { ...e, ...updatedEvent } : e),
          }),
      };
    });
  };

  const onPaid = ({ payout, period_status }) => {
    setData(prev => {
      if (!prev) return prev;
      const payouts = prev.payouts.map(po => po.id === payout.id ? { ...po, ...payout } : po);
      // Advance focus to the next pending row, derived from the freshly-updated
      // payouts list (the just-paid id is now status='paid' so it filters out
      // naturally). Computing inside the setData updater avoids the stale-closure
      // bug if the user clicks Mark Paid in rapid succession.
      const remaining = payouts.filter(p => p.status === 'pending');
      setExpanded(remaining[0] ? new Set([remaining[0].id]) : new Set());
      return { ...prev, period: { ...prev.period, status: period_status }, payouts };
    });
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (!data) return <div className="chip danger">Couldn't load the current period.</div>;

  // Mirror the server freeze gate exactly (admin/payroll.js rejects payout-event
  // edits when the period is `processing` OR `paid`). Editing during processing
  // used to look live but 409 on save; the hint below explains the frozen state.
  const editable = !!(data.period && data.period.status !== 'paid' && data.period.status !== 'processing');

  return (
    <>
      <PayrollHeader
        period={data.period}
        payouts={data.payouts}
        onProcess={processPeriod}
        processing={processing}
      />
      {data.period && data.period.status === 'processing' && (
        <div className="muted tiny" style={{ marginBottom: 'var(--gap)' }}>
          Period is processing. Line edits are frozen.
        </div>
      )}
      {(data.payouts || []).map(po => (
        <PayoutRow
          key={po.id}
          payout={po}
          expanded={expanded.has(po.id)}
          onToggle={() => toggle(po.id)}
          onLineSaved={onLineSaved}
          onPaid={onPaid}
          editable={editable}
        />
      ))}
      {(!data.payouts || data.payouts.length === 0) && (
        <div className="card"><div className="card-body muted">No payouts in this period yet.</div></div>
      )}
    </>
  );
}

function HistoryTab({ initialPeriodId }) {
  return <HistoryView initialPeriodId={initialPeriodId} />;
}
function UnassignedTab() {
  return (
    <div className="vstack" style={{ gap: 16 }}>
      <UnassignedTipsPanel />
      <DeferredTipsPanel />
    </div>
  );
}
