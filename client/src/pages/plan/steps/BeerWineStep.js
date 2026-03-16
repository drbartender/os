import React from 'react';

const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer', 'Non-Alcoholic'];
const WINE_STYLES = ['Red', 'White', 'Ros\u00e9', 'Sparkling'];
const BALANCE_OPTIONS = [
  { value: '50/50', label: '50/50' },
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
];

export default function BeerWineStep({ selections, onChange }) {
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
          Beer &amp; Wine Preferences
        </h2>
        <p className="text-muted">
          Tell us what styles you'd like so we can curate the perfect selection.
        </p>
      </div>

      {/* Beer */}
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
                  checked={(selections.beerFromBeerWine || []).includes(style)}
                  onChange={() => toggleArray('beerFromBeerWine', style)}
                />
                <span>{style}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Wine */}
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
                  checked={(selections.wineFromBeerWine || []).includes(style)}
                  onChange={() => toggleArray('wineFromBeerWine', style)}
                />
                <span>{style}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Balance */}
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
                  name="beerWineBalanceBeerWine"
                  checked={selections.beerWineBalanceBeerWine === opt.value}
                  onChange={() => onChange('beerWineBalanceBeerWine', opt.value)}
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
