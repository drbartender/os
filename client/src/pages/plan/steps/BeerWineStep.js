import React from 'react';

const WINE_STYLES = ['Red', 'White', 'Rosé', 'Sparkling'];
const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'Non-Alcoholic'];
const BALANCE_OPTIONS = [
  { value: 'mostly-beer', label: 'Mostly Beer' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'mostly-wine', label: 'Mostly Wine' },
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
    <div className="card">
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
        Beer &amp; Wine Preferences
      </h2>

      {/* Wine Styles */}
      <div className="form-group">
        <label className="form-label">Wine Styles</label>
        <div className="checkbox-grid">
          {WINE_STYLES.map(style => (
            <label key={style} className="checkbox-label">
              <input
                type="checkbox"
                checked={(selections.wineStyles || []).includes(style)}
                onChange={() => toggleArray('wineStyles', style)}
              />
              <span>{style}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Beer Styles */}
      <div className="form-group">
        <label className="form-label">Beer Styles</label>
        <div className="checkbox-grid">
          {BEER_STYLES.map(style => (
            <label key={style} className="checkbox-label">
              <input
                type="checkbox"
                checked={(selections.beerStyles || []).includes(style)}
                onChange={() => toggleArray('beerStyles', style)}
              />
              <span>{style}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Balance */}
      <div className="form-group">
        <label className="form-label">Beer vs. Wine Balance</label>
        <div className="checkbox-grid">
          {BALANCE_OPTIONS.map(opt => (
            <label key={opt.value} className="checkbox-label">
              <input
                type="radio"
                name="beerWineBalance"
                checked={selections.beerWineBalance === opt.value}
                onChange={() => onChange('beerWineBalance', opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="form-group">
        <label className="form-label">Notes &amp; Preferences</label>
        <textarea
          className="form-textarea"
          rows={4}
          placeholder="E.g., IPAs only, sweet wine, prosecco over champagne, no seltzers..."
          value={selections.beerWineNotes || ''}
          onChange={(e) => onChange('beerWineNotes', e.target.value)}
        />
      </div>
    </div>
  );
}
