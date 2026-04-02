import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from '../components/BrandLogo';

export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) return setError('Passwords do not match.');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    setLoading(true);
    try {
      const res = await api.post('/auth/register', form);
      login(res.data.token, res.data.user);
      navigate('/apply');
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
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
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚗️</div>
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

              <div className="form-group">
                <label className="form-label">Create Password</label>
                <input
                  name="password" type="password" className="form-input"
                  placeholder="Minimum 8 characters"
                  value={form.password} onChange={handle} required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Confirm Password</label>
                <input
                  name="confirmPassword" type="password" className="form-input"
                  placeholder="Confirm your password"
                  value={form.confirmPassword} onChange={handle} required
                />
              </div>

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
