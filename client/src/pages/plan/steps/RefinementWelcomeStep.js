import React from 'react';

const VIBE_LABELS = {
  elegant: 'Elegant & Refined',
  casual: 'Laid-Back & Easy',
  playful: 'Fun & Festive',
  bold: 'Bold & Adventurous',
  chill: 'Chill & Cozy',
  themed: 'Themed & Creative',
};

export default function RefinementWelcomeStep({ plan, exploration, guestCount }) {
  const hasExploration = exploration && (exploration.vibe || exploration.favoriteDrinks?.length > 0);

  return (
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
            Let's finalize the details for your bar. We'll build on what you already
            explored and lock everything in.
          </p>

          {hasExploration && (
            <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(193, 125, 60, 0.08)', borderRadius: '8px', borderLeft: '3px solid var(--amber)' }}>
              <p style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem', fontSize: '0.9rem' }}>
                From your exploration:
              </p>
              {exploration.vibe && (
                <p className="text-muted text-small">Vibe: {VIBE_LABELS[exploration.vibe] || exploration.vibe}</p>
              )}
              {exploration.flavorDirections?.length > 0 && (
                <p className="text-muted text-small">Flavors: {exploration.flavorDirections.join(', ')}</p>
              )}
              {exploration.favoriteDrinks?.length > 0 && (
                <p className="text-muted text-small">{exploration.favoriteDrinks.length} favorite drink{exploration.favoriteDrinks.length !== 1 ? 's' : ''} saved</p>
              )}
            </div>
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
