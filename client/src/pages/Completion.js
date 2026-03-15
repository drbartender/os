import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function Completion() {
  const navigate = useNavigate();

  return (
    <div className="page-container" style={{ maxWidth: 600 }}>
      <div className="card text-center" style={{ padding: '3rem 2rem' }}>
        <div className="completion-icon">🧪</div>
        <h1 style={{ color: 'var(--forest)', marginBottom: '0.5rem' }}>You're All Set!</h1>
        <div className="divider-ornate"><span>officially official</span></div>

        <p style={{ fontSize: '1.05rem', marginBottom: '1.25rem' }}>
          Thanks for wrapping things up — your info's in and you're officially part of the team.
        </p>

        <div style={{ marginBottom: '1.5rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate('/welcome')}
          >
            Back to overview
          </button>
        </div>

        <div className="alert alert-success" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
          <strong>Keep an eye on your inbox!</strong>
          <p style={{ marginTop: '0.35rem', marginBottom: 0, fontSize: '0.9rem' }}>
            You'll receive an invite to the Dr. Bartender Staff Portal, where you can view upcoming gigs and request events.
          </p>
        </div>

        <div style={{
          background: 'var(--parchment)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '1.25rem', marginBottom: '1.5rem', textAlign: 'left'
        }}>
          <h4 style={{ marginBottom: '0.5rem' }}>What Happens Next</h4>
          <ul style={{ paddingLeft: '1.25rem', fontSize: '0.9rem' }}>
            <li style={{ marginBottom: '0.35rem' }}>Your onboarding will be reviewed by the Dr. Bartender team.</li>
            <li style={{ marginBottom: '0.35rem' }}>You'll receive a Staff Portal invite via email once approved.</li>
            <li style={{ marginBottom: '0.35rem' }}>
              Join our team WhatsApp group for scheduling updates:{' '}
              <a href="https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--amber)', fontWeight: 600 }}>
                Join the WhatsApp Group →
              </a>
            </li>
          </ul>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Have questions?{' '}
          <a href="tel:+13125889401">Text us at (312) 588-9401</a>
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
