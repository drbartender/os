import React from 'react';

const SPIRITS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch'];

export default function FullBarSpiritsStep({ selections, onChange }) {
  const spirits = selections.spirits || [];

  const toggleArray = (field, value) => {
    const current = selections[field] || [];
    if (current.includes(value)) {
      onChange(field, current.filter(v => v !== value));
    } else {
      onChange(field, [...current, value]);
    }
  };

  const allSpiritsSelected = SPIRITS.every(s => spirits.includes(s));
  const handleSelectAllSpirits = () => {
    if (allSpiritsSelected) {
      onChange('spirits', spirits.filter(s => !SPIRITS.includes(s)));
    } else {
      const merged = [...new Set([...spirits, ...SPIRITS])];
      onChange('spirits', merged);
    }
  };

  const handleSpiritOtherToggle = () => {
    if (spirits.includes('Other')) {
      onChange('spirits', spirits.filter(s => s !== 'Other'));
      onChange('spiritsOther', '');
    } else {
      onChange('spirits', [...spirits, 'Other']);
    }
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Spirits &amp; Mixers
        </h2>
        <p className="text-muted">
          For a cocktail-forward crowd, Vodka, Tequila, and Gin cover about 80% of requests.
        </p>
      </div>

      {/* Spirits */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Spirits &amp; Liquor
        </h3>
        <div className="form-group">
          <label className="form-label">Which spirits should we stock?</label>
          <div className="checkbox-grid">
            <label className="checkbox-label select-all">
              <input
                type="checkbox"
                checked={allSpiritsSelected}
                onChange={handleSelectAllSpirits}
              />
              <span>Select All</span>
            </label>
            {SPIRITS.map(spirit => (
              <label key={spirit} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={spirits.includes(spirit)}
                  onChange={() => toggleArray('spirits', spirit)}
                />
                <span>{spirit}</span>
              </label>
            ))}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={spirits.includes('Other')}
                onChange={handleSpiritOtherToggle}
              />
              <span>Other</span>
            </label>
          </div>
          {spirits.includes('Other') && (
            <div className="mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What other spirits? E.g., Mezcal, Cognac..."
                value={selections.spiritsOther || ''}
                onChange={(e) => onChange('spiritsOther', e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Mixers */}
      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Mixers
        </h3>
        <div className="form-group">
          <label className="form-label">
            Would you like us to stock mixers for these spirits?
          </label>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            Tonic, soda, ginger beer, juices, etc. for guests who want simple mixed drinks.
          </p>
          <div className="checkbox-grid">
            <label className="checkbox-label">
              <input
                type="radio"
                name="mixersForSpirits"
                checked={selections.mixersForSpirits === true}
                onChange={() => onChange('mixersForSpirits', true)}
              />
              <span>Yes, include mixers</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="mixersForSpirits"
                checked={selections.mixersForSpirits === false}
                onChange={() => onChange('mixersForSpirits', false)}
              />
              <span>No mixers needed</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="mixersForSpirits"
                checked={selections.mixersForSpirits === null}
                onChange={() => onChange('mixersForSpirits', null)}
              />
              <span>Not sure yet — we'll figure it out together</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
