import React from 'react';

const SPIRITS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch'];
const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer', 'Non-Alcoholic'];
const WINE_STYLES = ['Red', 'White', 'Ros\u00e9', 'Sparkling'];
const BALANCE_OPTIONS = [
  { value: '50/50', label: '50/50' },
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
];

export default function FullBarStep({ selections, onChange }) {
  const toggleArray = (field, value) => {
    const current = selections[field] || [];
    if (current.includes(value)) {
      onChange(field, current.filter(v => v !== value));
    } else {
      onChange(field, [...current, value]);
    }
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Full Bar Setup
        </h2>
        <p className="text-muted">
          Let's build out your complete bar. We'll cover spirits, mixers, beer, and wine.
        </p>
      </div>

      {/* Part 1: Spirits */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Spirits & Liquor
        </h3>
        <div className="form-group">
          <label className="form-label">Which spirits should we stock?</label>
          <div className="checkbox-grid">
            {SPIRITS.map(spirit => (
              <label key={spirit} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={(selections.spirits || []).includes(spirit)}
                  onChange={() => toggleArray('spirits', spirit)}
                />
                <span>{spirit}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Part 2: Mixers */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Mixers
        </h3>
        <div className="form-group">
          <label className="form-label">
            Would you like us to stock mixers for these spirits?
          </label>
          <p className="text-muted text-small mb-1">
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
          </div>
        </div>
      </div>

      {/* Part 3: Beer */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Beer & Seltzer
        </h3>
        <div className="form-group">
          <label className="form-label">What styles of beer should we include?</label>
          <div className="checkbox-grid">
            {BEER_STYLES.map(style => (
              <label key={style} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={(selections.beerFromFullBar || []).includes(style)}
                  onChange={() => toggleArray('beerFromFullBar', style)}
                />
                <span>{style}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Part 4: Wine */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Wine
        </h3>
        <div className="form-group">
          <label className="form-label">What styles of wine should we include?</label>
          <div className="checkbox-grid">
            {WINE_STYLES.map(style => (
              <label key={style} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={(selections.wineFromFullBar || []).includes(style)}
                  onChange={() => toggleArray('wineFromFullBar', style)}
                />
                <span>{style}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Part 5: Balance */}
      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Beer & Wine Balance
        </h3>
        <div className="form-group">
          <label className="form-label">How should we balance beer and wine?</label>
          <div className="checkbox-grid">
            {BALANCE_OPTIONS.map(opt => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="radio"
                  name="beerWineBalanceFullBar"
                  checked={selections.beerWineBalanceFullBar === opt.value}
                  onChange={() => onChange('beerWineBalanceFullBar', opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
