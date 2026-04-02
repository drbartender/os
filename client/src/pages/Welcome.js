import React, { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import api from '../utils/api';

export default function Welcome() {
  const navigate = useNavigate();
  const { setProgress } = useOutletContext();
  const [loading, setLoading] = useState(false);

  async function handleGetStarted() {
    setLoading(true);
    try {
      const r = await api.put('/progress/step', { step: 'welcome_viewed' });
      setProgress(r.data);
      navigate('/field-guide');
    } catch (err) {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="welcome-hero">
        <div className="ornament" style={{ fontSize: '1.5rem', display: 'block', marginBottom: '0.5rem' }}>⚗</div>
        <h1>Welcome to the Lab</h1>
        <p>Your official Dr. Bartender contractor onboarding portal</p>
      </div>

      <div className="page-container">
        <div className="card">
          <p style={{ fontSize: '1rem', lineHeight: 1.7, color: 'var(--deep-brown)', marginBottom: '1.5rem' }}>
            So you've been invited into the lab. This is where the experiment begins.
            Review your protocols, sign your name in digital ink, and send us your W-9
            so we can pay you for your brilliance.
          </p>

          <div style={{ marginBottom: '1.5rem' }}>
            <h4 style={{ marginBottom: '0.75rem' }}>Lab Access Requirements</h4>
            <ul className="req-list">
              {['Review Field Guide', 'Sign Form', 'Submit W-9', 'Join Chat'].map(item => (
                <li key={item}>
                  <span className="req-check">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="divider-ornate"><span>What to Expect</span></div>

          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: '1rem' }}>
            This will take about 10–15 minutes — short, but important.
          </p>


          <div className="alert alert-info">
            Once submitted, you'll get an email invite to view and request shifts.
          </div>

          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
            Quick onboarding. Serious standards. Let's go.
          </p>

          <button
            className="btn btn-primary btn-full"
            onClick={handleGetStarted}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Access the Field Guide →'}
          </button>
        </div>
      </div>
    </div>
  );
}
