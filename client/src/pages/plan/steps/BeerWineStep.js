import React from 'react';

const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer', 'Non-Alcoholic'];
const WINE_STYLES = ['Red', 'White', 'Sparkling', 'Other'];
const BALANCE_OPTIONS = [
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_cocktails', label: 'Mostly Cocktails' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'help_me_decide', label: 'Help me decide' },
];

export default function BeerWineStep({ selections, onChange }) {
  const beerFromBeerWine = selections.beerFromBeerWine || [];
  const wineFromBeerWine = selections.wineFromBeerWine || [];

  // None/other mutual exclusion for beer
  const handleBeerToggle = (value) => {
    if (value === 'None') {
      onChange('beerFromBeerWine', beerFromBeerWine.includes('None') ? [] : ['None']);
    } else {
      const withoutNone = beerFromBeerWine.filter(v => v !== 'None');
      if (withoutNone.includes(value)) {
        onChange('beerFromBeerWine', withoutNone.filter(v => v !== value));
      } else {
        onChange('beerFromBeerWine', [...withoutNone, value]);
      }
    }
  };

  // None/other mutual exclusion for wine
  const handleWineToggle = (value) => {
    if (value === 'None') {
      onChange('wineFromBeerWine', wineFromBeerWine.includes('None') ? [] : ['None']);
      if (!wineFromBeerWine.includes('None')) {
        onChange('wineOtherBeerWine', '');
      }
    } else {
      const withoutNone = wineFromBeerWine.filter(v => v !== 'None');
      if (withoutNone.includes(value)) {
        onChange('wineFromBeerWine', withoutNone.filter(v => v !== value));
        if (value === 'Other') onChange('wineOtherBeerWine', '');
      } else {
        onChange('wineFromBeerWine', [...withoutNone, value]);
      }
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
          Beer &amp; Seltzer
        </h3>
        <div className="form-group">
          <label className="form-label">What styles of beer should we include?</label>
          <div className="checkbox-grid">
            {BEER_STYLES.map(style => (
              <label key={style} className={`checkbox-label${beerFromBeerWine.includes('None') ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={beerFromBeerWine.includes(style)}
                  onChange={() => handleBeerToggle(style)}
                  disabled={beerFromBeerWine.includes('None')}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input
                type="checkbox"
                checked={beerFromBeerWine.includes('None')}
                onChange={() => handleBeerToggle('None')}
              />
              <span>None</span>
            </label>
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
              <label key={style} className={`checkbox-label${wineFromBeerWine.includes('None') ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={wineFromBeerWine.includes(style)}
                  onChange={() => handleWineToggle(style)}
                  disabled={wineFromBeerWine.includes('None')}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input
                type="checkbox"
                checked={wineFromBeerWine.includes('None')}
                onChange={() => handleWineToggle('None')}
              />
              <span>None</span>
            </label>
          </div>
          {wineFromBeerWine.includes('Other') && (
            <div className="mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What other wine styles? E.g., Rosé, Orange wine..."
                value={selections.wineOtherBeerWine || ''}
                onChange={(e) => onChange('wineOtherBeerWine', e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Balance */}
      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Beer &amp; Wine Balance
        </h3>
        <div className="form-group">
          <label className="form-label">How should we balance beer vs wine?</label>
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
