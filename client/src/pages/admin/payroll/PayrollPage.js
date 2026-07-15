import React from 'react';
import { useNavigate } from 'react-router-dom';
import useUrlListState from '../../../hooks/useUrlListState';
import PayRunView from './PayRunView';
import HistoryView from './HistoryView';
import UnassignedTipsPanel from './UnassignedTipsPanel';
import DeferredTipsPanel from './DeferredTipsPanel';
import TaxTotalsTab from './TaxTotalsTab';

const TABS = [
  { id: 'payrun', label: 'Pay run' },
  { id: 'history', label: 'History' },
  { id: 'tips', label: 'Tips repair' },
  { id: 'tax', label: '1099 / tax' },
];
const TAB_IDS = TABS.map(t => t.id);
// Pre-redesign tab ids remap on read so old bookmarks and deep links keep
// working (the payroll redesign renamed the tabs); writes use the new ids.
const LEGACY_TAB_REMAP = { current: 'payrun', unassigned: 'tips' };
const PAYROLL_DEFAULTS = { tab: 'payrun', period: '' };

export default function PayrollPage() {
  const [listState, setListState] = useUrlListState(PAYROLL_DEFAULTS);
  const mappedTab = LEGACY_TAB_REMAP[listState.tab] || listState.tab;
  const tab = TAB_IDS.includes(mappedTab) ? mappedTab : 'payrun';
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Payroll</div>
          <div className="page-subtitle">Weekly pay run, history, and tip repair.</div>
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
            // Clear the period param on tab clicks: both Pay run and History
            // consume it, and a stale non-paid id would bounce History right
            // back to Pay run. Deep links set the param directly in the URL.
            onClick={() => setListState({ tab: t.id, period: '' })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'payrun' && <PayRunView periodParam={listState.period} />}
      {tab === 'history' && <HistoryView periodParam={listState.period} />}
      {tab === 'tips' && (
        <div className="vstack" style={{ gap: 16 }}>
          <UnassignedTipsPanel />
          <DeferredTipsPanel />
        </div>
      )}
      {tab === 'tax' && <TaxTotalsTab />}
    </div>
  );
}
