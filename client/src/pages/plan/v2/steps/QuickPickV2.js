import React from 'react';

// Four presets; Custom Setup is gone (spec §3.1) — every combination it
// enabled is reachable through these flows' None/skip answers.
const PICKS = [
  { key: 'full_bar', label: 'Full Bar Experience', emoji: '🍸', description: 'Complete open bar with signature cocktails, spirits, beer & wine.' },
  { key: 'sig_beer_wine', label: 'Signature Drinks + Beer & Wine', emoji: '🍷', description: 'Custom cocktails plus beer and wine. No other mixed drinks.' },
  { key: 'beer_wine', label: 'Beer & Wine Only', emoji: '🍺', description: 'Curated beer and wine selection, no cocktails.' },
  { key: 'mocktails', label: 'Mocktails Only', emoji: '🧃', description: 'Non-alcoholic handcrafted drinks for all ages.' },
];

export default function QuickPickV2({ quickPick, setQuickPick, goToStep }) {
  const select = (key) => {
    setQuickPick(key);
    const first = { full_bar: 'drinks', sig_beer_wine: 'drinks', beer_wine: 'beerWine', mocktails: 'drinks' }[key];
    goToStep(first);
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>What's on the Menu?</h2>
        <p className="text-muted">What kind of bar experience are you imagining?</p>
      </div>
      <div className="serving-type-grid">
        {PICKS.map((pick) => (
          <button
            key={pick.key}
            className={`card serving-type-card${quickPick === pick.key ? ' selected' : ''}`}
            onClick={() => select(pick.key)}
          >
            <span className="serving-type-emoji">{pick.emoji}</span>
            <h3 className="serving-type-label">{pick.label}</h3>
            <p className="serving-type-desc">{pick.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
