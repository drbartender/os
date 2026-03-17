import React from 'react';

const SPIRITS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch'];
const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer', 'Non-Alcoholic'];
const WINE_STYLES = ['Red', 'White', 'Sparkling', 'Other'];
const BALANCE_OPTIONS = [
  { value: 'mostly_beer', label: 'Mostly Beer' },
  { value: 'mostly_cocktails', label: 'Mostly Cocktails' },
  { value: 'mostly_wine', label: 'Mostly Wine' },
  { value: 'balanced', label: 'Balanced' },
];

export default function FullBarStep({ selections, onChange }) {
  const spirits = selections.spirits || [];
  const beerFromFullBar = selections.beerFromFullBar || [];
  const wineFromFullBar = selections.wineFromFullBar || [];

  const toggleArray = (field, value) => {
    const current = selections[field] || [];
    if (current.includes(value)) {
      onChange(field, current.filter(v => v !== value));
    } else {
      onChange(field, [...current, value]);
    }
  };

  // Select All spirits logic
  const allSpiritsSelected = SPIRITS.every(s => spirits.includes(s));
  const handleSelectAllSpirits = () => {
    if (allSpiritsSelected) {
      onChange('spirits', spirits.filter(s => !SPIRITS.includes(s)));
    } else {
      const merged = [...new Set([...spirits, ...SPIRITS])];
      onChange('spirits', merged);
    }
  };

  // None/other mutual exclusion for beer
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

  // None/other mutual exclusion for wine
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

  // Other spirit toggle
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
          Full Bar Setup
        </h2>
        <p className="text-muted">
          Let's build out your complete bar. We'll cover spirits, mixers, beer, and wine.
        </p>
      </div>

      {/* Part 1: Spirits */}
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

      {/* Part 2: Mixers */}
      <div className="card mb-2">
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
          </div>
        </div>
      </div>

      {/* Part 3: Beer */}
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
            <label className={`checkbox-label none-option`}>
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

      {/* Part 4: Wine */}
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
                placeholder="What other wine styles? E.g., Rosé, Orange wine..."
                value={selections.wineOtherFullBar || ''}
                onChange={(e) => onChange('wineOtherFullBar', e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Part 5: Balance */}
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
