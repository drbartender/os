import React, { useState, useEffect } from 'react';

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
  onNext,
  onSkipMocktails,
  onBack,
}) {
  const [activeTab, setActiveTab] = useState(categories[0]?.id || 'crowd-favorites');

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

  const toggleDrink = (drinkId) => {
    if (selected.includes(drinkId)) {
      onChange(selected.filter(id => id !== drinkId));
    } else {
      onChange([...selected, drinkId]);
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
    if (catId === 'your-menu') return selected.length;
    return cocktails.filter(d => d.category_id === catId && selected.includes(d.id)).length;
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Signature Cocktails
        </h2>
        <p className="text-muted">
          We recommend 2-4 drinks for the best flow. You are free to choose more, but
          larger menus require more ingredients which may increase cost and slow service.
        </p>
        <p className="text-muted text-small mt-1">
          Select a category to browse drinks, then tap to add them to Your Menu.
        </p>
      </div>

      {/* Mobile pills */}
      <div className="category-pills">
        {allTabs.map(tab => {
          const count = countForCategory(tab.key);
          return (
            <button
              key={tab.key}
              className={`category-pill${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
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
                onClick={() => setActiveTab(tab.key)}
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
                Your Menu ({selectedDrinks.length} drink{selectedDrinks.length !== 1 ? 's' : ''} selected)
              </h3>
              {selectedDrinks.length === 0 ? (
                <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
                  No drinks selected yet. Browse the categories to add your favorites!
                </p>
              ) : (
                <div className="your-menu-list">
                  {selectedDrinks.map((drink, i) => (
                    <div key={drink.id} className="your-menu-item">
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
                  ))}
                </div>
              )}

              {/* Mixer question — only if Full Bar is NOT active and drinks are selected */}
              {!isFullBarActive && selectedDrinks.length > 0 && extractedSpirits.length > 0 && (
                <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                  <div className="form-group">
                    <label className="form-label">
                      Would you like basic mixers for {extractedSpirits.join(', ')}?
                    </label>
                    <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
                      This includes things like tonic, soda, ginger beer, and juice for your signature drink spirits.
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
                    </div>
                  </div>
                </div>
              )}

              {/* Navigation buttons — only on Your Menu */}
              <div className="step-nav mt-2">
                {onBack ? (
                  <button className="btn btn-secondary" onClick={onBack}>Back</button>
                ) : <div />}
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  {isMocktailsActive && (
                    <button className="btn btn-secondary" onClick={onSkipMocktails}>
                      Skip Mocktails
                    </button>
                  )}
                  <button className="btn" onClick={onNext}>
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
                  <button
                    key={drink.id}
                    className={`drink-card-horizontal${isSelected ? ' selected' : ''}`}
                    onClick={() => toggleDrink(drink.id)}
                  >
                    <span className="drink-card-emoji">{drink.emoji}</span>
                    <div className="drink-card-info">
                      <span className="drink-card-name">{drink.name}</span>
                      <span className="drink-card-desc">{drink.description}</span>
                    </div>
                    <span className="drink-check-stylized">&#10003;</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
