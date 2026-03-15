import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function submit(e) {
    e.preventDefault();
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
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚗️</div>
            <h1 style={{ marginBottom: '0.25rem' }}>Welcome Back</h1>
            <p className="text-muted italic">Sign in to your account</p>
          </div>

          <div className="card">
            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={submit}>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input
                  name="email" type="email" className="form-input"
                  placeholder="your@email.com"
                  value={form.email} onChange={handle} required
                />
              </div>

              <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                <label className="form-label">Password</label>
                <input
                  name="password" type="password" className="form-input"
                  placeholder="Your password"
                  value={form.password} onChange={handle} required
                />
              </div>

              <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
                {loading ? 'Signing In...' : 'Sign In →'}
              </button>
            </form>

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
