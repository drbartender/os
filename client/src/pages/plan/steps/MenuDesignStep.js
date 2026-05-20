import React, { useState } from 'react';
import MenuSamplesModal from '../../../components/MenuSamplesModal';
import { MENU_SAMPLES } from '../../../data/menuSamples';
import ScopeBanner from '../components/ScopeBanner';

export default function MenuDesignStep({ selections, activeModules, cocktails = [], mocktails = [], onChange }) {
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));
  const [samplesOpen, setSamplesOpen] = useState(false);

  return (
    <div>
      <ScopeBanner
        tone="aside"
        title="Not part of your shopping list"
        body="How you'd like your drink menu displayed at the event."
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Menu Design
        </h2>
        <p className="text-muted">
          Here's a summary of your selections. Below, choose how you'd like your drink menu displayed at the event.
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
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks && (
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
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
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
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
              <p className="text-muted text-small" style={{ color: 'var(--text-muted)' }}>
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
          <p className="text-muted" style={{ color: 'var(--text-muted)' }}>No drink selections yet.</p>
        )}
      </div>

      {/* Three-way Menu Design */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">How would you like your drink menu displayed at the event?</label>
          {MENU_SAMPLES.length > 0 && (
            <button
              type="button"
              className="menu-samples-trigger"
              onClick={() => setSamplesOpen(true)}
            >
              See sample menus →
            </button>
          )}
          <div className="checkbox-grid">
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'custom'}
                onChange={() => onChange('menuStyle', 'custom')}
              />
              <span>Custom Menu Design (designed for your event's look and feel)</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'house'}
                onChange={() => onChange('menuStyle', 'house')}
              />
              <span>Standard Menu (Dr. Bartender branded, drinks listed in plain terms)</span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="menuStyle"
                checked={selections.menuStyle === 'none'}
                onChange={() => onChange('menuStyle', 'none')}
              />
              <span>No Menu Card (we'll skip the printed menu)</span>
            </label>
          </div>
        </div>

        <MenuSamplesModal isOpen={samplesOpen} onClose={() => setSamplesOpen(false)} />

        {selections.menuStyle === 'custom' && (
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

        {selections.menuStyle === 'house' && (
          <span className="potion-field-note">
            Our standard bar menu. Dr. Bartender branded, listing your drinks in plain terms like Vodka Lemonade, Old Fashioned, or Beer and Wine. We bring it printed and framed for the bar. No setup needed from you.
          </span>
        )}

        {selections.menuStyle === 'none' && (
          <span className="potion-field-note">
            No printed menu will be created. Your selections still drive your shopping list.
          </span>
        )}
      </div>
    </div>
  );
}
