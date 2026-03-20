import React from 'react';

export default function WelcomeStep({ plan }) {
  return (
    <div className="potion-parchment">
      <div className="potion-welcome-layout">
        <div className="potion-welcome-left">
          <img
            src="/images/potion-bartender.png"
            alt="Dr. Bartender"
            className="potion-welcome-side-img"
          />
        </div>

        <div className="potion-welcome-center">
          <h1 className="potion-welcome-title">
            Welcome to the Potion Planning Lab
          </h1>
          {plan?.client_name && (
            <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--deep-brown)', fontWeight: 600 }}>
              Hello, {plan.client_name}!
            </p>
          )}
          {plan?.event_name && (
            <p style={{ marginBottom: '1rem', color: 'var(--warm-brown)', fontFamily: 'var(--font-display)' }}>
              Event: {plan.event_name}
              {plan.event_date && <> &mdash; {new Date(plan.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>}
            </p>
          )}
          <p style={{ lineHeight: 1.7, color: 'var(--deep-brown)', fontSize: '0.95rem' }}>
            You're about to mix a few details to help us design your perfect bar setup.
            We'll take your answers, refine the recipe, and send back your completed
            shopping list and display menu in a few days.
          </p>
          <p style={{ fontSize: '0.9rem', color: 'var(--warm-brown)', marginTop: '1rem' }}>
            Click <strong>Next</strong> to begin.
          </p>
        </div>

        <div className="potion-welcome-right">
          <img
            src="/images/potion-drinks.png"
            alt="Signature cocktails"
            className="potion-welcome-side-img"
          />
        </div>
      </div>
    </div>
  );
}
