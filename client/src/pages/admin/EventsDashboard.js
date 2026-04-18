import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone } from '../../utils/formatPhone';
import { getEventTypeLabel } from '../../utils/eventTypes';

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
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('upcoming');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.get('/shifts');
      setEvents(res.data);
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const fmtDate = (iso) => {
    if (!iso) return '\u2014';
    const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '\u2014';
    return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handleField = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.event_date) {
      setCreateError('Event date is required.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      // Build positions_needed as an array of N "Bartender" entries
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
      setForm(EMPTY_FORM);
      setShowCreateForm(false);
      // Navigate directly to the new event detail page
      const newShift = res.data;
      if (newShift.proposal_id) {
        navigate(`/admin/events/${newShift.proposal_id}`);
      } else {
        navigate(`/admin/events/shift/${newShift.id}`);
      }
    } catch (err) {
      setCreateError(err.response?.data?.error || 'Failed to create event.');
    } finally {
      setCreating(false);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const filtered = events.filter(e => {
    if (filter === 'upcoming' && e.event_date && e.event_date.slice(0, 10) < today) return false;
    if (filter === 'past' && e.event_date && e.event_date.slice(0, 10) >= today) return false;
    if (search) {
      const q = search.toLowerCase();
      const fields = [e.client_name, e.client_email, e.location].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.2rem' }}>Events</h1>
          <p className="text-muted text-small">All confirmed and manually created events</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreateForm(!showCreateForm)}>
          {showCreateForm ? 'Cancel' : '+ Create Event'}
        </button>
      </div>

      {/* Create Event Form */}
      {showCreateForm && (
        <div className="card mb-2" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>Create Event</h3>

          {/* Warning banners */}
          <div style={{
            background: '#fef3cd', border: '1px solid #ffc107', borderRadius: '8px',
            padding: '0.75rem 1rem', marginBottom: '0.75rem', fontSize: '0.85rem', color: '#856404',
          }}>
            No signed contract on file for this event.
          </div>
          <div style={{
            background: '#fef3cd', border: '1px solid #ffc107', borderRadius: '8px',
            padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#856404',
          }}>
            No payment received for this event.
          </div>

          {createError && (
            <div style={{
              background: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: '8px',
              padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#721c24',
            }}>{createError}</div>
          )}

          <form onSubmit={handleCreate}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
              <div>
                <label className="form-label">Client Name</label>
                <input className="form-input" value={form.client_name} onChange={e => handleField('client_name', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Client Email</label>
                <input className="form-input" type="email" value={form.client_email} onChange={e => handleField('client_email', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Client Phone</label>
                <input className="form-input" value={form.client_phone} onChange={e => handleField('client_phone', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Event Date *</label>
                <input className="form-input" type="date" value={form.event_date} onChange={e => handleField('event_date', e.target.value)} required />
              </div>
              <div>
                <label className="form-label">Start Time</label>
                <select className="form-select" value={form.start_time} onChange={e => handleField('start_time', e.target.value)}>
                  <option value="">Select...</option>
                  {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">End Time</label>
                <select className="form-select" value={form.end_time} onChange={e => handleField('end_time', e.target.value)}>
                  <option value="">Select...</option>
                  {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Duration (hours)</label>
                <input className="form-input" type="number" step="0.5" min="0.5" value={form.event_duration_hours} onChange={e => handleField('event_duration_hours', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Location</label>
                <input className="form-input" value={form.location} onChange={e => handleField('location', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Guest Count</label>
                <input className="form-input" type="number" min="1" value={form.guest_count} onChange={e => handleField('guest_count', e.target.value)} />
              </div>
              <div>
                <label className="form-label">Positions Needed</label>
                <input className="form-input" type="number" min="1" value={form.positions_needed} onChange={e => handleField('positions_needed', e.target.value)} />
              </div>
            </div>
            <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-primary" type="submit" disabled={creating}>
                {creating ? 'Creating...' : 'Create Event'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => { setShowCreateForm(false); setForm(EMPTY_FORM); setCreateError(''); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="flex gap-1 mb-2" style={{ flexWrap: 'wrap' }}>
        <input
          className="form-input"
          style={{ maxWidth: '280px' }}
          placeholder="Search by event, client, or location..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="form-select"
          style={{ maxWidth: '160px' }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="all">All Events</option>
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <p className="text-muted">
            {events.length === 0
              ? 'No events yet. Create one or events are created automatically when a proposal deposit is paid.'
              : 'No events match your filters.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {filtered.map(event => {
            let positions = [];
            try { positions = JSON.parse(event.positions_needed || '[]').map(p => typeof p === 'string' ? p : p.position || 'Bartender'); } catch (e) {}
            const approvedCount = Number(event.approved_count) || 0;

            return (
              <div key={event.id} className="card card-clickable" style={{ padding: '1.25rem 1.5rem' }}
                onClick={() => navigate(event.proposal_id ? `/admin/events/${event.proposal_id}` : `/admin/events/shift/${event.id}`)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', color: 'var(--deep-brown)' }}>
                    <span className="event-title">{event.client_name || 'Event'}</span>
                    <span className="event-subtitle"> — {getEventTypeLabel({ event_type: event.event_type, event_type_custom: event.event_type_custom })}</span>
                  </strong>
                  <span className={`badge ${event.status === 'open' ? 'badge-approved' : event.status === 'filled' ? 'badge-reviewed' : 'badge-deactivated'}`}>
                    {event.status}
                  </span>
                  {!event.proposal_id && (
                    <span style={{
                      background: 'var(--warm-brown)', color: 'white', borderRadius: '99px',
                      padding: '0.1rem 0.5rem', fontSize: '0.72rem', fontWeight: 700,
                    }}>Manual</span>
                  )}
                  {Number(event.request_count) > 0 && (
                    <span style={{
                      background: 'var(--amber)', color: 'white', borderRadius: '99px',
                      padding: '0.1rem 0.5rem', fontSize: '0.72rem', fontWeight: 700,
                    }}>{event.request_count} request{event.request_count !== '1' ? 's' : ''}</span>
                  )}
                </div>

                <div style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--warm-brown)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <span>{fmtDate(event.event_date)}</span>
                  {(event.start_time || event.end_time) && (
                    <span>{event.start_time || '?'} – {event.end_time || '?'}</span>
                  )}
                  {event.location && <span>{event.location}</span>}
                </div>

                {event.client_name && (
                  <div style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    <strong>{event.client_name}</strong>
                    {event.client_phone && <span> &middot; {formatPhone(event.client_phone)}</span>}
                    {event.client_email && <span> &middot; {event.client_email}</span>}
                  </div>
                )}

                <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {positions.length > 0 && (
                    <span style={{
                      fontSize: '0.82rem', fontWeight: 600,
                      color: approvedCount >= positions.length ? 'var(--success)' : 'var(--warm-brown)',
                    }}>
                      {approvedCount}/{positions.length} Bartender{positions.length !== 1 ? 's' : ''} filled
                    </span>
                  )}
                  {event.proposal_total && (
                    <span style={{
                      fontSize: '0.8rem', color: 'var(--text-muted)',
                      borderLeft: '1px solid var(--border-dark)', paddingLeft: '0.5rem',
                    }}>
                      {formatCurrency(event.proposal_total)}
                    </span>
                  )}
                  {event.proposal_guest_count && (
                    <span style={{
                      fontSize: '0.8rem', color: 'var(--text-muted)',
                      borderLeft: '1px solid var(--border-dark)', paddingLeft: '0.5rem',
                    }}>
                      {event.proposal_guest_count} guests
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
