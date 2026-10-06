import React from 'react';
import { QUICK_PICKS } from '../pages/plan/data/servingTypes';
import { formatPhoneInput } from '../utils/formatPhone';
import { SYRUPS, getAllUniqueSyrups } from '../data/syrups';

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

// listOnly: the shopping-list modal's answers panel (spec 2026-10-06) shows
// only the answers that drive the list, so menu design and every logistics
// answer stay on the plan page's full card.
export default function DrinkPlanSelections({ plan, cocktails = [], mocktails = [], listOnly = false }) {
  const sel = plan.selections || {};

  if (isNewFormat(sel)) {
    return <NewSelections plan={plan} sel={sel} cocktails={cocktails} mocktails={mocktails} listOnly={listOnly} />;
  }
  return <LegacySelections plan={plan} sel={sel} cocktails={cocktails} listOnly={listOnly} />;
}

// One string each for the crowd and guest-preference answers, so the full
// card (inside Logistics) and the list-only card render them identically.
function crowdText(sel) {
  const c = sel.crowd;
  if (!c) return null;
  const hasDrinkers = c.drinkers !== null && c.drinkers !== undefined;
  if (!hasDrinkers && !c.profile) return null;
  const count = hasDrinkers ? `${c.drinkers} drinkers` : 'drinker count unsure';
  return `Crowd: ${count}${c.profile ? ` · ${String(c.profile).replace(/_/g, ' ')}` : ''}`;
}

function guestPreferencesText(sel) {
  const gp = sel.guestPreferences;
  if (!gp || Object.keys(gp).length === 0) return null;
  return `Guest preferences: ${Object.entries(gp)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(v).replace(/_/g, ' ')}`)
    .join(' · ')}`;
}

function NewSelections({ plan, sel, cocktails, mocktails, listOnly }) {
  const crowd = crowdText(sel);
  const prefs = guestPreferencesText(sel);
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
      {am.signatureDrinks && (selectedDrinks.length > 0 || (sel.customCocktails || []).length > 0) && (
        <div className="mb-2">
          <strong>Signature Cocktails:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {selectedDrinks.map(d => (
              <li key={d.id}>{d.emoji} {d.name}{d.base_spirit ? ` (${d.base_spirit})` : ''}</li>
            ))}
            {(sel.customCocktails || []).map((name, i) => (
              <li key={`custom-${i}`}>✨ {name} <span className="text-muted text-small">(custom request)</span></li>
            ))}
          </ul>
          {sel.signatureDrinkSpirits?.length > 0 && (
            <p className="text-muted text-small">Extracted spirits: {sel.signatureDrinkSpirits.join(', ')}</p>
          )}
          {sel.mixersForSignatureDrinks === true && (
            <p className="text-muted text-small">Basic mixers included for simple mixed drinks</p>
          )}
          {sel.mixersForSignatureDrinks === false && (
            <p className="text-muted text-small">No additional mixers requested</p>
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

      {/* Menu Design — three-way (custom / house / none) post-2026-05-20.
          Legacy plans wrote `customMenuDesign: true|false` and no `menuStyle`;
          map them into the new buckets so already-saved plans still render. */}
      {!listOnly && (() => {
        const menuStyle = sel.menuStyle
          ?? (sel.customMenuDesign === true ? 'custom'
            : sel.customMenuDesign === false ? 'none'
            : null);
        if (menuStyle === 'custom') {
          return (
            <div className="mb-2">
              <p className="mb-1"><strong>Menu Design:</strong> Custom Menu Design</p>
              {sel.menuTheme && <p className="text-muted mb-1">Theme: {sel.menuTheme}</p>}
              {sel.drinkNaming && <p className="text-muted mb-1">Custom naming: {sel.drinkNaming}</p>}
              {sel.menuDesignNotes && <p className="text-muted mb-1">Design notes: {sel.menuDesignNotes}</p>}
            </div>
          );
        }
        if (menuStyle === 'house') {
          return <p className="mb-1"><strong>Menu Design:</strong> Standard Menu (Dr. Bartender branded)</p>;
        }
        if (menuStyle === 'none') {
          return <p className="mb-1"><strong>Menu Design:</strong> No printed menu</p>;
        }
        return null;
      })()}
      {sel.additionalNotes && (
        <p className="mb-1"><strong>Anything else:</strong> <span className="text-muted">{sel.additionalNotes}</span></p>
      )}

      {/* Logistics: not shown in the shopping-list answers panel */}
      {!listOnly && (
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
        {/* Planner v2 keys (spec 2026-07-18): operationally load-bearing —
            outdoor bars may need power planning; crowd sizes the list. */}
        {sel.barPlacement && (
          <p className="text-muted">Bar placement: {{ indoors: 'Indoors', outdoors: 'Outdoors', unsure: 'Not sure yet' }[sel.barPlacement] || sel.barPlacement}</p>
        )}
        {sel.powerAtBar && (
          <p className="text-muted">Power at the bar: {{ yes: 'Outlet within 50 ft', no: 'No outlet nearby', unsure: 'Not sure yet' }[sel.powerAtBar] || sel.powerAtBar}</p>
        )}
        {crowd && <p className="text-muted">{crowd}</p>}
        {prefs && <p className="text-muted">{prefs}</p>}
        {/* Backward compat */}
        {logistics.ice && <p className="text-muted">Ice machine: {logistics.ice}</p>}
        {logistics.other && !logistics.accessNotes && <p className="text-muted">Notes: {logistics.other}</p>}
      </div>
      )}
      {listOnly && (crowd || prefs) && (
        <div className="mb-1">
          {crowd && <p className="text-muted">{crowd}</p>}
          {prefs && <p className="text-muted">{prefs}</p>}
        </div>
      )}

      {/* Flavor Add-Ons (Dr. Bartender supplied) */}
      {getAllUniqueSyrups(sel.syrupSelections).length > 0 && (
        <div className="mb-1">
          <strong>Flavor Add-Ons (Supplied):</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {getAllUniqueSyrups(sel.syrupSelections).map(id => {
              const s = SYRUPS.find(sy => sy.id === id);
              return s ? <li key={id}>{s.name}</li> : null;
            })}
          </ul>
        </div>
      )}

      {/* Self-Provided Syrups */}
      {(sel.syrupSelfProvided || []).length > 0 && (
        <div className="mb-1">
          <strong>Flavor Add-Ons (Client Providing):</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {(sel.syrupSelfProvided || []).map(id => {
              const s = SYRUPS.find(sy => sy.id === id);
              return s ? <li key={id}>{s.name}</li> : null;
            })}
          </ul>
        </div>
      )}

      {/* Add-Ons */}
      {sel.addOns && Object.keys(sel.addOns).length > 0 && (
        <div className="mb-1">
          <strong>Add-Ons:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
            {Object.entries(sel.addOns).map(([slug, meta]) => (
              <li key={slug}>
                {slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                {meta.servingStyle && ` (${meta.servingStyle.replace(/-/g, ' ')})`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function LegacySelections({ plan, sel, cocktails, listOnly }) {
  const typeName = LEGACY_SERVING_TYPES[plan.serving_type];
  const selectedDrinks = cocktails.filter(d => (sel.signatureCocktails || []).includes(d.id));
  // The "no selections" line shows only when nothing above it renders; it used
  // to sit under a plan's own beer or wine answers whenever typeName and
  // spirits were empty.
  const anyAnswer = Boolean(
    typeName || selectedDrinks.length || sel.spirits?.length || sel.barFocus
    || sel.wineStyles?.length || sel.beerStyles?.length || sel.beerWineBalance
    || sel.beerWineNotes || sel.fullBarNotes || sel.mocktailNotes
    || (!listOnly && sel.logisticsNotes)
  );

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
      {!listOnly && sel.logisticsNotes && (
        <div className="mb-1"><strong>Logistics:</strong><p className="text-muted">{sel.logisticsNotes}</p></div>
      )}

      {!anyAnswer && (
        <p className="text-muted">Client hasn't made any selections yet.</p>
      )}
    </>
  );
}
