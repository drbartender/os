import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { useToast } from '../../context/ToastContext';
import { useClientAuth } from '../../context/ClientAuthContext';
import { API_BASE_URL } from '../../utils/api';

const OTP_LENGTH = 6;

export default function ClientLogin() {
  const { isClientAuthenticated, clientLogin } = useClientAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otpDigits, setOtpDigits] = useState(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const otpRefs = useRef([]);

  const otp = otpDigits.join('');

  useEffect(() => {
    if (isClientAuthenticated) navigate('/my-proposals', { replace: true });
  }, [isClientAuthenticated, navigate]);

  // When stepping into OTP, focus the first box.
  useEffect(() => {
    if (step === 2 && otpRefs.current[0]) {
      otpRefs.current[0].focus();
    }
  }, [step]);

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
      setOtpDigits(Array(OTP_LENGTH).fill(''));
      otpRefs.current[0]?.focus();
    } catch (err) {
      setError(err.message || 'Failed to resend code. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (idx, raw) => {
    const digit = raw.replace(/\D/g, '').slice(0, 1);
    const next = [...otpDigits];
    next[idx] = digit;
    setOtpDigits(next);
    if (digit && idx < OTP_LENGTH - 1) {
      otpRefs.current[idx + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !otpDigits[idx] && idx > 0) {
      e.preventDefault();
      const next = [...otpDigits];
      next[idx - 1] = '';
      setOtpDigits(next);
      otpRefs.current[idx - 1]?.focus();
    }
  };

  const handleOtpPaste = (e) => {
    const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    const next = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i += 1) next[i] = pasted[i];
    setOtpDigits(next);
    const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    otpRefs.current[focusIndex]?.focus();
  };

  if (isClientAuthenticated) return null;

  return (
    <PublicLayout>
      <section className="client-login-section">
        {/* ── Left: ledger card with benefits ─────────────────── */}
        <aside className="client-login-benefits">
          <span className="kicker">Lab Access · No. 06</span>
          <h2>What's inside the prescription.</h2>
          <p className="client-login-benefits-intro">
            Your event proposal, menu, payments, and team — all in one calm portal.
          </p>
          <ul className="client-login-features">
            <li>
              <span className="client-feature-icon" aria-hidden="true">📋</span>
              <div>
                <strong>Proposal</strong>
                <span>Review, sign, and pay your custom event proposal.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">🥃</span>
              <div>
                <strong>Menu</strong>
                <span>Build your drink menu in the Potion Planning Lab.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">💰</span>
              <div>
                <strong>Payments</strong>
                <span>Track balances, deposits, and final invoices.</span>
              </div>
            </li>
            <li>
              <span className="client-feature-icon" aria-hidden="true">💬</span>
              <div>
                <strong>Messages</strong>
                <span>Stay in touch with your bartending team.</span>
              </div>
            </li>
          </ul>
        </aside>

        {/* ── Right: wax-seal medallion + login card ────────── */}
        <div className="client-login-stack">
          <div className="wax-seal" aria-hidden="true">
            <span className="wax-seal-rx">Rx</span>
          </div>

          <div className="card client-login-card">
            <h2>Open the prescription.</h2>
            <p className="client-login-subtitle">
              {step === 1
                ? "Enter your email and we'll send a one-time code to access your proposal."
                : `Enter the 6-digit code we sent to ${email || 'your email'}.`}
            </p>

            {step === 1 ? (
              <form onSubmit={handleRequestOtp}>
                <label className="client-label" htmlFor="client-login-email">Email Address</label>
                <input
                  id="client-login-email"
                  type="email"
                  autoComplete="email"
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
                  {loading ? 'Sending…' : 'Send Login Code'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp}>
                <label className="client-label">Login Code</label>
                <div
                  className="client-otp-grid"
                  role="group"
                  aria-label="Six-digit login code"
                  onPaste={handleOtpPaste}
                >
                  {otpDigits.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => { otpRefs.current[idx] = el; }}
                      type="text"
                      inputMode="numeric"
                      autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                      pattern="[0-9]*"
                      maxLength={1}
                      className="client-input client-otp-input"
                      value={digit}
                      onChange={(e) => handleOtpChange(idx, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                      onFocus={(e) => e.target.select()}
                      aria-invalid={!!error}
                      aria-label={`Digit ${idx + 1} of 6`}
                    />
                  ))}
                </div>
                <FieldError error={fieldErrors.otp} />
                <FormBanner error={error} fieldErrors={fieldErrors} />
                <button
                  type="submit"
                  className="btn client-btn-primary"
                  disabled={loading || otp.length !== OTP_LENGTH}
                >
                  {loading ? 'Verifying…' : 'Verify & Enter'}
                </button>
                <button type="button" className="client-resend-link" onClick={handleResend} disabled={loading}>
                  Send a new code
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
