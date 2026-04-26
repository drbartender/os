import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { formatPhone, formatPhoneInput, stripPhone } from '../utils/formatPhone';
import { useToast } from '../context/ToastContext';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import { getEventTypeLabel } from '../utils/eventTypes';
import Icon from '../components/adminos/Icon';
import StatusChip from '../components/adminos/StatusChip';
import { fmt$, fmtDate, fmtDateFull, relDay } from '../components/adminos/format';

// Until per-staff hourly rate + a payouts ledger exist in the schema, YTD
// earnings is an estimate: `(past shifts this calendar year) × DEFAULT_HOURS
// × DEFAULT_HOURLY`. Once those tables land, swap this for the real sum.
const DEFAULT_HOURS_PER_SHIFT = 4;
const DEFAULT_HOURLY_RATE = 40;

function computeYtdEstEarnings(pastEvents) {
  const yr = new Date().getFullYear();
  const ytdCount = (pastEvents || []).filter(ev => {
    if (!ev.event_date) return false;
    const d = new Date(String(ev.event_date).slice(0, 10) + 'T12:00:00');
    return !Number.isNaN(d.getTime()) && d.getFullYear() === yr;
  }).length;
  return ytdCount * DEFAULT_HOURS_PER_SHIFT * DEFAULT_HOURLY_RATE;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function initialsOf(name, email) {
  const src = (name || email || '?').trim();
  return src.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

const PAYMENT_METHODS = ['Zelle', 'Venmo', 'CashApp', 'PayPal', 'Direct Deposit'];

const TabButton = ({ active, count, children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      padding: '10px 16px',
      background: 'transparent',
      border: 0,
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
      marginBottom: -1,
      color: active ? 'var(--ink-1)' : 'var(--ink-3)',
      fontWeight: active ? 600 : 400,
      cursor: 'pointer',
      fontSize: 13,
      whiteSpace: 'nowrap',
    }}
  >
    {children}
    {count != null && <span className="muted" style={{ marginLeft: 4 }}>{count}</span>}
  </button>
);

const Sparkbars = ({ values }) => {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 32 }}>
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: Math.max(2, (v / max) * 32),
            background: i === values.length - 1 ? 'var(--ink-1)' : 'var(--line-2)',
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AdminUserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  const [statusLoading, setStatusLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [permsSaving, setPermsSaving] = useState(false);

  // Profile/payment edit shared state
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileFieldErrors, setProfileFieldErrors] = useState({});

  // Seniority state
  const [seniority, setSeniority] = useState(null);
  const [seniorityLoading, setSeniorityLoading] = useState(false);
  const [seniorityForm, setSeniorityForm] = useState({ seniority_adjustment: 0, hire_date: '' });
  const [senioritySaving, setSenioritySaving] = useState(false);
  const [seniorityError, setSeniorityError] = useState('');
  const [seniorityFieldErrors, setSeniorityFieldErrors] = useState({});

  // Events
  const [events, setEvents] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Messages
  const [userMessages, setUserMessages] = useState([]);
  const [userMsgLoading, setUserMsgLoading] = useState(false);
  const [userMsgBody, setUserMsgBody] = useState('');
  const [userMsgType, setUserMsgType] = useState('general');
  const [userMsgSending, setUserMsgSending] = useState(false);
  const [userMsgResult, setUserMsgResult] = useState(null);

  // Initial load
  useEffect(() => {
    api.get(`/admin/users/${id}`)
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load contractor record. Try refreshing.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Always pre-load events + seniority so the identity bar stat row + Overview
  // shifts table don't flicker when switching tabs.
  useEffect(() => {
    if (!data) return;
    setEventsLoading(true);
    api.get(`/shifts/user/${id}/events`)
      .then(r => setEvents(r.data))
      .catch(() => { /* non-blocking */ })
      .finally(() => setEventsLoading(false));
    setSeniorityLoading(true);
    api.get(`/admin/users/${id}/seniority`)
      .then(r => {
        setSeniority(r.data);
        setSeniorityForm({
          seniority_adjustment: r.data.seniority_adjustment || 0,
          hire_date: r.data.hire_date ? String(r.data.hire_date).slice(0, 10) : '',
        });
      })
      .catch(() => { /* non-blocking */ })
      .finally(() => setSeniorityLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.user?.id, id]);

  // Lazy-load messages only when the tab opens
  useEffect(() => {
    if (tab !== 'messages') return;
    setUserMsgLoading(true);
    api.get(`/messages/user/${id}`)
      .then(r => setUserMessages(r.data?.messages || []))
      .catch(() => toast.error('Failed to load message history. Try refreshing.'))
      .finally(() => setUserMsgLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  if (loading) return <div className="page"><div className="muted">Loading contractor record…</div></div>;
  if (!data) return (
    <div className="page">
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/staffing')}>
          <Icon name="left" size={11} />Staff
        </button>
      </div>
      <div className="chip danger">Contractor not found.</div>
    </div>
  );

  const { user, progress, profile, agreement, payment, application } = data;
  const isDeactivated = user.onboarding_status === 'deactivated';
  const isOnboarding = !progress?.onboarding_completed && !isDeactivated;
  const displayName = profile?.preferred_name || user.email;

  // ── Saved actions ─────────────────────────────────────────────
  const updateStatus = async (status) => {
    setConfirmAction(null);
    setStatusLoading(true);
    try {
      await api.put(`/admin/users/${id}/status`, { status });
      setData(d => ({ ...d, user: { ...d.user, onboarding_status: status } }));
      toast.success(
        status === 'deactivated' ? 'Account deactivated.' :
        status === 'submitted' ? 'Account reactivated.' :
        `Status changed to ${status}.`
      );
    } catch (e) {
      toast.error(e.message || 'Failed to update status.');
    } finally {
      setStatusLoading(false);
    }
  };

  const updatePermission = async (field, value) => {
    setPermsSaving(true);
    try {
      const current = data.user;
      const r = await api.put(`/admin/users/${id}/permissions`, {
        role: current.role,
        can_hire: current.can_hire || false,
        can_staff: current.can_staff || false,
        [field]: value,
      });
      setData(d => ({ ...d, user: { ...d.user, ...r.data } }));
      toast.success('Permissions updated.');
    } catch (e) {
      toast.error(e.message || 'Failed to update permissions.');
    } finally {
      setPermsSaving(false);
    }
  };

  const downloadFile = async (url) => {
    try {
      const response = await api.get(url);
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(e.message || 'Could not open file.');
    }
  };

  const startEditing = () => {
    const p = profile || {};
    const pay = payment || {};
    setEditForm({
      preferred_name: p.preferred_name || '',
      phone: p.phone || '',
      email: p.email || user.email || '',
      birth_month: p.birth_month || '',
      birth_day: p.birth_day || '',
      birth_year: p.birth_year || '',
      city: p.city || '',
      state: p.state || '',
      street_address: p.street_address || '',
      zip_code: p.zip_code || '',
      travel_distance: p.travel_distance || '',
      reliable_transportation: p.reliable_transportation || '',
      equipment_portable_bar: !!p.equipment_portable_bar,
      equipment_cooler: !!p.equipment_cooler,
      equipment_table_with_spandex: !!p.equipment_table_with_spandex,
      equipment_none_but_open: !!p.equipment_none_but_open,
      equipment_no_space: !!p.equipment_no_space,
      equipment_will_pickup: !!p.equipment_will_pickup,
      emergency_contact_name: p.emergency_contact_name || '',
      emergency_contact_phone: p.emergency_contact_phone || '',
      emergency_contact_relationship: p.emergency_contact_relationship || '',
      preferred_payment_method: pay.preferred_payment_method || '',
      payment_username: pay.payment_username || '',
      routing_number: pay.routing_number || '',
      account_number: pay.account_number || '',
    });
    setProfileError('');
    setProfileFieldErrors({});
    setEditing(true);
  };

  const saveProfile = async () => {
    setSaving(true);
    setProfileError('');
    setProfileFieldErrors({});
    try {
      const r = await api.put(`/admin/users/${id}/profile`, editForm);
      setData(d => ({ ...d, profile: r.data.profile, payment: r.data.payment }));
      setEditing(false);
      toast.success('User updated.');
    } catch (e) {
      setProfileError(e.message || 'Failed to save changes.');
      setProfileFieldErrors(e.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const saveSeniority = async () => {
    setSenioritySaving(true);
    setSeniorityError('');
    setSeniorityFieldErrors({});
    try {
      await api.put(`/admin/users/${id}/seniority`, {
        seniority_adjustment: parseInt(seniorityForm.seniority_adjustment, 10) || 0,
        hire_date: seniorityForm.hire_date || null,
      });
      const r = await api.get(`/admin/users/${id}/seniority`);
      setSeniority(r.data);
      toast.success('Seniority updated.');
    } catch (e) {
      setSeniorityError(e.message || 'Failed to save seniority.');
      setSeniorityFieldErrors(e.fieldErrors || {});
    } finally {
      setSenioritySaving(false);
    }
  };

  const sendUserMessage = async (e) => {
    e.preventDefault();
    if (!userMsgBody.trim()) return;
    setUserMsgSending(true);
    setUserMsgResult(null);
    try {
      const r = await api.post('/messages/send', {
        recipient_ids: [parseInt(id, 10)],
        body: userMsgBody.trim(),
        message_type: userMsgType,
      });
      setUserMsgResult(r.data);
      setUserMsgBody('');
      setUserMsgType('general');
      const hist = await api.get(`/messages/user/${id}`);
      setUserMessages(hist.data?.messages || []);
    } catch (err) {
      setUserMsgResult({ error: err.message || 'Failed to send' });
    } finally {
      setUserMsgSending(false);
    }
  };

  // ── Derived values ───────────────────────────────────────────
  const upcomingEvents = events?.upcoming || [];
  const pastEvents = events?.past || [];
  const totalShifts = upcomingEvents.length + pastEvents.length;
  const ytdEarningsEst = computeYtdEstEarnings(pastEvents);

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/staffing')}>
          <Icon name="left" size={11} />Staff
        </button>
      </div>

      {/* ── Identity bar ────────────────────────────────── */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 64, height: 64, fontSize: 22, flexShrink: 0 }}>
            {initialsOf(profile?.preferred_name, user.email)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Staff · #{user.id}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, margin: 0, lineHeight: 1.1 }}>
                {displayName}
              </h1>
              <StatusChip kind={isDeactivated ? 'danger' : isOnboarding ? 'warn' : 'ok'}>
                {isDeactivated ? 'Deactivated' : isOnboarding ? 'Onboarding' : 'Active'}
              </StatusChip>
              <span className="tag">{user.role === 'manager' ? 'Manager' : 'Staff'}</span>
              {user.can_hire && <span className="tag">Can hire</span>}
              {user.can_staff && <span className="tag">Can staff</span>}
            </div>
            <div className="hstack" style={{ gap: 16, marginTop: 6, color: 'var(--ink-3)', fontSize: 13, flexWrap: 'wrap' }}>
              <span className="hstack"><Icon name="mail" size={12} />{user.email}</span>
              {profile?.phone && (
                <span className="hstack"><Icon name="phone" size={12} /><span className="mono">{formatPhone(profile.phone)}</span></span>
              )}
              {(profile?.city || profile?.state) && (
                <span className="hstack">
                  <Icon name="location" size={12} />
                  {[profile.city, profile.state].filter(Boolean).join(', ')}
                </span>
              )}
              <span className="hstack"><Icon name="calendar" size={12} />Joined {fmtDate(user.created_at && String(user.created_at).slice(0, 10), { year: 'numeric' })}</span>
            </div>
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setTab('messages')}>
              <Icon name="mail" size={12} />Message
            </button>
            {isDeactivated ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={statusLoading}
                onClick={() => updateStatus('submitted')}
              >
                <Icon name="check" size={12} />Reactivate
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }}
                disabled={statusLoading}
                onClick={() => setConfirmAction({
                  status: 'deactivated',
                  label: 'Deactivate account?',
                  description: `This will block ${displayName} from logging in. This can be reversed.`,
                })}
              >
                Deactivate
              </button>
            )}
          </div>
        </div>

        {/* Stat row */}
        <div className="stat-row" style={{ marginTop: 20 }}>
          <div className="stat">
            <div className="stat-label">Upcoming shifts</div>
            <div className="stat-value">{upcomingEvents.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Total shifts</div>
            <div className="stat-value">{totalShifts}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Seniority</div>
            <div className="stat-value">{seniority?.computed_score ?? '—'}</div>
            <div className="stat-sub">
              <span>{seniority?.tenure_months ? `${seniority.tenure_months}mo tenure · ` : ''}{seniority?.events_worked ?? 0} events worked</span>
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">YTD earnings · est.</div>
            <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{fmt$(ytdEarningsEst)}</div>
            <div className="stat-sub">
              <span>{pastEvents.filter(ev => ev.event_date && new Date(String(ev.event_date).slice(0,10)+'T12:00:00').getFullYear() === new Date().getFullYear()).length} shifts × {DEFAULT_HOURS_PER_SHIFT}hr × ${DEFAULT_HOURLY_RATE}/hr</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────── */}
      <div className="hstack" style={{ marginBottom: 14, borderBottom: '1px solid var(--line-1)', flexWrap: 'wrap' }}>
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
        <TabButton active={tab === 'shifts'} onClick={() => setTab('shifts')} count={totalShifts}>Shifts</TabButton>
        <TabButton active={tab === 'certifications'} onClick={() => setTab('certifications')}>Certifications</TabButton>
        <TabButton active={tab === 'payouts'} onClick={() => setTab('payouts')}>Payouts</TabButton>
        <TabButton active={tab === 'documents'} onClick={() => setTab('documents')}>Documents</TabButton>
        <TabButton active={tab === 'messages'} onClick={() => setTab('messages')} count={userMessages.length || null}>Messages</TabButton>
        {application?.id && (
          <TabButton active={tab === 'application'} onClick={() => setTab('application')}>Application</TabButton>
        )}
      </div>

      {/* ── OVERVIEW ───────────────────────────────────── */}
      {tab === 'overview' && (
        <OverviewTab
          user={user}
          profile={profile}
          upcoming={upcomingEvents}
          recent={pastEvents.slice(0, 4)}
          eventsLoading={eventsLoading}
          editing={editing}
          editForm={editForm}
          setEditForm={setEditForm}
          startEditing={startEditing}
          cancelEditing={() => { setEditing(false); setProfileError(''); setProfileFieldErrors({}); }}
          saveProfile={saveProfile}
          saving={saving}
          profileError={profileError}
          profileFieldErrors={profileFieldErrors}
          permsSaving={permsSaving}
          updatePermission={updatePermission}
          navigate={navigate}
        />
      )}

      {tab === 'shifts' && (
        <ShiftsTab upcoming={upcomingEvents} past={pastEvents} eventsLoading={eventsLoading} navigate={navigate} />
      )}

      {tab === 'certifications' && (
        <CertificationsTab profile={profile} application={application} downloadFile={downloadFile} />
      )}

      {tab === 'payouts' && (
        <PayoutsTab
          payment={payment}
          seniority={seniority}
          seniorityLoading={seniorityLoading}
          seniorityForm={seniorityForm}
          setSeniorityForm={setSeniorityForm}
          saveSeniority={saveSeniority}
          senioritySaving={senioritySaving}
          seniorityError={seniorityError}
          seniorityFieldErrors={seniorityFieldErrors}
          editing={editing}
          editForm={editForm}
          setEditForm={setEditForm}
          startEditing={startEditing}
          cancelEditing={() => { setEditing(false); setProfileError(''); setProfileFieldErrors({}); }}
          saveProfile={saveProfile}
          saving={saving}
          profileError={profileError}
          profileFieldErrors={profileFieldErrors}
        />
      )}

      {tab === 'documents' && (
        <DocumentsTab agreement={agreement} payment={payment} profile={profile} application={application} downloadFile={downloadFile} />
      )}

      {tab === 'messages' && (
        <MessagesTab
          loading={userMsgLoading}
          messages={userMessages}
          sending={userMsgSending}
          body={userMsgBody}
          setBody={setUserMsgBody}
          type={userMsgType}
          setType={setUserMsgType}
          result={userMsgResult}
          send={sendUserMessage}
          recipient={displayName}
        />
      )}

      {tab === 'application' && application?.id && (
        <ApplicationTab application={application} />
      )}

      {/* Confirmation modal */}
      {confirmAction && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
          onClick={() => setConfirmAction(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 420, width: '100%', padding: '1.25rem 1.5rem' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 8, fontSize: 16 }}>{confirmAction.label}</h3>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16 }}>{confirmAction.description}</p>
            <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                style={confirmAction.status === 'deactivated' ? { background: 'hsl(var(--danger-h) var(--danger-s) 50%)', borderColor: 'hsl(var(--danger-h) var(--danger-s) 50%)' } : {}}
                onClick={() => updateStatus(confirmAction.status)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── OVERVIEW TAB ──────────────────────────────────────────────────────────

function OverviewTab(props) {
  const {
    user, profile, upcoming, recent, eventsLoading,
    editing, editForm, setEditForm, startEditing, cancelEditing,
    saveProfile, saving, profileError, profileFieldErrors,
    permsSaving, updatePermission, navigate,
  } = props;

  const monthly = useMemo(() => {
    // Bucket past+upcoming events by month, last 12 months
    const buckets = Array(12).fill(0);
    const now = new Date();
    [...recent, ...upcoming].forEach(ev => {
      if (!ev.event_date) return;
      const d = new Date(String(ev.event_date).slice(0, 10) + 'T12:00:00');
      const monthsAgo = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
      const idx = 11 - monthsAgo;
      if (idx >= 0 && idx < 12) buckets[idx]++;
    });
    return buckets;
  }, [recent, upcoming]);

  const updateField = (k, v) => setEditForm(f => ({ ...f, [k]: v }));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 'var(--gap)' }}>
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {/* Upcoming shifts */}
        <div className="card">
          <div className="card-head">
            <h3>Upcoming shifts</h3>
            <span className="k">{upcoming.length}</span>
          </div>
          {eventsLoading ? (
            <div className="card-body muted tiny">Loading…</div>
          ) : upcoming.length === 0 ? (
            <div className="card-body muted tiny">No upcoming shifts on the books.</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Event</th><th>Date</th><th>Position</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.slice(0, 6).map(ev => (
                    <tr
                      key={`${ev.id}-up`}
                      onClick={() => ev.proposal_id ? navigate(`/admin/events/${ev.proposal_id}`) : navigate(`/admin/events/shift/${ev.id}`)}
                    >
                      <td>
                        <strong>{ev.client_name || 'Event'}</strong>
                        <div className="sub">{getEventTypeLabel({
                          event_type: ev.event_type || ev.proposal_event_type,
                          event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                        })}</div>
                      </td>
                      <td>
                        <div>{ev.event_date ? fmtDate(String(ev.event_date).slice(0, 10)) : '—'}</div>
                        <div className="sub">{ev.event_date ? relDay(String(ev.event_date).slice(0, 10)) : ''}</div>
                      </td>
                      <td className="muted">{ev.position || '—'}</td>
                      <td>
                        <StatusChip kind={ev.request_status === 'approved' ? 'ok' : 'warn'}>
                          {ev.request_status === 'approved' ? 'Confirmed' : 'Pending'}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Performance + monthly sparkbars */}
        <div className="card">
          <div className="card-head">
            <h3>Performance</h3>
            <span className="muted tiny">Last 12 months</span>
          </div>
          <div className="card-body">
            <div className="hstack" style={{ marginBottom: 8 }}>
              <div className="tiny muted" style={{ flex: 1 }}>Shifts per month</div>
              <div className="tiny muted">{Math.max(...monthly)} peak</div>
            </div>
            <Sparkbars values={monthly} />
            <div className="hstack" style={{ marginTop: 6 }}>
              <div className="tiny muted">~12mo ago</div>
              <div className="spacer" style={{ flex: 1 }} />
              <div className="tiny muted">now</div>
            </div>
          </div>
        </div>

        {/* Recent activity (past shifts) */}
        <div className="card">
          <div className="card-head"><h3>Recent activity</h3></div>
          <div className="card-body">
            {recent.length === 0 ? (
              <div className="muted tiny">No completed shifts yet.</div>
            ) : (
              <div className="vstack" style={{ gap: 0 }}>
                {recent.map((ev, i) => (
                  <div
                    key={`${ev.id}-recent`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '14px 1fr 110px',
                      gap: 14,
                      padding: '10px 0',
                      borderBottom: i < recent.length - 1 ? '1px solid var(--line-1)' : 0,
                    }}
                  >
                    <div style={{ position: 'relative', paddingTop: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />
                      {i < recent.length - 1 && (
                        <div style={{ position: 'absolute', left: 3, top: 14, bottom: -10, width: 1, background: 'var(--line-1)' }} />
                      )}
                    </div>
                    <div>
                      <div style={{ fontSize: 13 }}>
                        <strong>Shift completed</strong>
                        <span className="muted" style={{ marginLeft: 6 }}>· {ev.position || 'Bartender'}</span>
                      </div>
                      <div className="tiny muted" style={{ marginTop: 2 }}>
                        {ev.client_name ? `${ev.client_name} · ` : ''}
                        {getEventTypeLabel({
                          event_type: ev.event_type || ev.proposal_event_type,
                          event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                        })}
                      </div>
                    </div>
                    <div className="tiny muted" style={{ textAlign: 'right' }}>
                      {ev.event_date ? relDay(String(ev.event_date).slice(0, 10)) : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {/* Profile card with edit toggle */}
        <div className="card">
          <div className="card-head">
            <h3>Profile</h3>
            {editing ? (
              <div className="hstack" style={{ gap: 4 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={cancelEditing}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveProfile}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={startEditing}>
                <Icon name="pen" size={11} />Edit
              </button>
            )}
          </div>
          <div className="card-body">
            {editing ? (
              <div className="vstack" style={{ gap: 10 }}>
                <FormBanner error={profileError} fieldErrors={profileFieldErrors} />
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Preferred name</div>
                  <input className="input" value={editForm.preferred_name} onChange={e => updateField('preferred_name', e.target.value)} />
                  <FieldError error={profileFieldErrors?.preferred_name} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Email</div>
                  <input className="input" type="email" value={editForm.email} onChange={e => updateField('email', e.target.value)} />
                  <FieldError error={profileFieldErrors?.email} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Phone</div>
                  <input className="input" type="tel" value={formatPhoneInput(editForm.phone)} onChange={e => updateField('phone', stripPhone(e.target.value))} />
                  <FieldError error={profileFieldErrors?.phone} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>City</div>
                    <input className="input" value={editForm.city} onChange={e => updateField('city', e.target.value)} />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>State</div>
                    <input className="input" value={editForm.state} onChange={e => updateField('state', e.target.value)} />
                  </div>
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Travel distance</div>
                  <select className="select" value={editForm.travel_distance} onChange={e => updateField('travel_distance', e.target.value)}>
                    <option value="">—</option>
                    {['Up to 15 miles', 'Up to 30 miles', 'Up to 50 miles', '50+ miles'].map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Reliable transport</div>
                  <select className="select" value={editForm.reliable_transportation} onChange={e => updateField('reliable_transportation', e.target.value)}>
                    <option value="">—</option>
                    {['Yes', 'No', 'Sometimes'].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <dl className="dl">
                <dt>Phone</dt>
                <dd>{profile?.phone ? formatPhone(profile.phone) : '—'}</dd>
                <dt>Address</dt>
                <dd>{[profile?.street_address, profile?.zip_code].filter(Boolean).join(' ') || '—'}</dd>
                <dt>Travel</dt>
                <dd>{profile?.travel_distance || '—'}</dd>
                <dt>Transport</dt>
                <dd>{profile?.reliable_transportation || '—'}</dd>
                <dt>Birthday</dt>
                <dd>
                  {profile?.birth_month && profile?.birth_day && profile?.birth_year
                    ? `${profile.birth_month}/${profile.birth_day}/${profile.birth_year}`
                    : '—'}
                </dd>
              </dl>
            )}
          </div>
        </div>

        {/* Equipment */}
        <div className="card">
          <div className="card-head"><h3>Equipment</h3></div>
          <div className="card-body">
            <EquipmentDisplay profile={profile} editing={editing} editForm={editForm} updateField={updateField} />
          </div>
        </div>

        {/* Permissions */}
        <div className="card">
          <div className="card-head"><h3>Role & permissions</h3></div>
          <div className="card-body vstack" style={{ gap: 10 }}>
            <div className="seg" style={{ width: '100%' }}>
              {['staff', 'manager'].map(r => (
                <button
                  key={r}
                  type="button"
                  className={user.role === r ? 'active' : ''}
                  style={{ flex: 1 }}
                  disabled={permsSaving}
                  onClick={() => updatePermission('role', r)}
                >
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
            <label className="hstack" style={{ alignItems: 'flex-start', gap: 8, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={!!user.can_hire}
                disabled={permsSaving}
                onChange={(e) => updatePermission('can_hire', e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>Can hire</div>
                <div className="tiny muted">Manage applications + applicant status</div>
              </div>
            </label>
            <label className="hstack" style={{ alignItems: 'flex-start', gap: 8, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={!!user.can_staff}
                disabled={permsSaving}
                onChange={(e) => updatePermission('can_staff', e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>Can staff</div>
                <div className="tiny muted">View roster + manage shift requests</div>
              </div>
            </label>
          </div>
        </div>

        {/* Emergency contact */}
        {(profile?.emergency_contact_name || profile?.emergency_contact_phone) && (
          <div className="card">
            <div className="card-head"><h3>Emergency contact</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Name</dt><dd>{profile.emergency_contact_name || '—'}</dd>
                <dt>Phone</dt><dd>{profile.emergency_contact_phone ? formatPhone(profile.emergency_contact_phone) : '—'}</dd>
                <dt>Relation</dt><dd>{profile.emergency_contact_relationship || '—'}</dd>
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EquipmentDisplay({ profile, editing, editForm, updateField }) {
  const items = [
    ['equipment_portable_bar', 'Portable Bar'],
    ['equipment_cooler', 'Cooler'],
    ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
    ['equipment_none_but_open', 'Open to Getting Equipment'],
    ['equipment_no_space', 'No Space'],
    ['equipment_will_pickup', 'Will Pick Up from Storage'],
  ];

  if (editing) {
    return (
      <div className="vstack" style={{ gap: 6 }}>
        {items.map(([key, label]) => (
          <label key={key} className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!editForm[key]}
              onChange={(e) => updateField(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    );
  }
  const owned = items.filter(([k]) => profile?.[k]);
  if (owned.length === 0) return <div className="muted tiny">No equipment listed.</div>;
  return (
    <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
      {owned.map(([k, label]) => <span key={k} className="tag">{label}</span>)}
    </div>
  );
}

// ─── SHIFTS TAB ────────────────────────────────────────────────────────────

function ShiftsTab({ upcoming, past, eventsLoading, navigate }) {
  if (eventsLoading) return <div className="muted">Loading shifts…</div>;
  return (
    <div className="vstack" style={{ gap: 'var(--gap)' }}>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Total shifts</div><div className="stat-value">{upcoming.length + past.length}</div></div>
        <div className="stat"><div className="stat-label">Upcoming</div><div className="stat-value">{upcoming.length}</div></div>
        <div className="stat"><div className="stat-label">Past</div><div className="stat-value">{past.length}</div></div>
        <div className="stat"><div className="stat-label">Cancellations</div><div className="stat-value">0</div></div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Upcoming</h3><span className="k">{upcoming.length}</span></div>
        {upcoming.length === 0 ? (
          <div className="card-body muted tiny">No upcoming shifts.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Event</th><th>Client</th><th>Position</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(ev => (
                  <tr
                    key={`${ev.id}-up`}
                    onClick={() => ev.proposal_id ? navigate(`/admin/events/${ev.proposal_id}`) : navigate(`/admin/events/shift/${ev.id}`)}
                  >
                    <td>
                      <div>{ev.event_date ? fmtDate(String(ev.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</div>
                      <div className="sub">{ev.start_time ? `${ev.start_time}${ev.end_time ? ` – ${ev.end_time}` : ''}` : ''}</div>
                    </td>
                    <td>
                      <strong>{getEventTypeLabel({
                        event_type: ev.event_type || ev.proposal_event_type,
                        event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                      })}</strong>
                      {ev.location && <div className="sub">{ev.location}</div>}
                    </td>
                    <td className="muted">{ev.client_name || '—'}</td>
                    <td className="muted">{ev.position || '—'}</td>
                    <td>
                      <StatusChip kind={ev.request_status === 'approved' ? 'ok' : 'warn'}>
                        {ev.request_status === 'approved' ? 'Confirmed' : 'Pending'}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Past shifts</h3><span className="k">{past.length}</span></div>
        {past.length === 0 ? (
          <div className="card-body muted tiny">No past shifts on record.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Event</th><th>Client</th><th>Position</th><th className="num">Guests</th>
                </tr>
              </thead>
              <tbody>
                {past.map(ev => (
                  <tr key={`${ev.id}-past`}>
                    <td>{ev.event_date ? fmtDate(String(ev.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                    <td>
                      <strong>{getEventTypeLabel({
                        event_type: ev.event_type || ev.proposal_event_type,
                        event_type_custom: ev.event_type_custom || ev.proposal_event_type_custom,
                      })}</strong>
                    </td>
                    <td className="muted">{ev.client_name || '—'}</td>
                    <td className="muted">{ev.position || '—'}</td>
                    <td className="num muted">{ev.guest_count || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── CERTIFICATIONS TAB ────────────────────────────────────────────────────

function CertificationsTab({ profile, application, downloadFile }) {
  const alcoholUrl = profile?.alcohol_certification_file_url || application?.basset_file_url;
  const alcoholName = profile?.alcohol_certification_filename || application?.basset_filename;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head">
          <h3>Certifications & licenses</h3>
          <button type="button" className="btn btn-secondary btn-sm" disabled>
            <Icon name="plus" size={11} />Upload
          </button>
        </div>
        <div className="card-body">
          {alcoholUrl ? (
            <div className="vstack" style={{ gap: 8 }}>
              <div className="hstack" style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}>
                <Icon name="clipboard" size={14} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}><strong>Alcohol certification</strong></div>
                  <div className="tiny muted">{alcoholName || 'Uploaded'}</div>
                </div>
                <StatusChip kind="ok">On file</StatusChip>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => downloadFile(alcoholUrl)}
                >
                  <Icon name="external" size={11} />Open
                </button>
              </div>
            </div>
          ) : (
            <div className="muted tiny" style={{ padding: 8 }}>
              No certifications on file. A general cert table isn't tracked yet — upload alcohol cert via the contractor profile.
            </div>
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Compliance</h3></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Alcohol cert</dt>
              <dd>{alcoholUrl ? <StatusChip kind="ok">On file</StatusChip> : <StatusChip kind="warn">Missing</StatusChip>}</dd>
              <dt>Eligible for</dt>
              <dd>{alcoholUrl ? 'All event types' : 'NA-only events'}</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Reminders</h3></div>
          <div className="card-body vstack" style={{ gap: 8 }}>
            <div className="tiny muted">Renewal-tracking schema not built yet — set up before launch if you'll auto-email staff before expirations.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PAYOUTS TAB ───────────────────────────────────────────────────────────

function PayoutsTab(props) {
  const {
    payment, seniority, seniorityLoading,
    seniorityForm, setSeniorityForm, saveSeniority, senioritySaving, seniorityError, seniorityFieldErrors,
    editing, editForm, setEditForm, startEditing, cancelEditing, saveProfile, saving, profileError, profileFieldErrors,
  } = props;

  const updateField = (k, v) => setEditForm(f => ({ ...f, [k]: v }));
  const w9 = !!payment?.w9_file_url;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {/* Pay periods placeholder */}
        <div className="card">
          <div className="card-head">
            <h3>Pay periods</h3>
            <button type="button" className="btn btn-secondary btn-sm" disabled>
              <Icon name="dollar" size={11} />Run payout
            </button>
          </div>
          <div className="card-body muted tiny">
            Pay-period tracking isn't wired up yet. Once you add a payouts table this card will show period rows with shifts / hours / wages / tips / total / status.
          </div>
        </div>

        {/* 1099 / tax — derived from current data */}
        <div className="card">
          <div className="card-head"><h3>1099 / tax</h3></div>
          <div className="card-body">
            <dl className="dl">
              <dt>Classification</dt><dd>1099 Independent Contractor</dd>
              <dt>W-9 on file</dt>
              <dd>{w9 ? <StatusChip kind="ok">Submitted</StatusChip> : <StatusChip kind="danger">Missing</StatusChip>}</dd>
              <dt>YTD earnings</dt><dd className="num muted">Tracking pending</dd>
              <dt>1099 threshold</dt><dd className="num muted">$600</dd>
            </dl>
          </div>
        </div>

        {/* Seniority */}
        <div className="card">
          <div className="card-head"><h3>Seniority</h3></div>
          <div className="card-body">
            {seniorityLoading || !seniority ? (
              <div className="muted tiny">Loading seniority…</div>
            ) : (
              <>
                <div className="stat-row" style={{ marginBottom: 12 }}>
                  <div className="stat">
                    <div className="stat-label">Score</div>
                    <div className="stat-value">{seniority.computed_score ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Events worked</div>
                    <div className="stat-value">{seniority.events_worked ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Months tenure</div>
                    <div className="stat-value">{seniority.tenure_months ?? 0}</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Hire date</div>
                    <input
                      className="input"
                      type="date"
                      value={seniorityForm.hire_date}
                      onChange={(e) => setSeniorityForm(f => ({ ...f, hire_date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Manual adjustment</div>
                    <input
                      className="input num"
                      type="number"
                      value={seniorityForm.seniority_adjustment}
                      onChange={(e) => setSeniorityForm(f => ({ ...f, seniority_adjustment: e.target.value }))}
                    />
                    <div className="tiny muted" style={{ marginTop: 3 }}>+ to boost · − to reduce</div>
                  </div>
                </div>
                <FormBanner error={seniorityError} fieldErrors={seniorityFieldErrors} />
                <div className="hstack" style={{ marginTop: 12, gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={senioritySaving} onClick={saveSeniority}>
                    {senioritySaving ? 'Saving…' : 'Save seniority'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Payout method</h3>
            {editing ? (
              <div className="hstack" style={{ gap: 4 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={cancelEditing}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveProfile}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={startEditing}>
                <Icon name="pen" size={11} />Edit
              </button>
            )}
          </div>
          <div className="card-body">
            {editing ? (
              <div className="vstack" style={{ gap: 10 }}>
                <FormBanner error={profileError} fieldErrors={profileFieldErrors} />
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Method</div>
                  <select className="select" value={editForm.preferred_payment_method} onChange={(e) => updateField('preferred_payment_method', e.target.value)}>
                    <option value="">—</option>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Username / handle</div>
                  <input className="input" value={editForm.payment_username} onChange={(e) => updateField('payment_username', e.target.value)} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Routing number</div>
                  <input className="input" value={editForm.routing_number} onChange={(e) => updateField('routing_number', e.target.value)} />
                </div>
                <div>
                  <div className="meta-k" style={{ marginBottom: 4 }}>Account number</div>
                  <input className="input" value={editForm.account_number} onChange={(e) => updateField('account_number', e.target.value)} />
                </div>
              </div>
            ) : payment?.preferred_payment_method ? (
              <div className="vstack" style={{ gap: 10 }}>
                <div className="hstack" style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}>
                  <Icon name="dollar" size={14} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ fontSize: 12.5 }}>{payment.preferred_payment_method}</strong>
                    <div className="tiny muted">{payment.payment_username || (payment.account_number ? `Account ··· ${String(payment.account_number).slice(-4)}` : 'Not configured')}</div>
                  </div>
                </div>
                <dl className="dl">
                  <dt>W-9</dt>
                  <dd>{w9 ? <StatusChip kind="ok">On file</StatusChip> : <StatusChip kind="danger">Missing</StatusChip>}</dd>
                </dl>
              </div>
            ) : (
              <div className="vstack" style={{ gap: 8 }}>
                <StatusChip kind="warn">Not configured</StatusChip>
                <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'flex-start' }} onClick={startEditing}>
                  <Icon name="plus" size={11} />Configure payout method
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>YTD totals</h3></div>
          <div className="card-body">
            <div className="muted tiny">
              YTD earnings tracking will plug in here once payout records exist. For now, see Shifts tab for a count.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DOCUMENTS TAB ─────────────────────────────────────────────────────────

function DocumentsTab({ agreement, payment, profile, application, downloadFile }) {
  const items = [
    {
      name: 'Contractor agreement',
      sub: agreement?.signed_at ? `Signed ${fmtDateFull(String(agreement.signed_at).slice(0, 10))}` : 'Not signed yet',
      kind: agreement?.signed_at ? 'ok' : 'warn',
      url: null,
    },
    {
      name: 'W-9 (current year)',
      sub: payment?.w9_file_url ? (payment.w9_filename || 'Submitted') : 'Missing',
      kind: payment?.w9_file_url ? 'ok' : 'danger',
      url: payment?.w9_file_url || null,
    },
    {
      name: 'Alcohol certification',
      sub: profile?.alcohol_certification_filename || application?.basset_filename || 'Missing',
      kind: (profile?.alcohol_certification_file_url || application?.basset_file_url) ? 'ok' : 'warn',
      url: profile?.alcohol_certification_file_url || application?.basset_file_url || null,
    },
    {
      name: 'Resume',
      sub: profile?.resume_filename || application?.resume_filename || 'Not on file',
      kind: (profile?.resume_file_url || application?.resume_file_url) ? 'ok' : 'neutral',
      url: profile?.resume_file_url || application?.resume_file_url || null,
    },
    {
      name: 'Headshot',
      sub: profile?.headshot_filename || application?.headshot_filename || 'Not on file',
      kind: (profile?.headshot_file_url || application?.headshot_file_url) ? 'ok' : 'neutral',
      url: profile?.headshot_file_url || application?.headshot_file_url || null,
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Documents</h3></div>
        <div className="card-body vstack" style={{ gap: 6 }}>
          {items.map((it) => (
            <div
              key={it.name}
              className="hstack"
              style={{ padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}
            >
              <Icon name="clipboard" size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}><strong>{it.name}</strong></div>
                <div className="tiny muted">{it.sub}</div>
              </div>
              <StatusChip kind={it.kind === 'neutral' ? 'neutral' : it.kind}>
                {it.kind === 'ok' ? 'On file' : it.kind === 'danger' ? 'Missing' : it.kind === 'warn' ? 'Action' : '—'}
              </StatusChip>
              {it.url && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadFile(it.url)}>
                  <Icon name="external" size={11} />Open
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {agreement?.signed_at && agreement?.signature_data && (
          <div className="card">
            <div className="card-head"><h3>Signature</h3></div>
            <div className="card-body">
              <div className="tiny muted" style={{ marginBottom: 8 }}>
                {agreement.signature_method === 'type' ? 'Typed' : 'Drawn'} on {fmtDateFull(String(agreement.signed_at).slice(0, 10))}
              </div>
              {agreement.signature_method === 'type' ? (
                <div style={{ padding: '0.75rem 1rem', background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 3 }}>
                  <span style={{ fontFamily: "'Brush Script MT', 'Segoe Script', cursive", fontSize: '1.5rem', color: 'var(--ink-1)' }}>
                    {agreement.signature_data}
                  </span>
                </div>
              ) : (
                <div style={{ padding: 8, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 3 }}>
                  <img src={agreement.signature_data} alt="Signature" style={{ maxWidth: '100%', display: 'block' }} />
                </div>
              )}
            </div>
          </div>
        )}

        {agreement?.signed_at && (
          <div className="card">
            <div className="card-head"><h3>Acknowledgments</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>SMS consent</dt><dd>{agreement.sms_consent ? <StatusChip kind="ok">Yes</StatusChip> : <StatusChip kind="warn">No</StatusChip>}</dd>
                <dt>IC status</dt><dd>{agreement.ack_ic_status ? '✓' : '—'}</dd>
                <dt>Commitment</dt><dd>{agreement.ack_commitment ? '✓' : '—'}</dd>
                <dt>Non-solicit</dt><dd>{(agreement.agreed_non_solicitation || agreement.ack_non_solicit) ? '✓' : '—'}</dd>
                <dt>Damage</dt><dd>{agreement.ack_damage_recoupment ? '✓' : '—'}</dd>
                <dt>Legal</dt><dd>{agreement.ack_legal_protections ? '✓' : '—'}</dd>
                <dt>Field guide</dt><dd>{(agreement.acknowledged_field_guide || agreement.ack_field_guide) ? '✓' : '—'}</dd>
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MESSAGES TAB ──────────────────────────────────────────────────────────

function MessagesTab({ loading, messages, sending, body, setBody, type, setType, result, send, recipient }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Message history</h3><span className="k">{messages.length}</span></div>
        <div className="card-body vstack" style={{ gap: 10 }}>
          {loading ? (
            <div className="muted tiny">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="muted tiny">No messages sent to this staff member yet.</div>
          ) : (
            messages.map(m => (
              <div
                key={m.id}
                style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}
              >
                <div className="hstack" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                  <StatusChip kind={m.status === 'sent' ? 'ok' : 'danger'}>{m.status}</StatusChip>
                  <StatusChip kind={m.message_type === 'invitation' ? 'info' : m.message_type === 'reminder' ? 'warn' : 'neutral'}>
                    {m.message_type}
                  </StatusChip>
                  {m.shift_event_type_label && (
                    <span className="tiny muted">for {m.shift_event_type_label}</span>
                  )}
                  <div className="spacer" style={{ flex: 1 }} />
                  <span className="tiny muted">
                    {m.created_at ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{m.body}</div>
                {m.error_message && (
                  <div className="tiny" style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)', marginTop: 4 }}>
                    Error: {m.error_message}
                  </div>
                )}
                {m.sender_email && (
                  <div className="tiny muted" style={{ marginTop: 4 }}>Sent by {m.sender_email}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Send SMS</h3></div>
          <div className="card-body">
            <form onSubmit={send} className="vstack" style={{ gap: 10 }}>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Type</div>
                <div className="seg" style={{ width: '100%' }}>
                  {['general', 'reminder', 'announcement'].map(t => (
                    <button
                      key={t}
                      type="button"
                      className={type === t ? 'active' : ''}
                      onClick={() => setType(t)}
                      style={{ flex: 1, textTransform: 'capitalize' }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Message</div>
                <textarea
                  className="input"
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={1600}
                  placeholder={`Message to ${recipient}…`}
                  style={{ width: '100%', minHeight: 80, padding: 8 }}
                />
                <div className="tiny muted" style={{ textAlign: 'right', marginTop: 2 }}>{body.length}/1600</div>
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={sending || !body.trim()}
              >
                <Icon name="send" size={11} />{sending ? 'Sending…' : 'Send SMS'}
              </button>
            </form>
            {result && (
              <div
                className="tiny"
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 3,
                  border: result.error ? '1px solid hsl(var(--danger-h) var(--danger-s) 50% / 0.4)' : '1px solid hsl(var(--ok-h) var(--ok-s) 50% / 0.4)',
                  background: result.error ? 'hsl(var(--danger-h) var(--danger-s) 50% / 0.08)' : 'hsl(var(--ok-h) var(--ok-s) 50% / 0.08)',
                  color: result.error ? 'hsl(var(--danger-h) var(--danger-s) 65%)' : 'hsl(var(--ok-h) var(--ok-s) 52%)',
                }}
              >
                {result.error || (result.sent > 0 ? 'Message sent.' : 'Failed to send.')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── APPLICATION TAB ───────────────────────────────────────────────────────

function ApplicationTab({ application }) {
  let positions = [];
  try { positions = JSON.parse(application.positions_interested || '[]'); } catch { positions = []; }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Original application</h3></div>
        <div className="card-body">
          <dl className="dl">
            <dt>Full name</dt><dd>{application.full_name || '—'}</dd>
            <dt>Phone</dt><dd>{application.phone ? formatPhone(application.phone) : '—'}</dd>
            <dt>DOB</dt>
            <dd>
              {application.birth_month && application.birth_day && application.birth_year
                ? `${application.birth_month}/${application.birth_day}/${application.birth_year}`
                : '—'}
            </dd>
            <dt>Address</dt>
            <dd>{[application.street_address, application.city, application.state, application.zip_code].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Travel</dt><dd>{application.travel_distance || '—'}</dd>
            <dt>Transport</dt><dd>{application.reliable_transportation || '—'}</dd>
            <dt>Bartending exp.</dt><dd>{application.has_bartending_experience ? 'Yes' : 'No'}</dd>
            <dt>Last worked</dt><dd>{application.last_bartending_time || '—'}</dd>
            <dt>Saturdays</dt><dd>{application.available_saturdays || '—'}</dd>
            <dt>Setup confidence</dt><dd>{application.setup_confidence ? `${application.setup_confidence}/5` : '—'}</dd>
          </dl>

          {application.bartending_experience_description && (
            <div style={{ marginTop: 12 }}>
              <div className="meta-k" style={{ marginBottom: 4 }}>Description</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {application.bartending_experience_description}
              </div>
            </div>
          )}

          {application.why_dr_bartender && (
            <div style={{ marginTop: 12 }}>
              <div className="meta-k" style={{ marginBottom: 4 }}>Why Dr. Bartender</div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {application.why_dr_bartender}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {positions.length > 0 && (
          <div className="card">
            <div className="card-head"><h3>Positions of interest</h3></div>
            <div className="card-body hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {positions.map(p => <span key={p} className="tag">{p}</span>)}
            </div>
          </div>
        )}
        {application.favorite_color && (
          <div className="card">
            <div className="card-head"><h3>Fun</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Favorite color</dt><dd>{application.favorite_color}</dd>
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
