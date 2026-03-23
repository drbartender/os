import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';

function Section({ title, children }) {
  return (
    <div className="card mb-2">
      <h3 style={{ marginBottom: '1.25rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value, editing, editKey, editValue, onChange, type = 'text', options }) {
  if (editing && editKey) {
    const labelStyle = { fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.25rem' };
    if (options) {
      return (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={labelStyle}>{label}</div>
          <select className="form-input" style={{ marginBottom: 0 }} value={editValue || ''} onChange={e => onChange(editKey, e.target.value)}>
            <option value="">—</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    }
    const isTel = type === 'tel';
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={labelStyle}>{label}</div>
        <input className="form-input" style={{ marginBottom: 0 }} type={type}
          value={isTel ? formatPhoneInput(editValue || '') : (editValue || '')}
          onChange={e => onChange(editKey, isTel ? stripPhone(e.target.value) : e.target.value)} />
      </div>
    );
  }
  const displayValue = type === 'tel' && value ? formatPhoneInput(value) : value;
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.15rem' }}>{label}</div>
      <div style={{ fontSize: '0.9rem', color: 'var(--deep-brown)' }}>{displayValue || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not provided</span>}</div>
    </div>
  );
}

const STEP_LABELS = {
  account_created: 'Account Created',
  welcome_viewed: 'Welcome Viewed',
  field_guide_completed: 'Field Guide',
  agreement_completed: 'Agreement Signed',
  contractor_profile_completed: 'Contractor Profile',
  payday_protocols_completed: 'Payday Protocols',
  onboarding_completed: 'Onboarding Complete',
};

export default function AdminUserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('profile');
  const [statusLoading, setStatusLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [permsSaving, setPermsSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Messages state
  const [userMessages, setUserMessages] = useState([]);
  const [userMsgLoading, setUserMsgLoading] = useState(false);
  const [userMsgBody, setUserMsgBody] = useState('');
  const [userMsgType, setUserMsgType] = useState('general');
  const [userMsgSending, setUserMsgSending] = useState(false);
  const [userMsgResult, setUserMsgResult] = useState(null);

  useEffect(() => {
    api.get(`/admin/users/${id}`)
      .then(r => setData(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  // Fetch message history for this user
  useEffect(() => {
    if (tab !== 'messages') return;
    setUserMsgLoading(true);
    api.get(`/messages/user/${id}`)
      .then(r => setUserMessages(r.data.messages))
      .catch(console.error)
      .finally(() => setUserMsgLoading(false));
  }, [tab, id]);

  async function sendUserMessage(e) {
    e.preventDefault();
    if (!userMsgBody.trim()) return;
    setUserMsgSending(true);
    setUserMsgResult(null);
    try {
      const r = await api.post('/messages/send', {
        recipient_ids: [parseInt(id)],
        body: userMsgBody.trim(),
        message_type: userMsgType,
      });
      setUserMsgResult(r.data);
      setUserMsgBody('');
      setUserMsgType('general');
      // Refresh history
      const hist = await api.get(`/messages/user/${id}`);
      setUserMessages(hist.data.messages);
    } catch (err) {
      setUserMsgResult({ error: err.response?.data?.error || 'Failed to send' });
    } finally {
      setUserMsgSending(false);
    }
  }

  async function updateStatus(status) {
    setConfirmAction(null);
    setStatusLoading(true);
    try {
      await api.put(`/admin/users/${id}/status`, { status });
      setData(d => ({ ...d, user: { ...d.user, onboarding_status: status } }));
    } catch (e) {
      console.error(e);
    } finally {
      setStatusLoading(false);
    }
  }

  async function downloadFile(url, filename) {
    try {
      const response = await api.get(url, { responseType: 'blob' });
      const blobUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error('Download failed', e);
    }
  }

  async function updatePermission(field, value) {
    setPermsSaving(true);
    try {
      const current = data.user;
      const payload = {
        role: current.role,
        can_hire: current.can_hire || false,
        can_staff: current.can_staff || false,
        [field]: value,
      };
      const r = await api.put(`/admin/users/${id}/permissions`, payload);
      setData(d => ({ ...d, user: { ...d.user, ...r.data } }));
    } catch (e) {
      console.error(e);
    } finally {
      setPermsSaving(false);
    }
  }

  function startEditing() {
    const p = data.profile || {};
    const pay = data.payment || {};
    setEditForm({
      preferred_name: p.preferred_name || '',
      phone: p.phone || '',
      email: p.email || data.user.email || '',
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
      emergency_contact_name: p.emergency_contact_name || '',
      emergency_contact_phone: p.emergency_contact_phone || '',
      emergency_contact_relationship: p.emergency_contact_relationship || '',
      preferred_payment_method: pay.preferred_payment_method || '',
      payment_username: pay.payment_username || '',
      routing_number: pay.routing_number || '',
      account_number: pay.account_number || '',
    });
    setEditing(true);
  }

  function updateField(key, value) {
    setEditForm(f => ({ ...f, [key]: value }));
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const r = await api.put(`/admin/users/${id}/profile`, editForm);
      setData(d => ({ ...d, profile: r.data.profile, payment: r.data.payment }));
      setEditing(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="loading"><div className="spinner" />Loading contractor record...</div>;
  if (!data) return <div className="page-container"><div className="alert alert-error">Contractor not found.</div></div>;

  const { user, progress, profile, agreement, payment, application } = data;

  const isDeactivated = user.onboarding_status === 'deactivated';

  const equipmentItems = [
    ['equipment_portable_bar', 'Portable Bar'],
    ['equipment_cooler', 'Cooler'],
    ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
    ['equipment_none_but_open', 'Open to Getting Equipment'],
    ['equipment_no_space', 'No Space'],
  ].filter(([key]) => profile[key]);

  return (
    <>
      <div className="page-container wide">
        <div style={{ marginBottom: '1rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/staffing')}>← Staff</button>
        </div>

        {/* ── Header Card ── */}
        <div className="card mb-2">
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h2 style={{ marginBottom: '0.25rem' }}>{profile.preferred_name || user.email}</h2>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                <span>{user.email}</span>
                {profile.phone && <span>{profile.phone}</span>}
                {profile.city && profile.state && <span>{profile.city}, {profile.state}</span>}
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', marginBottom: 0 }}>
                Joined {new Date(user.created_at).toLocaleDateString()}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {isDeactivated ? (
                <button
                  className="btn btn-success btn-sm"
                  disabled={statusLoading}
                  onClick={() => updateStatus('submitted')}
                >
                  Reactivate
                </button>
              ) : (
                <button
                  className="btn btn-danger btn-sm"
                  disabled={statusLoading}
                  onClick={() => setConfirmAction({ status: 'deactivated', label: 'Deactivate account?', description: `This will block ${profile.preferred_name || user.email} from logging in. This can be reversed.` })}
                >
                  Deactivate
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="tab-nav">
          {[
            ['profile', 'Profile'],
            ['documents', 'Documents'],
            ...(application?.id ? [['application', 'Application']] : []),
            ['progress', 'Onboarding'],
            ['payment', 'Payment'],
            ['permissions', 'Permissions'],
            ['messages', 'Messages'],
          ].map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); setEditing(false); }}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Profile Tab ── */}
        {tab === 'profile' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem', gap: '0.5rem' }}>
              {editing ? (
                <>
                  <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary btn-sm" disabled={saving} onClick={saveProfile}>
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={startEditing}>Edit</button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Section title="Contact Info">
                <Field label="Preferred Name" value={profile.preferred_name} editing={editing} editKey="preferred_name" editValue={editForm.preferred_name} onChange={updateField} />
                <Field label="Phone" value={profile.phone} editing={editing} editKey="phone" editValue={editForm.phone} onChange={updateField} type="tel" />
                <Field label="Email" value={profile.email || user.email} editing={editing} editKey="email" editValue={editForm.email} onChange={updateField} type="email" />
                {editing ? (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.25rem' }}>Birthday</div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input className="form-input" style={{ marginBottom: 0, width: 70 }} placeholder="MM" type="number" min="1" max="12" value={editForm.birth_month || ''} onChange={e => updateField('birth_month', e.target.value)} />
                      <input className="form-input" style={{ marginBottom: 0, width: 70 }} placeholder="DD" type="number" min="1" max="31" value={editForm.birth_day || ''} onChange={e => updateField('birth_day', e.target.value)} />
                      <input className="form-input" style={{ marginBottom: 0, width: 90 }} placeholder="YYYY" type="number" min="1900" max="2010" value={editForm.birth_year || ''} onChange={e => updateField('birth_year', e.target.value)} />
                    </div>
                  </div>
                ) : (
                  <Field label="Birthday" value={profile.birth_month && profile.birth_day && profile.birth_year ? `${profile.birth_month}/${profile.birth_day}/${profile.birth_year}` : null} />
                )}
              </Section>
              <Section title="Location & Travel">
                <Field label="City" value={profile.city} editing={editing} editKey="city" editValue={editForm.city} onChange={updateField} />
                <Field label="State" value={profile.state} editing={editing} editKey="state" editValue={editForm.state} onChange={updateField} />
                {editing ? (
                  <>
                    <Field label="Street Address" editing={editing} editKey="street_address" editValue={editForm.street_address} onChange={updateField} />
                    <Field label="Zip Code" editing={editing} editKey="zip_code" editValue={editForm.zip_code} onChange={updateField} />
                  </>
                ) : (
                  <Field label="Address" value={[profile.street_address, profile.zip_code].filter(Boolean).join(' ') || null} />
                )}
                <Field label="Travel Distance" value={profile.travel_distance} editing={editing} editKey="travel_distance" editValue={editForm.travel_distance} onChange={updateField}
                  options={['Up to 15 miles', 'Up to 30 miles', 'Up to 50 miles', '50+ miles']} />
                <Field label="Transportation" value={profile.reliable_transportation} editing={editing} editKey="reliable_transportation" editValue={editForm.reliable_transportation} onChange={updateField}
                  options={['Yes', 'No', 'Sometimes']} />
              </Section>
              <Section title="Equipment">
                {editing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {[
                      ['equipment_portable_bar', 'Portable Bar'],
                      ['equipment_cooler', 'Cooler'],
                      ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
                      ['equipment_none_but_open', 'Open to Getting Equipment'],
                      ['equipment_no_space', 'No Space'],
                    ].map(([key, label]) => (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                        <input type="checkbox" checked={!!editForm[key]} onChange={e => updateField(key, e.target.checked)} style={{ width: 16, height: 16 }} />
                        {label}
                      </label>
                    ))}
                  </div>
                ) : equipmentItems.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    {equipmentItems.map(([key, label]) => (
                      <span key={key} className="badge badge-inprogress">{label}</span>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted" style={{ fontStyle: 'italic' }}>No equipment listed</span>
                )}
              </Section>
              <Section title="Emergency Contact">
                <Field label="Name" value={profile.emergency_contact_name} editing={editing} editKey="emergency_contact_name" editValue={editForm.emergency_contact_name} onChange={updateField} />
                <Field label="Phone" value={profile.emergency_contact_phone} editing={editing} editKey="emergency_contact_phone" editValue={editForm.emergency_contact_phone} onChange={updateField} type="tel" />
                <Field label="Relationship" value={profile.emergency_contact_relationship} editing={editing} editKey="emergency_contact_relationship" editValue={editForm.emergency_contact_relationship} onChange={updateField} />
              </Section>
            </div>
          </>
        )}

        {/* ── Documents Tab ── */}
        {tab === 'documents' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Section title="Contractor Agreement">
              {agreement.signed_at ? (
                <>
                  <Field label="Signed By" value={agreement.full_name} />
                  <Field label="Signed At" value={new Date(agreement.signed_at).toLocaleString()} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <Field label="SMS Consent" value={agreement.sms_consent ? '✓ Yes' : '✗ No'} />
                    <Field label="Field Guide Acknowledged" value={agreement.acknowledged_field_guide ? '✓ Yes' : '✗ No'} />
                    <Field label="Non-Solicitation" value={agreement.agreed_non_solicitation ? '✓ Yes' : '✗ No'} />
                  </div>
                  {agreement.signature_data && (
                    <div>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Digital Signature</div>
                      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', display: 'inline-block', background: 'white', padding: '0.5rem' }}>
                        <img src={agreement.signature_data} alt="Signature" style={{ maxWidth: 280, display: 'block' }} />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <span className="text-muted" style={{ fontStyle: 'italic' }}>Agreement not yet signed</span>
              )}
            </Section>

            <Section title="Uploaded Files">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {payment.w9_file_url ? (
                  <button className="btn btn-secondary btn-sm" style={{ textAlign: 'left' }}
                    onClick={() => downloadFile(payment.w9_file_url, payment.w9_filename)}>
                    📄 W-9: {payment.w9_filename}
                  </button>
                ) : <Field label="W-9" value={null} />}

                {profile.alcohol_certification_file_url ? (
                  <button className="btn btn-secondary btn-sm" style={{ textAlign: 'left' }}
                    onClick={() => downloadFile(profile.alcohol_certification_file_url, profile.alcohol_certification_filename)}>
                    📄 Alcohol Cert: {profile.alcohol_certification_filename}
                  </button>
                ) : <Field label="Alcohol Certification" value={null} />}

                {profile.resume_file_url ? (
                  <button className="btn btn-secondary btn-sm" style={{ textAlign: 'left' }}
                    onClick={() => downloadFile(profile.resume_file_url, profile.resume_filename)}>
                    📄 Resume: {profile.resume_filename}
                  </button>
                ) : <Field label="Resume" value={null} />}

                {profile.headshot_file_url ? (
                  <button className="btn btn-secondary btn-sm" style={{ textAlign: 'left' }}
                    onClick={() => downloadFile(profile.headshot_file_url, profile.headshot_filename)}>
                    📄 Headshot: {profile.headshot_filename}
                  </button>
                ) : <Field label="Headshot" value={null} />}
              </div>
            </Section>
          </div>
        )}

        {/* ── Application Tab ── */}
        {tab === 'application' && application?.id && (() => {
          let positions = [];
          try { positions = JSON.parse(application.positions_interested || '[]'); } catch (e) {}
          return (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Section title="Application Info">
                <Field label="Full Name" value={application.full_name} />
                <Field label="Phone" value={application.phone} />
                <Field label="Favorite Color" value={application.favorite_color} />
                <Field label="DOB" value={application.birth_month ? `${application.birth_month}/${application.birth_day}/${application.birth_year}` : null} />
                <Field label="Address" value={[application.street_address, application.city, application.state, application.zip_code].filter(Boolean).join(', ')} />
                <Field label="Travel Distance" value={application.travel_distance} />
                <Field label="Transportation" value={application.reliable_transportation} />
              </Section>
              <Section title="Experience & Positions">
                <Field label="Bartending Experience" value={application.has_bartending_experience ? 'Yes' : 'No'} />
                <Field label="Description" value={application.bartending_experience_description} />
                <Field label="Last Worked" value={application.last_bartending_time} />
                <Field label="Available Saturdays" value={application.available_saturdays} />
                <Field label="Setup Confidence" value={application.setup_confidence ? `${application.setup_confidence}/5` : null} />
                <Field label="Why Dr. Bartender" value={application.why_dr_bartender} />
                {positions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.5rem' }}>
                    {positions.map(p => <span key={p} className="badge badge-approved">{p}</span>)}
                  </div>
                )}
              </Section>
            </div>
          );
        })()}

        {/* ── Onboarding Progress Tab ── */}
        {tab === 'progress' && (
          <Section title="Onboarding Progress">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {Object.entries(STEP_LABELS).map(([key, label]) => (
                <div key={key} style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: progress[key] ? '#F0FFF0' : 'var(--parchment)',
                  border: `1px solid ${progress[key] ? '#90CC90' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)'
                }}>
                  <span style={{ fontSize: '1.1rem' }}>{progress[key] ? '✅' : '⭕'}</span>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: progress[key] ? 'var(--success)' : 'var(--text-muted)' }}>
                    {label}
                  </span>
                  {progress[key] && progress.updated_at && key === progress.last_completed_step && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {new Date(progress.updated_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Payment Tab ── */}
        {tab === 'payment' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem', gap: '0.5rem' }}>
              {editing ? (
                <>
                  <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary btn-sm" disabled={saving} onClick={saveProfile}>
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={startEditing}>Edit</button>
              )}
            </div>
            <Section title="Payment Info">
              <Field label="Payment Method" value={payment.preferred_payment_method} editing={editing} editKey="preferred_payment_method" editValue={editForm.preferred_payment_method} onChange={updateField}
                options={['Zelle', 'Venmo', 'CashApp', 'PayPal', 'Direct Deposit']} />
              <Field label="Username / Handle" value={payment.payment_username} editing={editing} editKey="payment_username" editValue={editForm.payment_username} onChange={updateField} />
              <Field label="Routing Number" value={payment.routing_number} editing={editing} editKey="routing_number" editValue={editForm.routing_number} onChange={updateField} />
              <Field label="Account Number" value={payment.account_number} editing={editing} editKey="account_number" editValue={editForm.account_number} onChange={updateField} />
            </Section>
          </>
        )}

        {/* ── Permissions Tab ── */}
        {tab === 'permissions' && (
          <div style={{ maxWidth: 520 }}>
            <Section title="Role">
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Managers can access the admin dashboard. Staff permissions control what they can do within it.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {['staff', 'manager'].map(r => (
                  <button
                    key={r}
                    className={`btn btn-sm ${user.role === r ? 'btn-dark' : 'btn-secondary'}`}
                    disabled={permsSaving}
                    onClick={() => updatePermission('role', r)}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Staff Permissions">
              {[
                { key: 'can_hire', label: 'Can Hire', desc: 'View and manage applications, change applicant status, schedule interviews' },
                { key: 'can_staff', label: 'Can Staff', desc: 'View active staff roster, manage shifts and shift requests' },
              ].map(perm => (
                <label key={perm.key} style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                  padding: '0.75rem 0', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={!!user[perm.key]}
                    disabled={permsSaving}
                    onChange={e => updatePermission(perm.key, e.target.checked)}
                    style={{ width: 18, height: 18, marginTop: '0.1rem', flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{perm.label}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{perm.desc}</div>
                  </div>
                </label>
              ))}
            </Section>
          </div>
        )}
        {/* ── Messages Tab ── */}
        {tab === 'messages' && (
          <div style={{ maxWidth: 640 }}>
            {/* Quick Compose */}
            <Section title="Send Message">
              <form onSubmit={sendUserMessage}>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label className="form-label">Type</label>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {['general', 'reminder', 'announcement'].map(t => (
                      <button key={t} type="button"
                        className={`btn btn-sm ${userMsgType === t ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setUserMsgType(t)}
                        style={{ textTransform: 'capitalize' }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label className="form-label">Message</label>
                  <textarea
                    className="form-input" rows={3}
                    value={userMsgBody} onChange={e => setUserMsgBody(e.target.value)}
                    maxLength={1600}
                    placeholder={`Message to ${profile.preferred_name || user.email}…`}
                    style={{ marginBottom: '0.25rem' }}
                  />
                  <div className="text-muted text-small" style={{ textAlign: 'right' }}>
                    {userMsgBody.length}/1600
                  </div>
                </div>
                <button type="submit" className="btn btn-primary btn-sm"
                  disabled={userMsgSending || !userMsgBody.trim()}>
                  {userMsgSending ? 'Sending…' : 'Send SMS'}
                </button>
              </form>
              {userMsgResult && (
                <div className={`alert ${userMsgResult.error ? 'alert-error' : 'alert-success'}`} style={{ marginTop: '0.75rem' }}>
                  {userMsgResult.error
                    ? userMsgResult.error
                    : `Message ${userMsgResult.sent > 0 ? 'sent' : 'failed'}`
                  }
                </div>
              )}
            </Section>

            {/* Message History */}
            <Section title="Message History">
              {userMsgLoading ? (
                <div className="text-muted">Loading…</div>
              ) : userMessages.length === 0 ? (
                <p className="text-muted italic">No messages sent to this staff member yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {userMessages.map(m => (
                    <div key={m.id} style={{
                      padding: '0.75rem', borderRadius: '6px',
                      background: 'var(--parchment)', border: '1px solid var(--border-dark)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem', flexWrap: 'wrap', gap: '0.3rem' }}>
                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <span className={`badge ${m.status === 'sent' ? 'badge-approved' : 'badge-deactivated'}`}>{m.status}</span>
                          <span className={`badge ${m.message_type === 'invitation' ? 'badge-reviewed' : m.message_type === 'reminder' ? 'badge-inprogress' : 'badge-submitted'}`} style={{ textTransform: 'capitalize' }}>
                            {m.message_type}
                          </span>
                          {m.shift_event_name && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>for {m.shift_event_name}</span>
                          )}
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: '0.88rem' }}>{m.body}</p>
                      {m.error_message && (
                        <div style={{ fontSize: '0.78rem', color: 'var(--error)', marginTop: '0.3rem' }}>Error: {m.error_message}</div>
                      )}
                      {m.sender_email && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>Sent by {m.sender_email}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>

      {/* Confirmation modal */}
      {confirmAction && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div className="card" style={{ maxWidth: 400, width: '100%', margin: 0 }}>
            <h3 style={{ marginBottom: '0.5rem' }}>{confirmAction.label}</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>{confirmAction.description}</p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className={`btn ${confirmAction.status === 'deactivated' ? 'btn-danger' : 'btn-success'}`}
                onClick={() => updateStatus(confirmAction.status)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
