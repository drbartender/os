import React from 'react';
import { QUICK_PICKS } from '../data/servingTypes';

export default function QuickPickStep({ selected, onSelect }) {
  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          What's on the Menu?
        </h2>
        <p className="text-muted">
          Choose a package to get started, or build your own custom setup.
        </p>
      </div>

      <div className="serving-type-grid">
        {QUICK_PICKS.map(pick => (
          <button
            key={pick.key}
            className={`card serving-type-card${selected === pick.key ? ' selected' : ''}`}
            onClick={() => onSelect(pick.key)}
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
