import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';

function Section({ title, children }) {
  return (
    <div className="card mb-2">
      <h3 style={{ marginBottom: '1.25rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.15rem' }}>{label}</div>
      <div style={{ fontSize: '0.9rem', color: 'var(--deep-brown)' }}>{value || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not provided</span>}</div>
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

  useEffect(() => {
    api.get(`/admin/users/${id}`)
      .then(r => setData(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

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
          ].map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Profile Tab ── */}
        {tab === 'profile' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Section title="Contact Info">
              <Field label="Preferred Name" value={profile.preferred_name} />
              <Field label="Phone" value={profile.phone} />
              <Field label="Email" value={profile.email || user.email} />
              <Field label="Birthday" value={profile.birth_month && profile.birth_day && profile.birth_year ? `${profile.birth_month}/${profile.birth_day}/${profile.birth_year}` : null} />
            </Section>
            <Section title="Location & Travel">
              <Field label="City" value={profile.city} />
              <Field label="State" value={profile.state} />
              <Field label="Address" value={[profile.street_address, profile.zip_code].filter(Boolean).join(' ') || null} />
              <Field label="Travel Distance" value={profile.travel_distance} />
              <Field label="Transportation" value={profile.reliable_transportation} />
            </Section>
            <Section title="Equipment">
              {equipmentItems.length > 0 ? (
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
              <Field label="Name" value={profile.emergency_contact_name} />
              <Field label="Phone" value={profile.emergency_contact_phone} />
              <Field label="Relationship" value={profile.emergency_contact_relationship} />
            </Section>
          </div>
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
          <Section title="Payment Info">
            <Field label="Payment Method" value={payment.preferred_payment_method} />
            {payment.payment_username && <Field label="Username / Handle" value={payment.payment_username} />}
            {payment.routing_number && <Field label="Routing Number" value={payment.routing_number} />}
            {payment.account_number && <Field label="Account Number" value={payment.account_number} />}
          </Section>
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
