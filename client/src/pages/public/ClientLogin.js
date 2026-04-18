import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { useToast } from '../../context/ToastContext';
import { useClientAuth } from '../../context/ClientAuthContext';
import { API_BASE_URL } from '../../utils/api';

export default function ClientLogin() {
  const { isClientAuthenticated, clientLogin } = useClientAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (isClientAuthenticated) navigate('/my-proposals', { replace: true });
  }, [isClientAuthenticated, navigate]);

  const parseError = async (res) => {
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    const message = data.error || 'Something went wrong. Please try again.';
    const err = new Error(message);
    err.fieldErrors = data.fieldErrors;
    err.code = data.code;
    return err;
  };

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw await parseError(res);
      // Neutral success — does not reveal whether the email is on file.
      toast.success('If an account exists for this email, a login code has been sent.');
      setStep(2);
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      if (!res.ok) throw await parseError(res);
      const data = await res.json();
      clientLogin(data.token, data.client);
      navigate('/my-proposals', { replace: true });
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setFieldErrors({});
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/client-auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw await parseError(res);
      toast.success('A new code has been sent to your email.');
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
      setFieldErrors(err.fieldErrors || {});
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
              <FieldError error={fieldErrors.email} />
              <FormBanner error={error} fieldErrors={fieldErrors} />
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
              <FieldError error={fieldErrors.otp} />
              <FormBanner error={error} fieldErrors={fieldErrors} />
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
