import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../utils/api';

// Planner version router (planner v2 rollout, spec 2026-07-18 §7).
// drink_plans.planner_version decides which wizard renders: 1 = the legacy
// PotionPlanningLab, untouched, so in-flight drafts finish exactly where they
// started; 2 = the v2 wizard. This file exists so PotionPlanningLab.js (at the
// file-size hard cap) never has to change.
const PotionPlanningLab = lazy(() => import('./PotionPlanningLab'));
const PlannerV2 = lazy(() => import('./v2/PlannerV2'));

export default function PlannerRouter() {
  const { token } = useParams();
  const [state, setState] = useState({ status: 'loading', plan: null, error: null });

  useEffect(() => {
    let cancelled = false;
    axios.get(`${BASE_URL}/drink-plans/t/${token}`)
      .then((res) => { if (!cancelled) setState({ status: 'ready', plan: res.data, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-restricted-syntax
        const msg = err.response?.data?.error || 'Could not load your drink plan.';
        setState({ status: 'error', plan: null, error: msg });
      });
    return () => { cancelled = true; };
  }, [token]);

  if (state.status === 'loading') {
    return (
      <div className="auth-page potion-app">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div role="status" aria-live="polite">
            <div className="spinner" />
            <p className="text-muted mt-2">Loading your drink plan...</p>
          </div>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="auth-page potion-app">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>&#9879;&#65039;</div>
            <h2 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>Something Went Wrong</h2>
            <p className="text-muted" style={{ marginBottom: '1rem' }}>{state.error}</p>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              This link may have expired. Please contact Dr. Bartender for a new link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const plan = state.plan;

  // Pre-booking: same locked card the legacy wizard shows, rendered here so
  // neither wizard mounts for an unbooked client.
  if (plan?.locked) {
    return (
      <div className="auth-page potion-app">
        <div className="page-container" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div className="card">
            <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
              Your drink plan unlocks after you book
            </h2>
            <p className="text-muted" style={{ marginTop: '0.75rem' }}>
              Once your deposit is paid, you'll design your drinks here. Until
              then, review and accept your proposal.
            </p>
            {plan.proposalToken && (
              <a
                className="btn btn-primary"
                href={`/proposal/${plan.proposalToken}`}
                style={{ marginTop: '1.25rem', display: 'inline-block' }}
              >
                View your proposal
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  const fallback = (
    <div className="auth-page potion-app">
      <div className="page-container" style={{ padding: '3rem', textAlign: 'center', color: '#6b5a4e' }}>Loading…</div>
    </div>
  );

  if (Number(plan?.planner_version) >= 2) {
    return (
      <Suspense fallback={fallback}>
        <PlannerV2 token={token} initialPlan={plan} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={fallback}>
      <PotionPlanningLab />
    </Suspense>
  );
}
