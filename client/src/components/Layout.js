// The onboarding shell: header, the step progress bar and the outstanding-documents notice around each onboarding page.
//
// The steps and their numbers come from utils/onboardingSteps.js, the same list the
// pages use to decide where a finished step goes next.

import React, { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import BrandLogo from './BrandLogo';
import { ONBOARDING_STEPS as STEPS, ONBOARDING_STEP_COUNT, PATH_TO_STEP } from '../utils/onboardingSteps';

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
                  aria-label={step.path ? `Step ${i}: ${step.label}` : undefined}
                  onClick={canNavigate ? () => navigate(step.path) : undefined}
                  onKeyDown={canNavigate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(step.path); } } : undefined}
                >
                  <div className="step-dot">
                    {/* Account (index 0) is the pre-step and has no number;
                        Welcome is 1, matching each page's "Step n of 6". */}
                    {status === 'completed' || i === 0 ? '✓' : i}
                  </div>
                  <div className="step-label">{step.label}</div>
                </div>
              );
            })}
          </div>
          {/* Compact counter, phones only (CSS swaps it in for .steps-track,
              which runs off-screen at 390px). Same STEPS/currentStepIndex. */}
          <div className="steps-compact">
            Step {currentStepIndex} of {ONBOARDING_STEP_COUNT}: {STEPS[currentStepIndex].label}
          </div>
          <div style={{ maxWidth: 800, margin: '0.75rem auto 0', padding: '0 4px' }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      )}

      <main>
        {/* Persistent, because a to-do that lives on one page is seen once. This
            sits in the layout so it follows the recruit through welcome, field
            guide, agreement, contractor profile and payday, and Layout already
            refetches /progress on every pathname change so it clears itself the
            moment they upload. alert-info, not alert-warning: index.css defines
            only alert / alert-error / alert-success / alert-info. */}
        {progress?.documents_outstanding?.length > 0 && (
          <div className="page-container">
            <div className="alert alert-info" role="status">
              We still need your {progress.documents_outstanding.join(' and ')}. Add
              {progress.documents_outstanding.length === 1 ? ' it' : ' them'} on
              the <Link to="/contractor-profile">Contractor Profile</Link> step. We do need
              {progress.documents_outstanding.length === 1 ? ' it' : ' them'} before your first shift.
            </div>
          </div>
        )}
        <Outlet context={{ progress, setProgress }} />
      </main>
    </>
  );
}
