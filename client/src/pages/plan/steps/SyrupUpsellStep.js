import React, { useState } from 'react';
import {
  SYRUPS,
  SYRUP_CATEGORIES,
  SYRUP_PRICE_SINGLE,
  SYRUP_PRICE_3PACK,
  calculateSyrupCost,
  getBottlesPerSyrup,
  getDrinksWithFlavors,
  getAllUniqueSyrups,
  getDrinkSyrupSelections,
} from '../../../data/syrups';

/**
 * SyrupUpsellStep — "Refine Your Cocktails" step.
 * Reframes syrups as flavor customization, not product purchase.
 * Per-drink flavor chips + source toggle (Dr. Bartender vs self-supply).
 *
 * syrupSelections is a per-drink map: { drinkId: [syrupId, ...] }
 * syrupSelfProvided is a flat array of syrup IDs the client will buy themselves.
 */
export default function SyrupUpsellStep({
  selectedDrinkIds = [],
  cocktails = [],
  syrupSelections = {},
  syrupSelfProvided = [],
  onSyrupToggle,
  onSelfProvidedChange,
  proposalSyrups = [],
  guestCount,
  onNext,
  onBack,
}) {
  const [showFullMenu, setShowFullMenu] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');

  const drinksWithFlavors = getDrinksWithFlavors(selectedDrinkIds, cocktails);

  // All uniquely selected flavor syrup IDs (from per-drink map + self-provided)
  const allUniqueSyrups = getAllUniqueSyrups(syrupSelections);
  const allSelectedFlavors = [...new Set([...allUniqueSyrups, ...syrupSelfProvided])];

  // Determine source for a syrup: 'drb' (Dr. Bartender) or 'self'
  const getSource = (syrupId) => {
    if (syrupSelfProvided.includes(syrupId)) return 'self';
    return 'drb';
  };

  // Toggle a flavor chip for a specific drink
  const toggleFlavor = (drinkId, syrupId) => {
    const drinkSyrups = getDrinkSyrupSelections(syrupSelections, drinkId);
    const isRemoving = drinkSyrups.includes(syrupId);

    // Toggle in per-drink map
    onSyrupToggle(drinkId, syrupId);

    // If removing and no other drink uses this syrup, also remove from selfProvided
    if (isRemoving) {
      const otherDrinkHasIt = Object.entries(syrupSelections)
        .some(([key, ids]) => key !== drinkId && Array.isArray(ids) && ids.includes(syrupId));
      if (!otherDrinkHasIt) {
        onSelfProvidedChange(syrupSelfProvided.filter(s => s !== syrupId));
      }
    }
  };

  // Switch supply source for a selected flavor (doesn't change per-drink assignments)
  const setFlavorSource = (syrupId, source) => {
    if (source === 'self') {
      if (!syrupSelfProvided.includes(syrupId)) {
        onSelfProvidedChange([...syrupSelfProvided, syrupId]);
      }
    } else {
      onSelfProvidedChange(syrupSelfProvided.filter(s => s !== syrupId));
    }
  };

  // Toggle from Browse All — uses '_browse' drink key
  const toggleBrowseSyrup = (syrupId) => {
    const isAnywhere = allSelectedFlavors.includes(syrupId);
    if (isAnywhere) {
      // Remove from all drinks + selfProvided
      onSyrupToggle('_all', syrupId);
      onSelfProvidedChange(syrupSelfProvided.filter(s => s !== syrupId));
    } else {
      onSyrupToggle('_browse', syrupId);
    }
  };

  // Pricing — only for syrups NOT self-provided and NOT from proposal
  const drbSyrups = allUniqueSyrups.filter(id => !syrupSelfProvided.includes(id));
  const newDrbSyrups = drbSyrups.filter(id => !proposalSyrups.includes(id));
  const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
  const drbCost = calculateSyrupCost(newDrbSyrups.length, bottlesPerFlavor);

  // Drinks that have flavor options but nothing selected for them
  const unflavoredDrinks = drinksWithFlavors
    .filter(d => {
      const drinkSyrups = getDrinkSyrupSelections(syrupSelections, d.drinkId);
      return !d.flavors.some(f => drinkSyrups.includes(f.syrupId) || syrupSelfProvided.includes(f.syrupId));
    })
    .map(d => d.drinkName);

  // Build "enhances" map: syrupId -> list of drink names that use it
  const enhancesMap = {};
  for (const drink of drinksWithFlavors) {
    for (const flavor of drink.flavors) {
      if (!enhancesMap[flavor.syrupId]) enhancesMap[flavor.syrupId] = [];
      enhancesMap[flavor.syrupId].push(drink.drinkName);
    }
  }

  // Full menu filtering
  const categoryTabs = [{ key: 'all', label: 'All' }, ...SYRUP_CATEGORIES];
  const filteredSyrups = activeCategory === 'all'
    ? SYRUPS
    : SYRUPS.filter(s => s.category === activeCategory);

  const hasAnySelection = allSelectedFlavors.length > 0;

  return (
    <div>
      {/* Section 1: Header */}
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Refine Your Cocktails
        </h2>
        <p className="text-muted">
          Add a signature twist to your cocktails. Pick a flavor and we'll handle the rest.
        </p>
      </div>

      {/* Section 2: Per-Drink Flavor Selection */}
      {drinksWithFlavors.length > 0 && (
        <div className="card mb-2">
          {drinksWithFlavors.map(drink => {
            const drinkSyrups = getDrinkSyrupSelections(syrupSelections, drink.drinkId);
            return (
              <div key={drink.drinkId} className="flavor-drink-group">
                <div className="flavor-drink-header">
                  <span>{drink.drinkEmoji} {drink.drinkName}</span>
                  <span className="flavor-drink-subtitle">Customize this drink:</span>
                </div>
                <div className="flavor-chip-grid">
                  {drink.flavors.map(flavor => {
                    const isSelected = drinkSyrups.includes(flavor.syrupId) || syrupSelfProvided.includes(flavor.syrupId);
                    return (
                      <button
                        key={flavor.syrupId}
                        className={`flavor-chip${isSelected ? ' selected' : ''}`}
                        onClick={() => toggleFlavor(drink.drinkId, flavor.syrupId)}
                        title={flavor.note || flavor.syrupName}
                      >
                        {flavor.note || flavor.syrupName}
                        {isSelected && ' \u2713'}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Section 3: Selected Flavors — Source Toggle */}
      {allSelectedFlavors.length > 0 && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            How Should We Get Your Flavors?
          </h3>
          {allSelectedFlavors.map(syrupId => {
            const syrup = SYRUPS.find(s => s.id === syrupId);
            if (!syrup) return null;
            const source = getSource(syrupId);
            const enhances = enhancesMap[syrupId];
            const isFromProposal = proposalSyrups.includes(syrupId);

            return (
              <div key={syrupId} className="flavor-source-card">
                <div className="flavor-source-header">
                  <strong>{syrup.name}</strong>
                  {enhances && enhances.length > 0 && (
                    <span className="text-muted text-small" style={{ display: 'block' }}>
                      Enhances: {enhances.join(', ')}
                    </span>
                  )}
                </div>
                <div className="flavor-source-options">
                  <label className="flavor-source-radio">
                    <input
                      type="radio"
                      name={`source-${syrupId}`}
                      checked={source === 'drb'}
                      onChange={() => setFlavorSource(syrupId, 'drb')}
                    />
                    <span className="flavor-source-radio-content">
                      <span className="flavor-source-radio-label">
                        Supplied by Dr. Bartender
                        {!isFromProposal && <span className="flavor-source-price"> (+${SYRUP_PRICE_SINGLE})</span>}
                        {isFromProposal && <span className="flavor-source-included"> (included)</span>}
                      </span>
                      <span className="flavor-source-recommended">Recommended</span>
                      <span className="text-muted text-small">We source, test, and bring the perfect syrup.</span>
                    </span>
                  </label>
                  <label className="flavor-source-radio">
                    <input
                      type="radio"
                      name={`source-${syrupId}`}
                      checked={source === 'self'}
                      onChange={() => setFlavorSource(syrupId, 'self')}
                    />
                    <span className="flavor-source-radio-content">
                      <span className="flavor-source-radio-label">Add to my shopping list</span>
                      {source === 'self' && (
                        <span className="text-muted text-small">We'll include details on what to buy.</span>
                      )}
                    </span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Section 4: Browse All Syrups */}
      <div className="card mb-2">
        <button
          className="btn btn-secondary"
          onClick={() => setShowFullMenu(!showFullMenu)}
          style={{ width: '100%' }}
        >
          {showFullMenu ? 'Hide Full Syrup Menu' : 'Browse All Syrups'}
        </button>

        {showFullMenu && (
          <div style={{ marginTop: '1rem' }}>
            <div className="syrup-category-tabs">
              {categoryTabs.map(cat => (
                <button
                  key={cat.key}
                  className={`syrup-cat-tab${activeCategory === cat.key ? ' active' : ''}`}
                  onClick={() => setActiveCategory(cat.key)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div className="syrup-grid syrup-grid-compact">
              {filteredSyrups.map(syrup => {
                const isSelected = allSelectedFlavors.includes(syrup.id);
                return (
                  <button
                    key={syrup.id}
                    className={`syrup-chip${isSelected ? ' selected' : ''}`}
                    onClick={() => toggleBrowseSyrup(syrup.id)}
                  >
                    <span className="syrup-chip-name">{syrup.name}</span>
                    {syrup.seasonal && <span className="syrup-seasonal-tag">Seasonal</span>}
                    {isSelected && (
                      <span className="syrup-check">
                        <svg width="12" height="10" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                          <path d="M1.5 6L5 9.5L12.5 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Section 5: Summary */}
      {hasAnySelection && (
        <div className="card mb-2">
          {/* Dr. Bartender supplied */}
          {drbSyrups.length > 0 && (
            <div className="flavor-summary-section">
              <strong>Supplied by Dr. Bartender:</strong>
              <span> {drbSyrups.length} syrup{drbSyrups.length !== 1 ? 's' : ''}
                {drbCost.total > 0 && <> &mdash; ${drbCost.total}</>}
              </span>
              <div className="text-muted text-small" style={{ marginTop: '0.25rem' }}>
                {drbSyrups.map(id => SYRUPS.find(s => s.id === id)?.name).filter(Boolean).join(', ')}
              </div>
              {drbCost.singles > 0 && drbCost.singles < 3 && newDrbSyrups.length > 0 && (
                <div className="syrup-pack-nudge" style={{ marginTop: '0.5rem' }}>
                  Add {3 - drbCost.singles} more for the 3-pack price &mdash; save ${3 * SYRUP_PRICE_SINGLE - SYRUP_PRICE_3PACK}
                </div>
              )}
            </div>
          )}

          {/* Self-provided shopping list */}
          {syrupSelfProvided.length > 0 && (
            <div className="flavor-shopping-list" style={{ marginTop: drbSyrups.length > 0 ? '1rem' : 0 }}>
              <strong>Your Shopping List:</strong>
              <ul style={{ margin: '0.5rem 0', paddingLeft: '1.25rem' }}>
                {syrupSelfProvided.map(id => {
                  const s = SYRUPS.find(sy => sy.id === id);
                  return s ? (
                    <li key={id}>{s.name} syrup (750ml bottle, bartender-ready)</li>
                  ) : null;
                })}
              </ul>
              <p className="text-muted text-small" style={{ fontStyle: 'italic' }}>
                Tip: Look for pure flavored syrups &mdash; no pulp or puree.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Soft nudge for unselected drinks */}
      {!hasAnySelection && unflavoredDrinks.length > 0 && (
        <div className="flavor-nudge">
          Your {unflavoredDrinks.join(', ')} can be customized with flavors &mdash; skip or pick above.
        </div>
      )}

      {/* Section 6: Navigation */}
      <div className="step-nav mt-2">
        {onBack ? (
          <button className="btn btn-secondary" onClick={onBack}>Back</button>
        ) : <div />}
        <button className="btn btn-primary" onClick={onNext}>
          {hasAnySelection ? 'Continue' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
