import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import useFormValidation from '../hooks/useFormValidation';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ password: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [tokenExpired, setTokenExpired] = useState(false);
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const rules = [
    { field: 'password', label: 'Password', test: v => v.length >= 8 },
    { field: 'confirmPassword', label: 'Confirm Password' },
  ];

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    clearField(e.target.name);
    if (fieldErrors[e.target.name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[e.target.name];
        return next;
      });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setTokenExpired(false);
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    if (form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'Passwords do not match.' });
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password: form.password });
      setSuccess(true);
      toast.success('Password reset!');
      // Brief delay before redirect so the success card / toast register
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      const fe = err.fieldErrors || {};
      // Token-level errors are presented as a banner with a "request a new link" CTA,
      // not under any specific input.
      if (fe.token) {
        setTokenExpired(true);
        setError(fe.token);
      } else if (fe.password) {
        setFieldErrors({ password: fe.password });
        setError(err.message || 'Reset failed.');
      } else {
        setError(err.message || 'Reset failed. The link may have expired.');
      }
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
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔒</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Set New Password</h1>
            <p className="text-muted italic">Choose a new password for your account</p>
          </div>

          <div className="card">
            {success ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                <p style={{ color: 'var(--deep-brown)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  Your password has been reset successfully. You can now sign in with your new password.
                </p>
                <Link to="/login" className="btn btn-primary">Sign In</Link>
              </div>
            ) : (
              <form onSubmit={submit}>
                <div className={"form-group" + fieldClass('password')}>
                  <label htmlFor="reset-password" className="form-label">New Password</label>
                  <input
                    id="reset-password"
                    name="password"
                    type="password"
                    className={"form-input" + inputClass('password')}
                    placeholder="At least 8 characters"
                    value={form.password}
                    onChange={handle}
                    aria-invalid={!!fieldErrors?.password}
                  />
                  <FieldError error={fieldErrors?.password} />
                </div>
                <div className={"form-group" + fieldClass('confirmPassword')} style={{ marginBottom: '1.5rem' }}>
                  <label htmlFor="reset-confirmPassword" className="form-label">Confirm Password</label>
                  <input
                    id="reset-confirmPassword"
                    name="confirmPassword"
                    type="password"
                    className={"form-input" + inputClass('confirmPassword')}
                    placeholder="Re-enter your password"
                    value={form.confirmPassword}
                    onChange={handle}
                    aria-invalid={!!fieldErrors?.confirmPassword}
                  />
                  <FieldError error={fieldErrors?.confirmPassword} />
                </div>

                <FormBanner error={error} fieldErrors={fieldErrors} />
                {tokenExpired && (
                  <p className="text-small" style={{ marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
                    <Link to="/forgot-password">Request a new reset link →</Link>
                  </p>
                )}

                <button type="submit" className="btn btn-primary btn-full" disabled={loading || tokenExpired}>
                  {loading ? 'Resetting...' : 'Reset Password'}
                </button>
              </form>
            )}

            <div className="divider" />
            <p className="text-center text-small">
              <Link to="/login">Back to Sign In</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
