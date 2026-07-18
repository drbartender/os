import React from 'react';
import ScopeBanner from '../../components/ScopeBanner';

const SPIRITS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch'];

// BYOB full-bar stocking: spirits + mixers. One shared vocabulary; "not sure
// yet" stores the real value 'undecided' (never null, spec §3.1).
export default function SpiritsV2({ selections, updateSelections }) {
  const spirits = selections.spirits || [];
  const toggle = (s) => updateSelections('spirits', spirits.includes(s) ? spirits.filter((x) => x !== s) : [...spirits, s]);
  const allSelected = SPIRITS.every((s) => spirits.includes(s));

  return (
    <div>
      <ScopeBanner
        tone="shopping"
        title="Builds your shopping list"
        body="Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy."
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Spirits &amp; Mixers</h2>
        <p className="text-muted">For a cocktail-forward crowd, Vodka, Tequila, and Gin cover about 80% of requests.</p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Spirits &amp; Liquor</h3>
        <div className="form-group">
          <label className="form-label">Which spirits should we stock?</label>
          <div className="checkbox-grid">
            <label className="checkbox-label select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => updateSelections('spirits', allSelected ? spirits.filter((s) => !SPIRITS.includes(s)) : [...new Set([...spirits, ...SPIRITS])])}
              />
              <span>Select all</span>
            </label>
            {SPIRITS.map((s) => (
              <label key={s} className="checkbox-label">
                <input type="checkbox" checked={spirits.includes(s)} onChange={() => toggle(s)} />
                <span>{s}</span>
              </label>
            ))}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={spirits.includes('Other')}
                onChange={() => {
                  if (spirits.includes('Other')) {
                    updateSelections('spirits', spirits.filter((s) => s !== 'Other'));
                    updateSelections('spiritsOther', '');
                  } else toggle('Other');
                }}
              />
              <span>Other</span>
            </label>
          </div>
          {spirits.includes('Other') && (
            <div className="mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What other spirits? e.g. Mezcal, Cognac..."
                value={selections.spiritsOther || ''}
                onChange={(e) => updateSelections('spiritsOther', e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Mixers</h3>
        <div className="form-group">
          <label className="form-label">Would you like us to stock mixers for these spirits?</label>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            Tonic, soda, juices, and the rest, for guests who want simple mixed drinks.
          </p>
          <div className="checkbox-grid">
            {[[true, 'Yes, include mixers'], [false, 'No mixers needed'], ['undecided', 'Not sure yet, we’ll figure it out together']].map(([value, label]) => (
              <label key={String(value)} className="checkbox-label">
                <input
                  type="radio"
                  name="mixersForSpirits"
                  checked={selections.mixersForSpirits === value}
                  onChange={() => updateSelections('mixersForSpirits', value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
