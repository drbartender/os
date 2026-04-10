import React from 'react';

export default function WelcomeStep({ plan, phase = 'refinement' }) {
  const isExploration = phase === 'exploration';

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <h1 className="potion-welcome-title">
        Welcome to the Potion Planning Lab
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
              Hello, {plan.client_name}!
            </p>
          )}
          {plan?.event_name && (
            <p style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>
              Event: {plan.event_name}
              {plan.event_date && <> &mdash; {new Date(plan.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>}
            </p>
          )}
          {isExploration ? (
            <>
              <p>
                Think of this as a conversation with your bartender. We'll explore what excites
                you, what flavors you love, and what kind of bar experience you're imagining.
              </p>
              <p style={{ marginTop: '0.75rem', color: 'var(--warm-brown)', fontStyle: 'italic' }}>
                Nothing is final — just tell us what sounds good.
              </p>
            </>
          ) : (
            <p>
              Let's design your perfect bar together. We'll use your preferences to
              craft something your guests will love.
            </p>
          )}
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
