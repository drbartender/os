import React, { useState, useEffect } from 'react';
import { SYRUPS, SYRUP_CATEGORIES, getAllUniqueSyrups, getDrinkSyrupSelections, calculateSyrupCost, getBottlesPerSyrup } from '../../../data/syrups';
import { getUpgradesForDrink, isUpgradeSelectedForDrink } from '../data/drinkUpgrades';
import MakeItYoursPanel from './MakeItYoursPanel';

export default function SignaturePickerStep({
  selected,
  onChange,
  cocktails = [],
  categories = [],
  isFullBarActive,
  isMocktailsActive,
  mixersForSignatureDrinks,
  onMixersChange,
  onSpiritsExtracted,
  customCocktails = [],
  onCustomCocktailsChange,
  addOns = {},
  toggleAddOn,
  toggleAddOnForDrink,
  updateAddOnMeta,
  addonPricing = [],
  guestCount,
  syrupSelections = {},
  onSyrupToggle,
  syrupSelfProvided = [],
  onSelfProvidedChange,
  proposalSyrups = [],
  phase = 'refinement',
  onNext,
  onSkipMocktails,
  onBack,
}) {
  const [activeTab, setActiveTab] = useState(categories[0]?.id || 'crowd-favorites');
  const [lastBrowseTab, setLastBrowseTab] = useState(categories[0]?.id || 'crowd-favorites');
  const [customInput, setCustomInput] = useState('');
  const [showAllSyrups, setShowAllSyrups] = useState(false);
  const [syrupCategory, setSyrupCategory] = useState('all');

  // Track last browsed category when switching tabs
  const handleTabChange = (tabKey) => {
    if (tabKey !== 'your-menu') setLastBrowseTab(tabKey);
    setActiveTab(tabKey);
  };

  // Extract spirits from selected cocktails
  const selectedDrinks = cocktails.filter(d => selected.includes(d.id));
  const extractedSpirits = [...new Set(
    selectedDrinks.map(d => d.base_spirit).filter(Boolean)
  )];

  // Notify parent of extracted spirits whenever they change
  useEffect(() => {
    if (onSpiritsExtracted) {
      onSpiritsExtracted(extractedSpirits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractedSpirits.join(',')]);

  const [dismissedWarning, setDismissedWarning] = useState(false);

  const toggleDrink = (drinkId) => {
    if (selected.includes(drinkId)) {
      onChange(selected.filter(id => id !== drinkId));
    } else {
      onChange([...selected, drinkId]);
      if (selected.length >= 4) setDismissedWarning(false);
    }
  };

  const allTabs = [
    ...categories.map(c => ({ key: c.id, label: c.label })),
    { key: 'your-menu', label: 'Your Menu' },
  ];
  const isYourMenu = activeTab === 'your-menu';
  const filteredDrinks = cocktails.filter(d => d.category_id === activeTab);

  // Count selected per category
  const countForCategory = (catId) => {
    if (catId === 'your-menu') return selected.length + customCocktails.length;
    return cocktails.filter(d => d.category_id === catId && selected.includes(d.id)).length;
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Signature Cocktails
        </h2>
        <p className="text-muted">
          Pick the drinks that feel right — we recommend 2-4 for the best flow.
          We'll help you refine later.
        </p>
        <p className="text-muted text-small mt-1">
          Select a category to browse drinks, then tap to add them to Your Menu.
        </p>
      </div>

      {/* Drink count warning */}
      {selected.length > 4 && !dismissedWarning && (
        <div className="drink-count-warning">
          <div className="drink-count-warning-text">
            <strong>{selected.length} drinks selected</strong>
            <span>
              {selected.length > 7
                ? "That's a lot of signatures! Things tend to get messy past 4 drinks \u2014 service slows down, ingredient lists explode, and your guests may get overwhelmed by choices. We can make it work, but we'd love to chat about streamlining."
                : "We recommend 2\u20134 signature drinks for the best guest experience. More than that and things can get messy \u2014 longer wait times, more ingredients to stock, and decision fatigue at the bar. Totally your call though!"
              }
            </span>
          </div>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setDismissedWarning(true)}
            style={{ whiteSpace: 'nowrap', alignSelf: 'flex-start' }}
          >
            Got it
          </button>
        </div>
      )}

      {/* Mobile pills */}
      <div className="category-pills">
        {allTabs.map(tab => {
          const count = countForCategory(tab.key);
          return (
            <button
              key={tab.key}
              className={`category-pill${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => handleTabChange(tab.key)}
            >
              {tab.label}
              {count > 0 && (
                <span style={{ marginLeft: '0.3rem', fontWeight: 700 }}>({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Desktop sidebar + drink list */}
      <div className="drink-picker-layout">
        {/* Sidebar */}
        <div className="category-sidebar">
          {allTabs.map(tab => {
            const count = countForCategory(tab.key);
            return (
              <button
                key={tab.key}
                className={`category-sidebar-btn${activeTab === tab.key ? ' active' : ''}`}
                onClick={() => handleTabChange(tab.key)}
              >
                <span>{tab.label}</span>
                {count > 0 && (
                  <span className={`badge ${tab.key === 'your-menu' ? 'badge-approved' : 'badge-inprogress'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Drink list */}
        <div>
          {isYourMenu ? (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
                Your Menu ({selectedDrinks.length + customCocktails.length} drink{selectedDrinks.length + customCocktails.length !== 1 ? 's' : ''} selected)
              </h3>
              {selectedDrinks.length === 0 && customCocktails.length === 0 ? (
                <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
                  No drinks selected yet. Browse the categories to add your favorites!
                </p>
              ) : (
                <div className="your-menu-list">
                  {selectedDrinks.map((drink, i) => {
                    const drinkSyrups = getDrinkSyrupSelections(syrupSelections, drink.id);
                    const drinkFlairUpgrades = getUpgradesForDrink(drink.id)
                      .filter(u => u.perDrink
                        ? isUpgradeSelectedForDrink(addOns, u.addonSlug, drink.id)
                        : !!addOns[u.addonSlug]);
                    const selectedSyrupDetails = drinkSyrups
                      .map(id => SYRUPS.find(s => s.id === id))
                      .filter(Boolean);

                    return (
                      <div key={drink.id} className="your-menu-item-wrapper">
                        <div className="your-menu-item">
                          <span className="your-menu-number">{i + 1}.</span>
                          <span className="your-menu-emoji">{drink.emoji}</span>
                          <div className="your-menu-info">
                            <strong>{drink.name}</strong>
                            <span className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                              {drink.description}
                            </span>
                          </div>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => toggleDrink(drink.id)}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                        {(selectedSyrupDetails.length > 0 || drinkFlairUpgrades.length > 0) && (
                          <div className="your-menu-drink-extras">
                            {selectedSyrupDetails.map(syrup => {
                              const isSelf = syrupSelfProvided.includes(syrup.id);
                              return (
                                <button
                                  key={syrup.id}
                                  className="your-menu-extra-tag removable"
                                  onClick={() => onSyrupToggle(drink.id, syrup.id)}
                                  title={`Remove ${syrup.name}`}
                                >
                                  {syrup.name}
                                  <span className={`extra-source-badge ${isSelf ? 'self' : 'drb'}`}>
                                    {isSelf ? 'Shopping List' : 'DRB'}
                                  </span>
                                  <span className="extra-remove">&times;</span>
                                </button>
                              );
                            })}
                            {drinkFlairUpgrades.map(u => (
                              <button
                                key={u.addonSlug}
                                className="your-menu-extra-tag flair removable"
                                onClick={() => u.perDrink && toggleAddOnForDrink
                                  ? toggleAddOnForDrink(u.addonSlug, drink.id)
                                  : toggleAddOn(u.addonSlug)}
                                title={`Remove ${u.label}`}
                              >
                                {u.emoji} {u.label}
                                <span className="extra-remove">&times;</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Cost summary — only if purchasing something from DRB */}
              {(() => {
                const selectedAddonSlugs = Object.keys(addOns);
                const allSyrups = getAllUniqueSyrups(syrupSelections);
                // DRB-supplied syrups (not self-provided, not already in proposal)
                const drbSyrupIds = allSyrups.filter(id =>
                  !syrupSelfProvided.includes(id) && !proposalSyrups.includes(id)
                );

                const hasDrbPurchases = selectedAddonSlugs.length > 0 || drbSyrupIds.length > 0;
                if (!hasDrbPurchases) return null;

                let addonTotal = 0;
                const bottlesPerFlavor = getBottlesPerSyrup(guestCount);
                const syrupCost = calculateSyrupCost(drbSyrupIds.length, bottlesPerFlavor);

                return (
                  <div className="upgrades-summary" style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                    <h4 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
                      Estimated Costs
                    </h4>
                    <div className="drink-upgrades-panel">
                      {selectedAddonSlugs.map(slug => {
                        const pricing = addonPricing.find(a => a.slug === slug);
                        if (!pricing) return null;
                        const rate = Number(pricing.rate);
                        const isPerGuest = pricing.billing_type === 'per_guest';
                        const lineTotal = isPerGuest && guestCount ? rate * guestCount : rate;
                        const priceLabel = isPerGuest
                          ? guestCount ? `$${rate}/guest × ${guestCount}` : `$${rate}/guest`
                          : `$${rate}`;
                        addonTotal += lineTotal;
                        return (
                          <label key={slug} className="upgrade-checkbox">
                            <input
                              type="checkbox"
                              checked={true}
                              onChange={() => toggleAddOn(slug)}
                            />
                            <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div>
                                <span className="upgrade-label">{pricing.name}</span>
                                {isPerGuest && (
                                  <span className="text-muted text-small" style={{ display: 'block', color: 'var(--warm-brown)' }}>
                                    {priceLabel}
                                  </span>
                                )}
                              </div>
                              <span className="upgrade-price">${lineTotal.toFixed(2)}</span>
                            </div>
                          </label>
                        );
                      })}
                      {drbSyrupIds.length > 0 && (
                        <>
                          {selectedAddonSlugs.length > 0 && (
                            <div style={{ borderTop: '1px solid var(--border)', margin: '0.25rem 0' }} />
                          )}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.25rem 0' }}>
                            <span className="upgrade-label">
                              {drbSyrupIds.length} syrup{drbSyrupIds.length !== 1 ? 's' : ''} from Dr. Bartender
                              {bottlesPerFlavor > 1 && (
                                <span className="text-muted text-small" style={{ display: 'block' }}>
                                  {syrupCost.totalBottles} bottles total ({bottlesPerFlavor} per flavor for {guestCount} guests)
                                </span>
                              )}
                            </span>
                            <span className="upgrade-price">${syrupCost.total}</span>
                          </div>
                        </>
                      )}
                      {(addonTotal > 0 || syrupCost.total > 0) && (
                        <div style={{ borderTop: '2px solid var(--deep-brown)', marginTop: '0.5rem', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--deep-brown)' }}>
                          <span>Estimated Total</span>
                          <span>${(addonTotal + syrupCost.total).toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Browse All Syrups — discover beyond per-drink recommendations */}
              {phase === 'refinement' && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowAllSyrups(!showAllSyrups)}
                    style={{ width: '100%' }}
                  >
                    {showAllSyrups ? 'Hide Full Syrup Menu' : 'Browse All Syrups'}
                  </button>
                  {showAllSyrups && (
                    <div style={{ marginTop: '1rem' }}>
                      <div className="syrup-category-tabs">
                        <button
                          className={`syrup-cat-tab${syrupCategory === 'all' ? ' active' : ''}`}
                          onClick={() => setSyrupCategory('all')}
                        >All</button>
                        {SYRUP_CATEGORIES.map(cat => (
                          <button
                            key={cat.key}
                            className={`syrup-cat-tab${syrupCategory === cat.key ? ' active' : ''}`}
                            onClick={() => setSyrupCategory(cat.key)}
                          >{cat.label}</button>
                        ))}
                      </div>
                      <div className="syrup-grid syrup-grid-compact">
                        {(syrupCategory === 'all' ? SYRUPS : SYRUPS.filter(s => s.category === syrupCategory)).map(syrup => {
                          const isSelected = getAllUniqueSyrups(syrupSelections).includes(syrup.id);
                          return (
                            <button
                              key={syrup.id}
                              className={`syrup-chip${isSelected ? ' selected' : ''}`}
                              onClick={() => onSyrupToggle('_browse', syrup.id)}
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
              )}

              {/* Custom cocktail requests */}
              <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                <div className="form-group">
                  <label className="form-label">Have a cocktail in mind that's not on the menu?</label>
                  <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
                    Describe the drink and we'll do our best to make it happen.
                  </p>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="E.g., Lavender Gin Fizz, Spicy Mezcal Mule..."
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && customInput.trim()) {
                          onCustomCocktailsChange([...customCocktails, customInput.trim()]);
                          setCustomInput('');
                        }
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={!customInput.trim()}
                      onClick={() => {
                        if (customInput.trim()) {
                          onCustomCocktailsChange([...customCocktails, customInput.trim()]);
                          setCustomInput('');
                        }
                      }}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Add
                    </button>
                  </div>
                  {customCocktails.length > 0 && (
                    <div className="your-menu-list" style={{ marginTop: '0.75rem' }}>
                      {customCocktails.map((drink, i) => (
                        <div key={i} className="your-menu-item">
                          <span className="your-menu-number">{selectedDrinks.length + i + 1}.</span>
                          <span className="your-menu-emoji">✨</span>
                          <div className="your-menu-info">
                            <strong>{drink}</strong>
                            <span className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
                              Custom request
                            </span>
                          </div>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => onCustomCocktailsChange(customCocktails.filter((_, j) => j !== i))}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Mixer question — only if Full Bar is NOT active and drinks are selected */}
              {!isFullBarActive && selectedDrinks.length > 0 && extractedSpirits.length > 0 && (
                <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                  <div className="form-group">
                    <label className="form-label">
                      Your signature cocktails use {extractedSpirits.length > 1
                        ? extractedSpirits.slice(0, -1).join(', ') + ' and ' + extractedSpirits[extractedSpirits.length - 1]
                        : extractedSpirits[0]}.
                    </label>
                    <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
                      Would you like us to also stock basic mixers (tonic, soda, ginger beer, juices) so guests can make simple mixed drinks with these spirits — in addition to your signature cocktails?
                    </p>
                    <div className="checkbox-grid">
                      <label className="checkbox-label">
                        <input
                          type="radio"
                          name="mixersForSigDrinks"
                          checked={mixersForSignatureDrinks === true}
                          onChange={() => onMixersChange(true)}
                        />
                        <span>Yes, include mixers</span>
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="radio"
                          name="mixersForSigDrinks"
                          checked={mixersForSignatureDrinks === false}
                          onChange={() => onMixersChange(false)}
                        />
                        <span>No, just the signature drinks</span>
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="radio"
                          name="mixersForSigDrinks"
                          checked={mixersForSignatureDrinks === 'undecided'}
                          onChange={() => onMixersChange('undecided')}
                        />
                        <span>Not sure yet — we'll figure it out together</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Navigation buttons — on Your Menu */}
              <div className="step-nav mt-2">
                <button className="btn btn-secondary" onClick={() => handleTabChange(lastBrowseTab)}>Back</button>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  {isMocktailsActive && (
                    <button className="btn btn-secondary" onClick={onSkipMocktails}>
                      Skip Mocktails
                    </button>
                  )}
                  <button className="btn btn-primary" onClick={onNext}>
                    {isMocktailsActive ? 'Continue to Mocktails' : 'Continue'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="drink-card-list">
              {filteredDrinks.map(drink => {
                const isSelected = selected.includes(drink.id);

                return (
                  <div key={drink.id}>
                    <button
                      className={`drink-card-horizontal${isSelected ? ' selected' : ''}`}
                      onClick={() => toggleDrink(drink.id)}
                      aria-pressed={isSelected}
                    >
                      <span className="drink-card-emoji">{drink.emoji}</span>
                      <div className="drink-card-info">
                        <span className="drink-card-name">{drink.name}</span>
                        <span className="drink-card-desc">{drink.description}</span>
                      </div>
                      <span className="drink-check-stylized">
                        <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                          <path d="M1.5 6L5 9.5L12.5 1.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    </button>
                    {isSelected && (
                      <MakeItYoursPanel
                        drinkId={drink.id}
                        drinkName={drink.name}
                        phase={phase}
                        addOns={addOns}
                        toggleAddOn={toggleAddOn}
                        toggleAddOnForDrink={toggleAddOnForDrink}
                        updateAddOnMeta={updateAddOnMeta}
                        addonPricing={addonPricing}
                        syrupSelections={syrupSelections}
                        onSyrupToggle={onSyrupToggle}
                        syrupSelfProvided={syrupSelfProvided}
                        onSelfProvidedChange={onSelfProvidedChange}
                        proposalSyrups={proposalSyrups}
                        guestCount={guestCount}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Persistent sticky footer — visible when browsing drinks */}
      {!isYourMenu && (
        <div className="drink-picker-sticky-footer">
          <div className="sticky-footer-info">
            <span className="sticky-footer-count">
              {selected.length + customCocktails.length} drink{selected.length + customCocktails.length !== 1 ? 's' : ''} selected
            </span>
          </div>
          <div className="sticky-footer-actions">
            {onBack && (
              <button className="btn btn-secondary btn-sm" onClick={onBack}>Back</button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => handleTabChange('your-menu')}>
              Review Your Menu
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
