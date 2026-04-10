import React from 'react';

const VIBE_LABELS = {
  elegant: 'Elegant & Refined',
  casual: 'Laid-Back & Easy',
  playful: 'Fun & Festive',
  bold: 'Bold & Adventurous',
  chill: 'Chill & Cozy',
  themed: 'Themed & Creative',
};

export default function ExplorationSaveStep({
  exploration = {},
  cocktails = [],
  onSave,
  saving,
}) {
  const { vibe, flavorDirections = [], favoriteDrinks = [], mocktailInterest } = exploration;
  const favDrinkNames = cocktails.filter(c => favoriteDrinks.includes(c.id));

  return (
    <div>
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', textAlign: 'center' }}>
          Here's What You Explored
        </h2>
        <p className="text-muted" style={{ textAlign: 'center' }}>
          We'll keep these ideas warm for you. When you're ready to book, everything
          you saved will be waiting.
        </p>

        <div style={{ marginTop: '1.5rem' }}>
          {vibe && (
            <div className="exploration-summary-item">
              <strong>Your vibe:</strong> {VIBE_LABELS[vibe] || vibe}
            </div>
          )}

          {flavorDirections.length > 0 && (
            <div className="exploration-summary-item">
              <strong>Flavor direction:</strong> {flavorDirections.join(', ')}
            </div>
          )}

          {favDrinkNames.length > 0 && (
            <div className="exploration-summary-item">
              <strong>Favorite drinks:</strong>
              <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                {favDrinkNames.map(d => (
                  <li key={d.id}>{d.emoji} {d.name}</li>
                ))}
              </ul>
            </div>
          )}

          {mocktailInterest && (
            <div className="exploration-summary-item">
              <strong>Mocktails:</strong> {
                mocktailInterest === 'yes' ? 'Interested' :
                mocktailInterest === 'maybe' ? 'Maybe' : 'Not needed'
              }
            </div>
          )}
        </div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button
          className="btn btn-success"
          onClick={onSave}
          disabled={saving}
          style={{ padding: '0.75rem 2.5rem', fontSize: '1.1rem' }}
        >
          {saving ? 'Saving...' : 'Save Your Exploration'}
        </button>
      </div>
    </div>
  );
}
