import React from 'react';
import { SERVING_TYPES } from '../data/servingTypes';

export default function ConfirmationStep({ plan, servingType, selections, cocktails = [], onSubmit, saving, error }) {
  const type = SERVING_TYPES.find(t => t.key === servingType);
  const selectedDrinks = cocktails.filter(d => selections.signatureCocktails?.includes(d.id));

  const hasSignature = type?.modules.includes('signature');
  const hasFullBar = type?.modules.includes('full-bar');
  const hasBeerWine = type?.modules.includes('beer-wine');
  const hasMocktail = type?.modules.includes('mocktail');

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
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Package: {type?.label}
        </h3>

        {hasSignature && selectedDrinks.length > 0 && (
          <div className="mb-2">
            <strong>Signature Cocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
            </ul>
          </div>
        )}

        {hasFullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}</p>
            )}
            {selections.barFocus && (
              <p><strong>Bar Focus:</strong> {selections.barFocus.replace(/-/g, ' ')}</p>
            )}
          </div>
        )}

        {(hasBeerWine || hasFullBar) && (
          <div className="mb-2">
            {selections.wineStyles?.length > 0 && (
              <p><strong>Wine Styles:</strong> {selections.wineStyles.join(', ')}</p>
            )}
            {selections.beerStyles?.length > 0 && (
              <p><strong>Beer Styles:</strong> {selections.beerStyles.join(', ')}</p>
            )}
            {hasBeerWine && selections.beerWineBalance && (
              <p><strong>Balance:</strong> {selections.beerWineBalance.replace(/-/g, ' ')}</p>
            )}
          </div>
        )}

        {hasMocktail && selections.mocktailNotes && (
          <div className="mb-2">
            <strong>Mocktail Preferences:</strong>
            <p className="text-muted">{selections.mocktailNotes}</p>
          </div>
        )}

        {/* Notes */}
        {(selections.beerWineNotes || selections.fullBarNotes) && (
          <div className="mb-2">
            <strong>Drink Notes:</strong>
            <p className="text-muted">{selections.beerWineNotes || selections.fullBarNotes}</p>
          </div>
        )}

        {selections.logisticsNotes && (
          <div className="mb-2">
            <strong>Logistics Notes:</strong>
            <p className="text-muted">{selections.logisticsNotes}</p>
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
