import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';

export default function StaffProfile() {
  const { user } = useAuth();
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/contractor')
      .then(r => setProfile(r.data))
      .catch(err => {
        console.error(err);
        toast.error("Couldn't load profile. Try refreshing.");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page-container"><div className="loading"><div className="spinner" />Loading...</div></div>;

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>My Profile</h1>
        <Link to="/contractor-profile" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
          Edit Profile
        </Link>
      </div>

      {profile ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div className="card">
            <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Personal Info</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Name</div>
                <div style={{ color: 'var(--deep-brown)' }}>{profile.preferred_name || user?.email}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Email</div>
                <div style={{ color: 'var(--deep-brown)' }}>{user?.email || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Phone</div>
                <div style={{ color: 'var(--deep-brown)' }}>{profile.phone || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Location</div>
                <div style={{ color: 'var(--deep-brown)' }}>{[profile.city, profile.state].filter(Boolean).join(', ') || '—'}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Emergency Contact</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Name</div>
                <div style={{ color: 'var(--deep-brown)' }}>{profile.emergency_contact_name || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Phone</div>
                <div style={{ color: 'var(--deep-brown)' }}>{profile.emergency_contact_phone || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Relationship</div>
                <div style={{ color: 'var(--deep-brown)' }}>{profile.emergency_contact_relationship || '—'}</div>
              </div>
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Equipment & Skills</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {profile.has_vehicle && <span className="badge badge-approved">Has Vehicle</span>}
              {profile.has_bar_kit && <span className="badge badge-approved">Bar Kit</span>}
              {profile.has_ice_luge && <span className="badge badge-approved">Ice Luge</span>}
              {profile.has_mobile_bar && <span className="badge badge-approved">Mobile Bar</span>}
              {!profile.has_vehicle && !profile.has_bar_kit && !profile.has_ice_luge && !profile.has_mobile_bar && (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No equipment listed</span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card text-center" style={{ padding: '2.5rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>
            No profile found. <Link to="/contractor-profile" style={{ color: 'var(--amber)' }}>Set up your profile</Link>
          </p>
        </div>
      )}
    </div>
  );
}
