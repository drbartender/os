import React, { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from './BrandLogo';

const STEPS = [
  { key: 'account_created', label: 'Account', path: null },
  { key: 'welcome_viewed', label: 'Welcome', path: '/welcome' },
  { key: 'field_guide_completed', label: 'Field Guide', path: '/field-guide' },
  { key: 'agreement_completed', label: 'Agreement', path: '/agreement' },
  { key: 'contractor_profile_completed', label: 'Profile', path: '/contractor-profile' },
  { key: 'payday_protocols_completed', label: 'Payday', path: '/payday-protocols' },
  { key: 'onboarding_completed', label: 'Complete', path: '/complete' },
];

const PATH_TO_STEP = {
  '/welcome': 1,
  '/field-guide': 2,
  '/agreement': 3,
  '/contractor-profile': 4,
  '/payday-protocols': 5,
  '/complete': 6,
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [progress, setProgress] = useState({});

  useEffect(() => {
    api.get('/progress').then(r => setProgress(r.data)).catch(() => {});
  }, [location.pathname]);

  const currentStepIndex = PATH_TO_STEP[location.pathname] ?? 0;

  function getStepStatus(index) {
    const step = STEPS[index];
    if (progress[step.key]) return 'completed';
    if (index === currentStepIndex) return 'active';
    return 'pending';
  }

  const completedCount = STEPS.filter((s, i) => progress[s.key]).length;
  const pct = Math.round((completedCount / STEPS.length) * 100);

  return (
    <>
      <header className="site-header">
        <BrandLogo />
        <div className="header-actions">
          <span className="header-user">{user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>
            Sign Out
          </button>
        </div>
      </header>

      {user?.role === 'staff' && (
        <div className="steps-bar" role="navigation" aria-label="Onboarding progress">
          <div className="steps-track">
            {STEPS.map((step, i) => {
              const status = getStepStatus(i);
              const canNavigate = step.path && (status === 'completed' || status === 'active');
              return (
                <div
                  key={step.key}
                  className={`step-item ${status} ${canNavigate ? 'step-item-clickable' : ''}`}
                  role={canNavigate ? 'button' : undefined}
                  tabIndex={canNavigate ? 0 : undefined}
                  aria-current={status === 'active' ? 'step' : undefined}
                  aria-label={step.path ? `Step ${i + 1}: ${step.label}` : undefined}
                  onClick={canNavigate ? () => navigate(step.path) : undefined}
                  onKeyDown={canNavigate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(step.path); } } : undefined}
                >
                  <div className="step-dot">
                    {status === 'completed' ? '✓' : i + 1}
                  </div>
                  <div className="step-label">{step.label}</div>
                </div>
              );
            })}
          </div>
          <div style={{ maxWidth: 800, margin: '0.75rem auto 0', padding: '0 4px' }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      )}

      <main>
        <Outlet context={{ progress, setProgress }} />
      </main>
    </>
  );
}
