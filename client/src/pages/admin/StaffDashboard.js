import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatPhone } from '../../utils/formatPhone';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';

function initialsOf(s) {
  if (!s?.preferred_name && !s?.email) return '?';
  const src = s.preferred_name || s.email;
  return src.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function StaffDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('active');

  useEffect(() => {
    api.get('/admin/active-staff')
      .then(r => setStaff(r.data?.staff || []))
      .catch(() => toast.error('Failed to load staff. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  const filtered = useMemo(() => staff.filter(s => {
    if (tab === 'active' && s.onboarding_status !== 'approved') return false;
    if (tab === 'onboarding' && !['submitted', 'reviewed'].includes(s.onboarding_status)) return false;
    if (search) {
      const q = search.toLowerCase();
      const fields = [s.preferred_name, s.email, s.phone, s.city, s.state].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  }), [staff, tab, search]);

  const tabs = useMemo(() => ([
    { id: 'active', label: 'Active', count: staff.filter(s => s.onboarding_status === 'approved').length },
    { id: 'onboarding', label: 'Onboarding', count: staff.filter(s => ['submitted', 'reviewed'].includes(s.onboarding_status)).length },
    { id: 'all', label: 'All' },
  ]), [staff]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Staff</div>
          <div className="page-subtitle">Active roster — hiring pipeline lives next door.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/hiring')}>
            <Icon name="external" />Open hiring
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/staffing/legacy')}>
            <Icon name="send" />Send SMS
          </button>
        </div>
      </div>

      <Toolbar search={search} setSearch={setSearch} tabs={tabs} tab={tab} setTab={setTab} />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Phone</th>
                <th>City</th>
                <th>Equipment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (<tr><td colSpan={7} className="muted">Loading…</td></tr>)}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} className="muted">No staff match these filters.</td></tr>
              )}
              {!loading && filtered.map(s => {
                const equipment = [
                  s.equipment_portable_bar && 'Bar',
                  s.equipment_cooler && 'Cooler',
                  s.equipment_table_with_spandex && 'Table',
                ].filter(Boolean);
                return (
                  <tr key={s.id} onClick={() => navigate(`/staffing/users/${s.id}`)}>
                    <td>
                      <div className="hstack">
                        <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initialsOf(s)}</div>
                        <div>
                          <strong>{s.preferred_name || s.email}</strong>
                          {s.preferred_name && s.email && <div className="sub">{s.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="muted">{s.role === 'manager' ? 'Manager' : 'Staff'}</td>
                    <td>
                      <StatusChip kind={s.onboarding_status === 'approved' ? 'ok' : 'warn'}>
                        {s.onboarding_status === 'approved' ? 'Active' : 'Onboarding'}
                      </StatusChip>
                    </td>
                    <td className="muted mono">{s.phone ? formatPhone(s.phone) : '—'}</td>
                    <td className="muted">
                      {s.city && s.state ? `${s.city}, ${s.state}` : (s.city || s.state || '—')}
                    </td>
                    <td className="tiny muted">{equipment.length ? equipment.join(' · ') : '—'}</td>
                    <td className="shrink">
                      <button type="button" className="icon-btn" onClick={(e) => e.stopPropagation()} title="More">
                        <Icon name="kebab" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {filtered.length} {filtered.length === 1 ? 'team member' : 'team members'}
        </div>
      )}
    </div>
  );
}
