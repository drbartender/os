// Login (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';
import useFormValidation from '../hooks/useFormValidation';
import { getHomePath } from '../utils/userRoutes';
import { connectReturn, CONNECT_WRONG_ACCOUNT } from '../utils/connectReturn';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  // The Claude consent page's way back (spec 2026-11-19 section 7.2): honored
  // only when it is exactly that page with a request id (connectReturn), and
  // only for an admin, the one role the page admits. Another account signing
  // in on it is not signed in at all (no token is stored on this origin) and
  // is told to use the admin account, with the return kept, so the pending
  // request is not dropped. The consent route's guard sends a non-admin
  // session here the same way, with the notice in the location state.
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const returnTo = connectReturn(searchParams.get('return'));
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(
    returnTo && location.state && location.state.connectNotice === 'wrong_account' ? CONNECT_WRONG_ACCOUNT : ''
  );
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const rules = [
    { field: 'email', label: 'Email' },
    { field: 'password', label: 'Password' },
  ];

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    clearField(e.target.name);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    setLoading(true);
    try {
      const res = await api.post('/auth/login', form);
      const u = res.data.user;
      if (returnTo && u.role !== 'admin') {
        setForm({ email: '', password: '' });
        setError(CONNECT_WRONG_ACCOUNT);
        return;
      }
      login(res.data.token, res.data.user);
      if (u.role === 'admin' && returnTo) navigate(returnTo, { replace: true });
      else if (u.role === 'admin') navigate('/admin');
      else if (['applied','interviewing','rejected'].includes(u.onboarding_status)) navigate(getHomePath(u));
      else if (u.onboarding_status === 'in_progress' && !u.has_application) {
        if (window.location.hostname.startsWith('staff.')) {
          const params = new URLSearchParams();
          if (u.email) params.set('email', u.email);
          const qs = params.toString();
          window.location.assign('https://hiring.drbartender.com/apply' + (qs ? '?' + qs : ''));
          return;
        }
        navigate('/apply');
        return;
      }
      // Portal staff (submitted/reviewed/approved) + hired onboarding fall through
      // to the canonical decision tree. Post-cutover this sends portal users to
      // /dashboard (→ / → HomePage on staff; → HomePage on hiring), not /welcome.
      else navigate(getHomePath(u));
    } catch (err) {
      // Login intentionally surfaces a generic message (no field-level errors)
      // for security: never reveal whether email exists vs. password wrong.
      setError(err.message || 'Login failed.');
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div className="text-center mb-3">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }} aria-hidden="true">⚗️</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Welcome Back</h1>
            <p className="text-muted italic">
              {returnTo ? 'Sign in with your admin account to approve Claude' : 'Sign in to your account'}
            </p>
          </div>

          <div className="card">
            <form onSubmit={submit}>
              <div className={"form-group" + fieldClass('email')}>
                <label htmlFor="email" className="form-label">Email Address</label>
                <input
                  id="email" name="email" type="email" autoComplete="username" className={"form-input" + inputClass('email')}
                  placeholder="your@email.com"
                  value={form.email} onChange={handle}
                />
              </div>

              <div className={"form-group" + fieldClass('password')} style={{ marginBottom: '1.5rem' }}>
                <label htmlFor="password" className="form-label">Password</label>
                <input
                  id="password" name="password" type="password" autoComplete="current-password" className={"form-input" + inputClass('password')}
                  placeholder="Your password"
                  value={form.password} onChange={handle}
                />
              </div>

              <FormBanner error={error} fieldErrors={fieldErrors} />

              <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                {loading ? 'Signing In...' : 'Sign In →'}
              </button>
            </form>

            <p className="text-center text-small" style={{ marginTop: '0.75rem' }}>
              <Link to="/forgot-password">Forgot your password?</Link>
            </p>

            <div className="divider" />
            <p className="text-center text-small">
              New contractor? <Link to="/register">Create your account</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
