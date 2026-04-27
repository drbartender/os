import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { formatPhone } from '../../../utils/formatPhone';
import { useToast } from '../../../context/ToastContext';
import Icon from '../../../components/adminos/Icon';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$, fmtDate } from '../../../components/adminos/format';
import {
  DEFAULT_HOURS_PER_SHIFT,
  initialsOf,
  rateOf,
  computeYtdEstEarnings,
  ytdShiftCount,
} from './helpers';
import TabButton from './components/TabButton';
import AssignToEventModal from './components/AssignToEventModal';
import OverviewTab from './tabs/OverviewTab';
import ShiftsTab from './tabs/ShiftsTab';
import CertificationsTab from './tabs/CertificationsTab';
import PayoutsTab from './tabs/PayoutsTab';
import DocumentsTab from './tabs/DocumentsTab';
import MessagesTab from './tabs/MessagesTab';
import ApplicationTab from './tabs/ApplicationTab';

export default function AdminUserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  const [statusLoading, setStatusLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [customMessage, setCustomMessage] = useState('');
  const [permsSaving, setPermsSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

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
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/staffing')}>
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
  const updateStatus = async (status, message) => {
    setConfirmAction(null);
    setCustomMessage('');
    setStatusLoading(true);
    try {
      const payload = { status };
      const trimmed = (message || '').trim();
      if (trimmed) payload.customMessage = trimmed;
      await api.put(`/admin/users/${id}/status`, payload);
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
      hourly_rate: p.hourly_rate != null ? String(p.hourly_rate) : '',
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
  const ytdEarningsEst = computeYtdEstEarnings(pastEvents, profile);
  const hourlyRate = rateOf(profile);
  const ytdShifts = ytdShiftCount(pastEvents);

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/staffing')}>
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
            <button type="button" className="btn btn-ghost" onClick={() => setTab('messages')}>
              <Icon name="mail" size={12} />Message
            </button>
            {!isDeactivated && (
              <button type="button" className="btn btn-primary" onClick={() => setAssignOpen(true)}>
                <Icon name="plus" size={12} />Assign to event
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
              <span>{ytdShifts} shifts × {DEFAULT_HOURS_PER_SHIFT}hr × ${hourlyRate}/hr</span>
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
          profile={profile}
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

      {/* Assign-to-event modal */}
      {assignOpen && (
        <AssignToEventModal
          userId={user.id}
          staffName={displayName}
          onClose={() => setAssignOpen(false)}
          onAssigned={() => {
            // Refresh shift history so the new assignment appears immediately.
            api.get(`/shifts/user/${id}/events`)
              .then(r => setEvents(r.data))
              .catch(() => {});
          }}
          toast={toast}
        />
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
          onClick={() => { setConfirmAction(null); setCustomMessage(''); }}
        >
          <div
            className="card"
            style={{ maxWidth: 480, width: '100%', padding: '1.25rem 1.5rem' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 8, fontSize: 16 }}>{confirmAction.label}</h3>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 12 }}>{confirmAction.description}</p>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
              Personal note (optional — included in the email to {displayName})
            </label>
            <textarea
              className="form-input"
              rows={3}
              value={customMessage}
              onChange={e => setCustomMessage(e.target.value)}
              placeholder="Add a brief explanation or next steps."
              style={{ marginBottom: 16, resize: 'vertical' }}
            />
            <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => { setConfirmAction(null); setCustomMessage(''); }}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                style={confirmAction.status === 'deactivated' ? { background: 'hsl(var(--danger-h) var(--danger-s) 50%)', borderColor: 'hsl(var(--danger-h) var(--danger-s) 50%)' } : {}}
                onClick={() => updateStatus(confirmAction.status, customMessage)}
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
