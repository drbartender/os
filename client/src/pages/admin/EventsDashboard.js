import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import NumberStepper from '../../components/NumberStepper';
import ConfirmModal from '../../components/ConfirmModal';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import StaffPills from '../../components/adminos/StaffPills';
import ClickableRow from '../../components/ClickableRow';
import RowLink from '../../components/RowLink';
import Toolbar from '../../components/adminos/Toolbar';
import KebabMenu from '../../components/adminos/KebabMenu';
import useDrawerParam, { drawerHref } from '../../hooks/useDrawerParam';
import useUrlListState from '../../hooks/useUrlListState';
import EntityLink from '../../components/EntityLink';
import ShiftDrawer from '../../components/adminos/drawers/ShiftDrawer';
import InvoicesDrawer from '../../components/adminos/drawers/InvoicesDrawer';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';
import { shiftPositions, parsePositionsCount, approvedCount, eventStatusChip, remainingByRole, SHIFT_EQUIPMENT_OPTIONS, parseEquipmentArray } from '../../components/adminos/shifts';
import { ROLES } from '../../utils/staffingRoles';

const TIME_SLOTS = [];
for (let h = 6; h < 24; h++) {
  for (let m = 0; m < 60; m += 30) {
    const hh = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const mm = m === 0 ? '00' : '30';
    TIME_SLOTS.push(`${hh}:${mm} ${ampm}`);
  }
}

// Per-role roster counts on the create form. The positions_needed array sent to
// the server is built from these (NOT a flat Array(n).fill('Bartender')), so a
// manual event can request banquet servers and barbacks too. Order here is the
// display + slot-build order (bartenders first, then servers, then barbacks).
const ROSTER_ROLES = [ROLES.BARTENDER, ROLES.BANQUET_SERVER, ROLES.BARBACK];

// URL-backed view state (tab / status filter). Kept at module scope so
// the hook's default identity is stable. Back restores the exact list view.
const LIST_DEFAULTS = { tab: 'upcoming', status: '' };
const EVENT_TABS = ['upcoming', 'unstaffed', 'past', 'all'];

const EMPTY_FORM = {
  client_name: '', client_email: '', client_phone: '',
  event_date: '', start_time: '', end_time: '', event_duration_hours: '',
  location: '', guest_count: '',
  // Per-role headcount. Defaults to one bartender (the common manual event).
  roster: { [ROLES.BARTENDER]: 1, [ROLES.BANQUET_SERVER]: 0, [ROLES.BARBACK]: 0 },
  // Token array consumed by the auto-assign equipment scorer. Defaults empty
  // (= no gear requirement, scorer awards full equipment credit to everyone).
  equipment_required: [],
};

// Builds the positions_needed array (one canonical label per slot) from the
// per-role roster counts, in display order.
function buildPositionsFromRoster(roster) {
  const out = [];
  for (const role of ROSTER_ROLES) {
    const n = Math.max(0, parseInt(roster?.[role], 10) || 0);
    for (let i = 0; i < n; i++) out.push(role);
  }
  return out;
}

export default function EventsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const drawer = useDrawerParam();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const tab = EVENT_TABS.includes(listState.tab) ? listState.tab : 'upcoming';
  const statusFilter = listState.status;
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [reminderTarget, setReminderTarget] = useState(null);
  const [sendingReminder, setSendingReminder] = useState(false);

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

  const handleField = (field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[field];
        return next;
      });
    }
  };

  // Update a single role's headcount in the roster.
  const setRosterCount = (role, value) => {
    setForm(f => ({ ...f, roster: { ...f.roster, [role]: value } }));
    if (fieldErrors.positions_needed) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next.positions_needed;
        return next;
      });
    }
  };

  // Add/remove an equipment token from form.equipment_required. parseEquipmentArray
  // keeps this correct whether the field holds the array default or a JSON-string
  // seed (edit-existing case).
  const toggleEquipment = (token, checked) => {
    setForm(f => {
      const current = parseEquipmentArray(f.equipment_required);
      const next = checked
        ? (current.includes(token) ? current : [...current, token])
        : current.filter(t => t !== token);
      return { ...f, equipment_required: next };
    });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    setFieldErrors({});
    if (!form.event_date) {
      setFieldErrors({ event_date: 'Event date is required.' });
      return;
    }
    const positions = buildPositionsFromRoster(form.roster);
    if (positions.length === 0) {
      setFieldErrors({ positions_needed: 'Add at least one staff position.' });
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/shifts', {
        client_name: form.client_name,
        client_email: form.client_email,
        client_phone: form.client_phone,
        event_date: form.event_date,
        start_time: form.start_time,
        end_time: form.end_time,
        event_duration_hours: form.event_duration_hours || null,
        location: form.location,
        guest_count: form.guest_count || null,
        positions_needed: positions,
        // Send as a plain token array — POST /shifts JSON.stringifies it server
        // side (server/routes/shifts.js). parseEquipmentArray tolerates either
        // an array (the form default) or a JSON-string seed (edit-existing).
        equipment_required: parseEquipmentArray(form.equipment_required),
      });
      toast.success('Event created.');
      setForm(EMPTY_FORM);
      setShowCreateForm(false);
      const newShift = res.data;
      navigate(`/events/${newShift.proposal_id}`);
    } catch (err) {
      setCreateError(err.message || 'Failed to create event.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setCreating(false);
    }
  };

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
    return events
      .filter(e => {
        const day = e.event_date ? dayDiff(e.event_date.slice(0, 10)) : null;
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
      .sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));
  }, [events, tab, statusFilter]);

  // Tab badge counts are independent of the active tab/filter — keying
  // them only on `events` keeps them from recomputing on every list-state change.
  const { upcomingCount, unstaffedCount } = useMemo(() => {
    let upcoming = 0;
    let unstaffed = 0;
    for (const e of events) {
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
          <div className="page-subtitle">Every confirmed and manually-created event. Staffing and financials in one row.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowCreateForm(v => !v)}>
            <Icon name={showCreateForm ? 'x' : 'plus'} />{showCreateForm ? 'Cancel' : 'New event'}
          </button>
        </div>
      </div>

      {showCreateForm && (
        <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: 'var(--gap)' }}>
          <div className="section-title" style={{ margin: 0, marginBottom: 12 }}>New event</div>
          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.85rem' }}>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Client name</div>
                <input className="input" value={form.client_name} onChange={e => handleField('client_name', e.target.value)} aria-invalid={!!fieldErrors?.client_name} />
                <FieldError error={fieldErrors?.client_name} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Client email</div>
                <input className="input" type="email" value={form.client_email} onChange={e => handleField('client_email', e.target.value)} aria-invalid={!!fieldErrors?.client_email} />
                <FieldError error={fieldErrors?.client_email} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Client phone</div>
                <input className="input" value={form.client_phone} onChange={e => handleField('client_phone', e.target.value)} aria-invalid={!!fieldErrors?.client_phone} />
                <FieldError error={fieldErrors?.client_phone} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Event date *</div>
                <input className="input" type="date" required value={form.event_date} onChange={e => handleField('event_date', e.target.value)} aria-invalid={!!fieldErrors?.event_date} />
                <FieldError error={fieldErrors?.event_date} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Start time</div>
                <select className="select" value={form.start_time} onChange={e => handleField('start_time', e.target.value)}>
                  <option value="">Select…</option>
                  {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <FieldError error={fieldErrors?.start_time} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>End time</div>
                <select className="select" value={form.end_time} onChange={e => handleField('end_time', e.target.value)}>
                  <option value="">Select…</option>
                  {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <FieldError error={fieldErrors?.end_time} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Duration (hours)</div>
                <NumberStepper className="input" step={0.5} min={0.5}
                  value={form.event_duration_hours}
                  onChange={v => handleField('event_duration_hours', v)}
                  ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration" />
                <FieldError error={fieldErrors?.event_duration_hours} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Location</div>
                <input className="input" value={form.location} onChange={e => handleField('location', e.target.value)} />
                <FieldError error={fieldErrors?.location} />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Guest count</div>
                <input className="input" type="number" min="1" value={form.guest_count} onChange={e => handleField('guest_count', e.target.value)} />
                <FieldError error={fieldErrors?.guest_count} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="meta-k" style={{ marginBottom: 4 }}>Staffing roster</div>
                <div className="hstack" style={{ flexWrap: 'wrap', gap: 16 }}>
                  {ROSTER_ROLES.map(role => (
                    <label key={role} className="hstack" style={{ gap: 6, fontSize: 13 }}>
                      <span style={{ minWidth: 110 }}>{role}</span>
                      <input
                        className="input"
                        style={{ width: 72 }}
                        type="number"
                        min="0"
                        value={form.roster[role]}
                        onChange={e => setRosterCount(role, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <FieldError error={fieldErrors?.positions_needed} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="meta-k" style={{ marginBottom: 4 }}>Equipment required</div>
                <div className="hstack" style={{ flexWrap: 'wrap', gap: 16 }}>
                  {SHIFT_EQUIPMENT_OPTIONS.map(([token, label]) => {
                    const selected = parseEquipmentArray(form.equipment_required);
                    return (
                      <label key={token} className="hstack" style={{ gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(token)}
                          onChange={e => toggleEquipment(token, e.target.checked)}
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
                <div className="muted tiny" style={{ marginTop: 4 }}>
                  Used to prioritize bartenders who own this gear during auto-assign.
                </div>
              </div>
            </div>
            <FormBanner error={createError} fieldErrors={fieldErrors} />
            <div className="hstack" style={{ marginTop: 14, gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create event'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => { setShowCreateForm(false); setForm(EMPTY_FORM); setCreateError(''); setFieldErrors({}); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

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
                <th>Event</th>
                <th>Date</th>
                <th>Location</th>
                <th className="num">Guests</th>
                <th>Staffing</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Balance</th>
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

      <ConfirmModal
        isOpen={!!reminderTarget}
        title="Send payment reminder?"
        message={`Send a payment reminder to ${reminderTarget?.client_name || 'the client'}? They'll get an email with a link to pay the balance.`}
        onCancel={() => { if (!sendingReminder) setReminderTarget(null); }}
        onConfirm={async () => {
          if (!reminderTarget?.proposal_id) {
            setReminderTarget(null);
            return;
          }
          setSendingReminder(true);
          try {
            await api.post(`/proposals/${reminderTarget.proposal_id}/send-reminder`);
            toast.success('Reminder sent.');
            setReminderTarget(null);
          } catch (err) {
            toast.error(err?.message || 'Failed to send reminder.');
          } finally {
            setSendingReminder(false);
          }
        }}
      />
    </div>
  );
}

// Memoized row — only re-renders when its event reference changes. Dispatch is
// a stable callback from the parent, so list-state changes no longer rebuild
// 5 closures × N rows.
const EventRow = React.memo(function EventRow({ event: e, dispatch }) {
  const [searchParams] = useSearchParams();
  const total = Number(e.proposal_total || 0);
  const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
  const bal = total - paid;
  const guestCount = e.guest_count || e.proposal_guest_count;
  const fullyPaid = total > 0 && paid >= total;

  // Pending requests beyond the open slots are effectively a waitlist. The admin
  // /shifts feed carries request_count + approved_count (not a per-role waitlist),
  // so this is the count of requests that cannot fill an open slot.
  const remaining = remainingByRole(e);
  const openSlots = Object.values(remaining).reduce((sum, n) => sum + Math.max(0, n), 0);
  // A roster-less legacy row yields remaining {} (openSlots 0), which would count
  // every normal pending request as waitlisted. Without a roster we cannot classify
  // a waitlist, so report none rather than over-report.
  const waitlistCount = Object.keys(remaining).length === 0
    ? 0
    : Math.max(0, Number(e.request_count || 0) - approvedCount(e) - openSlots);

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
        <div className="sub">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}{!e.proposal_id && ' · Manual'}</div>
      </td>
      <td>
        <div>{fmtDate(e.event_date && e.event_date.slice(0, 10))}</div>
        <div className="sub">{e.event_date ? `${relDay(e.event_date.slice(0, 10))}${e.start_time ? ' · ' + e.start_time : ''}` : '—'}</div>
      </td>
      <td className="muted">{(typeof e.location === 'string' && e.location.trim()) || '—'}</td>
      <td className="num">{guestCount || '—'}</td>
      <td>
        <div className="vstack" style={{ gap: 4, alignItems: 'flex-start' }}>
          <StaffPills positions={shiftPositions(e)} />
          {waitlistCount > 0 && (
            <StatusChip kind="neutral">{waitlistCount} on waitlist</StatusChip>
          )}
        </div>
      </td>
      <td>{e.proposal_id ? eventStatusChip(e) : <StatusChip kind="neutral">Manual</StatusChip>}</td>
      <td className="num">{total > 0 ? <strong>{fmt$(total)}</strong> : '—'}</td>
      <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
        {bal > 0 ? fmt$(bal) : '—'}
      </td>
      <td className="shrink" onMouseUp={(ev) => ev.stopPropagation()}>
        <KebabMenu items={kebabItems} />
      </td>
    </ClickableRow>
  );
});
