import React from 'react';
import { QUICK_PICKS } from '../data/servingTypes';

export default function ConfirmationStep({ plan, quickPickChoice, activeModules, selections, cocktails = [], onSubmit, saving, error }) {
  const pick = QUICK_PICKS.find(p => p.key === quickPickChoice);
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Review Your Selections
        </h2>
        <p className="text-muted">
          Look everything over before submitting. Use the Back button to make changes.
        </p>
      </div>

      <div className="card mb-2">
        {pick && (
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Package: {pick.label}
          </h3>
        )}

        {/* Signature Drinks */}
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
            {selections.mixersForSignatureDrinks === true && (
              <p className="text-muted text-small">Basic mixers included for signature drink spirits</p>
            )}
          </div>
        )}

        {/* Mocktails */}
        {activeModules.mocktails && selections.mocktailNotes && (
          <div className="mb-2">
            <strong>Mocktail Preferences</strong>
            <p className="text-muted">{selections.mocktailNotes}</p>
          </div>
        )}

        {/* Full Bar */}
        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}</p>
            )}
            {selections.mixersForSpirits === true && (
              <p className="text-muted text-small">Mixers included for bar spirits</p>
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

        {/* Beer & Wine Only */}
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

        {/* Menu Design */}
        {selections.customMenuDesign === true && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> Yes
            {selections.menuTheme && (
              <p className="text-muted">Theme: {selections.menuTheme}</p>
            )}
            {selections.drinkNaming && (
              <p className="text-muted">Custom naming: {selections.drinkNaming}</p>
            )}
          </div>
        )}
        {selections.customMenuDesign === false && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> No
          </div>
        )}

        {/* Logistics */}
        {selections.logistics && (
          <div className="mb-2">
            <strong>Logistics</strong>
            {selections.logistics.parking && (
              <p className="text-muted">Parking: {selections.logistics.parking.replace(/_/g, ' ')}</p>
            )}
            {selections.logistics.ice && (
              <p className="text-muted">Ice machine: {selections.logistics.ice}</p>
            )}
            {selections.logistics.other && (
              <p className="text-muted">Notes: {selections.logistics.other}</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-error mb-2">{error}</div>
      )}

      <div style={{ textAlign: 'center' }}>
        <button
          className="btn btn-success"
          onClick={onSubmit}
          disabled={saving}
          style={{ padding: '0.75rem 2.5rem', fontSize: '1.1rem' }}
        >
          {saving ? 'Submitting...' : 'Submit My Drink Plan'}
        </button>
      </div>
    </div>
  );
}
