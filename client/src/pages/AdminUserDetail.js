import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';

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

function StatusBadge({ status }) {
  const map = {
    applied: ['badge-submitted', 'Applied'],
    interviewing: ['badge-inprogress', 'Interviewing'],
    hired: ['badge-approved', 'Hired'],
    rejected: ['badge-deactivated', 'Rejected'],
    in_progress: ['badge-inprogress', 'In Progress'],
    submitted: ['badge-submitted', 'Submitted'],
    reviewed: ['badge-reviewed', 'Reviewed'],
    approved: ['badge-approved', 'Approved'],
    deactivated: ['badge-deactivated', 'Deactivated'],
  };
  const [cls, label] = map[status] || ['badge-inprogress', status];
  return <span className={`badge ${cls}`}>{label}</span>;
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
  const { logout } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');
  const [statusLoading, setStatusLoading] = useState(false);
  // { status, label, description } — set to show confirmation modal before acting
  const [confirmAction, setConfirmAction] = useState(null);

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

  // Fetch file through the authenticated API and trigger a browser download
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

  if (loading) return <div className="loading"><div className="spinner" />Loading contractor record...</div>;
  if (!data) return <div className="page-container"><div className="alert alert-error">Contractor not found.</div></div>;

  const { user, progress, profile, agreement, payment, application } = data;

  return (
    <div className="admin-page" style={{ minHeight: '100vh' }}>
      <header className="site-header">
        <BrandLogo admin />
        <div className="header-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin')}>← Dashboard</button>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>Sign Out</button>
        </div>
      </header>

      <div className="page-container wide">
        {/* Header */}
        <div className="card mb-2">
          <div className="flex-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h2 style={{ marginBottom: '0.25rem' }}>{profile.preferred_name || user.email}</h2>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{user.email}</span>
                <StatusBadge status={user.onboarding_status} />
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem', marginBottom: 0 }}>
                Joined {new Date(user.created_at).toLocaleDateString()}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-success btn-sm"
                disabled={statusLoading || user.onboarding_status === 'approved'}
                onClick={() => setConfirmAction({ status: 'approved', label: 'Approve contractor?', description: `This will mark ${profile.preferred_name || user.email} as approved and ready to work.` })}
              >
                ✓ Approve
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={statusLoading || user.onboarding_status === 'reviewed'}
                onClick={() => updateStatus('reviewed')}
              >
                Mark Reviewed
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={statusLoading || user.onboarding_status === 'deactivated'}
                onClick={() => setConfirmAction({ status: 'deactivated', label: 'Deactivate account?', description: `This will block ${profile.preferred_name || user.email} from logging in. This can be reversed by changing their status.` })}
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="tab-nav">
          {[
            ...(application?.id ? [['application', 'Application']] : []),
            ['overview', 'Overview'],
            ['profile', 'Contractor Profile'],
            ['agreement', 'Agreement'],
            ['payment', 'Payment'],
            ['progress', 'Progress'],
          ].map(([key, label]) => (
            <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

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

        {tab === 'overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Section title="Account Info">
              <Field label="Email" value={user.email} />
              <Field label="Role" value={user.role} />
              <Field label="Status" value={<StatusBadge status={user.onboarding_status} />} />
              <Field label="Notifications Opt-in" value={user.notifications_opt_in ? 'Yes' : 'No'} />
              <Field label="Account Created" value={new Date(user.created_at).toLocaleString()} />
            </Section>
            <Section title="Quick Profile">
              <Field label="Preferred Name" value={profile.preferred_name} />
              <Field label="Phone" value={profile.phone} />
              <Field label="Location" value={profile.city && profile.state ? `${profile.city}, ${profile.state}` : null} />
              <Field label="Travel Distance" value={profile.travel_distance} />
              <Field label="Transportation" value={profile.reliable_transportation} />
            </Section>
          </div>
        )}

        {tab === 'profile' && (
          <Section title="Contractor Profile">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
              <Field label="Preferred Name" value={profile.preferred_name} />
              <Field label="Phone" value={profile.phone} />
              <Field label="Email" value={profile.email} />
              <Field label="Birthday" value={profile.birth_month && profile.birth_day && profile.birth_year ? `${profile.birth_month}/${profile.birth_day}/${profile.birth_year}` : null} />
              <Field label="City" value={profile.city} />
              <Field label="State" value={profile.state} />
              <Field label="Travel Distance" value={profile.travel_distance} />
              <Field label="Transportation" value={profile.reliable_transportation} />
            </div>
            <div style={{ marginTop: '1rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Equipment</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {[
                  ['equipment_portable_bar', 'Portable Bar'],
                  ['equipment_cooler', 'Cooler'],
                  ['equipment_table_with_spandex', '6ft Table'],
                  ['equipment_none_but_open', 'Open to Getting Equipment'],
                  ['equipment_no_space', 'No Space'],
                ].map(([key, label]) => profile[key] && (
                  <span key={key} className="badge badge-inprogress">{label}</span>
                ))}
              </div>
            </div>
            <div style={{ marginTop: '1.25rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>Uploaded Files</div>
              {profile.alcohol_certification_file_url ? (
                <button className="btn btn-secondary btn-sm" style={{ marginRight: '0.5rem' }}
                  onClick={() => downloadFile(profile.alcohol_certification_file_url, profile.alcohol_certification_filename)}>
                  📄 Alcohol Cert: {profile.alcohol_certification_filename}
                </button>
              ) : <span className="text-muted text-small">No alcohol certification uploaded</span>}
              {profile.resume_file_url && (
                <button className="btn btn-secondary btn-sm"
                  onClick={() => downloadFile(profile.resume_file_url, profile.resume_filename)}>
                  📄 Resume: {profile.resume_filename}
                </button>
              )}
            </div>
          </Section>
        )}

        {tab === 'agreement' && (
          <Section title="Contractor Agreement">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
              <Field label="Full Name" value={agreement.full_name} />
              <Field label="Email" value={agreement.email} />
              <Field label="Phone" value={agreement.phone} />
              <Field label="SMS Consent" value={agreement.sms_consent ? 'Yes' : 'No'} />
              <Field label="Acknowledged Field Guide" value={agreement.acknowledged_field_guide ? '✓ Yes' : '✗ No'} />
              <Field label="Agreed Non-Solicitation" value={agreement.agreed_non_solicitation ? '✓ Yes' : '✗ No'} />
              <Field label="Signed At" value={agreement.signed_at ? new Date(agreement.signed_at).toLocaleString() : null} />
            </div>
            {agreement.signature_data && (
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>Digital Signature</div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', display: 'inline-block', background: 'white', padding: '0.5rem' }}>
                  <img src={agreement.signature_data} alt="Signature" style={{ maxWidth: 320, display: 'block' }} />
                </div>
              </div>
            )}
          </Section>
        )}

        {tab === 'payment' && (
          <Section title="Payment Info">
            <Field label="Payment Method" value={payment.preferred_payment_method} />
            {payment.payment_username && <Field label="Username / Handle" value={payment.payment_username} />}
            {payment.routing_number && <Field label="Routing Number" value={payment.routing_number} />}
            {payment.account_number && <Field label="Account Number" value={payment.account_number} />}
            <div style={{ marginTop: '0.75rem' }}>
              {payment.w9_file_url ? (
                <button className="btn btn-secondary btn-sm"
                  onClick={() => downloadFile(payment.w9_file_url, payment.w9_filename)}>
                  📄 W-9: {payment.w9_filename}
                </button>
              ) : <span className="text-muted text-small italic">No W-9 uploaded yet</span>}
            </div>
          </Section>
        )}

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
      </div>

      {/* Confirmation modal for destructive / significant status changes */}
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
    </div>
  );
}
