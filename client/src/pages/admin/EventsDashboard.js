import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import SendModal, { describeSendResult } from '../../components/SendModal';
import StatusChip from '../../components/adminos/StatusChip';
import StaffingCell from '../../components/adminos/StaffingCell';
import ClickableRow from '../../components/ClickableRow';
import RowLink from '../../components/RowLink';
import Toolbar from '../../components/adminos/Toolbar';
import KebabMenu from '../../components/adminos/KebabMenu';
import SortableTh from '../../components/adminos/SortableTh';
import useDrawerParam, { drawerHref } from '../../hooks/useDrawerParam';
import useUrlListState from '../../hooks/useUrlListState';
import EntityLink from '../../components/EntityLink';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import InvoicesDrawer from '../../components/adminos/drawers/InvoicesDrawer';
import { fmtDate, fmtTimeRange24, dayDiff } from '../../components/adminos/format';
import { parsePositionsCount, approvedCount, isCancelledEvent } from '../../components/adminos/shifts';
import { eventPlanState, eventPaymentState } from '../../components/adminos/eventPlan';

// URL-backed view state (tab / status filter). Kept at module scope so
// the hook's default identity is stable. Back restores the exact list view.
const LIST_DEFAULTS = { tab: 'upcoming', status: '' };
const EVENT_TABS = ['upcoming', 'unstaffed', 'past', 'all'];

// Sort accessors, one per sortable column. Text/date accessors return '' when
// missing so the comparator can push blanks to the bottom; numeric accessors
// return a number (missing => 0).
//
// `status` sorts by MONEY OWED, not by proposal_status: the column stopped
// being a lifecycle label when Total and Balance were dropped, and the useful
// order is settled-first then smallest-debt-up. Cancelled and no-total rows
// return '' so they land at the bottom like any other blank.
//
// `plan` sorts by who is blocked, your queue first, because the column exists
// to answer "what do I owe" before anything else.
const PLAN_SORT_RANK = { you: 0, client: 1, done: 2 };
const EVENT_SORT_ACCESSORS = {
  event: e => (e.client_name || '').toLowerCase(),
  event_date: e => (e.event_date ? e.event_date.slice(0, 10) : ''),
  location: e => (typeof e.location === 'string' ? e.location.trim().toLowerCase() : ''),
  guests: e => Number(e.guest_count || e.proposal_guest_count || 0),
  plan: e => PLAN_SORT_RANK[eventPlanState(e).owner] ?? 3,
  status: e => {
    const s = eventPaymentState(e);
    if (s.kind === 'paid') return 0;
    if (s.kind === 'owed') return Number(e.proposal_total || 0) - Number(e.proposal_amount_paid || e.amount_paid || 0);
    return '';
  },
};

export default function EventsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const drawer = useDrawerParam();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const tab = EVENT_TABS.includes(listState.tab) ? listState.tab : 'upcoming';
  const statusFilter = listState.status;
  // Ephemeral sort (not URL-persisted): reverts to the default event-date sort
  // on navigation. First click asc, second flips desc, new column resets asc.
  const [sort, setSort] = useState({ key: 'event_date', dir: 'asc' });
  const onSort = useCallback((key) => {
    setSort(prev => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
  }, []);
  const [reminderTarget, setReminderTarget] = useState(null);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.get('/shifts');
      setEvents(res.data || []);
    } catch (err) {
      toast.error('Failed to load events. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // Ref-backed dispatcher: row/kebab callbacks need access to the latest
  // navigate / drawer / toast / setReminderTarget closures, but EventRow only
  // re-renders when its props change. Storing the closures in a ref and exposing
  // a single stable `dispatch` lets us memoize EventRow without re-binding on
  // every parent render (e.g. list-state changes).
  const handlersRef = useRef(null);
  handlersRef.current = {
    rowClick: (e) => {
      if (e.proposal_id) navigate(`/events/${e.proposal_id}`);
      else drawer.open('shift', e.id);
    },
    assign: (e) => {
      if (!e.id) { toast.error('No shift on this event yet.'); return; }
      drawer.open('shift', e.id);
    },
    remind: (e) => setReminderTarget(e),
    invoices: (e) => {
      if (e.proposal_id) drawer.open('invoices', e.proposal_id);
    },
  };
  const dispatch = useCallback((action, e) => {
    handlersRef.current?.[action]?.(e);
  }, []);

  const filtered = useMemo(() => {
    const acc = EVENT_SORT_ACCESSORS[sort.key] || EVENT_SORT_ACCESSORS.event_date;
    const cmp = (a, b) => {
      const va = acc(a), vb = acc(b);
      const aBlank = va === '' || va == null;
      const bBlank = vb === '' || vb == null;
      if (aBlank && bBlank) return a.id - b.id;      // both blank: stable by id
      if (aBlank) return 1;                          // blanks last, either direction
      if (bBlank) return -1;
      let r = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb
        : String(va).localeCompare(String(vb));
      if (r === 0) return a.id - b.id;               // stable tiebreak, unsigned
      return sort.dir === 'asc' ? r : -r;            // flip only the value compare
    };
    return events
      .filter(e => {
        const day = e.event_date ? dayDiff(e.event_date.slice(0, 10)) : null;
        // A cancelled event is not upcoming work and can never need staffing.
        // Past / All still show it — that is the history this feed exists for.
        if ((tab === 'upcoming' || tab === 'unstaffed') && isCancelledEvent(e)) return false;
        if (tab === 'upcoming' && day != null && day < 0) return false;
        if (tab === 'past' && day != null && day >= 0) return false;
        if (tab === 'unstaffed') {
          if (day != null && day < 0) return false;
          if (approvedCount(e) >= parsePositionsCount(e)) return false;
        }
        // "Contract pending" — proposal still out for signature (sent/viewed/modified).
        // Manual events (no proposal) and paid/confirmed events (already signed) are excluded.
        if (statusFilter === 'contract' && !['sent', 'viewed', 'modified'].includes(e.proposal_status)) return false;
        if (statusFilter === 'payment') {
          const total = Number(e.proposal_total || 0);
          const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
          if (total > 0 && paid >= total) return false;
        }
        return true;
      })
      .sort(cmp);
  }, [events, tab, statusFilter, sort]);

  // Tab badge counts are independent of the active tab/filter — keying
  // them only on `events` keeps them from recomputing on every list-state change.
  const { upcomingCount, unstaffedCount } = useMemo(() => {
    let upcoming = 0;
    let unstaffed = 0;
    for (const e of events) {
      // Same exclusion the Upcoming/Unstaffed tab bodies apply, so the badge
      // never counts a row the tab won't render.
      if (isCancelledEvent(e)) continue;
      const dayKey = e.event_date ? e.event_date.slice(0, 10) : null;
      if (!dayKey) continue;
      const day = dayDiff(dayKey);
      if (day < 0) continue;
      upcoming++;
      if (approvedCount(e) < parsePositionsCount(e)) unstaffed++;
    }
    return { upcomingCount: upcoming, unstaffedCount: unstaffed };
  }, [events]);

  const tabs = useMemo(() => [
    { id: 'upcoming',  label: 'Upcoming',  count: upcomingCount },
    { id: 'unstaffed', label: 'Unstaffed', count: unstaffedCount },
    { id: 'past',      label: 'Past' },
    { id: 'all',       label: 'All' },
  ], [upcomingCount, unstaffedCount]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Events</div>
          <div className="page-subtitle">Every confirmed event. Staffing and financials in one row.</div>
        </div>
      </div>

      <Toolbar
        tabs={tabs}
        tab={tab}
        setTab={(v) => setListState({ tab: v })}
        filters={(
          <select className="select" value={statusFilter} onChange={e => setListState({ status: e.target.value })} style={{ minWidth: 160 }}>
            <option value="">All statuses</option>
            <option value="contract">Contract pending</option>
            <option value="payment">Balance due</option>
          </select>
        )}
      />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <SortableTh label="Event" sortKey="event" sort={sort} onSort={onSort} />
                <SortableTh label="Date" sortKey="event_date" sort={sort} onSort={onSort} />
                <SortableTh label="Location" sortKey="location" sort={sort} onSort={onSort} />
                <SortableTh label="Guests" sortKey="guests" sort={sort} onSort={onSort} className="num" />
                <th>Staffing</th>
                <SortableTh label="Plan" sortKey="plan" sort={sort} onSort={onSort} />
                <th>Prep</th>
                <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="muted">Loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={9} className="muted">No events match these filters.</td></tr>
              )}
              {!loading && filtered.map(e => (
                <EventRow key={e.id} event={e} dispatch={dispatch} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {filtered.length} {filtered.length === 1 ? 'event' : 'events'} · Click a row to open
        </div>
      )}

      <ShiftDrawer
        open={drawer.kind === 'shift' && !!drawer.id}
        shiftId={drawer.kind === 'shift' && drawer.id ? Number(drawer.id) : null}
        onClose={drawer.close}
      />

      <InvoicesDrawer
        open={drawer.kind === 'invoices' && !!drawer.id}
        proposalId={drawer.kind === 'invoices' && drawer.id ? Number(drawer.id) : null}
        onClose={drawer.close}
      />

      {/* Compose-first balance reminder: SendModal previews the server-resolved
          recipient/channels, the admin edits and confirms, and onComplete reports
          the honest per-channel result. Only rendered for events with a proposal. */}
      {reminderTarget?.proposal_id && (
        <SendModal
          action="payment_reminder"
          entityId={reminderTarget.proposal_id}
          title="Send Balance Reminder"
          confirmLabel="Send Reminder"
          onClose={() => setReminderTarget(null)}
          onComplete={(results) => {
            const { hadFailure, message } = describeSendResult(results);
            if (hadFailure) toast.error(message);
            else toast.success(message);
          }}
        />
      )}
    </div>
  );
}

// Memoized row — only re-renders when its event reference changes. Dispatch is
// a stable callback from the parent, so list-state changes no longer rebuild
// 5 closures × N rows.
// Plan-cell chip colours carry the OWNER, the text carries what is owed:
// grey = the ball is in the client's court, amber = yours, green = settled.
const PLAN_CHIP_KIND = { client: 'neutral', you: 'warn', done: 'ok' };
const PAY_CHIP_KIND = { paid: 'ok', owed: 'danger', cancelled: 'neutral' };

// Bar and Supplies are FACTS about the event, not alarms, so they stay quiet
// and dotless rather than competing with the Plan column's amber.
function PrepCell({ event: e }) {
  const tags = [];
  if (e.bar_required) tags.push('Bar');
  if (e.supply_run_required) tags.push('Supplies');
  if (!tags.length) return <span className="muted">—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {tags.map(t => <StatusChip key={t} kind="neutral" dot={false}>{t}</StatusChip>)}
    </div>
  );
}

// Stacked rather than side by side: both deliverables unlock the moment the
// planner or consult input lands, so "owes both" is the normal state and the
// column has to stay narrow enough to live beside Staffing.
function PlanCell({ event: e }) {
  const { owner, tags } = eventPlanState(e);
  if (!owner) return <span className="muted">—</span>;
  if (owner === 'done') return <StatusChip kind="ok">Done</StatusChip>;
  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
      {tags.map(t => <StatusChip key={t} kind={PLAN_CHIP_KIND[owner]}>{t}</StatusChip>)}
    </div>
  );
}

const EventRow = React.memo(function EventRow({ event: e, dispatch }) {
  const [searchParams] = useSearchParams();
  const guestCount = e.guest_count || e.proposal_guest_count;
  const pay = eventPaymentState(e);
  const fullyPaid = pay.kind === 'paid';

  // The package name earns a place only when it changes how the event runs.
  // BYOB is ~9 in 10 bookings, so printing it on every row is wallpaper; a name
  // here means hosted, which brings an included bar and a 1:100 staffing ratio.
  const typeLabel = getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom });
  const subline = [typeLabel, e.package_category === 'hosted' ? e.package_name : null]
    .filter(Boolean).join(' · ');

  // fmtDate is month+day only, which put three real 2027 bookings shoulder to
  // shoulder with next month's. Show the year only when it is not this one, so
  // the common row stays short.
  const ymd = e.event_date ? e.event_date.slice(0, 10) : null;
  const dateOpts = ymd && ymd.slice(0, 4) !== String(new Date().getFullYear())
    ? { year: 'numeric' }
    : undefined;

  const kebabItems = useMemo(() => [
    {
      label: 'Assign Staff',
      icon: 'users',
      onClick: () => dispatch('assign', e),
    },
    {
      label: 'Send Payment Reminder',
      icon: 'mail',
      disabled: !e.proposal_id || fullyPaid,
      onClick: () => dispatch('remind', e),
    },
    {
      label: 'View Invoices/Payments',
      icon: 'card',
      disabled: !e.proposal_id,
      onClick: () => dispatch('invoices', e),
    },
  ], [e, dispatch, fullyPaid]);

  return (
    <ClickableRow onActivate={() => dispatch('rowClick', e)}>
      <td>
        {e.proposal_id
          ? <RowLink to={`/events/${e.proposal_id}`}><strong>{e.client_name || 'Event'}</strong></RowLink>
          : <EntityLink to={drawerHref(searchParams, 'shift', e.id)}><strong>{e.client_name || 'Event'}</strong></EntityLink>}
        {subline && <div className="sub">{subline}</div>}
      </td>
      <td>
        <div>{fmtDate(ymd, dateOpts)}</div>
        <div className="sub">{e.start_time ? fmtTimeRange24(e.start_time, e.end_time, e.event_duration_hours) : '—'}</div>
      </td>
      <td className="muted">{(typeof e.location === 'string' && e.location.trim()) || '—'}</td>
      <td className="num">{guestCount || '—'}</td>
      <td><StaffingCell event={e} /></td>
      <td><PlanCell event={e} /></td>
      <td><PrepCell event={e} /></td>
      <td>
        {pay.kind === 'none'
          ? <span className="muted">{pay.label}</span>
          : <StatusChip kind={PAY_CHIP_KIND[pay.kind]}>{pay.label}</StatusChip>}
      </td>
      <td className="shrink" onMouseUp={(ev) => ev.stopPropagation()}>
        <KebabMenu items={kebabItems} />
      </td>
    </ClickableRow>
  );
});
