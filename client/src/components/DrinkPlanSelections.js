import React from 'react';
import { QUICK_PICKS } from '../pages/plan/data/servingTypes';
import { formatPhoneInput } from '../utils/formatPhone';

const LEGACY_SERVING_TYPES = {
  'full-bar-signature': 'Full Bar + Signature Drinks',
  'signature-beer-wine': 'Signature Drinks + Beer & Wine',
  'signature-matching-mixers': 'Signature Drinks + Matching Mixers',
  'signature-only': 'Signature Drinks Only',
  'beer-wine-only': 'Beer & Wine Only',
  'mocktail': 'Mocktail / Non-Alcoholic Bar',
};

function isNewFormat(sel) {
  return sel && sel.activeModules;
}

export default function DrinkPlanSelections({ plan, cocktails = [], mocktails = [] }) {
  const sel = plan.selections || {};

  if (isNewFormat(sel)) {
    return <NewSelections plan={plan} sel={sel} cocktails={cocktails} mocktails={mocktails} />;
  }
  return <LegacySelections plan={plan} sel={sel} cocktails={cocktails} />;
}

function NewSelections({ plan, sel, cocktails, mocktails }) {
  const am = sel.activeModules;
  const pick = QUICK_PICKS.find(p => p.key === plan.serving_type);
  const selectedDrinks = cocktails.filter(d => (sel.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (sel.mocktails || []).includes(d.id));
  const logistics = sel.logistics || {};

  return (
    <>
      {pick && (
        <p className="mb-1"><strong>Package:</strong> {pick.emoji} {pick.label}</p>
      )}
      {plan.serving_type === 'custom' && (
        <p className="mb-1"><strong>Package:</strong> Custom Setup</p>
      )}

      {/* Signature Drinks */}
      {am.signatureDrinks && selectedDrinks.length > 0 && (
        <div className="mb-2">
          <strong>Signature Cocktails:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {selectedDrinks.map(d => (
              <li key={d.id}>{d.emoji} {d.name}{d.base_spirit ? ` (${d.base_spirit})` : ''}</li>
            ))}
          </ul>
          {sel.signatureDrinkSpirits?.length > 0 && (
            <p className="text-muted text-small">Extracted spirits: {sel.signatureDrinkSpirits.join(', ')}</p>
          )}
          {sel.mixersForSignatureDrinks === true && (
            <p className="text-muted text-small">Basic mixers requested for signature drink spirits</p>
          )}
          {sel.mixersForSignatureDrinks === false && (
            <p className="text-muted text-small">No mixers for signature drink spirits</p>
          )}
        </div>
      )}

      {/* Mocktails */}
      {am.mocktails && selectedMocktails.length > 0 && (
        <div className="mb-2">
          <strong>Mocktails:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {selectedMocktails.map(d => (
              <li key={d.id}>{d.emoji} {d.name}</li>
            ))}
          </ul>
          {sel.mocktailNotes && (
            <p className="text-muted text-small">Notes: {sel.mocktailNotes}</p>
          )}
        </div>
      )}
      {/* Legacy mocktail notes (text only) */}
      {am.mocktails && !selectedMocktails.length && sel.mocktailNotes && (
        <div className="mb-1"><strong>Mocktail Preferences:</strong><p className="text-muted">{sel.mocktailNotes}</p></div>
      )}

      {/* Full Bar */}
      {am.fullBar && (
        <div className="mb-2">
          {sel.spirits?.length > 0 && (
            <p className="mb-1"><strong>Spirits:</strong> {sel.spirits.join(', ')}
              {sel.spiritsOther && `, ${sel.spiritsOther}`}
            </p>
          )}
          {sel.mixersForSpirits === true && (
            <p className="text-muted text-small mb-1">Mixers included for bar spirits</p>
          )}
          {sel.beerFromFullBar?.length > 0 && (
            <p className="mb-1"><strong>Beer:</strong> {sel.beerFromFullBar.join(', ')}</p>
          )}
          {sel.wineFromFullBar?.length > 0 && (
            <p className="mb-1"><strong>Wine:</strong> {sel.wineFromFullBar.join(', ')}
              {sel.wineOtherFullBar && ` (${sel.wineOtherFullBar})`}
            </p>
          )}
          {sel.beerWineBalanceFullBar && (
            <p className="mb-1"><strong>Guest preference:</strong> {sel.beerWineBalanceFullBar.replace(/_/g, ' ')}</p>
          )}
        </div>
      )}

      {/* Beer & Wine Only */}
      {am.beerWineOnly && !am.fullBar && (
        <div className="mb-2">
          {sel.beerFromBeerWine?.length > 0 && (
            <p className="mb-1"><strong>Beer:</strong> {sel.beerFromBeerWine.join(', ')}</p>
          )}
          {sel.wineFromBeerWine?.length > 0 && (
            <p className="mb-1"><strong>Wine:</strong> {sel.wineFromBeerWine.join(', ')}
              {sel.wineOtherBeerWine && ` (${sel.wineOtherBeerWine})`}
            </p>
          )}
          {sel.beerWineBalanceBeerWine && (
            <p className="mb-1"><strong>Balance:</strong> {sel.beerWineBalanceBeerWine.replace(/_/g, ' ')}</p>
          )}
        </div>
      )}

      {/* Menu Design */}
      {sel.customMenuDesign === true && (
        <div className="mb-2">
          <p className="mb-1"><strong>Custom Menu Design:</strong> Yes</p>
          {sel.menuTheme && <p className="text-muted mb-1">Theme: {sel.menuTheme}</p>}
          {sel.drinkNaming && <p className="text-muted mb-1">Custom naming: {sel.drinkNaming}</p>}
          {sel.menuDesignNotes && <p className="text-muted mb-1">Design notes: {sel.menuDesignNotes}</p>}
        </div>
      )}
      {sel.customMenuDesign === false && (
        <p className="mb-1"><strong>Custom Menu Design:</strong> No</p>
      )}

      {/* Logistics */}
      <div className="mb-1">
        <strong>Logistics:</strong>
        {logistics.dayOfContact?.name && (
          <p className="text-muted">
            Day-of contact: {logistics.dayOfContact.name}
            {logistics.dayOfContact.phone && ` — ${formatPhoneInput(logistics.dayOfContact.phone)}`}
          </p>
        )}
        {logistics.parking && (
          <p className="text-muted">Parking: {logistics.parking.replace(/_/g, ' ')}</p>
        )}
        {logistics.equipment?.length > 0 && (
          <p className="text-muted">
            Equipment: {logistics.equipment.map(e => e.replace(/_/g, ' ')).join(', ')}
            {logistics.equipmentOther && ` (${logistics.equipmentOther})`}
          </p>
        )}
        {logistics.accessNotes && (
          <p className="text-muted">Event notes: {logistics.accessNotes}</p>
        )}
        {/* Backward compat */}
        {logistics.ice && <p className="text-muted">Ice machine: {logistics.ice}</p>}
        {logistics.other && !logistics.accessNotes && <p className="text-muted">Notes: {logistics.other}</p>}
      </div>
    </>
  );
}

function LegacySelections({ plan, sel, cocktails }) {
  const typeName = LEGACY_SERVING_TYPES[plan.serving_type];
  const selectedDrinks = cocktails.filter(d => (sel.signatureCocktails || []).includes(d.id));

  return (
    <>
      {typeName && (
        <p className="mb-1"><strong>Package:</strong> {typeName}</p>
      )}

      {selectedDrinks.length > 0 && (
        <div className="mb-2">
          <strong>Signature Cocktails:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {selectedDrinks.map(d => (
              <li key={d.id}>{d.emoji} {d.name}</li>
            ))}
          </ul>
        </div>
      )}

      {sel.spirits?.length > 0 && (
        <p className="mb-1"><strong>Spirits:</strong> {sel.spirits.join(', ')}</p>
      )}
      {sel.barFocus && (
        <p className="mb-1"><strong>Bar Focus:</strong> {sel.barFocus.replace(/-/g, ' ')}</p>
      )}
      {sel.wineStyles?.length > 0 && (
        <p className="mb-1"><strong>Wine Styles:</strong> {sel.wineStyles.join(', ')}</p>
      )}
      {sel.beerStyles?.length > 0 && (
        <p className="mb-1"><strong>Beer Styles:</strong> {sel.beerStyles.join(', ')}</p>
      )}
      {sel.beerWineBalance && (
        <p className="mb-1"><strong>Balance:</strong> {sel.beerWineBalance.replace(/-/g, ' ')}</p>
      )}
      {sel.beerWineNotes && (
        <div className="mb-1"><strong>Drink Notes:</strong><p className="text-muted">{sel.beerWineNotes}</p></div>
      )}
      {sel.fullBarNotes && (
        <div className="mb-1"><strong>Full Bar Notes:</strong><p className="text-muted">{sel.fullBarNotes}</p></div>
      )}
      {sel.mocktailNotes && (
        <div className="mb-1"><strong>Mocktail Preferences:</strong><p className="text-muted">{sel.mocktailNotes}</p></div>
      )}
      {sel.logisticsNotes && (
        <div className="mb-1"><strong>Logistics:</strong><p className="text-muted">{sel.logisticsNotes}</p></div>
      )}

      {!typeName && !sel.spirits?.length && !sel.logisticsNotes && (
        <p className="text-muted">Client hasn't made any selections yet.</p>
      )}
    </>
  );
}
