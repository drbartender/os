import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import useFormValidation from '../hooks/useFormValidation';

export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const rules = [
    { field: 'email', label: 'Email' },
    { field: 'password', label: 'Password', test: v => v.length >= 8 },
    { field: 'confirmPassword', label: 'Confirm Password' },
  ];

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
    clearField(name);
    // Clear server-side field error when user edits that field
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
      const res = await api.post('/auth/register', form);
      login(res.data.token, res.data.user);
      toast.success('Account created!');
      navigate('/apply');
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
      setFieldErrors(err.fieldErrors || {});
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
        <div style={{ width: '100%', maxWidth: 460 }}>
          <div className="text-center mb-3">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }} aria-hidden="true">⚗️</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Create Your Account</h1>
            <p className="text-muted italic">Apply to join the Dr. Bartender team</p>
          </div>

          <div className="card">
            <div style={{ marginBottom: '1.5rem' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
                Welcome to Dr. Bartender! Create your account to start your application.
                After applying, we'll review your info and be in touch.
              </p>
            </div>

            <form onSubmit={submit}>
              <div className={"form-group" + fieldClass('email')}>
                <label htmlFor="register-email" className="form-label">Email Address</label>
                <input
                  id="register-email" name="email" type="email" className={"form-input" + inputClass('email')}
                  placeholder="your@email.com"
                  value={form.email} onChange={handle}
                  aria-invalid={!!fieldErrors?.email}
                />
                <FieldError error={fieldErrors?.email} />
              </div>

              <div className={"form-group" + fieldClass('password')}>
                <label htmlFor="register-password" className="form-label">Create Password</label>
                <input
                  id="register-password" name="password" type="password" className={"form-input" + inputClass('password')}
                  placeholder="Minimum 8 characters"
                  value={form.password} onChange={handle}
                  aria-invalid={!!fieldErrors?.password}
                />
                <FieldError error={fieldErrors?.password} />
              </div>

              <div className={"form-group" + fieldClass('confirmPassword')}>
                <label htmlFor="register-confirmPassword" className="form-label">Confirm Password</label>
                <input
                  id="register-confirmPassword" name="confirmPassword" type="password" className={"form-input" + inputClass('confirmPassword')}
                  placeholder="Confirm your password"
                  value={form.confirmPassword} onChange={handle}
                  aria-invalid={!!fieldErrors?.confirmPassword}
                />
                <FieldError error={fieldErrors?.confirmPassword} />
              </div>

              <FormBanner error={error} fieldErrors={fieldErrors} />

              <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                {loading ? 'Creating Account...' : 'Create Account →'}
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
