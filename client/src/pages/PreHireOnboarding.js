import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import api from '../utils/api';
import { getHomePath } from '../utils/userRoutes';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import useFormValidation from '../hooks/useFormValidation';

export default function PreHireOnboarding() {
  const { user, login, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();
  const claimedRef = useRef(false);

  // If the visitor is already logged in (returning recruit, or someone who
  // registered via /register before learning about /onboarding), claim the
  // pre-hire flag on their existing account and route them onward. Otherwise
  // render the registration form below.
  useEffect(() => {
    if (authLoading || !user || claimedRef.current) return;
    claimedRef.current = true;
    (async () => {
      try {
        const res = await api.post('/auth/claim-pre-hire');
        const updated = res?.data?.user;
        const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
        if (updated && token) login(token, updated);
        const status = updated?.onboarding_status || user.onboarding_status;
        if (['hired', 'submitted', 'reviewed', 'approved'].includes(status)) {
          navigate('/welcome');
        } else {
          navigate('/apply');
        }
      } catch (claimErr) {
        // Best-effort fallback — if the claim call fails, route the user to
        // the appropriate landing for their current status via the shared
        // getHomePath so 'interviewing' / 'hired' / portal users don't end up
        // on /apply by mistake.
        navigate(getHomePath(user));
      }
    })();
  }, [user, authLoading, login, navigate]);

  const rules = [
    { field: 'email', label: 'Email' },
    { field: 'password', label: 'Password', test: v => v.length >= 8 },
    { field: 'confirmPassword', label: 'Confirm Password' },
  ];

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
    clearField(name);
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    if (form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'Passwords do not match.' });
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/register-pre-hired', {
        email: form.email,
        password: form.password,
      });
      login(res.data.token, res.data.user);
      toast.success('Welcome aboard!');
      navigate('/apply');
    } catch (err) {
      setError(err.message || 'Could not create your account. Please try again.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setLoading(false);
    }
  }

  // Logged-in visitors get the claim path above — render a loader while it runs
  // instead of flashing the registration form they don't need. Geometry matches
  // the Suspense fallback (~50vh) to avoid a visible layout jump when the lazy
  // chunk resolves and this loader takes over from <SuspenseFallback />.
  if (authLoading || user) {
    return (
      <div
        className="loading"
        style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        role="status"
        aria-live="polite"
      >
        <div className="spinner" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="auth-page" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 460 }}>
          <div className="text-center mb-3">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }} aria-hidden="true">🥂</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Welcome aboard!</h1>
            <p className="text-muted italic">You've been pre-approved as a Dr. Bartender contractor</p>
          </div>

          <div className="card">
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Set up your account to get started. Next you'll fill out a quick contractor
                application, then sign the agreement, complete your profile, and upload your
                W-9 — about 20 minutes total.
              </p>
            </div>

            <form onSubmit={submit}>
              <div className={"form-group" + fieldClass('email')}>
                <label htmlFor="prehire-email" className="form-label">Email Address</label>
                <input
                  id="prehire-email" name="email" type="email" autoComplete="email" className={"form-input" + inputClass('email')}
                  placeholder="your@email.com"
                  value={form.email} onChange={handle}
                  aria-invalid={!!fieldErrors?.email}
                />
                <FieldError error={fieldErrors?.email} />
              </div>

              <div className={"form-group" + fieldClass('password')}>
                <label htmlFor="prehire-password" className="form-label">Create Password</label>
                <input
                  id="prehire-password" name="password" type="password" autoComplete="new-password" className={"form-input" + inputClass('password')}
                  placeholder="Minimum 8 characters, with a number and uppercase letter"
                  value={form.password} onChange={handle}
                  aria-invalid={!!fieldErrors?.password}
                />
                <FieldError error={fieldErrors?.password} />
              </div>

              <div className={"form-group" + fieldClass('confirmPassword')}>
                <label htmlFor="prehire-confirmPassword" className="form-label">Confirm Password</label>
                <input
                  id="prehire-confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" className={"form-input" + inputClass('confirmPassword')}
                  placeholder="Confirm your password"
                  value={form.confirmPassword} onChange={handle}
                  aria-invalid={!!fieldErrors?.confirmPassword}
                />
                <FieldError error={fieldErrors?.confirmPassword} />
              </div>

              <FormBanner error={error} fieldErrors={fieldErrors} />

              <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                {loading ? 'Creating Account...' : 'Start Onboarding →'}
              </button>
            </form>

            <div className="divider" />
            <p className="text-center text-small">
              Already have an account? <Link to="/login">Sign in here</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
