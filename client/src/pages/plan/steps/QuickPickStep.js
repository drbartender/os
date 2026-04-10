import React, { useState } from 'react';
import { QUICK_PICKS } from '../data/servingTypes';

export default function QuickPickStep({ selected, onSelect, exploration }) {
  const [selecting, setSelecting] = useState(null);

  const handleSelect = (key) => {
    setSelecting(key);
    setTimeout(() => {
      onSelect(key);
      setSelecting(null);
    }, 400);
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          What's on the Menu?
        </h2>
        <p className="text-muted">
          What kind of bar experience are you imagining?
        </p>
        {exploration?.vibe && (
          <p className="text-muted text-small" style={{ color: 'var(--amber)', fontStyle: 'italic', marginTop: '0.5rem' }}>
            Based on your {exploration.vibe} vibe, we'd suggest starting here.
          </p>
        )}
      </div>

      <div className="serving-type-grid">
        {QUICK_PICKS.map(pick => (
          <button
            key={pick.key}
            className={`card serving-type-card${selected === pick.key || selecting === pick.key ? ' selected' : ''}`}
            onClick={() => !selecting && handleSelect(pick.key)}
            disabled={!!selecting}
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
