import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { formatPhone } from '../../utils/formatPhone';
import { getEventTypeLabel } from '../../utils/eventTypes';

function fmtDate(iso) {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export default function ShiftDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Manual assign state
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [activeStaff, setActiveStaff] = useState([]);
  const [assignSearch, setAssignSearch] = useState('');
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [assignPosition, setAssignPosition] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [staffError, setStaffError] = useState('');

  const loadData = () => {
    setLoading(true);
    api.get(`/shifts/detail/${id}`)
      .then(res => setData(res.data))
      .catch(() => navigate('/admin/events'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [id]); // eslint-disable-line

  useEffect(() => {
    api.get('/admin/active-staff?limit=100')
      .then(res => setActiveStaff(res.data.staff || []))
      .catch(() => {});
  }, []);

  const shift = data?.shift;
  const requests = data?.requests || [];
  const approvedRequests = requests.filter(r => r.status === 'approved');
  const pendingRequests = requests.filter(r => r.status === 'pending');

  let positions = [];
  try { positions = JSON.parse(shift?.positions_needed || '[]').map(p => typeof p === 'string' ? p : p.position || 'Bartender'); } catch (e) {}
  const neededCount = positions.length || 1;
  const approvedCount = approvedRequests.length;
  const openCount = Math.max(0, neededCount - approvedCount);

  const startEdit = () => {
    setEditForm({
      client_name: shift.client_name || '',
      client_email: shift.client_email || '',
      client_phone: shift.client_phone || '',
      event_date: shift.event_date ? shift.event_date.slice(0, 10) : '',
      start_time: shift.start_time || '',
      end_time: shift.end_time || '',
      location: shift.location || '',
      guest_count: shift.guest_count || '',
      notes: shift.notes || '',
    });
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/shifts/${id}`, editForm);
      setEditing(false);
      loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const filteredStaff = assignSearch.length >= 2
    ? activeStaff.filter(s => {
        const name = (s.preferred_name || s.email || '').toLowerCase();
        return name.includes(assignSearch.toLowerCase());
      }).slice(0, 8)
    : [];

  const handleManualAssign = async (userId, position) => {
    setAssigning(true);
    setStaffError('');
    try {
      await api.post(`/shifts/${id}/assign`, { user_id: userId, position });
      setShowAssignPicker(false);
      setAssignSearch('');
      setSelectedStaff(null);
      setAssignPosition('');
      loadData();
    } catch (e) {
      setStaffError(e.response?.data?.error || 'Failed to assign staff');
    } finally {
      setAssigning(false);
    }
  };

  if (loading) return <div className="page-container"><div className="loading"><div className="spinner" />Loading...</div></div>;
  if (!shift) return <div className="page-container"><p>Event not found.</p></div>;

  return (
    <div className="page-container wide">
      {/* Header */}
      <div className="event-header">
        <div className="event-header-top">
          <div>
            <h1 className="event-title">{shift.client_name || 'Shift'}</h1>
            <div className="event-subtitle">{getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })} on {fmtDate(shift.event_date)}</div>
          </div>
          <div className="event-header-actions">
            {!editing && <button className="event-detail-btn" onClick={startEdit}>Edit</button>}
          </div>
        </div>
        <div className="event-meta-row">
          <div className="event-meta-item">{fmtDate(shift.event_date)}</div>
          {shift.start_time && (
            <div className="event-meta-item">{shift.start_time}{shift.end_time && ` - ${shift.end_time}`}</div>
          )}
          {shift.location && <div className="event-meta-item">{shift.location}</div>}
          {shift.guest_count && <div className="event-meta-item">{shift.guest_count} guests</div>}
        </div>

        {/* Warning badges for missing items */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ background: '#fef3cd', color: '#856404', borderRadius: '99px', padding: '0.15rem 0.65rem', fontSize: '0.75rem', fontWeight: 600 }}>
            No Contract
          </span>
          <span style={{ background: '#fef3cd', color: '#856404', borderRadius: '99px', padding: '0.15rem 0.65rem', fontSize: '0.75rem', fontWeight: 600 }}>
            No Payment
          </span>
          {!shift.proposal_id && (
            <span style={{ background: 'var(--warm-brown)', color: 'white', borderRadius: '99px', padding: '0.15rem 0.65rem', fontSize: '0.75rem', fontWeight: 600 }}>
              Manual Event
            </span>
          )}
        </div>
      </div>

      <div className="event-grid">
        {/* Edit Form */}
        {editing && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>Edit Event</h3>
            {error && <div className="alert alert-error">{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
              <div>
                <label className="form-label">Client Name</label>
                <input className="form-input" value={editForm.client_name} onChange={e => setEditForm(f => ({ ...f, client_name: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Client Email</label>
                <input className="form-input" type="email" value={editForm.client_email} onChange={e => setEditForm(f => ({ ...f, client_email: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Client Phone</label>
                <input className="form-input" value={editForm.client_phone} onChange={e => setEditForm(f => ({ ...f, client_phone: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Date</label>
                <input className="form-input" type="date" value={editForm.event_date} onChange={e => setEditForm(f => ({ ...f, event_date: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Start Time</label>
                <input className="form-input" type="time" value={editForm.start_time} onChange={e => setEditForm(f => ({ ...f, start_time: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">End Time</label>
                <input className="form-input" type="time" value={editForm.end_time} onChange={e => setEditForm(f => ({ ...f, end_time: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Location</label>
                <input className="form-input" value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Guest Count</label>
                <input className="form-input" type="number" value={editForm.guest_count} onChange={e => setEditForm(f => ({ ...f, guest_count: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="form-label" style={{ marginTop: '1rem' }}>Notes</label>
              <textarea className="form-input" rows={3} value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} style={{ resize: 'vertical' }} />
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
              <button className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Client Info */}
        {(shift.client_name || shift.client_email || shift.client_phone) && !editing && (
          <div className="card">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Client</h3>
            {shift.client_name && <div style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>{shift.client_name}</div>}
            {shift.client_email && <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)' }}>{shift.client_email}</div>}
            {shift.client_phone && <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)' }}>{formatPhone(shift.client_phone)}</div>}
          </div>
        )}

        {/* Staffing */}
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Staffing</h3>
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem' }}>
            <div><strong>{neededCount}</strong> Needed</div>
            <div><strong>{approvedCount}</strong> Assigned</div>
            <div><strong>{openCount}</strong> Open</div>
          </div>

          {/* Assigned staff */}
          {approvedRequests.map(req => (
            <div key={req.id} style={{ padding: '0.4rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{req.staff_name}</span>
              <span className="badge badge-approved">{req.position || 'Bartender'}</span>
            </div>
          ))}

          {/* Pending requests */}
          {pendingRequests.length > 0 && (
            <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--warm-brown)', marginBottom: '0.4rem' }}>
                Pending Requests ({pendingRequests.length})
              </div>
              {pendingRequests.map(req => (
                <div key={req.id} style={{ padding: '0.3rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.85rem' }}>{req.staff_name}</span>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button className="btn btn-sm btn-primary"
                      onClick={async () => { await api.post(`/shifts/${id}/assign`, { user_id: req.user_id, position: req.position || 'Bartender' }); loadData(); }}>
                      Approve
                    </button>
                    <button className="btn btn-sm btn-secondary"
                      onClick={async () => { await api.put(`/shifts/requests/${req.id}`, { status: 'denied' }); loadData(); }}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Manual assign */}
          {openCount > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              {staffError && <div className="alert alert-error" style={{ fontSize: '0.82rem', marginBottom: '0.5rem' }}>{staffError}</div>}
              {!showAssignPicker ? (
                <button className="section-toggle" onClick={() => setShowAssignPicker(true)}>
                  + Assign Staff Manually
                </button>
              ) : (
                <div className="staff-assign-wrapper">
                  <input
                    className="staff-assign-search"
                    placeholder="Search staff by name..."
                    value={assignSearch}
                    onChange={e => { setAssignSearch(e.target.value); setSelectedStaff(null); }}
                    autoFocus
                  />
                  {filteredStaff.length > 0 && !selectedStaff && (
                    <div className="staff-assign-dropdown">
                      {filteredStaff.map(s => (
                        <div key={s.id} className="staff-assign-item" onClick={() => {
                          setSelectedStaff(s);
                          setAssignSearch(s.preferred_name || s.email);
                        }}>
                          <div className="staff-assign-item-name">{s.preferred_name || s.email}</div>
                          <div className="staff-assign-item-meta">{s.email}{s.city ? ` · ${s.city}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedStaff && (
                    <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <select className="form-select" value={assignPosition} onChange={e => setAssignPosition(e.target.value)}
                        style={{ fontSize: '0.82rem', padding: '0.3rem 0.5rem' }}>
                        <option value="">Position...</option>
                        <option value="Bartender">Bartender</option>
                        <option value="Barback">Barback</option>
                        <option value="Server">Server</option>
                      </select>
                      <button className="btn btn-sm btn-primary" disabled={assigning}
                        onClick={() => handleManualAssign(selectedStaff.id, assignPosition || 'Bartender')}>
                        {assigning ? 'Assigning...' : 'Assign'}
                      </button>
                      <button className="btn btn-sm btn-secondary" onClick={() => {
                        setShowAssignPicker(false);
                        setAssignSearch('');
                        setSelectedStaff(null);
                        setAssignPosition('');
                      }}>Cancel</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Notes */}
        {shift.notes && !editing && (
          <div className="card">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Notes</h3>
            <p style={{ color: 'var(--warm-brown)', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>{shift.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}
