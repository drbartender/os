import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WHATSAPP_GROUP_URL, COMPANY_PHONE, COMPANY_PHONE_TEL } from '../utils/constants';

export default function Completion() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  // Safety net: if the user landed here without a fresh session (e.g. hard refresh),
  // reload /auth/me so RequirePortal sees the 'submitted' status set by payment.js.
  useEffect(() => {
    refreshUser().catch(() => {});
  }, [refreshUser]);

  return (
    <div className="page-container" style={{ maxWidth: 600 }}>
      <div className="card text-center" style={{ padding: '3rem 2rem' }}>
        <div className="completion-icon">🧪</div>
        <h1 style={{ color: 'var(--forest)', marginBottom: '0.5rem' }}>You're All Set!</h1>
        <div className="divider-ornate"><span>officially official</span></div>

        <p style={{ fontSize: '1.05rem', marginBottom: '1.25rem' }}>
          Thanks for wrapping things up — your info's in and you're officially part of the team.
          Your staff portal is open — head there to see open shifts and request your first gig.
        </p>

        <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate('/portal/shifts')}
          >
            See Open Shifts →
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate('/portal/dashboard')}
          >
            Go to Dashboard
          </button>
        </div>

        <div style={{
          background: 'var(--parchment)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '1.25rem', marginBottom: '1.5rem', textAlign: 'left'
        }}>
          <h4 style={{ marginBottom: '0.5rem' }}>What Happens Next</h4>
          <ul style={{ paddingLeft: '1.25rem', fontSize: '0.9rem' }}>
            <li style={{ marginBottom: '0.35rem' }}>Browse open shifts in the staff portal and request the ones that fit your schedule.</li>
            <li style={{ marginBottom: '0.35rem' }}>We'll confirm your requests as shifts get staffed — watch for SMS/email updates.</li>
            <li style={{ marginBottom: '0.35rem' }}>
              Join our team WhatsApp group for real-time scheduling updates:{' '}
              <a href={WHATSAPP_GROUP_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--amber)', fontWeight: 600 }}>
                Join the WhatsApp Group →
              </a>
            </li>
          </ul>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Have questions?{' '}
          <a href={COMPANY_PHONE_TEL}>Text us at {COMPANY_PHONE}</a>
          {' '}or{' '}
          <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>
          <p style={{ marginTop: '0.5rem', fontStyle: 'italic', color: 'var(--amber)', fontFamily: 'var(--font-display)' }}>
            We're glad to have you on board.
          </p>
        </div>
      </div>
    </div>
  );
}
