import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import NumberStepper from '../../components/NumberStepper';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import StaffPills from '../../components/adminos/StaffPills';
import Toolbar from '../../components/adminos/Toolbar';
import useDrawerParam from '../../hooks/useDrawerParam';
import EventDrawer from '../../components/adminos/drawers/EventDrawer';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';
import { shiftPositions, parsePositionsCount, approvedCount, eventStatusChip } from '../../components/adminos/shifts';

const TIME_SLOTS = [];
for (let h = 6; h < 24; h++) {
  for (let m = 0; m < 60; m += 30) {
    const hh = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const mm = m === 0 ? '00' : '30';
    TIME_SLOTS.push(`${hh}:${mm} ${ampm}`);
  }
}

const EMPTY_FORM = {
  client_name: '', client_email: '', client_phone: '',
  event_date: '', start_time: '', end_time: '', event_duration_hours: '',
  location: '', guest_count: '', positions_needed: 1,
};

export default function EventsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const drawer = useDrawerParam();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('upcoming');
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.get('/shifts');
      setEvents(res.data || []);
    } catch (err) {
      toast.error('Failed to load events — try refreshing.');
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

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    setFieldErrors({});
    if (!form.event_date) {
      setFieldErrors({ event_date: 'Event date is required.' });
      return;
    }
    setCreating(true);
    try {
      const posCount = parseInt(form.positions_needed, 10) || 1;
      const positions = Array.from({ length: posCount }, () => 'Bartender');
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
      });
      toast.success('Event created.');
      setForm(EMPTY_FORM);
      setShowCreateForm(false);
      const newShift = res.data;
      if (newShift.proposal_id) {
        navigate(`/admin/events/${newShift.proposal_id}`);
      } else {
        navigate(`/admin/events/shift/${newShift.id}`);
      }
    } catch (err) {
      setCreateError(err.message || 'Failed to create event.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setCreating(false);
    }
  };

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
        if (search) {
          const q = search.toLowerCase();
          const fields = [e.client_name, e.client_email, e.location].filter(Boolean).join(' ').toLowerCase();
          if (!fields.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));
  }, [events, tab, statusFilter, search]);

  const tabs = useMemo(() => {
    const upcomingCount = events.filter(e => e.event_date && dayDiff(e.event_date.slice(0, 10)) >= 0).length;
    const unstaffedCount = events.filter(e => {
      if (!e.event_date || dayDiff(e.event_date.slice(0, 10)) < 0) return false;
      return approvedCount(e) < parsePositionsCount(e);
    }).length;
    return [
      { id: 'upcoming',  label: 'Upcoming',  count: upcomingCount },
      { id: 'unstaffed', label: 'Unstaffed', count: unstaffedCount },
      { id: 'past',      label: 'Past' },
      { id: 'all',       label: 'All' },
    ];
  }, [events]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Events</div>
          <div className="page-subtitle">Every confirmed and manually-created event — staffing and financials in one row.</div>
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
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Positions needed</div>
                <input className="input" type="number" min="1" value={form.positions_needed} onChange={e => handleField('positions_needed', e.target.value)} />
                <FieldError error={fieldErrors?.positions_needed} />
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
        search={search}
        setSearch={setSearch}
        tabs={tabs}
        tab={tab}
        setTab={setTab}
        filters={(
          <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ minWidth: 160 }}>
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
              {!loading && filtered.map(e => {
                const total = Number(e.proposal_total || 0);
                const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
                const bal = total - paid;
                const guestCount = e.guest_count || e.proposal_guest_count;
                return (
                  <tr key={e.id} onClick={() => drawer.open('event', e.id)}>
                    <td>
                      <strong>{e.client_name || 'Event'}</strong>
                      <div className="sub">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}{!e.proposal_id && ' · Manual'}</div>
                    </td>
                    <td>
                      <div>{fmtDate(e.event_date && e.event_date.slice(0, 10))}</div>
                      <div className="sub">{e.event_date ? `${relDay(e.event_date.slice(0, 10))}${e.start_time ? ' · ' + e.start_time : ''}` : '—'}</div>
                    </td>
                    <td className="muted">{e.location || '—'}</td>
                    <td className="num">{guestCount || '—'}</td>
                    <td><StaffPills positions={shiftPositions(e)} /></td>
                    <td>{e.proposal_id ? eventStatusChip(e) : <StatusChip kind="neutral">Manual</StatusChip>}</td>
                    <td className="num">{total > 0 ? <strong>{fmt$(total)}</strong> : '—'}</td>
                    <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                      {bal > 0 ? fmt$(bal) : '—'}
                    </td>
                    <td className="shrink"><button type="button" className="icon-btn" onClick={(ev) => ev.stopPropagation()} title="More"><Icon name="kebab" size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {filtered.length} {filtered.length === 1 ? 'event' : 'events'} · Click a row to peek
        </div>
      )}

      <EventDrawer
        id={drawer.kind === 'event' ? drawer.id : null}
        open={drawer.kind === 'event'}
        onClose={drawer.close}
      />
    </div>
  );
}
