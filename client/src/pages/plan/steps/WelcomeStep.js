import React from 'react';
import { getEventTypeLabel } from '../../../utils/eventTypes';

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
          <div className="event-subtitle">
            {plan?.client_name
              ? `${plan.client_name}'s ${getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}`
              : `Your ${getEventTypeLabel({ event_type: plan.event_type, event_type_custom: plan.event_type_custom })}`}
          </div>
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
