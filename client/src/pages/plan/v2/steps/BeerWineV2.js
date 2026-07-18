import React from 'react';
import ScopeBanner from '../../components/ScopeBanner';

const BEER_STYLES = ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Seltzer', 'Non-Alcoholic (Athletic Brewing)'];
const WINE_STYLES = ['Red', 'White', 'Sparkling', 'Other'];

// BYOB beer & wine stocking. The balance question is GONE from this screen
// (it lives on the crowd step now, spec §3.1), and this one component writes
// the right key family for its flow so the two-parallel-vocabularies bug dies.
export default function BeerWineV2({ selections, updateSelections, quickPick }) {
  const fullBar = quickPick === 'full_bar';
  const beerKey = fullBar ? 'beerFromFullBar' : 'beerFromBeerWine';
  const wineKey = fullBar ? 'wineFromFullBar' : 'wineFromBeerWine';
  const wineOtherKey = fullBar ? 'wineOtherFullBar' : 'wineOtherBeerWine';
  const beer = selections[beerKey] || [];
  const wine = selections[wineKey] || [];

  const toggleIn = (key, current, value) => {
    if (value === 'None') {
      updateSelections(key, current.includes('None') ? [] : ['None']);
      if (key === wineKey && !current.includes('None')) updateSelections(wineOtherKey, '');
      return;
    }
    const withoutNone = current.filter((v) => v !== 'None');
    if (withoutNone.includes(value)) {
      updateSelections(key, withoutNone.filter((v) => v !== value));
      if (value === 'Other') updateSelections(wineOtherKey, '');
    } else {
      updateSelections(key, [...withoutNone, value]);
    }
  };

  return (
    <div>
      <ScopeBanner
        tone="shopping"
        title="Builds your shopping list"
        body="Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy."
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Beer &amp; Wine</h2>
        <p className="text-muted">A balanced selection typically means 2 to 3 beer styles and 2 to 3 wines.</p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Beer &amp; Seltzer</h3>
        <div className="form-group">
          <label className="form-label">What styles of beer should we include?</label>
          <div className="checkbox-grid">
            {BEER_STYLES.map((style) => (
              <label key={style} className={`checkbox-label${beer.includes('None') ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={beer.includes(style)}
                  onChange={() => toggleIn(beerKey, beer, style)}
                  disabled={beer.includes('None')}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input type="checkbox" checked={beer.includes('None')} onChange={() => toggleIn(beerKey, beer, 'None')} />
              <span>None</span>
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Wine</h3>
        <div className="form-group">
          <label className="form-label">What styles of wine should we include?</label>
          <div className="checkbox-grid">
            {WINE_STYLES.map((style) => (
              <label key={style} className={`checkbox-label${wine.includes('None') ? ' none-option' : ''}`}>
                <input
                  type="checkbox"
                  checked={wine.includes(style)}
                  onChange={() => toggleIn(wineKey, wine, style)}
                  disabled={wine.includes('None')}
                />
                <span>{style}</span>
              </label>
            ))}
            <label className="checkbox-label none-option">
              <input type="checkbox" checked={wine.includes('None')} onChange={() => toggleIn(wineKey, wine, 'None')} />
              <span>None</span>
            </label>
          </div>
          {wine.includes('Other') && (
            <div className="mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What other wine styles? e.g. Rosé, Orange wine..."
                value={selections[wineOtherKey] || ''}
                onChange={(e) => updateSelections(wineOtherKey, e.target.value)}
                style={{ maxWidth: '400px' }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
