import React from 'react';

export default function WelcomeStep({ plan }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
        Welcome to the Potion Planning Lab
      </h1>
      {plan?.client_name && (
        <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>
          Hello, <strong>{plan.client_name}</strong>!
        </p>
      )}
      {plan?.event_name && (
        <p className="text-muted" style={{ marginBottom: '1rem' }}>
          Event: <strong>{plan.event_name}</strong>
          {plan.event_date && <> &mdash; {new Date(plan.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>}
        </p>
      )}
      <p style={{ lineHeight: 1.7, maxWidth: '540px', margin: '0 auto 1rem' }}>
        You're about to mix a few details to help us design your perfect bar setup.
        We'll take your answers, refine the recipe, and send back your completed
        shopping list and display menu in a few days.
      </p>
      <p className="text-muted text-small">Click <strong>Next</strong> to begin.</p>
    </div>
  );
}
