import React, { useMemo } from 'react';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';
import { fmtDate, relDay } from '../../../../components/adminos/format';
import { formatPhone, formatPhoneInput, stripPhone } from '../../../../utils/formatPhone';
import { getEventTypeLabel } from '../../../../utils/eventTypes';
import FormBanner from '../../../../components/FormBanner';
import FieldError from '../../../../components/FieldError';
import Sparkbars from '../components/Sparkbars';
import EquipmentDisplay from '../components/EquipmentDisplay';

export default function OverviewTab(props) {
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
                      onClick={() => ev.proposal_id ? navigate(`/events/${ev.proposal_id}`) : navigate(`/events/shift/${ev.id}`)}
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
