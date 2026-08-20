import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import api from '../../utils/api';
import useUrlListState from '../../hooks/useUrlListState';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { formatPhone, stripPhone } from '../../utils/formatPhone';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import KebabMenu from '../../components/adminos/KebabMenu';
import ClickableRow from '../../components/ClickableRow';
import AssignToEventModal from './userDetail/components/AssignToEventModal';

// URL-backed view state (admin cross-nav). Module scope = stable identity.
const STAFF_DEFAULTS = { tab: 'active', page: '1' };
const STAFF_TABS = ['active', 'deactivated', 'all'];
const PAGE_SIZE = 100; // the endpoint's max; groups and footer count from the same universe as the hub counts

function isLegacyCcStub(s) {
  return typeof s?.cc_id === 'string'
    && s.cc_id.startsWith('legacy_cc:')
    && s.onboarding_status === 'deactivated';
}

// Imported placeholder identities: legacy CC stubs and the payment-history
// import's @imported.invalid accounts. Status-scoped to match the server's
// imported_count predicate (spec section 5).
export function isImportedRecord(s) {
  return isLegacyCcStub(s)
    || (s?.onboarding_status === 'deactivated' && s?.import_source === 'payment_history_import');
}

function initialsOf(s) {
  if (!s?.display_name && !s?.preferred_name && !s?.email) return '?';
  const src = s.display_name || s.preferred_name || s.email;
  return src.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function StaffDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user: currentUser } = useAuth();
  // The Staff hub owns the page header and shares its summary through Outlet
  // context; a bare render outside the hub (a test) has none, so tolerate null.
  const { summary, setActions } = useOutletContext() || {};
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [meta, setMeta] = useState({ total: 0, pages: 1 });
  const [listState, setListState] = useUrlListState(STAFF_DEFAULTS);
  const tab = STAFF_TABS.includes(listState.tab) ? listState.tab : STAFF_DEFAULTS.tab;
  const page = Math.max(1, parseInt(listState.page, 10) || 1);
  const [assignTarget, setAssignTarget] = useState(null);

  // The hub renders whatever the landed child registers in .page-actions.
  useEffect(() => {
    if (!setActions) return undefined;
    setActions(
      <button type="button" className="btn btn-primary" onClick={() => navigate('/staffing/legacy')}>
        <Icon name="send" />Send SMS
      </button>
    );
    return () => setActions(null);
  }, [setActions, navigate]);

  // include_stubs=true surfaces the deactivated placeholders (legacy CC stubs
  // and the payment-history import) alongside active staff so the operator can
  // see imported records that still need to be linked or removed. The server
  // redacts stub emails for managers as defense in depth; the row render below
  // also hides the email client-side so a stale fetch can't leak. limit is the
  // endpoint max so the table's group counts come from the same universe as
  // the hub's counts; past that the footer pages.
  useEffect(() => {
    setLoading(true); setLoadError(false);
    api.get(`/admin/active-staff?include_stubs=true&limit=${PAGE_SIZE}&page=${page}`)
      .then(r => {
        setStaff(r.data?.staff || []);
        setMeta({ total: Number(r.data?.total || 0), pages: Number(r.data?.pages || 1) });
      })
      .catch(() => { setLoadError(true); toast.error('Failed to load staff. Try refreshing.'); })
      .finally(() => setLoading(false));
  }, [toast, page, reloadKey]);

  const active = useMemo(() => staff.filter(s => s.onboarding_status === 'approved'), [staff]);
  const deactivated = useMemo(() => staff.filter(s => s.onboarding_status === 'deactivated'), [staff]);
  const former = useMemo(() => deactivated.filter(s => !isImportedRecord(s)), [deactivated]);
  const imported = useMemo(() => deactivated.filter(isImportedRecord), [deactivated]);
  // The feed also returns 'reviewed' and 'submitted': onboarding is finished
  // (it requires onboarding_completed) but admin approval is still pending.
  // They are neither Active nor Deactivated, so without a bucket of their own
  // the All view drops them from the table while the footer still counts them.
  const awaiting = useMemo(
    () => staff.filter(s => s.onboarding_status !== 'approved' && s.onboarding_status !== 'deactivated'),
    [staff]
  );

  // Rows in render order, with group header markers where the view has groups.
  const rows = useMemo(() => {
    if (tab === 'active') return active.map(s => ({ kind: 'row', s }));
    const groups = [
      { label: 'Former staff', items: former },
      { label: 'Imported records', items: imported },
    ];
    if (tab === 'all') {
      groups.unshift({ label: 'Awaiting approval', items: awaiting });
      groups.unshift({ label: 'Active', items: active });
    }
    return groups
      .filter(g => g.items.length > 0)
      .flatMap(g => ([{ kind: 'sect', label: g.label, count: g.items.length }, ...g.items.map(s => ({ kind: 'row', s }))]));
  }, [tab, active, awaiting, former, imported]);

  // Tab counts prefer the server's whole-table numbers, falling back to the
  // loaded slice while the hub summary is still in flight or unavailable.
  const tabs = useMemo(() => ([
    { id: 'active', label: 'Active', count: summary?.active_count ?? active.length },
    { id: 'deactivated', label: 'Deactivated', count: summary?.deactivated_count ?? deactivated.length },
    { id: 'all', label: 'All', count: (summary?.active_count ?? active.length) + (summary?.deactivated_count ?? deactivated.length) + awaiting.length },
  ]), [summary, active.length, deactivated.length, awaiting.length]);

  const rosterEmpty = !loading && !loadError && tab === 'active' && active.length === 0;

  return (
    <>
      <Toolbar tabs={tabs} tab={tab} setTab={(t) => setListState({ tab: t, page: '1' })} />

      {rosterEmpty ? (
        <div className="card">
          <div className="hub-empty">
            <h4>No active staff yet</h4>
            <p>
              Approved hires land here on their own once onboarding completes.
              {summary?.new_applications > 0
                ? ` ${summary.new_applications === 1 ? 'One application is' : `${summary.new_applications} applications are`} waiting for a first look right now.`
                : ''}
            </p>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/staffing/hiring')}>
              Open Hiring
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="tbl-wrap">
            {/* .tbl is width:100% with no floor, so under ~760px the columns
                squeeze (phone numbers break across three lines) instead of the
                wrapper scrolling. Artboard 1j's law: wide tables scroll in
                .tbl-wrap, never the page. */}
            <table className="tbl" style={{ minWidth: 760 }}>
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
                {!loading && loadError && (
                  <tr><td colSpan={7}><span className="muted">Could not load staff.</span>{' '}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReloadKey(k => k + 1)}>Retry</button></td></tr>
                )}
                {!loading && rows.map(r => {
                  if (r.kind === 'sect') {
                    return (
                      <tr key={`sect-${r.label}`} className="roster-sect">
                        <td colSpan={7}>{r.label} · {r.count}</td>
                      </tr>
                    );
                  }
                  const s = r.s;
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
                            <strong>{s.display_name || s.preferred_name || displayEmail}</strong>
                            {isStub && (
                              <span className="badge badge-legacy-cc-stub">Legacy CC stub</span>
                            )}
                            {s.import_source === 'payment_history_import' && (
                              <span className="imported-chip">imported</span>
                            )}
                            {isImportedRecord(s)
                              ? <div className="sub">{isStub && !isAdmin ? 'email redacted for managers' : 'no email on file'}</div>
                              : ((s.display_name || s.preferred_name) && s.email && <div className="sub">{displayEmail}</div>)}
                          </div>
                        </div>
                      </td>
                      <td className="muted">{s.role === 'manager' ? 'Manager' : 'Staff'}</td>
                      <td>
                        {s.onboarding_status === 'approved' && <StatusChip kind="ok">Active</StatusChip>}
                        {s.onboarding_status === 'deactivated' && <StatusChip kind="neutral">Deactivated</StatusChip>}
                        {s.onboarding_status !== 'approved' && s.onboarding_status !== 'deactivated' && (
                          <StatusChip kind="warn">Awaiting approval</StatusChip>
                        )}
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
                            onClick: () => setAssignTarget({ id: s.id, name: s.display_name || s.preferred_name || s.email }),
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
      )}

      {!loading && !rosterEmpty && (
        <div className="tiny muted hstack" style={{ padding: '8px 2px', gap: 12 }}>
          <span>
            {tab === 'active' && `${active.length} active`}
            {tab === 'deactivated' && `${deactivated.length} deactivated · ${former.length} former staff, ${imported.length} imported records`}
            {tab === 'all' && `${staff.length} ${staff.length === 1 ? 'team member' : 'team members'}`}
          </span>
          {meta.pages > 1 && (
            <>
              <span>Showing page {page} of {meta.pages} ({meta.total} total)</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setListState({ page: String(page - 1) })}>Prev</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={page >= meta.pages} onClick={() => setListState({ page: String(page + 1) })}>Next</button>
            </>
          )}
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
    </>
  );
}
