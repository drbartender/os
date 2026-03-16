import React from 'react';

export default function MenuDesignStep({ selections, activeModules, cocktails = [], onChange }) {
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Menu Design
        </h2>
        <p className="text-muted">
          Here's a summary of your selections. Below, let us know if you'd like a custom menu graphic.
        </p>
      </div>

      {/* Summary */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Your Selections
        </h3>

        {activeModules.signatureDrinks && selectedDrinks.length > 0 && (
          <div className="mb-2">
            <strong>Signature Cocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {selections.signatureDrinkSpirits?.length > 0 && (
              <p className="text-muted text-small">
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks && (
              <p className="text-muted text-small">Basic mixers requested for signature drink spirits</p>
            )}
          </div>
        )}

        {activeModules.mocktails && selections.mocktailNotes && (
          <div className="mb-2">
            <strong>Mocktail Preferences</strong>
            <p className="text-muted">{selections.mocktailNotes}</p>
          </div>
        )}

        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}</p>
            )}
            {selections.mixersForSpirits && (
              <p className="text-muted text-small">Mixers requested for bar spirits</p>
            )}
            {selections.beerFromFullBar?.length > 0 && (
              <p><strong>Beer:</strong> {selections.beerFromFullBar.join(', ')}</p>
            )}
            {selections.wineFromFullBar?.length > 0 && (
              <p><strong>Wine:</strong> {selections.wineFromFullBar.join(', ')}</p>
            )}
            {selections.beerWineBalanceFullBar && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceFullBar.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {activeModules.beerWineOnly && !activeModules.fullBar && (
          <div className="mb-2">
            {selections.beerFromBeerWine?.length > 0 && (
              <p><strong>Beer:</strong> {selections.beerFromBeerWine.join(', ')}</p>
            )}
            {selections.wineFromBeerWine?.length > 0 && (
              <p><strong>Wine:</strong> {selections.wineFromBeerWine.join(', ')}</p>
            )}
            {selections.beerWineBalanceBeerWine && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {!activeModules.signatureDrinks && !activeModules.fullBar && !activeModules.beerWineOnly && !activeModules.mocktails && (
          <p className="text-muted">No drink selections yet.</p>
        )}
      </div>

      {/* Custom Menu Design Question */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">Would you like us to design a custom drink menu graphic for your event?</label>
          <div className="checkbox-grid">
            <label className="checkbox-label">
              <input
                type="radio"
                name="customMenuDesign"
                checked={selections.customMenuDesign === true}
                onChange={() => onChange('customMenuDesign', true)}
              />
              <span>Yes, please!</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="customMenuDesign"
                checked={selections.customMenuDesign === false}
                onChange={() => onChange('customMenuDesign', false)}
              />
              <span>No thanks</span>
            </label>
          </div>
        </div>

        {selections.customMenuDesign === true && (
          <>
            <div className="form-group">
              <label className="form-label">Any theme, color scheme, or vibe in mind?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rustic fall colors, elegant black and gold, tropical vibes..."
                value={selections.menuTheme || ''}
                onChange={(e) => onChange('menuTheme', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Would you like custom names for your drinks?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rename 'Old Fashioned' to 'The Groom's Go-To', or let us get creative..."
                value={selections.drinkNaming || ''}
                onChange={(e) => onChange('drinkNaming', e.target.value)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
