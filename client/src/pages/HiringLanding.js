import React from 'react';
import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';

export default function HiringLanding() {
  return (
    <div className="auth-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="site-header">
        <BrandLogo />
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ width: '100%', maxWidth: 600 }}>
          <div className="text-center mb-3">
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '0.5rem' }}>
              Join the Dr. Bartender Team
            </h1>
            <p style={{ color: 'var(--parchment)', opacity: 0.85, fontSize: '1.05rem', maxWidth: 480, margin: '0 auto' }}>
              We're always looking for talented, reliable bartenders, barbacks, and servers to join our crew.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '2rem' }}>
            <div className="card" style={{ textAlign: 'center', padding: '1.5rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>1</div>
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.3rem' }}>Create Account</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                Sign up with your email and set a password
              </p>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '1.5rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>2</div>
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.3rem' }}>Apply</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                Tell us about your experience and availability
              </p>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '1.5rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>3</div>
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.3rem' }}>Interview</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                We'll reach out to schedule a quick chat
              </p>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '1.5rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>4</div>
              <h3 style={{ fontSize: '0.95rem', marginBottom: '0.3rem' }}>Start Working</h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                Complete onboarding and pick up shifts
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center' }}>
            <Link to="/register" className="btn btn-primary" style={{ width: '100%', maxWidth: 320, textAlign: 'center', textDecoration: 'none', fontSize: '1.05rem', padding: '0.85rem 1.5rem' }}>
              Apply Now
            </Link>
            <p style={{ color: 'var(--parchment)', opacity: 0.7, fontSize: '0.88rem' }}>
              Already have an account? <Link to="/login" style={{ color: 'var(--amber-light)' }}>Sign in</Link>
            </p>
          </div>

          <div style={{ marginTop: '2.5rem', textAlign: 'center' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--amber-light)', fontSize: '1.1rem', marginBottom: '0.75rem' }}>
              Why Dr. Bartender?
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
              <div style={{ color: 'var(--parchment)', fontSize: '0.85rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>Flexible Schedule</div>
                <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>Pick the gigs that work for you</div>
              </div>
              <div style={{ color: 'var(--parchment)', fontSize: '0.85rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>Great Events</div>
                <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>Weddings, corporate, private parties</div>
              </div>
              <div style={{ color: 'var(--parchment)', fontSize: '0.85rem' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>Competitive Pay</div>
                <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>Hourly rates plus tips</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
