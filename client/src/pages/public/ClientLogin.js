import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import { useClientAuth } from '../../context/ClientAuthContext';
import { API_BASE_URL } from '../../utils/api';

export default function ClientLogin() {
  const { isClientAuthenticated, clientLogin } = useClientAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (isClientAuthenticated) navigate('/my-proposals', { replace: true });
  }, [isClientAuthenticated, navigate]);

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      setMessage('If an account exists for this email, a login code has been sent.');
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid code');
      clientLogin(data.token, data.client);
      navigate('/my-proposals', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setMessage('');
    setLoading(true);
    try {
      await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setMessage('A new code has been sent to your email.');
    } catch {
      setError('Failed to resend code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (isClientAuthenticated) return null;

  return (
    <PublicLayout>
      <section className="client-login-section">
        <div className="client-login-benefits">
          <h2>Your Event Portal</h2>
          <p className="client-login-benefits-intro">
            Log in to access everything you need for your upcoming event with Dr. Bartender.
          </p>
          <ul className="client-login-features">
            <li>
              <span className="client-feature-icon">&#128203;</span>
              <div>
                <strong>Event Proposals</strong>
                <span>View, review, and approve your custom event proposals</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon">&#127864;</span>
              <div>
                <strong>Drink Selections</strong>
                <span>Access your Potion Planning Lab picks and menu details</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon">&#128176;</span>
              <div>
                <strong>Payment &amp; Billing</strong>
                <span>Check payment status, balances, and transaction history</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon">&#128172;</span>
              <div>
                <strong>Your Team</strong>
                <span>Stay connected with your bartending team leading up to the event</span>
              </div>
            </li>
          </ul>
        </div>
        <div className="card client-login-card">
          <h2>Client Login</h2>
          <p className="client-login-subtitle">
            {step === 1
              ? 'Enter your email to receive a one-time login code.'
              : 'Enter the 6-digit code sent to your email.'}
          </p>

          {error && <div className="client-alert client-alert-error">{error}</div>}
          {message && <div className="client-alert client-alert-success">{message}</div>}

          {step === 1 ? (
            <form onSubmit={handleRequestOtp}>
              <label className="client-label">Email Address</label>
              <input
                type="email"
                className="client-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
              />
              <button type="submit" className="btn client-btn-primary" disabled={loading}>
                {loading ? 'Sending...' : 'Send Code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp}>
              <label className="client-label">Login Code</label>
              <input
                type="text"
                className="client-input client-otp-input"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                autoFocus
              />
              <button type="submit" className="btn client-btn-primary" disabled={loading || otp.length !== 6}>
                {loading ? 'Verifying...' : 'Sign In'}
              </button>
              <button type="button" className="client-resend-link" onClick={handleResend} disabled={loading}>
                Resend code
              </button>
            </form>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}
