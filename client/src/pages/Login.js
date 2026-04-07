import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';
import useFormValidation from '../hooks/useFormValidation';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
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
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', form);
      login(res.data.token, res.data.user);
      const u = res.data.user;
      if (u.role === 'admin') navigate('/admin');
      else if (['applied','interviewing','rejected'].includes(u.onboarding_status)) navigate('/application-status');
      else if (u.onboarding_status === 'in_progress' && !u.has_application) navigate('/apply');
      else navigate('/welcome');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed.');
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
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }} aria-hidden="true">⚗️</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Welcome Back</h1>
            <p className="text-muted italic">Sign in to your account</p>
          </div>

          <div className="card">
            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={submit}>
              <div className={"form-group" + fieldClass('email')}>
                <label htmlFor="email" className="form-label">Email Address</label>
                <input
                  id="email" name="email" type="email" className={"form-input" + inputClass('email')}
                  placeholder="your@email.com"
                  value={form.email} onChange={handle}
                />
              </div>

              <div className={"form-group" + fieldClass('password')} style={{ marginBottom: '1.5rem' }}>
                <label htmlFor="password" className="form-label">Password</label>
                <input
                  id="password" name="password" type="password" className={"form-input" + inputClass('password')}
                  placeholder="Your password"
                  value={form.password} onChange={handle}
                />
              </div>

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
