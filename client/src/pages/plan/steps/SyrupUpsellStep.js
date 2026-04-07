import React, { useState } from 'react';
import {
  SYRUPS,
  SYRUP_CATEGORIES,
  SYRUP_PRICE_SINGLE,
  SYRUP_PRICE_3PACK,
  calculateSyrupCost,
  getRecommendedSyrups,
} from '../../../data/syrups';

/**
 * SyrupUpsellStep — shown after signature drink selection in the Potion Planning Lab.
 * Recommends syrups based on selected drinks, and allows browsing the full menu.
 */
export default function SyrupUpsellStep({
  selectedDrinkIds = [],
  cocktails = [],
  syrupSelections = [],
  onChange,
  onNext,
  onBack,
}) {
  const [showFullMenu, setShowFullMenu] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');

  const recommendations = getRecommendedSyrups(selectedDrinkIds);
  const hasRecommendations = recommendations.length > 0;

  const toggleSyrup = (id) => {
    if (syrupSelections.includes(id)) {
      onChange(syrupSelections.filter(s => s !== id));
    } else {
      onChange([...syrupSelections, id]);
    }
  };

  const cost = calculateSyrupCost(syrupSelections.length);

  // Get drink name by ID
  const drinkName = (id) => cocktails.find(c => c.id === id)?.name || id;

  // Full menu filtering
  const categoryTabs = [{ key: 'all', label: 'All' }, ...SYRUP_CATEGORIES];
  const filteredSyrups = activeCategory === 'all'
    ? SYRUPS
    : SYRUPS.filter(s => s.category === activeCategory);

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Upgrade Your Cocktails
        </h2>
        <p className="text-muted">
          Our handcrafted syrups take your signature drinks to the next level.
          Each 750ml bottle makes 30-40 cocktails.
        </p>
        <div className="syrup-pricing-banner" style={{ marginTop: '0.75rem' }}>
          <span>${SYRUP_PRICE_SINGLE}/bottle</span>
          <span className="syrup-pricing-divider">|</span>
          <span className="syrup-pricing-deal">3 for ${SYRUP_PRICE_3PACK}</span>
        </div>
      </div>

      {/* Recommendations based on selected drinks */}
      {hasRecommendations && (
        <div className="card mb-2">
          <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
            Recommended for Your Menu
          </h3>
          <div className="syrup-rec-list">
            {recommendations.map(rec => {
              const isSelected = syrupSelections.includes(rec.id);
              return (
                <div key={rec.id} className={`syrup-rec-card${isSelected ? ' selected' : ''}`}>
                  <div className="syrup-rec-header">
                    <button
                      className={`syrup-rec-toggle${isSelected ? ' active' : ''}`}
                      onClick={() => toggleSyrup(rec.id)}
                    >
                      {isSelected ? (
                        <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                          <path d="M1.5 6L5 9.5L12.5 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      ) : '+'}
                    </button>
                    <div className="syrup-rec-info">
                      <strong>{rec.name}</strong>
                      {rec.seasonal && <span className="syrup-seasonal-tag">Seasonal</span>}
                    </div>
                  </div>
                  <div className="syrup-rec-drinks">
                    {rec.forDrinks.map(({ drinkId, note }) => (
                      <div key={drinkId} className="syrup-rec-drink-note">
                        <span className="syrup-rec-drink-name">{drinkName(drinkId)}</span>
                        {note && <span className="syrup-rec-note"> — {note}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Browse full menu toggle */}
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
                const isSelected = syrupSelections.includes(syrup.id);
                return (
                  <button
                    key={syrup.id}
                    className={`syrup-chip${isSelected ? ' selected' : ''}`}
                    onClick={() => toggleSyrup(syrup.id)}
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

      {/* Selection summary */}
      {syrupSelections.length > 0 && (
        <div className="card mb-2">
          <div className="syrup-summary">
            <div className="syrup-summary-count">
              {syrupSelections.length} syrup{syrupSelections.length !== 1 ? 's' : ''} selected
            </div>
            <div className="syrup-summary-cost">
              {cost.packs > 0 && <span>{cost.packs} three-pack{cost.packs !== 1 ? 's' : ''}</span>}
              {cost.packs > 0 && cost.singles > 0 && <span> + </span>}
              {cost.singles > 0 && <span>{cost.singles} single{cost.singles !== 1 ? 's' : ''}</span>}
              <span className="syrup-summary-total"> = ${cost.total}</span>
            </div>
            {cost.singles > 0 && (
              <div className="syrup-pack-nudge">
                Add {3 - cost.singles} more for the 3-pack discount (save ${3 * SYRUP_PRICE_SINGLE - SYRUP_PRICE_3PACK})
              </div>
            )}
            <div className="syrup-selected-list">
              {syrupSelections.map(id => {
                const s = SYRUPS.find(sy => sy.id === id);
                return s ? (
                  <span key={id} className="syrup-selected-tag">
                    {s.name}
                    <button className="syrup-remove-btn" onClick={() => toggleSyrup(id)} aria-label={`Remove ${s.name}`}>&times;</button>
                  </span>
                ) : null;
              })}
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="step-nav mt-2">
        {onBack ? (
          <button className="btn btn-secondary" onClick={onBack}>Back</button>
        ) : <div />}
        <button className="btn btn-primary" onClick={onNext}>
          {syrupSelections.length > 0 ? 'Continue' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
