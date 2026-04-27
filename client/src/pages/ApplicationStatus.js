import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandLogo from '../components/BrandLogo';
import { COMPANY_PHONE, COMPANY_PHONE_TEL } from '../utils/constants';

export default function ApplicationStatus() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const status = user?.onboarding_status;

  // If the user's status has advanced past the applicant phase (e.g. admin
  // flipped them to 'hired' after they applied), forward them to the correct
  // destination instead of stranding them on the "application received" card.
  if (status === 'hired') return <Navigate to="/welcome" replace />;
  if (['submitted', 'reviewed', 'approved'].includes(status)) return <Navigate to="/dashboard" replace />;
  if (status === 'in_progress' && !user?.has_application) return <Navigate to="/apply" replace />;

  return (
    <div className="auth-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
        <div className="header-actions">
          <span className="header-user">{user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>Sign Out</button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 520 }}>
          {status === 'rejected' ? (
            <div className="card text-center" style={{ padding: '3rem 2rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>😔</div>
              <h1 style={{ marginBottom: '0.5rem' }}>Application Update</h1>
              <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
                Unfortunately, we've decided not to move forward with your application at this time.
                We appreciate your interest in Dr. Bartender and encourage you to apply again in the future.
              </p>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                Have questions?{' '}
                <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
              </div>
            </div>
          ) : (
            <div className="card text-center" style={{ padding: '3rem 2rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚗️</div>
              <h1 style={{ marginBottom: '0.5rem' }}>Application Received!</h1>
              <div className="divider-ornate"><span>sit tight</span></div>

              <p style={{ fontSize: '1.05rem', marginBottom: '1.25rem' }}>
                Thanks for applying to join the Dr. Bartender team.
                Your application is {status === 'interviewing' ? 'under review and we may reach out to schedule an interview' : 'being reviewed by our team'}.
              </p>

              {status === 'interviewing' && (
                <div className="alert alert-info" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
                  <strong>Interview Stage</strong>
                  <p style={{ marginTop: '0.35rem', marginBottom: 0, fontSize: '0.9rem' }}>
                    We're interested in learning more about you! Keep an eye on your email and phone
                    for scheduling details.
                  </p>
                </div>
              )}

              <div style={{
                background: 'var(--parchment)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '1.25rem', marginBottom: '1.5rem', textAlign: 'left'
              }}>
                <h4 style={{ marginBottom: '0.5rem' }}>What Happens Next</h4>
                <ul style={{ paddingLeft: '1.25rem', fontSize: '0.9rem' }}>
                  <li style={{ marginBottom: '0.35rem' }}>We'll review your application and may reach out for a quick interview.</li>
                  <li style={{ marginBottom: '0.35rem' }}>If selected, you'll get an email letting you know you've been hired.</li>
                  <li style={{ marginBottom: '0.35rem' }}>Once hired, log back in here to complete your onboarding paperwork.</li>
                </ul>
              </div>

              <div className="alert alert-success" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
                <strong>Your application status: </strong>
                <span style={{ textTransform: 'capitalize' }}>{(status || 'applied').replace('_', ' ')}</span>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                Have questions?{' '}
                <a href={COMPANY_PHONE_TEL}>Text us at {COMPANY_PHONE}</a>
                {' '}or{' '}
                <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
