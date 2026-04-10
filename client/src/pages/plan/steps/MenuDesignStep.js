import React from 'react';

export default function MenuDesignStep({ selections, activeModules, cocktails = [], mocktails = [], onChange }) {
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));

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
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Basic mixers included for simple mixed drinks
              </p>
            )}
          </div>
        )}

        {activeModules.mocktails && selectedMocktails.length > 0 && (
          <div className="mb-2">
            <strong>Mocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedMocktails.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
            {selections.mocktailNotes && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Notes: {selections.mocktailNotes}
              </p>
            )}
          </div>
        )}

        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}
                {selections.spiritsOther && `, ${selections.spiritsOther}`}
              </p>
            )}
            {selections.mixersForSpirits && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Mixers requested for bar spirits
              </p>
            )}
            {selections.beerFromFullBar?.length > 0 && selections.beerFromFullBar[0] !== 'None' && (
              <p><strong>Beer:</strong> {selections.beerFromFullBar.join(', ')}</p>
            )}
            {selections.beerFromFullBar?.[0] === 'None' && (
              <p><strong>Beer:</strong> None</p>
            )}
            {selections.wineFromFullBar?.length > 0 && selections.wineFromFullBar[0] !== 'None' && (
              <p><strong>Wine:</strong> {selections.wineFromFullBar.join(', ')}
                {selections.wineOtherFullBar && ` (${selections.wineOtherFullBar})`}
              </p>
            )}
            {selections.wineFromFullBar?.[0] === 'None' && (
              <p><strong>Wine:</strong> None</p>
            )}
            {selections.beerWineBalanceFullBar && (
              <p><strong>Guest preference:</strong> {selections.beerWineBalanceFullBar.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</p>
            )}
          </div>
        )}

        {activeModules.beerWineOnly && !activeModules.fullBar && (
          <div className="mb-2">
            {selections.beerFromBeerWine?.length > 0 && selections.beerFromBeerWine[0] !== 'None' && (
              <p><strong>Beer:</strong> {selections.beerFromBeerWine.join(', ')}</p>
            )}
            {selections.beerFromBeerWine?.[0] === 'None' && (
              <p><strong>Beer:</strong> None</p>
            )}
            {selections.wineFromBeerWine?.length > 0 && selections.wineFromBeerWine[0] !== 'None' && (
              <p><strong>Wine:</strong> {selections.wineFromBeerWine.join(', ')}
                {selections.wineOtherBeerWine && ` (${selections.wineOtherBeerWine})`}
              </p>
            )}
            {selections.wineFromBeerWine?.[0] === 'None' && (
              <p><strong>Wine:</strong> None</p>
            )}
            {selections.beerWineBalanceBeerWine && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {!activeModules.signatureDrinks && !activeModules.fullBar && !activeModules.beerWineOnly && !activeModules.mocktails && (
          <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>No drink selections yet.</p>
        )}
      </div>

      {/* Custom Menu Design Question */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">Would you like us to design a custom drink menu graphic for your event?</label>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            We'll create a custom bar menu to match your event's look and feel.
          </p>
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
            <label className="checkbox-label">
              <input
                type="radio"
                name="customMenuDesign"
                checked={selections.customMenuDesign === 'undecided'}
                onChange={() => onChange('customMenuDesign', 'undecided')}
              />
              <span>I'd like to see options before deciding</span>
            </label>
          </div>
        </div>

        {selections.customMenuDesign === true && (
          <>
            <div className="form-group">
              <label className="form-label">Your event theme, colors, or overall vibe</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rustic fall colors, elegant black and gold, tropical vibes, garden party..."
                value={selections.menuTheme || ''}
                onChange={(e) => onChange('menuTheme', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Any drink names you'd like included?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., rename 'Old Fashioned' to 'The Groom's Go-To', or let us get creative..."
                value={selections.drinkNaming || ''}
                onChange={(e) => onChange('drinkNaming', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Any other inspiration or preferences for the menu design?</label>
              <textarea
                className="form-textarea"
                rows={3}
                placeholder="E.g., we have a Pinterest board, match our invitation style, include our monogram..."
                value={selections.menuDesignNotes || ''}
                onChange={(e) => onChange('menuDesignNotes', e.target.value)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
