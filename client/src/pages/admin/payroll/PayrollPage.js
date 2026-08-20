import React from 'react';
import { useOutletContext } from 'react-router-dom';
import useUrlListState from '../../../hooks/useUrlListState';
import Toolbar from '../../../components/adminos/Toolbar';
import StatusChip from '../../../components/adminos/StatusChip';
import PayRunView from './PayRunView';
import HistoryView from './HistoryView';
import UnassignedTipsPanel from './UnassignedTipsPanel';
import DeferredTipsPanel from './DeferredTipsPanel';
import TipsLedger from './TipsLedger';
import TaxTotalsTab from './TaxTotalsTab';

// Payroll is a child of the Staff hub (spec 2026-08-19 §7). The hub owns the
// page header; this page owns its views as .seg pills in the toolbar (two
// vocabularies: underline above, pills below, never the same strip twice).
const TABS = [
  { id: 'payrun', label: 'Pay run' },
  { id: 'history', label: 'History' },
  { id: 'tips', label: 'Tips' },
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
  // The hub shares its summary through Outlet context; a bare render outside
  // the hub (a test) has none, so tolerate null.
  const { summary, refresh } = useOutletContext() || {};

  return (
    <>
      <Toolbar
        tabs={TABS}
        tab={tab}
        // Clear the period param on tab clicks: both Pay run and History
        // consume it, and a stale non-paid id would bounce History right
        // back to Pay run. Deep links set the param directly in the URL.
        setTab={(t) => setListState({ tab: t, period: '' })}
      />

      {tab === 'payrun' && (
        <PayRunView
          periodParam={listState.period}
          openPeriod={summary?.open_period || null}
          pendingReviews={summary?.pending_reviews ?? 0}
          onChanged={refresh}
        />
      )}
      {tab === 'history' && <HistoryView periodParam={listState.period} />}
      {tab === 'tips' && <TipsTab />}
      {tab === 'tax' && <TaxTotalsTab />}
    </>
  );
}

// Repair, then ledger, then context. Both repair panels report their count so
// an empty pair collapses to one clear line and the ledger is the page. A
// panel that failed to load reports nothing, so a broken read never reads as
// "clear".
function TipsTab() {
  const [counts, setCounts] = React.useState({ unassigned: null, deferred: null });
  const bothClear = counts.unassigned === 0 && counts.deferred === 0;
  return (
    <div className="vstack" style={{ gap: 16 }}>
      {bothClear && (
        <div className="card card-flush">
          <div className="card-body hstack" style={{ gap: 10, padding: '10px 16px' }}>
            <StatusChip kind="ok">clear</StatusChip>
            <span style={{ fontSize: 12.5 }}>Repair queues are clear: no unassigned tips, nothing deferred.</span>
            <div className="spacer" />
            <span className="muted tiny">Unassigned appear when a tip can't find its event · deferred wait for an open period</span>
          </div>
        </div>
      )}
      <UnassignedTipsPanel hideWhenEmpty onCount={(n) => setCounts(c => (c.unassigned === n ? c : { ...c, unassigned: n }))} />
      <DeferredTipsPanel hideWhenEmpty onCount={(n) => setCounts(c => (c.deferred === n ? c : { ...c, deferred: n }))} />
      {/* The footer sentence lives inside the ledger's Activity card (artboard
          1g), so it is TipsLedger's to render, not this tab's. */}
      <TipsLedger />
    </div>
  );
}
