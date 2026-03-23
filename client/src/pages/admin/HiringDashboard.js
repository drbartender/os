import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';

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

const APP_FILTER_KEYS  = ['all', 'applied', 'interviewing', 'archived'];
const USER_FILTER_KEYS = ['all', 'hired', 'in_progress', 'deactivated'];

export default function HiringDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('applications');

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
  const [editingStatus, setEditingStatus] = useState(null);
  const tableRef = useRef(null);

  // Onboarding users state
  const [users, setUsers]                 = useState([]);
  const [usersLoading, setUsersLoading]   = useState(true);
  const [userFilter, setUserFilter]       = useState('all');
  const [userSearch, setUserSearch]       = useState('');
  const [userPage, setUserPage]           = useState(1);
  const [userTotalPages, setUserTotalPages] = useState(1);
  const [userTotal, setUserTotal]         = useState(0);

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

  // Fetch applications
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

  async function handleInlineStatusChange(userId, newStatus) {
    const prevApp = apps.find(a => a.id === userId);
    const oldStatus = prevApp?.onboarding_status;
    setEditingStatus(null);
    try {
      await api.put(`/admin/users/${userId}/status`, { status: newStatus });

      if (newStatus === 'rejected' || newStatus === 'hired') {
        // Remove from applications list — rejected goes to archive, hired moves to onboarding
        setApps(prev => prev.filter(a => a.id !== userId));
        if (newStatus === 'rejected') setArchivedCount(prev => prev + 1);
        setAppTotal(prev => Math.max(0, prev - 1));
        if (oldStatus) {
          setStatusCounts(prev => ({
            ...prev,
            [oldStatus]: Math.max(0, (prev[oldStatus] || 0) - 1),
            all: Math.max(0, (prev.all || 0) - 1),
          }));
        }
      } else if (oldStatus === 'rejected') {
        setApps(prev => prev.filter(a => a.id !== userId));
        setArchivedCount(prev => Math.max(0, prev - 1));
        setAppTotal(prev => prev + 1);
        setStatusCounts(prev => ({
          ...prev,
          [newStatus]: (prev[newStatus] || 0) + 1,
          all: (prev.all || 0) + 1,
        }));
      } else {
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
          <h1 style={{ marginBottom: '0.2rem' }}>Hiring</h1>
          <p className="text-muted text-small">Applications and onboarding</p>
        </div>
      </div>

      <div className="tab-nav" style={{ marginBottom: '1rem' }}>
        <button className={`tab-btn ${tab === 'applications' ? 'active' : ''}`} onClick={() => setTab('applications')}>
          Applications ({statusCounts.all ?? appTotal})
        </button>
        <button className={`tab-btn ${tab === 'onboarding' ? 'active' : ''}`} onClick={() => setTab('onboarding')}>
          Onboarding ({userTotal})
        </button>
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
    </div>
  );
}
