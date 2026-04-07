import React from 'react';
import { QUICK_PICKS } from '../data/servingTypes';
import { formatPhoneInput } from '../../../utils/formatPhone';
import { SYRUPS, calculateSyrupCost } from '../../../data/syrups';

export default function ConfirmationStep({ plan, quickPickChoice, activeModules, selections, cocktails = [], mocktails = [], onSubmit, saving, error }) {
  const pick = QUICK_PICKS.find(p => p.key === quickPickChoice);
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));
  const logistics = selections.logistics || {};

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
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Base spirits: {selections.signatureDrinkSpirits.join(', ')}
              </p>
            )}
            {selections.mixersForSignatureDrinks === true && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Basic mixers included for signature drink spirits
              </p>
            )}
          </div>
        )}

        {/* Mocktails */}
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

        {/* Full Bar */}
        {activeModules.fullBar && (
          <div className="mb-2">
            {selections.spirits?.length > 0 && (
              <p><strong>Spirits:</strong> {selections.spirits.join(', ')}
                {selections.spiritsOther && `, ${selections.spiritsOther}`}
              </p>
            )}
            {selections.mixersForSpirits === true && (
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                Mixers included for bar spirits
              </p>
            )}
            {selections.beerFromFullBar?.length > 0 && (
              <p><strong>Beer:</strong> {selections.beerFromFullBar.join(', ')}</p>
            )}
            {selections.wineFromFullBar?.length > 0 && (
              <p><strong>Wine:</strong> {selections.wineFromFullBar.join(', ')}
                {selections.wineOtherFullBar && ` (${selections.wineOtherFullBar})`}
              </p>
            )}
            {selections.beerWineBalanceFullBar && (
              <p><strong>Guest preference:</strong> {selections.beerWineBalanceFullBar.replace(/_/g, ' ')}</p>
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
              <p><strong>Wine:</strong> {selections.wineFromBeerWine.join(', ')}
                {selections.wineOtherBeerWine && ` (${selections.wineOtherBeerWine})`}
              </p>
            )}
            {selections.beerWineBalanceBeerWine && (
              <p><strong>Balance:</strong> {selections.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
            )}
          </div>
        )}

        {/* Syrups */}
        {(selections.syrupSelections || []).length > 0 && (() => {
          const syrupIds = selections.syrupSelections;
          const cost = calculateSyrupCost(syrupIds.length);
          return (
            <div className="mb-2">
              <strong>Handcrafted Syrups</strong>
              <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
                {syrupIds.map(id => {
                  const s = SYRUPS.find(sy => sy.id === id);
                  return s ? <li key={id}>{s.name}</li> : null;
                })}
              </ul>
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                {cost.count} bottle{cost.count !== 1 ? 's' : ''} — ${cost.total}
              </p>
            </div>
          );
        })()}

        {/* Menu Design */}
        {selections.customMenuDesign === true && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> Yes
            {selections.menuTheme && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Theme: {selections.menuTheme}</p>
            )}
            {selections.drinkNaming && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Custom naming: {selections.drinkNaming}</p>
            )}
            {selections.menuDesignNotes && (
              <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>Design notes: {selections.menuDesignNotes}</p>
            )}
          </div>
        )}
        {selections.customMenuDesign === false && (
          <div className="mb-2">
            <strong>Custom Menu Design:</strong> No
          </div>
        )}

        {/* Logistics */}
        <div className="mb-2">
          <strong>Logistics</strong>
          {logistics.dayOfContact?.name && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Day-of contact: {logistics.dayOfContact.name}
              {logistics.dayOfContact.phone && ` — ${formatPhoneInput(logistics.dayOfContact.phone)}`}
            </p>
          )}
          {logistics.parking && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Parking: {logistics.parking.replace(/_/g, ' ')}
            </p>
          )}
          {logistics.equipment?.length > 0 && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Equipment: {logistics.equipment.map(e => e.replace(/_/g, ' ')).join(', ')}
              {logistics.equipmentOther && ` (${logistics.equipmentOther})`}
            </p>
          )}
          {logistics.accessNotes && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Notes: {logistics.accessNotes}
            </p>
          )}
          {/* Backward compat for old logistics format */}
          {logistics.ice && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Ice machine: {logistics.ice}
            </p>
          )}
          {logistics.other && !logistics.accessNotes && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Notes: {logistics.other}
            </p>
          )}
        </div>
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
