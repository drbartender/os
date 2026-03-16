import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';

const ONBOARDING_STEPS = ['account_created','welcome_viewed','field_guide_completed','agreement_completed','contractor_profile_completed','payday_protocols_completed','onboarding_completed'];

function calcPct(row) {
  const done = ONBOARDING_STEPS.filter(s => row[s]).length;
  return Math.round((done / ONBOARDING_STEPS.length) * 100);
}

const STATUS_COLORS = {
  applied:      'badge-submitted',
  interviewing: 'badge-inprogress',
  hired:        'badge-approved',
  rejected:     'badge-deactivated',
  in_progress:  'badge-inprogress',
  submitted:    'badge-submitted',
  reviewed:     'badge-reviewed',
  approved:     'badge-approved',
  deactivated:  'badge-deactivated',
};

const STATUS_LABELS = {
  applied:      'Applied',
  interviewing: 'Interviewing',
  hired:        'Hired',
  rejected:     'Archived',
  in_progress:  'In Progress',
  submitted:    'Submitted',
  reviewed:     'Reviewed',
  approved:     'Approved',
  deactivated:  'Deactivated',
};

function StatusBadge({ status }) {
  const cls   = STATUS_COLORS[status] || 'badge-inprogress';
  const label = STATUS_LABELS[status] || status;
  return <span className={`badge ${cls}`}>{label}</span>;
}

const APP_FILTER_KEYS  = ['all', 'applied', 'interviewing', 'hired', 'archived'];
const USER_FILTER_KEYS = ['all', 'hired', 'in_progress', 'submitted', 'reviewed', 'approved', 'deactivated'];

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Determine the first visible tab based on role/permissions
  const defaultTab = (() => {
    if (!user) return 'applications';
    if (user.role === 'admin' || user.can_hire) return 'applications';
    if (user.can_staff) return 'active-staff';
    return 'applications';
  })();
  const [tab, setTab] = useState(defaultTab);

  // Applications state
  const [apps, setApps]                 = useState([]);
  const [appsLoading, setAppsLoading]   = useState(true);
  const [appFilter, setAppFilter]       = useState('all');
  const [appSearch, setAppSearch]       = useState('');
  const [appPage, setAppPage]           = useState(1);
  const [appTotalPages, setAppTotalPages] = useState(1);
  const [appTotal, setAppTotal]         = useState(0);
  const [statusCounts, setStatusCounts] = useState({});
  const [archivedCount, setArchivedCount] = useState(0);

  // Sort
  const [sortBy, setSortBy]   = useState('applied_at');
  const [sortDir, setSortDir] = useState('desc');

  // Inline status edit
  const [editingStatus, setEditingStatus] = useState(null); // userId
  const tableRef = useRef(null);

  // Onboarding users state
  const [users, setUsers]                 = useState([]);
  const [usersLoading, setUsersLoading]   = useState(true);
  const [userFilter, setUserFilter]       = useState('all');
  const [userSearch, setUserSearch]       = useState('');
  const [userPage, setUserPage]           = useState(1);
  const [userTotalPages, setUserTotalPages] = useState(1);
  const [userTotal, setUserTotal]         = useState(0);

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
  const [shiftForm, setShiftForm]             = useState({ event_name: '', event_date: '', start_time: '', end_time: '', location: '', notes: '', positions: [] });
  const [shiftPosInput, setShiftPosInput]     = useState('');

  // Managers state
  const [managers, setManagers]               = useState([]);
  const [managersLoading, setManagersLoading] = useState(false);
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [managerForm, setManagerForm]         = useState({ email: '', password: '', can_hire: false, can_staff: false });

  // Close inline editor when clicking outside the table
  useEffect(() => {
    function handleClick(e) {
      if (editingStatus && tableRef.current && !tableRef.current.contains(e.target)) {
        setEditingStatus(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [editingStatus]);

  // Fetch applications — refetches when switching to/from archived view or changing pages
  const isArchivedTab = appFilter === 'archived';
  useEffect(() => {
    if (tab !== 'applications') return;
    setAppsLoading(true);
    const archivedParam = isArchivedTab ? '&archived=true' : '';
    api.get(`/admin/applications?page=${appPage}&limit=50${archivedParam}`)
      .then(r => {
        setApps(r.data.applications);
        setAppTotalPages(r.data.pages);
        setAppTotal(r.data.total);
        if (r.data.statusCounts) setStatusCounts(r.data.statusCounts);
        if (r.data.archivedCount !== undefined) setArchivedCount(r.data.archivedCount);
      })
      .catch(console.error)
      .finally(() => setAppsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPage, tab, isArchivedTab]);

  // Fetch onboarding users
  useEffect(() => {
    if (tab !== 'onboarding') return;
    setUsersLoading(true);
    api.get(`/admin/users?page=${userPage}&limit=50`)
      .then(r => {
        setUsers(r.data.users);
        setUserTotalPages(r.data.pages);
        setUserTotal(r.data.total);
      })
      .catch(console.error)
      .finally(() => setUsersLoading(false));
  }, [userPage, tab]);

  // Fetch active staff
  useEffect(() => {
    if (tab !== 'active-staff') return;
    setStaffLoading(true);
    api.get('/admin/active-staff')
      .then(r => { setActiveStaff(r.data.staff); setStaffTotal(r.data.total); })
      .catch(console.error)
      .finally(() => setStaffLoading(false));
  }, [tab]);

  // Fetch shifts
  const fetchShifts = useCallback(() => {
    setShiftsLoading(true);
    api.get('/shifts')
      .then(r => setShifts(r.data))
      .catch(console.error)
      .finally(() => setShiftsLoading(false));
  }, []);

  useEffect(() => {
    if (tab !== 'shifts') return;
    fetchShifts();
  }, [tab, fetchShifts]);

  // Fetch managers
  useEffect(() => {
    if (tab !== 'managers') return;
    setManagersLoading(true);
    api.get('/admin/managers')
      .then(r => setManagers(r.data.managers))
      .catch(console.error)
      .finally(() => setManagersLoading(false));
  }, [tab]);

  async function handleInlineStatusChange(userId, newStatus) {
    const prevApp = apps.find(a => a.id === userId);
    const oldStatus = prevApp?.onboarding_status;
    setEditingStatus(null);
    try {
      await api.put(`/admin/users/${userId}/status`, { status: newStatus });

      if (newStatus === 'rejected') {
        // Archiving: remove from active list, update counts
        setApps(prev => prev.filter(a => a.id !== userId));
        setArchivedCount(prev => prev + 1);
        setAppTotal(prev => Math.max(0, prev - 1));
        if (oldStatus) {
          setStatusCounts(prev => ({
            ...prev,
            [oldStatus]: Math.max(0, (prev[oldStatus] || 0) - 1),
            all: Math.max(0, (prev.all || 0) - 1),
          }));
        }
      } else if (oldStatus === 'rejected') {
        // Restoring from archived: remove from archived list, update counts
        setApps(prev => prev.filter(a => a.id !== userId));
        setArchivedCount(prev => Math.max(0, prev - 1));
        setAppTotal(prev => prev + 1);
        setStatusCounts(prev => ({
          ...prev,
          [newStatus]: (prev[newStatus] || 0) + 1,
          all: (prev.all || 0) + 1,
        }));
      } else {
        // Regular status change within active list
        setApps(prev => prev.map(a => a.id === userId ? { ...a, onboarding_status: newStatus } : a));
        if (oldStatus && oldStatus !== newStatus) {
          setStatusCounts(prev => ({
            ...prev,
            [oldStatus]: Math.max(0, (prev[oldStatus] || 0) - 1),
            [newStatus]: (prev[newStatus] || 0) + 1,
          }));
        }
      }
    } catch (e) { console.error(e); }
  }

  function toggleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  }

  async function loadShiftRequests(shiftId) {
    if (shiftRequests[shiftId]) return; // already loaded
    try {
      const r = await api.get(`/shifts/${shiftId}/requests`);
      setShiftRequests(prev => ({ ...prev, [shiftId]: r.data }));
    } catch (e) { console.error(e); }
  }

  async function updateRequestStatus(requestId, status, shiftId) {
    try {
      await api.put(`/shifts/requests/${requestId}`, { status });
      const r = await api.get(`/shifts/${shiftId}/requests`);
      setShiftRequests(prev => ({ ...prev, [shiftId]: r.data }));
    } catch (e) { console.error(e); }
  }

  async function deleteShift(shiftId) {
    if (!window.confirm('Delete this shift? All requests will also be removed.')) return;
    try {
      await api.delete(`/shifts/${shiftId}`);
      fetchShifts();
      setExpandedShift(null);
    } catch (e) { console.error(e); }
  }

  async function createShift(e) {
    e.preventDefault();
    try {
      await api.post('/shifts', { ...shiftForm, positions_needed: shiftForm.positions });
      setShiftForm({ event_name: '', event_date: '', start_time: '', end_time: '', location: '', notes: '', positions: [] });
      setShiftPosInput('');
      setShowShiftForm(false);
      fetchShifts();
    } catch (e) { console.error(e); }
  }

  async function createManager(e) {
    e.preventDefault();
    try {
      const r = await api.post('/admin/managers', managerForm);
      setManagers(prev => [r.data, ...prev]);
      setManagerForm({ email: '', password: '', can_hire: false, can_staff: false });
      setShowManagerForm(false);
    } catch (e) { alert(e.response?.data?.error || 'Failed to create manager'); }
  }

  async function updateManagerPermissions(mgr, field, value) {
    try {
      const updated = await api.put(`/admin/managers/${mgr.id}`, { ...mgr, [field]: value });
      setManagers(prev => prev.map(m => m.id === mgr.id ? updated.data : m));
    } catch (e) { console.error(e); }
  }

  async function deleteManager(id) {
    if (!window.confirm('Remove this manager account?')) return;
    try {
      await api.delete(`/admin/managers/${id}`);
      setManagers(prev => prev.filter(m => m.id !== id));
    } catch (e) { console.error(e); }
  }

  const fmtDate = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—';

  // Permission flags for the current user
  const isAdmin     = user?.role === 'admin';
  const canHire     = isAdmin || user?.can_hire;
  const canStaff    = isAdmin || user?.can_staff;

  // Filtered + sorted applications
  // When on the archived tab, server already filtered to rejected — no status filter needed
  const filteredApps = apps
    .filter(a => {
      const matchStatus = isArchivedTab || appFilter === 'all' || a.onboarding_status === appFilter;
      const matchSearch = !appSearch ||
        a.full_name?.toLowerCase().includes(appSearch.toLowerCase()) ||
        a.email.toLowerCase().includes(appSearch.toLowerCase());
      return matchStatus && matchSearch;
    })
    .sort((a, b) => {
      const da = new Date(a.applied_at || a.created_at);
      const db = new Date(b.applied_at || b.created_at);
      return sortDir === 'desc' ? db - da : da - db;
    });

  // Filtered onboarding users
  const filteredUsers = users.filter(u => {
    const matchStatus = userFilter === 'all' || u.onboarding_status === userFilter;
    const matchSearch = !userSearch ||
      u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
      (u.preferred_name || '').toLowerCase().includes(userSearch.toLowerCase());
    return matchStatus && matchSearch;
  });

  function SortIcon({ field }) {
    if (sortBy !== field) return <span style={{ opacity: 0.3, marginLeft: '0.2rem' }}>↕</span>;
    return <span style={{ color: 'var(--amber)', marginLeft: '0.2rem' }}>{sortDir === 'desc' ? '↓' : '↑'}</span>;
  }

  function Pagination({ page, totalPages, setPage }) {
    if (totalPages <= 1) return null;
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Page {page} of {totalPages}</span>
        <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
      </div>
    );
  }

  return (
      <div className="page-container wide">
        <div className="flex-between mb-3" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h1 style={{ marginBottom: '0.2rem' }}>Staffing</h1>
            <p className="text-muted text-small">Manage applications and contractor onboarding</p>
          </div>
        </div>

        {/* Main Tabs */}
        <div className="tab-nav" style={{ marginBottom: '1rem' }}>
          {canHire && (
            <button className={`tab-btn ${tab === 'applications' ? 'active' : ''}`} onClick={() => setTab('applications')}>
              Applications ({statusCounts.all ?? appTotal})
            </button>
          )}
          {isAdmin && (
            <button className={`tab-btn ${tab === 'onboarding' ? 'active' : ''}`} onClick={() => setTab('onboarding')}>
              Onboarding ({userTotal})
            </button>
          )}
          {canStaff && (
            <button className={`tab-btn ${tab === 'active-staff' ? 'active' : ''}`} onClick={() => setTab('active-staff')}>
              Active Staff {staffTotal > 0 && `(${staffTotal})`}
            </button>
          )}
          {canStaff && (
            <button className={`tab-btn ${tab === 'shifts' ? 'active' : ''}`} onClick={() => setTab('shifts')}>
              Shifts {shifts.length > 0 && `(${shifts.length})`}
            </button>
          )}
          {isAdmin && (
            <button className={`tab-btn ${tab === 'managers' ? 'active' : ''}`} onClick={() => setTab('managers')}>
              Managers {managers.length > 0 && `(${managers.length})`}
            </button>
          )}
        </div>

        {/* ─── Applications Tab ─── */}
        {tab === 'applications' && (
          <>
            <div className="card card-sm mb-2" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-input" style={{ maxWidth: 240, marginBottom: 0 }}
                placeholder="Search by name or email…"
                value={appSearch} onChange={e => setAppSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {APP_FILTER_KEYS.map(f => {
                  let count;
                  if (f === 'archived') count = archivedCount;
                  else if (f === 'all') count = statusCounts.all ?? appTotal;
                  else count = statusCounts[f] || 0;
                  const isActive = appFilter === f;
                  return (
                    <button
                      key={f}
                      className={`btn btn-sm ${isActive ? 'btn-dark' : 'btn-secondary'}`}
                      onClick={() => { setAppFilter(f); setAppPage(1); }}
                    >
                      {f === 'all' ? 'All' : f === 'archived' ? 'Archived' : (STATUS_LABELS[f] || f)}
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: isActive ? 'rgba(255,255,255,0.22)' : (f === 'archived' ? '#888' : 'var(--amber)'),
                        color: 'white', borderRadius: '99px',
                        fontSize: '0.65rem', fontWeight: 700,
                        minWidth: 17, height: 17, padding: '0 4px', marginLeft: '0.35rem',
                      }}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {appsLoading ? (
              <div className="loading"><div className="spinner" />Loading applications…</div>
            ) : filteredApps.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No applications found.</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }} ref={tableRef}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Applicant</th>
                        <th>Status</th>
                        <th>Positions</th>
                        <th>Location</th>
                        <th>Experience</th>
                        <th
                          style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                          onClick={() => toggleSort('applied_at')}
                        >
                          Applied <SortIcon field="applied_at" />
                        </th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredApps.map(a => {
                        let positions = [];
                        try { positions = JSON.parse(a.positions_interested || '[]'); } catch (e) {}
                        const isEditing = editingStatus === a.id;

                        return (
                          <tr key={a.id} onClick={() => navigate(`/admin/staffing/applications/${a.id}`)}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{a.full_name}</div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{a.email}</div>
                            </td>

                            {/* Clickable status badge */}
                            <td style={{ position: 'relative' }}>
                              <div
                                onClick={e => { e.stopPropagation(); setEditingStatus(isEditing ? null : a.id); }}
                                title="Click to change status"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', cursor: 'pointer' }}
                              >
                                <StatusBadge status={a.onboarding_status} />
                                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', lineHeight: 1 }}>▾</span>
                              </div>

                              {isEditing && (
                                <div style={{
                                  position: 'absolute', top: '100%', left: 0, zIndex: 200,
                                  background: 'var(--card-bg)', border: '2px solid var(--border-dark)',
                                  borderRadius: 'var(--radius)', padding: '0.35rem',
                                  boxShadow: 'var(--shadow-lg)', minWidth: 155,
                                }}>
                                  {(isArchivedTab
                                  ? ['applied', 'interviewing', 'hired']
                                  : ['applied', 'interviewing', 'hired', 'rejected']
                                ).map(s => (
                                    <button
                                      key={s}
                                      onClick={e => { e.stopPropagation(); handleInlineStatusChange(a.id, s); }}
                                      style={{
                                        display: 'block', width: '100%', textAlign: 'left',
                                        background: 'none', border: 'none', cursor: 'pointer',
                                        padding: '0.35rem 0.5rem', borderRadius: 'var(--radius)',
                                        transition: 'background 0.1s',
                                      }}
                                      onMouseEnter={e => e.currentTarget.style.background = 'var(--parchment)'}
                                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                                    >
                                      <StatusBadge status={s} />
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>

                            <td style={{ fontSize: '0.82rem' }}>{positions.join(', ') || '—'}</td>
                            <td style={{ fontSize: '0.82rem' }}>{a.city}, {a.state}</td>
                            <td style={{ fontSize: '0.82rem' }}>{a.has_bartending_experience ? '✅ Yes' : '❌ No'}</td>
                            <td style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                              {new Date(a.applied_at || a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </td>
                            <td>
                              <button className="btn btn-secondary btn-sm"
                                onClick={e => { e.stopPropagation(); navigate(`/admin/staffing/applications/${a.id}`); }}>
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
            <Pagination page={appPage} totalPages={appTotalPages} setPage={setAppPage} />
          </>
        )}

        {/* ─── Onboarding Tab ─── */}
        {tab === 'onboarding' && (
          <>
            <div className="card card-sm mb-2" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="form-input" style={{ maxWidth: 240, marginBottom: 0 }}
                placeholder="Search by email or name…"
                value={userSearch} onChange={e => setUserSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                {USER_FILTER_KEYS.map(f => (
                  <button key={f}
                    className={`btn btn-sm ${userFilter === f ? 'btn-dark' : 'btn-secondary'}`}
                    onClick={() => setUserFilter(f)}>
                    {f === 'all' ? 'All' : STATUS_LABELS[f] || f.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            {usersLoading ? (
              <div className="loading"><div className="spinner" />Loading contractors…</div>
            ) : filteredUsers.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No contractors found.</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Contractor</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Last Step</th>
                        <th>Signed</th>
                        <th>Joined</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(u => {
                        const pct = calcPct(u);
                        return (
                          <tr key={u.id} onClick={() => navigate(`/admin/staffing/users/${u.id}`)}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{u.preferred_name || '—'}</div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{u.email}</div>
                            </td>
                            <td><StatusBadge status={u.onboarding_status} /></td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <div style={{ flex: 1, minWidth: 80 }}>
                                  <div className="progress-track">
                                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                                  </div>
                                </div>
                                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{pct}%</span>
                              </div>
                            </td>
                            <td style={{ fontSize: '0.82rem' }}>{u.last_completed_step?.replace(/_/g, ' ') || '—'}</td>
                            <td style={{ fontSize: '0.82rem' }}>{u.signed_at ? new Date(u.signed_at).toLocaleDateString() : '—'}</td>
                            <td style={{ fontSize: '0.82rem' }}>{new Date(u.created_at).toLocaleDateString()}</td>
                            <td>
                              <button className="btn btn-secondary btn-sm"
                                onClick={e => { e.stopPropagation(); navigate(`/admin/staffing/users/${u.id}`); }}>
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
            <Pagination page={userPage} totalPages={userTotalPages} setPage={setUserPage} />
          </>
        )}

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
                        <th>City</th>
                        <th>Status</th>
                        <th>Approved</th>
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
                        .map(s => (
                          <tr key={s.id} onClick={() => navigate(`/admin/staffing/users/${s.id}`)}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.preferred_name || '—'}</div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{s.email}</div>
                            </td>
                            <td style={{ fontSize: '0.82rem' }}>{s.phone || '—'}</td>
                            <td style={{ fontSize: '0.82rem' }}>{s.city || '—'}</td>
                            <td><StatusBadge status={s.onboarding_status} /></td>
                            <td style={{ fontSize: '0.82rem' }}>
                              {s.approved_at ? new Date(s.approved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                            </td>
                            <td>
                              <button className="btn btn-secondary btn-sm"
                                onClick={e => { e.stopPropagation(); navigate(`/admin/staffing/users/${s.id}`); }}>
                                View →
                              </button>
                            </td>
                          </tr>
                        ))}
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
                      <label className="form-label">Event Name *</label>
                      <input className="form-input" required value={shiftForm.event_name}
                        onChange={e => setShiftForm(f => ({ ...f, event_name: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label">Event Date *</label>
                      <input className="form-input" type="date" required value={shiftForm.event_date}
                        onChange={e => setShiftForm(f => ({ ...f, event_date: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label">Start Time</label>
                      <input className="form-input" type="time" value={shiftForm.start_time}
                        onChange={e => setShiftForm(f => ({ ...f, start_time: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label">End Time</label>
                      <input className="form-input" type="time" value={shiftForm.end_time}
                        onChange={e => setShiftForm(f => ({ ...f, end_time: e.target.value }))} />
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
                  try { positions = JSON.parse(shift.positions_needed || '[]'); } catch (e) {}
                  const requests = shiftRequests[shift.id] || [];

                  return (
                    <div key={shift.id} className="card" style={{ padding: '1rem' }}>
                      {/* Shift header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: '1rem' }}>{shift.event_name}</strong>
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
                                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{req.phone || req.email}</div>
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

        {/* ─── Managers Tab ─── */}
        {tab === 'managers' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{managers.length} manager{managers.length !== 1 ? 's' : ''}</span>
              <button className="btn btn-primary btn-sm" onClick={() => setShowManagerForm(v => !v)}>
                {showManagerForm ? '✕ Cancel' : '+ Add Manager'}
              </button>
            </div>

            {/* Add manager form */}
            {showManagerForm && (
              <div className="card mb-3" style={{ border: '2px solid var(--amber)' }}>
                <h3 style={{ marginBottom: '1rem' }}>Add Manager Account</h3>
                <form onSubmit={createManager}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    <div>
                      <label className="form-label">Email *</label>
                      <input className="form-input" type="email" required value={managerForm.email}
                        onChange={e => setManagerForm(f => ({ ...f, email: e.target.value }))} />
                    </div>
                    <div>
                      <label className="form-label">Temporary Password *</label>
                      <input className="form-input" type="password" required minLength={6} value={managerForm.password}
                        onChange={e => setManagerForm(f => ({ ...f, password: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                      <input type="checkbox" checked={managerForm.can_hire}
                        onChange={e => setManagerForm(f => ({ ...f, can_hire: e.target.checked }))} />
                      Can hire (Applications tab)
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                      <input type="checkbox" checked={managerForm.can_staff}
                        onChange={e => setManagerForm(f => ({ ...f, can_staff: e.target.checked }))} />
                      Can staff (Active Staff + Shifts tabs)
                    </label>
                  </div>
                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                    <button type="submit" className="btn btn-primary">Create Manager</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowManagerForm(false)}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

            {/* Managers list */}
            {managersLoading ? (
              <div className="loading"><div className="spinner" />Loading managers…</div>
            ) : managers.length === 0 ? (
              <div className="card text-center"><p className="text-muted italic">No managers added yet.</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th style={{ textAlign: 'center' }}>Can Hire</th>
                        <th style={{ textAlign: 'center' }}>Can Staff</th>
                        <th>Added</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {managers.map(mgr => (
                        <tr key={mgr.id}>
                          <td style={{ fontWeight: 600, fontSize: '0.9rem' }}>{mgr.email}</td>
                          <td style={{ textAlign: 'center' }}>
                            <label style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={!!mgr.can_hire}
                                onChange={e => updateManagerPermissions(mgr, 'can_hire', e.target.checked)}
                                style={{ width: 16, height: 16 }}
                              />
                            </label>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <label style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={!!mgr.can_staff}
                                onChange={e => updateManagerPermissions(mgr, 'can_staff', e.target.checked)}
                                style={{ width: 16, height: 16 }}
                              />
                            </label>
                          </td>
                          <td style={{ fontSize: '0.82rem' }}>
                            {new Date(mgr.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </td>
                          <td>
                            <button className="btn btn-danger btn-sm" onClick={() => deleteManager(mgr.id)}>Remove</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
  );
}
