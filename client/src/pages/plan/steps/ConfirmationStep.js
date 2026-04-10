import React from 'react';
import { QUICK_PICKS } from '../data/servingTypes';
import { formatPhoneInput } from '../../../utils/formatPhone';
import { SYRUPS, calculateSyrupCost, getBottlesPerSyrup, getAllUniqueSyrups } from '../../../data/syrups';

export default function ConfirmationStep({ plan, quickPickChoice, activeModules, selections, cocktails = [], mocktails = [], addOns = {}, addonPricing = [], guestCount, proposalSyrups = [], onSubmit, saving, error }) {
  const pick = QUICK_PICKS.find(p => p.key === quickPickChoice);
  const selectedDrinks = cocktails.filter(d => (selections.signatureDrinks || []).includes(d.id));
  const selectedMocktails = mocktails.filter(d => (selections.mocktails || []).includes(d.id));
  const logistics = selections.logistics || {};

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Here's Your Bar Plan
        </h2>
        <p className="text-muted">
          Take a look — you can go back and adjust anything before submitting.
        </p>
      </div>

      <div className="card mb-2">
        {pick && (
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Package: {pick.label}
          </h3>
        )}

        {/* Signature Drinks */}
        {activeModules.signatureDrinks && (selectedDrinks.length > 0 || (selections.customCocktails || []).length > 0) && (
          <div className="mb-2">
            <strong>Signature Cocktails</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {selectedDrinks.map(d => (
                <li key={d.id}>{d.emoji} {d.name}</li>
              ))}
              {(selections.customCocktails || []).map((name, i) => (
                <li key={`custom-${i}`}>✨ {name} <span className="text-muted text-small">(custom request)</span></li>
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

        {/* Flavor Add-Ons (Dr. Bartender supplied — excludes self-provided) */}
        {(() => {
          const allSyrupIds = getAllUniqueSyrups(selections.syrupSelections);
          const selfProvided = selections.syrupSelfProvided || [];
          const syrupIds = allSyrupIds.filter(id => !selfProvided.includes(id));
          if (syrupIds.length === 0) return null;
          const newIds = syrupIds.filter(id => !proposalSyrups.includes(id));
          const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
          const cost = calculateSyrupCost(newIds.length, bottlesPerFlavor);
          return (
            <div className="mb-2">
              <strong>Flavor Add-Ons</strong>
              <p className="text-muted text-small" style={{ color: 'var(--warm-brown)', marginBottom: '0.25rem' }}>
                Hand-crafted by Dr. Bartender
              </p>
              <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
                {syrupIds.map(id => {
                  const s = SYRUPS.find(sy => sy.id === id);
                  const included = proposalSyrups.includes(id);
                  return s ? (
                    <li key={id}>
                      {s.name}{included ? ' (included)' : ''}
                      {!included && bottlesPerFlavor > 1 && ` (${bottlesPerFlavor} bottles)`}
                    </li>
                  ) : null;
                })}
              </ul>
              {cost.total > 0 && (
                <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                  {cost.totalBottles} bottle{cost.totalBottles !== 1 ? 's' : ''} total &mdash; ${cost.total}
                </p>
              )}
            </div>
          );
        })()}

        {/* Your Shopping List (self-provided syrups) */}
        {(selections.syrupSelfProvided || []).length > 0 && (
          <div className="mb-2">
            <strong>Your Shopping List</strong>
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
              {(selections.syrupSelfProvided || []).map(id => {
                const s = SYRUPS.find(sy => sy.id === id);
                return s ? <li key={id}>{s.name} syrup</li> : null;
              })}
            </ul>
          </div>
        )}

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
          {logistics.equipment?.length > 0 && !logistics.equipment.includes('none') && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Equipment: {logistics.equipment.map(e => e.replace(/_/g, ' ')).join(', ')}
              {logistics.equipmentOther && ` (${logistics.equipmentOther})`}
            </p>
          )}
          {logistics.equipment?.includes('none') && (
            <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
              Equipment: None needed
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

      {/* Estimated Extras */}
      {(() => {
        const addonSlugs = Object.keys(addOns);
        // Calculate addon line items
        const addonItems = addonSlugs
          .map(slug => {
            const pricing = addonPricing.find(a => a.slug === slug);
            if (!pricing) return null;
            const rate = Number(pricing.rate);
            let lineTotal = rate;
            let desc = pricing.name;
            if (pricing.billing_type === 'per_guest' && guestCount) {
              lineTotal = rate * guestCount;
              desc = `${pricing.name} (${guestCount} guests)`;
            }
            return { slug, name: desc, total: lineTotal };
          })
          .filter(Boolean);
        // Syrup cost (only for syrups NOT from proposal, excluding self-provided)
        const syrupIds = getAllUniqueSyrups(selections.syrupSelections)
          .filter(id => !(selections.syrupSelfProvided || []).includes(id));
        const newSyrupIds = syrupIds.filter(id => !proposalSyrups.includes(id));
        const syrupCost = calculateSyrupCost(newSyrupIds.length, getBottlesPerSyrup(guestCount));
        const extrasTotal = addonItems.reduce((sum, item) => sum + item.total, 0) + syrupCost.total;

        if (addonItems.length === 0 && syrupCost.total === 0) return null;

        return (
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
              Estimated Extras
            </h3>
            {addonItems.map(item => (
              <div key={item.slug} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                <span>{item.name}</span>
                <span style={{ fontWeight: 600 }}>${item.total.toFixed(2)}</span>
              </div>
            ))}
            {syrupCost.total > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                <span>Hand-Crafted Syrups ({syrupCost.totalBottles} bottle{syrupCost.totalBottles !== 1 ? 's' : ''})</span>
                <span style={{ fontWeight: 600 }}>${syrupCost.total.toFixed(2)}</span>
              </div>
            )}
            <div style={{ borderTop: '2px solid var(--deep-brown)', marginTop: '0.5rem', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
              <span>Estimated Total Extras</span>
              <span>${extrasTotal.toFixed(2)}</span>
            </div>
            <p className="text-muted text-small mt-1" style={{ color: 'var(--warm-brown)', fontStyle: 'italic' }}>
              Final pricing will be confirmed by your bartender.
            </p>
          </div>
        );
      })()}

      {error && (
        <div className="alert alert-error mb-2">{error}</div>
      )}

      <div style={{ textAlign: 'center' }}>
        <p className="text-muted text-small" style={{ color: 'var(--parchment)', marginBottom: '0.75rem', fontStyle: 'italic' }}>
          After you submit, we'll review your selections and reach out within 2 business days.
        </p>
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
