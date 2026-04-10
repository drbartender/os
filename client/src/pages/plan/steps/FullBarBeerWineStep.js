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

export default function FullBarBeerWineStep({ selections, onChange }) {
  const beerFromFullBar = selections.beerFromFullBar || [];
  const wineFromFullBar = selections.wineFromFullBar || [];

  const handleBeerToggle = (value) => {
    if (value === 'None') {
      onChange('beerFromFullBar', beerFromFullBar.includes('None') ? [] : ['None']);
    } else {
      const withoutNone = beerFromFullBar.filter(v => v !== 'None');
      if (withoutNone.includes(value)) {
        onChange('beerFromFullBar', withoutNone.filter(v => v !== value));
      } else {
        onChange('beerFromFullBar', [...withoutNone, value]);
      }
    }
  };

  const handleWineToggle = (value) => {
    if (value === 'None') {
      onChange('wineFromFullBar', wineFromFullBar.includes('None') ? [] : ['None']);
      if (!wineFromFullBar.includes('None')) {
        onChange('wineOtherFullBar', '');
      }
    } else {
      const withoutNone = wineFromFullBar.filter(v => v !== 'None');
      if (withoutNone.includes(value)) {
        onChange('wineFromFullBar', withoutNone.filter(v => v !== value));
        if (value === 'Other') onChange('wineOtherFullBar', '');
      } else {
        onChange('wineFromFullBar', [...withoutNone, value]);
      }
    }
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Beer &amp; Wine
        </h2>
        <p className="text-muted">
          A balanced selection typically means 2-3 beer styles and 2-3 wines.
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
              <label key={style} className={`checkbox-label${beerFromFullBar.includes('None') && style !== 'None' ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={beerFromFullBar.includes(style)}
                  onChange={() => handleBeerToggle(style)}
                  disabled={beerFromFullBar.includes('None') && style !== 'None'}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input
                type="checkbox"
                checked={beerFromFullBar.includes('None')}
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
              <label key={style} className={`checkbox-label${wineFromFullBar.includes('None') && style !== 'None' ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={wineFromFullBar.includes(style)}
                  onChange={() => handleWineToggle(style)}
                  disabled={wineFromFullBar.includes('None') && style !== 'None'}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input
                type="checkbox"
                checked={wineFromFullBar.includes('None')}
                onChange={() => handleWineToggle('None')}
              />
              <span>None</span>
            </label>
          </div>
          {wineFromFullBar.includes('Other') && (
            <div className="mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What other wine styles? E.g., Ros\u00e9, Orange wine..."
                value={selections.wineOtherFullBar || ''}
                onChange={(e) => onChange('wineOtherFullBar', e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Balance */}
      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Guest Preferences
        </h3>
        <div className="form-group">
          <label className="form-label">What kinds of drinks do your guests usually enjoy?</label>
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
