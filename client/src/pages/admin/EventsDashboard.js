import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone } from '../../utils/formatPhone';

export default function EventsDashboard() {
  const navigate = useNavigate();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('upcoming'); // upcoming | past | all
  const [expandedShift, setExpandedShift] = useState(null);
  const [shiftRequests, setShiftRequests] = useState({});
  const [autoAssignPreview, setAutoAssignPreview] = useState(null); // { shiftId, scores, selected, slots_remaining }
  const [autoAssignLoading, setAutoAssignLoading] = useState(null); // shiftId while loading
  const [editingEquipment, setEditingEquipment] = useState(null); // shiftId
  const [equipmentForm, setEquipmentForm] = useState({ portable_bar: false, cooler: false, table_with_spandex: false, auto_assign_days_before: '' });

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.get('/shifts');
      // Only show shifts that came from proposals (i.e., paid events)
      setEvents(res.data.filter(s => s.proposal_id));
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const loadRequests = async (shiftId) => {
    try {
      const res = await api.get(`/shifts/${shiftId}/requests`);
      setShiftRequests(prev => ({ ...prev, [shiftId]: res.data }));
    } catch (e) { console.error(e); }
  };

  const updateRequestStatus = async (requestId, status, shiftId) => {
    try {
      await api.put(`/shifts/requests/${requestId}`, { status });
      loadRequests(shiftId);
      fetchEvents();
    } catch (e) { console.error(e); }
  };

  const handleAutoAssignPreview = async (shiftId) => {
    setAutoAssignLoading(shiftId);
    try {
      const res = await api.post(`/shifts/${shiftId}/auto-assign`, { dry_run: true });
      setAutoAssignPreview({ shiftId, ...res.data });
    } catch (e) {
      alert(e.response?.data?.error || 'Auto-assign failed');
    } finally {
      setAutoAssignLoading(null);
    }
  };

  const handleAutoAssignConfirm = async () => {
    if (!autoAssignPreview) return;
    try {
      await api.post(`/shifts/${autoAssignPreview.shiftId}/auto-assign`, { dry_run: false });
      setAutoAssignPreview(null);
      loadRequests(autoAssignPreview.shiftId);
      fetchEvents();
    } catch (e) {
      alert(e.response?.data?.error || 'Auto-assign failed');
    }
  };

  const openEquipmentEditor = (event) => {
    let required = [];
    try { required = JSON.parse(event.equipment_required || '[]'); } catch (e) {}
    setEquipmentForm({
      portable_bar: required.includes('portable_bar'),
      cooler: required.includes('cooler'),
      table_with_spandex: required.includes('table_with_spandex'),
      auto_assign_days_before: event.auto_assign_days_before ?? '',
    });
    setEditingEquipment(event.id);
  };

  const saveEquipmentConfig = async (shiftId) => {
    const equipment_required = ['portable_bar', 'cooler', 'table_with_spandex'].filter(k => equipmentForm[k]);
    const days = equipmentForm.auto_assign_days_before;
    try {
      await api.put(`/shifts/${shiftId}`, {
        equipment_required,
        auto_assign_days_before: days !== '' ? parseInt(days, 10) : null,
      });
      setEditingEquipment(null);
      fetchEvents();
    } catch (e) {
      alert('Failed to save');
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '—';
    return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const today = new Date().toISOString().slice(0, 10);
  const filtered = events.filter(e => {
    // Date filter
    if (filter === 'upcoming' && e.event_date && e.event_date.slice(0, 10) < today) return false;
    if (filter === 'past' && e.event_date && e.event_date.slice(0, 10) >= today) return false;
    // Search filter
    if (search) {
      const q = search.toLowerCase();
      const fields = [e.event_name, e.client_name, e.client_email, e.location].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.2rem' }}>Events</h1>
          <p className="text-muted text-small">Confirmed events from paid proposals</p>
        </div>
      </div>

      {/* Filters */}
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
              ? 'No events yet. Events are created automatically when a proposal deposit is paid.'
              : 'No events match your filters.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {filtered.map(event => {
            const isExpanded = expandedShift === event.id;
            const requests = shiftRequests[event.id] || [];
            let positions = [];
            try { positions = JSON.parse(event.positions_needed || '[]'); } catch (e) {}
            const approvedCount = requests.filter(r => r.status === 'approved').length;

            return (
              <div key={event.id} className="card card-clickable" style={{ padding: '1.25rem 1.5rem' }} onClick={() => event.proposal_id && navigate(`/admin/events/${event.proposal_id}`)}>
                {/* Event header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                      <strong style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', color: 'var(--deep-brown)' }}>
                        {event.event_name || (event.client_name ? `${event.client_name}'s Event` : 'Untitled Event')}
                      </strong>
                      <span className={`badge ${event.status === 'open' ? 'badge-approved' : event.status === 'filled' ? 'badge-reviewed' : 'badge-deactivated'}`}>
                        {event.status}
                      </span>
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

                    {/* Client info */}
                    {event.client_name && (
                      <div style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        Client: <strong>{event.client_name}</strong>
                        {event.client_phone && <span> &middot; {formatPhone(event.client_phone)}</span>}
                        {event.client_email && <span> &middot; {event.client_email}</span>}
                      </div>
                    )}

                    {/* Staffing status */}
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
                          {formatCurrency(event.proposal_total)} total
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

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0, flexDirection: 'column', alignItems: 'flex-end' }}>
                    <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation();
                      if (isExpanded) {
                        setExpandedShift(null);
                      } else {
                        setExpandedShift(event.id);
                        loadRequests(event.id);
                      }
                    }}>
                      {isExpanded ? 'Hide Requests' : `Requests (${event.request_count || 0})`}
                    </button>
                    {Number(event.request_count) > 0 && event.status === 'open' && (
                      <button className="btn btn-primary btn-sm" disabled={autoAssignLoading === event.id}
                        onClick={(e) => { e.stopPropagation(); handleAutoAssignPreview(event.id); }}>
                        {autoAssignLoading === event.id ? 'Analyzing...' : 'Auto-Assign'}
                      </button>
                    )}
                    <button className="btn btn-secondary btn-sm" style={{ fontSize: '0.72rem' }}
                      onClick={(e) => { e.stopPropagation(); openEquipmentEditor(event); }}>
                      Config
                    </button>
                  </div>
                </div>

                {/* Expanded requests */}
                {isExpanded && (
                  <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-dark)', paddingTop: '0.75rem' }}>
                    {requests.length === 0 ? (
                      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>No staff requests yet.</p>
                    ) : (
                      <table className="admin-table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Staff Member</th>
                            <th>Position</th>
                            <th>Notes</th>
                            <th>Status</th>
                            <th>Requested</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requests.map(req => (
                            <tr key={req.id}>
                              <td>
                                <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{req.preferred_name || req.email}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{req.phone ? formatPhone(req.phone) : req.email}</div>
                              </td>
                              <td style={{ fontSize: '0.82rem' }}>{req.position || '—'}</td>
                              <td style={{ fontSize: '0.82rem', maxWidth: 180 }}>{req.notes || '—'}</td>
                              <td>
                                <span className={`badge ${req.status === 'approved' ? 'badge-approved' : req.status === 'denied' ? 'badge-deactivated' : 'badge-inprogress'}`}>
                                  {req.status}
                                </span>
                              </td>
                              <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                                {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </td>
                              <td>
                                <div style={{ display: 'flex', gap: '0.3rem' }}>
                                  {req.status !== 'approved' && (
                                    <button className="btn btn-primary btn-sm"
                                      onClick={(e) => { e.stopPropagation(); updateRequestStatus(req.id, 'approved', event.id); }}>
                                      Approve
                                    </button>
                                  )}
                                  {req.status !== 'denied' && (
                                    <button className="btn btn-danger btn-sm"
                                      onClick={(e) => { e.stopPropagation(); updateRequestStatus(req.id, 'denied', event.id); }}>
                                      Deny
                                    </button>
                                  )}
                                  {req.status !== 'pending' && (
                                    <button className="btn btn-secondary btn-sm"
                                      onClick={(e) => { e.stopPropagation(); updateRequestStatus(req.id, 'pending', event.id); }}>
                                      Reset
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Auto-Assign Preview Modal */}
      {autoAssignPreview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setAutoAssignPreview(null)}>
          <div className="card" style={{ maxWidth: 700, width: '95%', maxHeight: '80vh', overflow: 'auto', padding: '1.5rem' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>Auto-Assign Preview</h3>
            <p className="text-muted text-small" style={{ marginBottom: '1rem' }}>
              {autoAssignPreview.slots_remaining} position{autoAssignPreview.slots_remaining !== 1 ? 's' : ''} to fill. Top candidates will be approved.
            </p>
            {autoAssignPreview.scores?.length > 0 ? (
              <table className="admin-table" style={{ margin: 0, fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Location</th>
                    <th>Total</th>
                    <th>Seniority</th>
                    <th>Geography</th>
                    <th>Equipment</th>
                    <th>Distance</th>
                    <th>Events</th>
                  </tr>
                </thead>
                <tbody>
                  {autoAssignPreview.scores.map((s, i) => {
                    const isSelected = autoAssignPreview.selected?.includes(s.request_id);
                    return (
                      <tr key={s.request_id} style={{ background: isSelected ? 'rgba(76, 175, 80, 0.08)' : undefined }}>
                        <td style={{ fontWeight: 600 }}>{isSelected ? '>' : ''} {i + 1}</td>
                        <td style={{ fontWeight: 600 }}>{s.preferred_name || `User ${s.user_id}`}</td>
                        <td style={{ fontSize: '0.78rem' }}>{[s.city, s.state].filter(Boolean).join(', ') || '—'}</td>
                        <td style={{ fontWeight: 700 }}>{s.scores.total}</td>
                        <td>{s.scores.seniority}</td>
                        <td>{s.scores.geography}</td>
                        <td>{s.scores.equipment}</td>
                        <td>{s.scores.distance_miles != null ? `${s.scores.distance_miles} mi` : '—'}</td>
                        <td>{s.scores.events_worked}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-muted">No pending requests to score.</p>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setAutoAssignPreview(null)}>Cancel</button>
              {autoAssignPreview.selected?.length > 0 && (
                <button className="btn btn-primary" onClick={handleAutoAssignConfirm}>
                  Approve {autoAssignPreview.selected.length} Staff
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Equipment / Auto-Assign Config Modal */}
      {editingEquipment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setEditingEquipment(null)}>
          <div className="card" style={{ maxWidth: 420, width: '95%', padding: '1.5rem' }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>Shift Configuration</h3>

            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Required Equipment</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1.25rem' }}>
              {[
                { key: 'portable_bar', label: 'Portable Bar' },
                { key: 'cooler', label: 'Cooler' },
                { key: 'table_with_spandex', label: '6ft Table w/ Spandex' },
              ].map(item => (
                <label key={item.key} className="checkbox-group">
                  <input type="checkbox" checked={equipmentForm[item.key]}
                    onChange={(e) => setEquipmentForm(f => ({ ...f, [item.key]: e.target.checked }))} />
                  <span className="checkbox-label">{item.label}</span>
                </label>
              ))}
            </div>

            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Scheduled Auto-Assign</h4>
            <div className="form-group" style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Days before event to auto-assign</label>
              <input type="number" className="form-input" style={{ maxWidth: 120 }}
                placeholder="e.g. 3" min="0" max="30"
                value={equipmentForm.auto_assign_days_before}
                onChange={(e) => setEquipmentForm(f => ({ ...f, auto_assign_days_before: e.target.value }))} />
              <p className="text-small text-muted" style={{ marginTop: '0.25rem' }}>
                Leave blank to disable scheduled auto-assign for this shift.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setEditingEquipment(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => saveEquipmentConfig(editingEquipment)}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
