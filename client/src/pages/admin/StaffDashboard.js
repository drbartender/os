import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { formatPhone, stripPhone } from '../../utils/formatPhone';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import KebabMenu from '../../components/adminos/KebabMenu';
import ClickableRow from '../../components/ClickableRow';
import AssignToEventModal from './userDetail/components/AssignToEventModal';

function isLegacyCcStub(s) {
  return typeof s?.cc_id === 'string'
    && s.cc_id.startsWith('legacy_cc:')
    && s.onboarding_status === 'deactivated';
}

function initialsOf(s) {
  if (!s?.preferred_name && !s?.email) return '?';
  const src = s.preferred_name || s.email;
  return src.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function StaffDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('active');
  const [assignTarget, setAssignTarget] = useState(null);

  // include_stubs=true surfaces legacy CC stub users (cc_id LIKE 'legacy_cc:%',
  // onboarding_status='deactivated') alongside active staff so the operator can
  // see imported placeholders that still need to be linked or removed. The
  // server redacts their emails for managers as defense in depth; the row
  // render below also hides the email client-side so a stale fetch can't leak.
  useEffect(() => {
    api.get('/admin/active-staff?include_stubs=true')
      .then(r => setStaff(r.data?.staff || []))
      .catch(() => toast.error('Failed to load staff. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  const filtered = useMemo(() => staff.filter(s => {
    if (tab === 'active' && s.onboarding_status !== 'approved') return false;
    if (search) {
      const q = search.toLowerCase();
      const fields = [s.preferred_name, s.email, s.phone, s.city, s.state].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  }), [staff, tab, search]);

  const tabs = useMemo(() => ([
    { id: 'active', label: 'Active', count: staff.filter(s => s.onboarding_status === 'approved').length },
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
                const isStub = isLegacyCcStub(s);
                const isAdmin = currentUser?.role === 'admin';
                // Server already redacts the email for non-admin callers; this
                // is the second safety net so a stale fetch can't briefly leak.
                const displayEmail = (isStub && !isAdmin) ? '(redacted)' : s.email;
                return (
                  <ClickableRow key={s.id} to={`/staffing/users/${s.id}`}>
                    <td>
                      <div className="hstack">
                        <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initialsOf(s)}</div>
                        <div>
                          <strong>{s.preferred_name || displayEmail}</strong>
                          {isStub && (
                            <span className="badge badge-legacy-cc-stub">Legacy CC stub (deactivated)</span>
                          )}
                          {s.preferred_name && s.email && <div className="sub">{displayEmail}</div>}
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
                    <td className="shrink" onMouseUp={(ev) => ev.stopPropagation()}>
                      <KebabMenu items={[
                        {
                          label: 'Email',
                          icon: 'mail',
                          href: (s.email && !isStub) ? `mailto:${s.email}` : undefined,
                          disabled: !s.email || isStub,
                        },
                        {
                          label: 'Call',
                          icon: 'phone',
                          href: s.phone ? `tel:${stripPhone(s.phone)}` : undefined,
                          disabled: !s.phone,
                        },
                        {
                          label: 'Text',
                          icon: 'chat',
                          href: s.phone ? `sms:${stripPhone(s.phone)}` : undefined,
                          disabled: !s.phone,
                        },
                        {
                          label: 'Copy Phone',
                          icon: 'copy',
                          disabled: !s.phone,
                          onClick: () => {
                            navigator.clipboard.writeText(formatPhone(s.phone))
                              .then(() => toast.success('Phone copied.'))
                              .catch(() => toast.error('Copy failed.'));
                          },
                        },
                        {
                          label: 'Assign to Event',
                          icon: 'userplus',
                          onClick: () => setAssignTarget({ id: s.id, name: s.preferred_name || s.email }),
                        },
                      ]} />
                    </td>
                  </ClickableRow>
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

      {assignTarget && (
        <AssignToEventModal
          userId={assignTarget.id}
          staffName={assignTarget.name}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {}}
          toast={toast}
        />
      )}
    </div>
  );
}
