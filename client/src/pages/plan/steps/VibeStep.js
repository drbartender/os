import React from 'react';

const VIBES = [
  { key: 'elegant', label: 'Elegant & Refined', emoji: '\u2728' },
  { key: 'casual', label: 'Laid-Back & Easy', emoji: '\uD83C\uDF3F' },
  { key: 'playful', label: 'Fun & Festive', emoji: '\uD83C\uDF89' },
  { key: 'bold', label: 'Bold & Adventurous', emoji: '\uD83D\uDD25' },
  { key: 'chill', label: 'Chill & Cozy', emoji: '\uD83D\uDECB\uFE0F' },
  { key: 'themed', label: 'Themed & Creative', emoji: '\uD83C\uDFA8' },
];

export default function VibeStep({ value, onChange }) {
  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          What's the vibe?
        </h2>
        <p className="text-muted">
          Pick the one that best describes the feeling you want to create.
        </p>
      </div>

      <div className="vibe-grid">
        {VIBES.map(vibe => (
          <button
            key={vibe.key}
            className={`vibe-card${value === vibe.key ? ' selected' : ''}`}
            onClick={() => onChange(vibe.key)}
            aria-pressed={value === vibe.key}
          >
            <span className="vibe-emoji">{vibe.emoji}</span>
            <span className="vibe-label">{vibe.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
