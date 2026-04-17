import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';

export default function ForgotPassword() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
      toast.success('Check your email for a reset link.');
    } catch (err) {
      // No field-level errors here — enumeration safety; backend returns
      // generic success even when account doesn't exist. We only land here
      // on rate-limit or hard server errors.
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div className="text-center mb-3">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔑</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Reset Password</h1>
            <p className="text-muted italic">Enter your email to receive a reset link</p>
          </div>

          <div className="card">
            {sent ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                <p style={{ color: 'var(--deep-brown)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  If an account exists with that email, a password reset link has been sent. Please check your inbox.
                </p>
                <Link to="/login" className="btn btn-primary">Back to Sign In</Link>
              </div>
            ) : (
              <form onSubmit={submit}>
                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                  <label className="form-label">Email Address</label>
                  <input
                    type="email"
                    className="form-input"
                    placeholder="your@email.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>
                <FormBanner error={error} />
                <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>
            )}

            <div className="divider" />
            <p className="text-center text-small">
              Remember your password? <Link to="/login">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
