import React from 'react';
import WelcomeRoadmap from '../components/WelcomeRoadmap';

export default function RefinementWelcomeStep({ plan, guestCount }) {
  const isHosted = plan?.package_category === 'hosted';
  const mode = isHosted ? 'hosted' : 'byob';
  const packageName = plan?.package_name || 'package';

  return (
    <>
      {isHosted && Array.isArray(plan.package_includes) && plan.package_includes.length > 0 && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
            Your package: {plan.package_name}
          </h3>
          <p className="text-muted text-small" style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Stocked &amp; ready:
          </p>
          <ul className="potion-hosted-list">
            {plan.package_includes
              .filter((item) => !/\{(hours|bartenders|bartenders_s)\}/.test(item))
              .map((item, i) => (
                <li key={i}>{item}</li>
              ))}
          </ul>
          <p className="text-muted text-small" style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
            Anything beyond this list is an upgrade.
          </p>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <h1 className="potion-welcome-title">
          Welcome Back!
        </h1>

        <div className="potion-welcome-body">
          <img
            src="/images/potion-bartender.png"
            alt="Dr. Bartender"
            className="potion-welcome-bartender"
          />

          <div className="potion-welcome-text">
            {plan?.client_name && (
              <p style={{ fontWeight: 700, marginBottom: '0.5rem' }}>
                {plan.client_name}, your booking is confirmed!
              </p>
            )}

            {guestCount && (
              <p style={{ fontFamily: 'var(--font-display)', marginBottom: '1rem', color: 'var(--deep-brown)' }}>
                Guest count: {guestCount}
              </p>
            )}

            <p>
              Let's finalize the details for your bar and lock everything in.
            </p>
          </div>

          <img
            src="/images/potion-drinks.png"
            alt="Signature cocktails"
            className="potion-welcome-drinks"
          />
        </div>
      </div>

      <WelcomeRoadmap mode={mode} packageName={packageName} />
    </>
  );
}
