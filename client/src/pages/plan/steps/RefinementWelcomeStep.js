import React from 'react';
import WelcomeRoadmap from '../components/WelcomeRoadmap';

// Format a date column ('YYYY-MM-DD' or ISO) without the UTC off-by-one shift.
function formatEventDate(value) {
  if (!value) return null;
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function RefinementWelcomeStep({ plan, guestCount, onStart }) {
  const isHosted = plan?.package_category === 'hosted';
  const mode = isHosted ? 'hosted' : 'byob';
  const packageName = plan?.package_name || 'your package';
  const firstName = plan?.client_name ? String(plan.client_name).trim().split(/\s+/)[0] : '';

  const metaBits = [
    guestCount ? `${guestCount} guests` : null,
    formatEventDate(plan?.event_date),
    isHosted ? packageName : 'BYOB',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="potion-welcome">
      <div className="card potion-card-inner-frame potion-welcome-card">
        <span className="potion-kicker">Finalize your bar</span>
        <h1 className="potion-welcome-title">
          Welcome back{firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="potion-welcome-lede">
          Your booking's confirmed, so you're already underway. All that's left is finalizing your
          bar. <strong>Three parts, just a few minutes.</strong>
        </p>

        <WelcomeRoadmap mode={mode} packageName={packageName} metaBits={metaBits} />

        <div className="potion-launch">
          <button type="button" className="btn potion-start" onClick={onStart}>
            Start
          </button>
          <p className="potion-launch-reassure">
            No wrong answers. Your progress saves as you go, and you can go back and change anything
            before you submit.
          </p>
          <p className="potion-launch-cost">
            Nothing here charges you. You'll see the price before any upgrade.
          </p>
        </div>
      </div>
    </div>
  );
}
