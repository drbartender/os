import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import api from '../utils/api';
import { formatPhone } from '../utils/formatPhone';
import TimePicker from '../components/TimePicker';

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState('active-staff');

  // Active Staff state
  const [activeStaff, setActiveStaff]         = useState([]);
  const [staffLoading, setStaffLoading]       = useState(false);
  const [staffSearch, setStaffSearch]         = useState('');
  const [staffTotal, setStaffTotal]           = useState(0);

  // Shifts state
  const [shifts, setShifts]                   = useState([]);
  const [shiftsLoading, setShiftsLoading]     = useState(false);
  const [expandedShift, setExpandedShift]     = useState(null);
  const [shiftRequests, setShiftRequests]     = useState({});
  const [showShiftForm, setShowShiftForm]     = useState(false);
  const [shiftForm, setShiftForm]             = useState({ event_date: '', start_time: '', end_time: '', location: '', notes: '', positions: [] });
  const [shiftPosInput, setShiftPosInput]     = useState('');

  // Messages state
  const [msgRecipients, setMsgRecipients]           = useState([]);
  const [msgRecipientsLoading, setMsgRecipientsLoading] = useState(false);
  const [msgSelected, setMsgSelected]               = useState([]);
  const [msgBody, setMsgBody]                       = useState('');
  const [msgType, setMsgType]                       = useState('general');
  const [msgShiftId, setMsgShiftId]                 = useState('');
  const [msgShifts, setMsgShifts]                   = useState([]);
  const [msgSending, setMsgSending]                 = useState(false);
  const [msgResult, setMsgResult]                   = useState(null);
  const [msgSearch, setMsgSearch]                    = useState('');
  const [msgHistory, setMsgHistory]                  = useState([]);
  const [msgHistoryLoading, setMsgHistoryLoading]    = useState(false);
  const [msgExpandedGroup, setMsgExpandedGroup]      = useState(null);
  const [msgGroupDetails, setMsgGroupDetails]        = useState({});

  // Fetch active staff (default tab)
  const fetchActiveStaff = useCallback(() => {
    setStaffLoading(true);
    api.get('/admin/active-staff')
      .then(r => { setActiveStaff(r.data.staff); setStaffTotal(r.data.total); })
      .catch(() => toast.error('Failed to load staff. Try refreshing.'))
      .finally(() => setStaffLoading(false));
  }, [toast]);

  useEffect(() => {
    if (tab === 'active-staff') fetchActiveStaff();
  }, [tab, fetchActiveStaff]);

  // Fetch shifts
  const fetchShifts = useCallback(() => {
    setShiftsLoading(true);
    api.get('/shifts')
      .then(r => setShifts(r.data))
      .catch(() => toast.error('Failed to load shifts. Try refreshing.'))
      .finally(() => setShiftsLoading(false));
  }, [toast]);

  useEffect(() => {
    if (tab !== 'shifts') return;
    fetchShifts();
  }, [tab, fetchShifts]);

  // Fetch messages recipients + history
  const fetchMsgRecipients = useCallback(() => {
    setMsgRecipientsLoading(true);
    api.get('/messages/recipients')
      .then(r => setMsgRecipients(r.data.recipients))
      .catch(() => toast.error('Failed to load recipients.'))
      .finally(() => setMsgRecipientsLoading(false));
  }, [toast]);

  const fetchMsgHistory = useCallback(() => {
    setMsgHistoryLoading(true);
    api.get('/messages/history')
      .then(r => setMsgHistory(r.data.groups))
      .catch(() => toast.error('Failed to load message history.'))
      .finally(() => setMsgHistoryLoading(false));
  }, [toast]);

  useEffect(() => {
    if (tab !== 'messages') return;
    fetchMsgRecipients();
    fetchMsgHistory();
    api.get('/messages/shifts')
      .then(r => setMsgShifts(r.data.shifts))
      .catch(() => toast.error('Failed to load shifts list.'));
  }, [tab, fetchMsgRecipients, fetchMsgHistory, toast]);

  async function sendMessage(e) {
    e.preventDefault();
    if (msgSelected.length === 0 || !msgBody.trim()) return;
    if (!window.confirm(`Send this message to ${msgSelected.length} staff member${msgSelected.length !== 1 ? 's' : ''}?`)) return;
    setMsgSending(true);
    setMsgResult(null);
    try {
      const r = await api.post('/messages/send', {
        recipient_ids: msgSelected,
        body: msgBody.trim(),
        message_type: msgType,
        shift_id: msgType === 'invitation' && msgShiftId ? parseInt(msgShiftId) : null,
      });
      setMsgResult(r.data);
      setMsgBody('');
      setMsgSelected([]);
      setMsgType('general');
      setMsgShiftId('');
      fetchMsgHistory();
    } catch (err) {
      setMsgResult({ error: err.message || 'Failed to send' });
    } finally {
      setMsgSending(false);
    }
  }

  async function loadMsgGroupDetail(groupId) {
    if (msgGroupDetails[groupId]) return;
    try {
      const r = await api.get(`/messages/history/${groupId}`);
      setMsgGroupDetails(prev => ({ ...prev, [groupId]: r.data.messages }));
    } catch (e) {
      toast.error(e.message || 'Failed to load message details.');
    }
  }

  async function loadShiftRequests(shiftId) {
    if (shiftRequests[shiftId]) return; // already loaded
    try {
      const r = await api.get(`/shifts/${shiftId}/requests`);
      setShiftRequests(prev => ({ ...prev, [shiftId]: r.data }));
    } catch (e) {
      toast.error(e.message || 'Failed to load shift requests.');
    }
  }

  async function updateRequestStatus(requestId, status, shiftId) {
    try {
      await api.put(`/shifts/requests/${requestId}`, { status });
      const r = await api.get(`/shifts/${shiftId}/requests`);
      setShiftRequests(prev => ({ ...prev, [shiftId]: r.data }));
      toast.success('Request updated.');
    } catch (e) {
      toast.error(e.message || 'Failed to update request.');
    }
  }

  async function deleteShift(shiftId) {
    if (!window.confirm('Delete this shift? All requests will also be removed.')) return;
    try {
      await api.delete(`/shifts/${shiftId}`);
      fetchShifts();
      setExpandedShift(null);
      toast.success('Shift deleted.');
    } catch (e) {
      toast.error(e.message || 'Failed to delete shift.');
    }
  }

  async function createShift(e) {
    e.preventDefault();
    try {
      await api.post('/shifts', { ...shiftForm, positions_needed: shiftForm.positions });
      setShiftForm({ event_date: '', start_time: '', end_time: '', location: '', notes: '', positions: [] });
      setShiftPosInput('');
      setShowShiftForm(false);
      fetchShifts();
      toast.success('Shift created!');
    } catch (e) {
      toast.error(e.message || 'Failed to create shift.');
    }
  }

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  // Permission flags for the current user
  const isAdmin     = user?.role === 'admin';
  const canStaff    = isAdmin || user?.can_staff;

  return (
      <div className="page-container wide">
        <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h1 style={{ marginBottom: '0.2rem' }}>Staff</h1>
            <p className="text-muted text-small">Manage your team and shifts</p>
          </div>
        </div>

        <div className="tab-nav" style={{ marginBottom: '1rem' }}>
          <button className={`tab-btn ${tab === 'active-staff' ? 'active' : ''}`} onClick={() => setTab('active-staff')}>
            Active Staff {staffTotal > 0 && `(${staffTotal})`}
          </button>
          {canStaff && (
            <button className={`tab-btn ${tab === 'shifts' ? 'active' : ''}`} onClick={() => setTab('shifts')}>
              Shifts {shifts.length > 0 && `(${shifts.length})`}
            </button>
          )}
          {isAdmin && (
            <button className={`tab-btn ${tab === 'messages' ? 'active' : ''}`} onClick={() => setTab('messages')}>
              Messages
            </button>
          )}
        </div>

        {/* ─── Active Staff Tab ─── */}
        {tab === 'active-staff' && (
          <>
            <div className="card card-sm mb-2" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-input" style={{ maxWidth: 260, marginBottom: 0 }}
                placeholder="Search by name or email…"
                value={staffSearch} onChange={e => setStaffSearch(e.target.value)}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {staffTotal} active contractor{staffTotal !== 1 ? 's' : ''}
              </span>
            </div>

            {staffLoading ? (
              <div className="loading"><div className="spinner" />Loading staff…</div>
            ) : activeStaff.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No active staff yet.</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>Location</th>
                        <th>Transportation</th>
                        <th>Equipment</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeStaff
                        .filter(s =>
                          !staffSearch ||
                          (s.preferred_name || '').toLowerCase().includes(staffSearch.toLowerCase()) ||
                          s.email.toLowerCase().includes(staffSearch.toLowerCase())
                        )
                        .map(s => {
                          const equip = [
                            s.equipment_portable_bar && 'Bar',
                            s.equipment_cooler && 'Cooler',
                            s.equipment_table_with_spandex && 'Table',
                          ].filter(Boolean);
                          return (
                            <tr key={s.id} onClick={() => navigate(`/staffing/users/${s.id}`)}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.preferred_name || '—'}</span>
                                  {s.role === 'manager' && <span className="badge badge-approved" style={{ fontSize: '0.6rem', padding: '0.1rem 0.4rem' }}>Manager</span>}
                                </div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{s.email}</div>
                              </td>
                              <td style={{ fontSize: '0.82rem' }}>{formatPhone(s.phone)}</td>
                              <td style={{ fontSize: '0.82rem' }}>{s.city && s.state ? `${s.city}, ${s.state}` : s.city || '—'}</td>
                              <td style={{ fontSize: '0.82rem' }}>{s.reliable_transportation || '—'}</td>
                              <td style={{ fontSize: '0.78rem' }}>
                                {equip.length > 0 ? (
                                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                                    {equip.map(e => <span key={e} className="badge badge-inprogress" style={{ fontSize: '0.7rem' }}>{e}</span>)}
                                  </div>
                                ) : <span style={{ color: 'var(--text-muted)' }}>None</span>}
                              </td>
                              <td>
                                <button className="btn btn-secondary btn-sm"
                                  onClick={e => { e.stopPropagation(); navigate(`/staffing/users/${s.id}`); }}>
                                  View →
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── Shifts Tab ─── */}
        {tab === 'shifts' && (
          <>
            {/* Header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{shifts.length} shift{shifts.length !== 1 ? 's' : ''} total</span>
              <button className="btn btn-primary btn-sm" onClick={() => setShowShiftForm(v => !v)}>
                {showShiftForm ? '✕ Cancel' : '+ New Shift'}
              </button>
            </div>

            {/* Create shift form */}
            {showShiftForm && (
              <div className="card mb-3" style={{ border: '2px solid var(--amber)' }}>
                <h3 style={{ marginBottom: '1rem' }}>Create New Shift</h3>
                <form onSubmit={createShift}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                    <div>
                      <label className="form-label">Event Date *</label>
                      <input className="form-input" type="date" required value={shiftForm.event_date}
                        onChange={e => setShiftForm(f => ({ ...f, event_date: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="shift-start-time">Start Time</label>
                      <TimePicker
                        id="shift-start-time"
                        value={shiftForm.start_time}
                        onChange={(v) => setShiftForm(f => ({ ...f, start_time: v }))}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="shift-end-time">End Time</label>
                      <TimePicker
                        id="shift-end-time"
                        value={shiftForm.end_time}
                        onChange={(v) => setShiftForm(f => ({ ...f, end_time: v }))}
                      />
                    </div>
                    <div>
                      <label className="form-label">Location</label>
                      <input className="form-input" value={shiftForm.location}
                        onChange={e => setShiftForm(f => ({ ...f, location: e.target.value }))} />
                    </div>
                  </div>

                  {/* Positions needed */}
                  <div style={{ marginTop: '0.75rem' }}>
                    <label className="form-label">Positions Needed</label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
                      {shiftForm.positions.map((p, i) => (
                        <span key={i} style={{
                          background: 'var(--amber)', color: 'white', borderRadius: '99px',
                          padding: '0.2rem 0.6rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem'
                        }}>
                          {p}
                          <button type="button" onClick={() => setShiftForm(f => ({ ...f, positions: f.positions.filter((_, j) => j !== i) }))}
                            style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', padding: 0, lineHeight: 1 }}>✕</button>
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input className="form-input" style={{ marginBottom: 0 }} placeholder="e.g. Bartender, Bar Back…"
                        value={shiftPosInput} onChange={e => setShiftPosInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const v = shiftPosInput.trim();
                            if (v) { setShiftForm(f => ({ ...f, positions: [...f.positions, v] })); setShiftPosInput(''); }
                          }
                        }} />
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => {
                        const v = shiftPosInput.trim();
                        if (v) { setShiftForm(f => ({ ...f, positions: [...f.positions, v] })); setShiftPosInput(''); }
                      }}>Add</button>
                    </div>
                  </div>

                  <div style={{ marginTop: '0.75rem' }}>
                    <label className="form-label">Notes</label>
                    <textarea className="form-input" rows={2} value={shiftForm.notes}
                      onChange={e => setShiftForm(f => ({ ...f, notes: e.target.value }))} />
                  </div>

                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                    <button type="submit" className="btn btn-primary">Create Shift</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowShiftForm(false)}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

            {/* Shift list */}
            {shiftsLoading ? (
              <div className="loading"><div className="spinner" />Loading shifts…</div>
            ) : shifts.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No shifts created yet.</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {shifts.map(shift => {
                  const isExpanded = expandedShift === shift.id;
                  let positions = [];
                  try { positions = JSON.parse(shift.positions_needed || '[]').map(p => typeof p === 'string' ? p : p.position || 'Bartender'); } catch (e) {}
                  const requests = shiftRequests[shift.id] || [];

                  return (
                    <div key={shift.id} className="card" style={{ padding: '1rem' }}>
                      {/* Shift header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: '1rem' }}>{shift.client_name || 'Shift'}</strong>
                            {shift.event_type_label && <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{shift.event_type_label}</div>}
                            <span className={`badge ${shift.status === 'open' ? 'badge-approved' : shift.status === 'filled' ? 'badge-reviewed' : 'badge-deactivated'}`}>
                              {shift.status}
                            </span>
                            {Number(shift.request_count) > 0 && (
                              <span style={{
                                background: 'var(--amber)', color: 'white', borderRadius: '99px',
                                padding: '0.1rem 0.5rem', fontSize: '0.72rem', fontWeight: 700,
                              }}>{shift.request_count} request{shift.request_count !== '1' ? 's' : ''}</span>
                            )}
                          </div>
                          <div style={{ marginTop: '0.3rem', fontSize: '0.83rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                            <span>📅 {fmtDate(shift.event_date)}</span>
                            {(shift.start_time || shift.end_time) && (
                              <span>🕐 {shift.start_time || '?'} – {shift.end_time || '?'}</span>
                            )}
                            {shift.location && <span>📍 {shift.location}</span>}
                          </div>
                          {positions.length > 0 && (
                            <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                              {positions.map((p, i) => (
                                <span key={i} style={{
                                  background: 'var(--parchment)', border: '1px solid var(--border-dark)',
                                  borderRadius: '99px', padding: '0.15rem 0.5rem', fontSize: '0.75rem',
                                }}>{p}</span>
                              ))}
                            </div>
                          )}
                          {shift.notes && <p style={{ marginTop: '0.4rem', fontSize: '0.82rem', color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>{shift.notes}</p>}
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => {
                            if (isExpanded) {
                              setExpandedShift(null);
                            } else {
                              setExpandedShift(shift.id);
                              loadShiftRequests(shift.id);
                            }
                          }}>
                            {isExpanded ? 'Hide Requests ↑' : `Requests (${shift.request_count || 0}) ↓`}
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteShift(shift.id)}>Delete</button>
                        </div>
                      </div>

                      {/* Expanded requests */}
                      {isExpanded && (
                        <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-dark)', paddingTop: '0.75rem' }}>
                          {requests.length === 0 ? (
                            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>No requests yet.</p>
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
                                            onClick={() => updateRequestStatus(req.id, 'approved', shift.id)}>
                                            Approve
                                          </button>
                                        )}
                                        {req.status !== 'denied' && (
                                          <button className="btn btn-danger btn-sm"
                                            onClick={() => updateRequestStatus(req.id, 'denied', shift.id)}>
                                            Deny
                                          </button>
                                        )}
                                        {req.status !== 'pending' && (
                                          <button className="btn btn-secondary btn-sm"
                                            onClick={() => updateRequestStatus(req.id, 'pending', shift.id)}>
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
          </>
        )}

        {/* ─── Messages Tab ─── */}
        {tab === 'messages' && (
          <>
            {/* Compose */}
            <div className="card mb-3" style={{ border: '2px solid var(--amber)' }}>
              <h3 style={{ marginBottom: '1rem' }}>Compose Message</h3>
              <form onSubmit={sendMessage}>
                {/* Message Type */}
                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Message Type</label>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {['general', 'invitation', 'reminder', 'announcement'].map(t => (
                      <button key={t} type="button"
                        className={`btn btn-sm ${msgType === t ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => {
                          setMsgType(t);
                          if (t !== 'invitation') setMsgShiftId('');
                        }}
                        style={{ textTransform: 'capitalize' }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Shift picker for invitations */}
                {msgType === 'invitation' && (
                  <div style={{ marginBottom: '1rem' }}>
                    <label className="form-label">Select Shift</label>
                    <select className="form-input" style={{ marginBottom: 0 }}
                      value={msgShiftId} onChange={e => {
                        setMsgShiftId(e.target.value);
                        const shift = msgShifts.find(s => String(s.id) === e.target.value);
                        if (shift) {
                          const date = shift.event_date
                            ? new Date(shift.event_date.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
                            : 'TBD';
                          const time = shift.start_time && shift.end_time
                            ? `${shift.start_time}\u2013${shift.end_time}` : shift.start_time || 'TBD';
                          setMsgBody(`Hey! We have an event coming up: ${shift.event_type_label || 'event'} at ${shift.client_name || 'TBD'} on ${date} at ${time} \u2014 ${shift.location || 'TBD'}. Interested in working it? Request the shift in your portal: https://staff.drbartender.com/dashboard - Dr. Bartender`);
                        }
                      }}>
                      <option value="">Select a shift…</option>
                      {msgShifts.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.event_type_label || 'event'} — {s.event_date ? new Date(s.event_date.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Recipients */}
                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Recipients</label>
                  <input
                    className="form-input" style={{ maxWidth: 300, marginBottom: '0.5rem' }}
                    placeholder="Search staff…"
                    value={msgSearch} onChange={e => setMsgSearch(e.target.value)}
                  />
                  {msgRecipientsLoading ? (
                    <div className="text-muted text-small">Loading…</div>
                  ) : (
                    <>
                      <div style={{ marginBottom: '0.4rem' }}>
                        <label style={{ fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <input type="checkbox"
                            checked={msgSelected.length === msgRecipients.filter(r => !msgSearch || r.preferred_name?.toLowerCase().includes(msgSearch.toLowerCase()) || r.email?.toLowerCase().includes(msgSearch.toLowerCase())).length && msgSelected.length > 0}
                            onChange={e => {
                              const filtered = msgRecipients.filter(r => !msgSearch || r.preferred_name?.toLowerCase().includes(msgSearch.toLowerCase()) || r.email?.toLowerCase().includes(msgSearch.toLowerCase()));
                              setMsgSelected(e.target.checked ? filtered.map(r => r.user_id) : []);
                            }}
                          />
                          Select All ({msgRecipients.filter(r => !msgSearch || r.preferred_name?.toLowerCase().includes(msgSearch.toLowerCase()) || r.email?.toLowerCase().includes(msgSearch.toLowerCase())).length})
                        </label>
                      </div>
                      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-dark)', borderRadius: '6px', padding: '0.5rem' }}>
                        {msgRecipients
                          .filter(r => !msgSearch || r.preferred_name?.toLowerCase().includes(msgSearch.toLowerCase()) || r.email?.toLowerCase().includes(msgSearch.toLowerCase()))
                          .map(r => (
                            <label key={r.user_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0', cursor: 'pointer', fontSize: '0.88rem' }}>
                              <input type="checkbox"
                                checked={msgSelected.includes(r.user_id)}
                                onChange={e => {
                                  setMsgSelected(prev =>
                                    e.target.checked ? [...prev, r.user_id] : prev.filter(id => id !== r.user_id)
                                  );
                                }}
                              />
                              <span style={{ fontWeight: 600 }}>{r.preferred_name || r.email}</span>
                              <span className="text-muted" style={{ fontSize: '0.78rem' }}>{formatPhone(r.phone)}</span>
                            </label>
                          ))
                        }
                        {msgRecipients.filter(r => !msgSearch || r.preferred_name?.toLowerCase().includes(msgSearch.toLowerCase()) || r.email?.toLowerCase().includes(msgSearch.toLowerCase())).length === 0 && (
                          <div className="text-muted text-small" style={{ padding: '0.5rem 0' }}>No eligible staff found (must have phone + SMS consent)</div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Message body */}
                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Message</label>
                  <textarea
                    className="form-input" rows={4}
                    value={msgBody} onChange={e => setMsgBody(e.target.value)}
                    maxLength={1600}
                    placeholder="Type your message…"
                    style={{ marginBottom: '0.25rem' }}
                  />
                  <div className="text-muted text-small" style={{ textAlign: 'right' }}>
                    {msgBody.length}/1600
                  </div>
                </div>

                {/* Send */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <button type="submit" className="btn btn-primary"
                    disabled={msgSending || msgSelected.length === 0 || !msgBody.trim()}>
                    {msgSending ? 'Sending…' : `Send to ${msgSelected.length} recipient${msgSelected.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </form>

              {/* Result */}
              {msgResult && (
                <div className={`alert ${msgResult.error ? 'alert-error' : 'alert-success'}`} style={{ marginTop: '1rem' }}>
                  {msgResult.error
                    ? msgResult.error
                    : `Sent ${msgResult.sent} of ${msgResult.total} message${msgResult.total !== 1 ? 's' : ''}${msgResult.failed > 0 ? ` (${msgResult.failed} failed)` : ''}`
                  }
                </div>
              )}
            </div>

            {/* History */}
            <h3 style={{ marginBottom: '0.75rem' }}>Message History</h3>
            {msgHistoryLoading ? (
              <div className="loading"><div className="spinner" />Loading history…</div>
            ) : msgHistory.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No messages sent yet.</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {msgHistory.map(g => {
                  const isExpanded = msgExpandedGroup === g.group_id;
                  const details = msgGroupDetails[g.group_id] || [];
                  return (
                    <div key={g.group_id} className="card" style={{ padding: '1rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                            <span className={`badge ${g.message_type === 'invitation' ? 'badge-reviewed' : g.message_type === 'reminder' ? 'badge-inprogress' : g.message_type === 'announcement' ? 'badge-submitted' : 'badge-approved'}`} style={{ textTransform: 'capitalize' }}>
                              {g.message_type}
                            </span>
                            {g.shift_event_type_label && (
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>for {g.shift_event_type_label}</span>
                            )}
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                              {new Date(g.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                          </div>
                          <p style={{ fontSize: '0.88rem', margin: '0.3rem 0', color: 'var(--deep-brown)' }}>
                            {g.body.length > 120 ? g.body.slice(0, 120) + '…' : g.body}
                          </p>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {g.total_recipients} recipient{g.total_recipients !== '1' ? 's' : ''}
                            {' · '}{g.sent_count} sent
                            {Number(g.failed_count) > 0 && <span style={{ color: 'var(--error)' }}> · {g.failed_count} failed</span>}
                          </div>
                        </div>
                        <button className="btn btn-secondary btn-sm" onClick={() => {
                          if (isExpanded) {
                            setMsgExpandedGroup(null);
                          } else {
                            setMsgExpandedGroup(g.group_id);
                            loadMsgGroupDetail(g.group_id);
                          }
                        }}>
                          {isExpanded ? 'Hide ↑' : 'Details ↓'}
                        </button>
                      </div>

                      {isExpanded && details.length > 0 && (
                        <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border-dark)', paddingTop: '0.75rem' }}>
                          <table className="admin-table" style={{ margin: 0 }}>
                            <thead>
                              <tr>
                                <th>Recipient</th>
                                <th>Phone</th>
                                <th>Status</th>
                                <th>Error</th>
                              </tr>
                            </thead>
                            <tbody>
                              {details.map(d => (
                                <tr key={d.id}>
                                  <td style={{ fontSize: '0.88rem' }}>{d.recipient_name || '—'}</td>
                                  <td style={{ fontSize: '0.82rem' }}>{formatPhone(d.recipient_phone)}</td>
                                  <td>
                                    <span className={`badge ${d.status === 'sent' ? 'badge-approved' : 'badge-deactivated'}`}>{d.status}</span>
                                  </td>
                                  <td style={{ fontSize: '0.78rem', color: 'var(--error)' }}>{d.error_message || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ─── Managers Tab ─── */}
      </div>
  );
}
