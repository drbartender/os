import React from 'react';

const OPTIONS = [
  { key: 'yes', label: 'Yes, definitely', emoji: '\uD83E\uDDC3', desc: 'We have some amazing non-alcoholic options.' },
  { key: 'maybe', label: 'Maybe — I\'d like to see what\'s available', emoji: '\uD83E\uDD14', desc: 'We\'ll show you options when you\'re ready to finalize.' },
  { key: 'no', label: 'No thanks', emoji: '\u274C', desc: 'No mocktails needed.' },
];

export default function MocktailInterestStep({ value, onChange }) {
  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Interested in mocktails?
        </h2>
        <p className="text-muted">
          If you have kids or non-drinkers at the event, we typically recommend 1-2
          mocktails that match your cocktail vibe.
        </p>
      </div>

      <div className="vibe-grid">
        {OPTIONS.map(opt => (
          <button
            key={opt.key}
            className={`vibe-card${value === opt.key ? ' selected' : ''}`}
            onClick={() => onChange(opt.key)}
            aria-pressed={value === opt.key}
          >
            <span className="vibe-emoji">{opt.emoji}</span>
            <span className="vibe-label">{opt.label}</span>
            <span className="vibe-desc">{opt.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
