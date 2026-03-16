import React from 'react';

const SPIRITS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch'];
const BAR_FOCUS_OPTIONS = [
  { value: 'cocktail-heavy', label: 'Cocktail Lovers' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'beer-wine-heavy', label: 'Beer & Wine Focused' },
];
const WINE_STYLES = ['Red', 'White', 'Rosé', 'Sparkling'];
const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'Non-Alcoholic'];

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
    <div className="card">
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
        Full Bar Setup
      </h2>

      {/* Spirits */}
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

      {/* Bar Focus */}
      <div className="form-group">
        <label className="form-label">Bar Focus</label>
        <div className="checkbox-grid">
          {BAR_FOCUS_OPTIONS.map(opt => (
            <label key={opt.value} className="checkbox-label">
              <input
                type="radio"
                name="barFocus"
                checked={selections.barFocus === opt.value}
                onChange={() => onChange('barFocus', opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

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

      {/* Notes */}
      <div className="form-group">
        <label className="form-label">Additional Notes</label>
        <textarea
          className="form-textarea"
          rows={4}
          placeholder="E.g., premium brands only, no tequila shots, focus on bourbon cocktails..."
          value={selections.fullBarNotes || ''}
          onChange={(e) => onChange('fullBarNotes', e.target.value)}
        />
      </div>
    </div>
  );
}
