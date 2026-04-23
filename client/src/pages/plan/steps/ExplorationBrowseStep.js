import React, { useState } from 'react';
import MakeItYoursPanel from './MakeItYoursPanel';

/**
 * ExplorationBrowseStep — browse cocktails and "favorite" them without commitment.
 * Shows "Make it yours" panels in no-pricing mode.
 */
export default function ExplorationBrowseStep({
  cocktails = [],
  categories = [],
  favoriteDrinks = [],
  onChange,
  addOns = {},
  toggleAddOn,
  toggleAddOnForDrink,
  addonPricing = [],
  syrupSelections = [],
  onSyrupToggle,
}) {
  const [activeTab, setActiveTab] = useState(categories[0]?.id || 'crowd-favorites');

  const toggleFavorite = (drinkId) => {
    if (favoriteDrinks.includes(drinkId)) {
      onChange(favoriteDrinks.filter(id => id !== drinkId));
    } else {
      onChange([...favoriteDrinks, drinkId]);
    }
  };

  const filteredDrinks = cocktails.filter(d => d.category_id === activeTab);

  const countForCategory = (catId) => {
    return cocktails.filter(d => d.category_id === catId && favoriteDrinks.includes(d.id)).length;
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Browse Our Cocktails
        </h2>
        <p className="text-muted">
          Tap to favorite the ones that catch your eye — nothing is final.
        </p>
      </div>

      {/* Category pills */}
      <div className="category-pills">
        {categories.map(cat => {
          const count = countForCategory(cat.id);
          return (
            <button
              key={cat.id}
              className={`category-pill${activeTab === cat.id ? ' active' : ''}`}
              onClick={() => setActiveTab(cat.id)}
            >
              {cat.label}
              {count > 0 && (
                <span style={{ marginLeft: '0.3rem', fontWeight: 700 }}>({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Desktop sidebar + drink list */}
      <div className="drink-picker-layout">
        <div className="category-sidebar">
          {categories.map(cat => {
            const count = countForCategory(cat.id);
            return (
              <button
                key={cat.id}
                className={`category-sidebar-btn${activeTab === cat.id ? ' active' : ''}`}
                onClick={() => setActiveTab(cat.id)}
              >
                <span>{cat.label}</span>
                {count > 0 && (
                  <span className="badge badge-inprogress">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div>
          <div className="drink-card-list">
            {filteredDrinks.map(drink => {
              const isFavorited = favoriteDrinks.includes(drink.id);
              return (
                <div key={drink.id}>
                  <button
                    className={`drink-card-horizontal${isFavorited ? ' selected' : ''}`}
                    onClick={() => toggleFavorite(drink.id)}
                    aria-pressed={isFavorited}
                  >
                    <span className="drink-card-emoji">{drink.emoji}</span>
                    <div className="drink-card-info">
                      <span className="drink-card-name">{drink.name}</span>
                      <span className="drink-card-desc">{drink.description}</span>
                    </div>
                    <span className="drink-check-stylized favorite-heart">
                      {isFavorited ? '\u2764\uFE0F' : '\u2661'}
                    </span>
                  </button>
                  {isFavorited && (
                    <MakeItYoursPanel
                      drinkId={drink.id}
                      drinkName={drink.name}
                      phase="exploration"
                      addOns={addOns}
                      toggleAddOn={toggleAddOn}
                      toggleAddOnForDrink={toggleAddOnForDrink}
                      addonPricing={addonPricing}
                      syrupSelections={syrupSelections}
                      onSyrupToggle={onSyrupToggle}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="drink-picker-sticky-footer">
        <div className="sticky-footer-info">
          <span className="sticky-footer-count">
            {favoriteDrinks.length} favorite{favoriteDrinks.length !== 1 ? 's' : ''} saved
          </span>
        </div>
      </div>
    </div>
  );
}
