import React, { useState, useEffect } from 'react';
import { getUpgradesForDrink, getPitch, isUpgradeSelectedForDrink } from '../data/drinkUpgrades';
import { DRINK_SYRUP_MAP, SYRUPS, NO_SYRUP_DRINKS, SYRUP_PRICE_SINGLE, SYRUP_PRICE_3PACK, getBottlesPerSyrup, getDrinkSyrupSelections, getAllUniqueSyrups, calculateSyrupCost } from '../../../data/syrups';
import { useToast } from '../../../context/ToastContext';

/**
 * MakeItYoursPanel — collapsible customization panel shown below a selected drink.
 * Starts collapsed with a summary + clickable "Customize" prompt.
 * Syrup selections are per-drink (not shared across drinks).
 */
export default function MakeItYoursPanel({
  drinkId,
  drinkName,
  phase = 'refinement',
  addOns = {},
  toggleAddOn,
  toggleAddOnForDrink,
  updateAddOnMeta,
  addonPricing = [],
  syrupSelections = {},
  onSyrupToggle,
  syrupSelfProvided = [],
  onSelfProvidedChange,
  proposalSyrups = [],
  guestCount,
}) {
  const [expanded, setExpanded] = useState(false);
  const toast = useToast();

  const allUpgrades = getUpgradesForDrink(drinkId);
  const featuredAddons = allUpgrades.filter(u => u.featured);
  const flairUpgrades = allUpgrades.filter(u => !u.featured);

  // Per-drink upgrades use toggleAddOnForDrink + their own selection check; non-per-drink
  // upgrades (e.g. ginger beer for moscow-mule) keep using the global toggleAddOn.
  const isFlairSelected = (upgrade) =>
    upgrade.perDrink
      ? isUpgradeSelectedForDrink(addOns, upgrade.addonSlug, drinkId)
      : !!addOns[upgrade.addonSlug];

  const handleFlairToggle = (upgrade) => {
    if (!upgrade.perDrink) {
      toggleAddOn(upgrade.addonSlug);
      return;
    }
    const ok = toggleAddOnForDrink
      ? toggleAddOnForDrink(upgrade.addonSlug, drinkId)
      : (toggleAddOn(upgrade.addonSlug), true);
    if (!ok && upgrade.maxDrinks) {
      toast.error(`You can choose up to ${upgrade.maxDrinks} drinks for the ${upgrade.label}.`);
    }
  };

  // Auto-deselect addons whose required dependency was removed
  useEffect(() => {
    for (const upgrade of allUpgrades) {
      if (!upgrade.requiresAddon) continue;
      const isOnForThisDrink = isFlairSelected(upgrade);
      if (isOnForThisDrink && !addOns[upgrade.requiresAddon] && !addOns['client-glassware']) {
        if (upgrade.perDrink && toggleAddOnForDrink) {
          toggleAddOnForDrink(upgrade.addonSlug, drinkId);
        } else {
          toggleAddOn(upgrade.addonSlug);
        }
      }
    }
  }, [addOns]); // eslint-disable-line react-hooks/exhaustive-deps

  const syrupMapping = DRINK_SYRUP_MAP[drinkId];
  const noSyrups = NO_SYRUP_DRINKS.includes(drinkId);
  const syrupRecs = (!noSyrups && syrupMapping && !syrupMapping.required)
    ? syrupMapping.syrups : [];

  const featuredIds = (!noSyrups && syrupMapping?.featured) || [];
  const featuredSyrups = featuredIds.filter(id => syrupRecs.includes(id));
  const collapsibleSyrups = syrupRecs.filter(id => !featuredIds.includes(id));

  const hasFlair = flairUpgrades.length > 0;
  const hasSyrups = syrupRecs.length > 0;
  const hasFeatured = featuredSyrups.length > 0 || featuredAddons.length > 0;
  const hasCollapsibleContent = collapsibleSyrups.length > 0 || hasFlair;

  if (!hasFlair && !hasSyrups && !hasFeatured) return null;

  // Per-drink syrup selections
  const drinkSyrups = getDrinkSyrupSelections(syrupSelections, drinkId);

  // Build collapsed summary of current selections
  const selectedSyrupNames = syrupRecs
    .filter(id => drinkSyrups.includes(id))
    .map(id => SYRUPS.find(s => s.id === id)?.name)
    .filter(Boolean);
  const selectedFlairLabels = flairUpgrades
    .filter(isFlairSelected)
    .map(u => u.label);
  const allSelections = [...selectedSyrupNames, ...selectedFlairLabels];
  const hasSelections = allSelections.length > 0;

  const handleSyrupToggle = (syrupId) => {
    onSyrupToggle(drinkId, syrupId);
  };

  // Source toggle for a selected syrup
  const getSource = (syrupId) => syrupSelfProvided.includes(syrupId) ? 'self' : 'drb';
  const setSource = (syrupId, source) => {
    if (!onSelfProvidedChange) return;
    if (source === 'self') {
      if (!syrupSelfProvided.includes(syrupId)) {
        onSelfProvidedChange([...syrupSelfProvided, syrupId]);
      }
    } else {
      onSelfProvidedChange(syrupSelfProvided.filter(s => s !== syrupId));
    }
  };

  // Compute global DRB syrup count for 3-pack pricing context
  const allUnique = getAllUniqueSyrups(syrupSelections);
  const drbSyrupCount = allUnique.filter(id => !syrupSelfProvided.includes(id) && !proposalSyrups.includes(id)).length;
  const bottles = getBottlesPerSyrup(guestCount);
  const globalCost = calculateSyrupCost(drbSyrupCount, bottles);
  // Effective per-bottle price (3-pack discount on total bottles)
  const perBottlePrice = globalCost.totalBottles > 0 ? Math.round(globalCost.total / globalCost.totalBottles) : SYRUP_PRICE_SINGLE;
  const perFlavorPrice = perBottlePrice * bottles;

  // Render a single syrup option with source toggle
  const renderSyrupOption = (syrupId, showSourceAlways = false) => {
    const syrup = SYRUPS.find(s => s.id === syrupId);
    if (!syrup) return null;
    const isSelected = drinkSyrups.includes(syrupId);
    const drinkNote = syrupMapping.notes?.[syrupId];
    const source = getSource(syrupId);
    const isFromProposal = proposalSyrups.includes(syrupId);
    const showSource = showSourceAlways || isSelected;

    return (
      <div key={syrupId}>
        <button
          className={`make-it-yours-option${isSelected ? ' selected' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleSyrupToggle(syrupId); }}
          aria-pressed={isSelected}
        >
          <div className="option-text">
            <span className="option-title">
              {syrup.name}
              {syrup.seasonal && <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--warm-brown)' }}> (Seasonal)</span>}
            </span>
            {drinkNote && (
              <span className="option-desc">{drinkNote}</span>
            )}
          </div>
          {isSelected && (
            <span className="option-check">
              <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                <path d="M1.5 6L5 9.5L12.5 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
          )}
        </button>
        {showSource && onSelfProvidedChange && (
          <div className="syrup-source-inline" onClick={(e) => e.stopPropagation()}>
            <label className="syrup-source-inline-option">
              <input
                type="radio"
                name={`source-${drinkId}-${syrupId}`}
                checked={source === 'drb'}
                onChange={() => setSource(syrupId, 'drb')}
              />
              <span>
                Hand-crafted by Dr. Bartender
                {isFromProposal
                  ? <span className="syrup-source-included"> (included)</span>
                  : <span className="syrup-source-price">
                      {bottles > 1
                        ? <> ({bottles} bottles &mdash; ${perFlavorPrice})</>
                        : <> (+${perFlavorPrice})</>
                      }
                      {globalCost.packs > 0 && <span className="syrup-source-discount"> 3-pack pricing</span>}
                    </span>
                }
              </span>
            </label>
            <label className="syrup-source-inline-option">
              <input
                type="radio"
                name={`source-${drinkId}-${syrupId}`}
                checked={source === 'self'}
                onChange={() => setSource(syrupId, 'self')}
              />
              <span>
                Add to my shopping list
                {bottles > 1 && <span className="text-muted"> ({bottles} bottles needed)</span>}
              </span>

            </label>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`make-it-yours-panel${hasSelections ? ' has-selections' : ''}`}>
      {/* Featured items — always visible above the collapsible section */}
      {hasFeatured && (
        <div className="make-it-yours-featured">
          <div className="make-it-yours-options">
            {featuredSyrups.map(syrupId => renderSyrupOption(syrupId, true))}
            {featuredAddons.map(upgrade => {
              const pricing = addonPricing.find(a => a.slug === upgrade.addonSlug);
              const isEnabled = !!addOns[upgrade.addonSlug];
              const pitch = getPitch(upgrade, drinkId);
              const priceLabel = pricing
                ? pricing.billing_type === 'per_guest'
                  ? guestCount ? `$${pricing.rate}/guest × ${guestCount} = $${(Number(pricing.rate) * guestCount).toFixed(0)}` : `$${pricing.rate}/guest`
                  : `$${pricing.rate}`
                : '';

              return (
                <div key={upgrade.addonSlug}>
                  <div className="make-it-yours-option selected" style={{ cursor: 'default' }}>
                    <span className="option-emoji">{upgrade.emoji}</span>
                    <div className="option-text">
                      <span className="option-title">{upgrade.label}</span>
                      <span className="option-desc">{pitch}</span>
                    </div>
                  </div>
                  <div className="syrup-source-inline" onClick={(e) => e.stopPropagation()}>
                    <label className="syrup-source-inline-option">
                      <input
                        type="radio"
                        name={`addon-source-${drinkId}-${upgrade.addonSlug}`}
                        checked={isEnabled}
                        onChange={() => { if (!isEnabled) toggleAddOn(upgrade.addonSlug); }}
                      />
                      <span>
                        Hand-crafted by Dr. Bartender
                        {priceLabel && <span className="syrup-source-price"> ({priceLabel})</span>}
                      </span>
                    </label>
                    <label className="syrup-source-inline-option">
                      <input
                        type="radio"
                        name={`addon-source-${drinkId}-${upgrade.addonSlug}`}
                        checked={!isEnabled}
                        onChange={() => { if (isEnabled) toggleAddOn(upgrade.addonSlug); }}
                      />
                      <span>Add to my shopping list</span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Collapsible section for remaining options */}
      {hasCollapsibleContent && (
        <>
          <button
            className="make-it-yours-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <span className="make-it-yours-label">Refine This Cocktail</span>
            <span className={`make-it-yours-arrow${expanded ? ' expanded' : ''}`}>&#9662;</span>
          </button>

          {/* Always-visible summary / customize prompt */}
          <div className="make-it-yours-summary" onClick={() => setExpanded(!expanded)}>
            {hasSelections && (
              <span className="make-it-yours-summary-selected">
                {allSelections.join(', ')}
              </span>
            )}
            <span className="make-it-yours-summary-prompt">
              {expanded ? 'Collapse' : 'Customize Flavor & Add-ons'}
            </span>
          </div>

          {expanded && (
            <div className="make-it-yours-content">
              {/* Flavor variants (non-featured syrups) */}
              {collapsibleSyrups.length > 0 && (
                <div className="make-it-yours-section">
                  <div className="make-it-yours-section-label">Flavor</div>
                  <div className="make-it-yours-options">
                    {collapsibleSyrups.map(syrupId => renderSyrupOption(syrupId))}
                  </div>
                  <p className="make-it-yours-pricing-note">
                    Hand-crafted syrups &mdash; each 750ml bottle makes 30-40 cocktails
                    {guestCount && guestCount > 50 && (
                      <span> (we recommend {getBottlesPerSyrup(guestCount)} bottles per flavor for {guestCount} guests)</span>
                    )}
                  </p>
                  {globalCost.singles > 0 && globalCost.singles < 3 && (
                    <div className="syrup-pack-nudge" style={{ marginTop: '0.35rem' }}>
                      {3 - globalCost.singles} more bottle{3 - globalCost.singles !== 1 ? 's' : ''} to complete a 3-pack &mdash; save ${3 * SYRUP_PRICE_SINGLE - SYRUP_PRICE_3PACK} per pack
                    </div>
                  )}
                </div>
              )}

              {/* Flair (service upgrades) */}
              {hasFlair && (
                <div className="make-it-yours-section">
                  <div className="make-it-yours-section-label">Flair</div>
                  <div className="make-it-yours-options">
                    {flairUpgrades.map(upgrade => {
                      const pricing = addonPricing.find(a => a.slug === upgrade.addonSlug);
                      const isSelected = isFlairSelected(upgrade);
                      const pitch = getPitch(upgrade, drinkId);
                      const priceLabel = pricing
                        ? pricing.billing_type === 'per_guest' ? `+$${pricing.rate}/guest` : `+$${pricing.rate}`
                        : '';

                      // Check if this upgrade requires another addon
                      const reqSlug = upgrade.requiresAddon;
                      const hasRequiredAddon = reqSlug ? (!!addOns[reqSlug] || !!addOns['client-glassware']) : true;
                      const isLocked = reqSlug && !hasRequiredAddon;

                      if (isLocked) {
                        const reqPricing = addonPricing.find(a => a.slug === reqSlug);
                        const reqPriceLabel = reqPricing
                          ? reqPricing.billing_type === 'per_guest' ? `+$${reqPricing.rate}/guest` : `+$${reqPricing.rate}`
                          : '';
                        return (
                          <div key={upgrade.addonSlug} className="make-it-yours-option locked">
                            <span className="option-emoji">{upgrade.emoji}</span>
                            <div className="option-text">
                              <span className="option-title">{upgrade.label}</span>
                              <span className="option-desc">{upgrade.requiresAddonMessage}</span>
                              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                                {guestCount && guestCount > 100 ? (
                                  <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                                    Real glassware is available for events up to 100 guests.
                                  </span>
                                ) : (
                                  <button
                                    className="btn btn-sm btn-primary"
                                    style={{ fontSize: '0.75rem' }}
                                    onClick={(e) => { e.stopPropagation(); toggleAddOn(reqSlug); }}
                                  >
                                    Add Real Glassware{reqPriceLabel && ` (${reqPriceLabel})`}
                                  </button>
                                )}
                                <button
                                  className="btn btn-sm btn-secondary"
                                  style={{ fontSize: '0.75rem' }}
                                  onClick={(e) => { e.stopPropagation(); toggleAddOn('client-glassware'); }}
                                >
                                  I have my own glassware
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      // Bubble flavor pairings for this drink
                      const bubblePairings = upgrade.bubbleFlavors?.[drinkId];
                      const addonData = addOns[upgrade.addonSlug] || {};
                      const selectedBubble = addonData.bubbles?.[drinkId];

                      return (
                        <div key={upgrade.addonSlug}>
                          <button
                            className={`make-it-yours-option${isSelected ? ' selected' : ''}`}
                            onClick={(e) => { e.stopPropagation(); handleFlairToggle(upgrade); }}
                            aria-pressed={isSelected}
                          >
                            <span className="option-emoji">{upgrade.emoji}</span>
                            <div className="option-text">
                              <span className="option-title">{upgrade.label}</span>
                              <span className="option-desc">{pitch}</span>
                            </div>
                            {phase === 'refinement' && priceLabel && !isSelected && (
                              <span className="option-price">{priceLabel}</span>
                            )}
                            {isSelected && (
                              <span className="option-check">
                                <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                                  <path d="M1.5 6L5 9.5L12.5 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </span>
                            )}
                          </button>
                          {isSelected && bubblePairings && bubblePairings.length > 0 && (
                            <div className="bubble-flavor-picker" onClick={(e) => e.stopPropagation()}>
                              <span className="bubble-flavor-label">Choose your aroma:</span>
                              <div className="bubble-flavor-chips">
                                {bubblePairings.map(flavor => {
                                  const isChosen = selectedBubble === flavor;
                                  return (
                                    <button
                                      key={flavor}
                                      className={`bubble-flavor-chip${isChosen ? ' selected' : ''}`}
                                      onClick={() => {
                                        const bubbles = { ...(addonData.bubbles || {}), [drinkId]: isChosen ? null : flavor };
                                        updateAddOnMeta(upgrade.addonSlug, { bubbles });
                                      }}
                                    >
                                      {flavor.charAt(0).toUpperCase() + flavor.slice(1)}
                                      {isChosen && ' \u2713'}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
