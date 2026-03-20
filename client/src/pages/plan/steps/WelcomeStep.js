import React from 'react';

export default function WelcomeStep({ plan }) {
  return (
    <div className="potion-parchment">
      <h1 className="potion-welcome-title">
        Welcome to the Potion Planning Lab
      </h1>

      <img
        src="/images/potion-bartender.png"
        alt="Dr. Bartender"
        className="potion-welcome-bartender"
      />

      <div className="potion-welcome-right">
        <div className="potion-welcome-text">
          {plan?.client_name && (
            <p style={{ fontWeight: 700, marginBottom: '0.5rem', color: '#2C1F0E' }}>
              Hello, {plan.client_name}!
            </p>
          )}
          {plan?.event_name && (
            <p style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)', color: '#2C1F0E' }}>
              <span style={{ color: '#6B1A1A', fontWeight: 600 }}>Event: {plan.event_name}</span>
              {plan.event_date && (
                <span style={{ color: '#C17D3C' }}>
                  {' '}&mdash;{' '}
                  {new Date(plan.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </span>
              )}
            </p>
          )}
          <p style={{ color: '#3D2810' }}>
            You're about to mix a few details to help us design your perfect bar setup.
            We'll take your answers, refine recipe,
            and send back your completed shopping list
            and display menu in a few days.
          </p>
          <p style={{ marginTop: '1rem', color: '#6B4226' }}>
            Click <strong>Next</strong> to begin.
          </p>
        </div>

        <img
          src="/images/potion-drinks.png"
          alt="Signature cocktails"
          className="potion-welcome-drinks"
        />
      </div>
    </div>
  );
}
