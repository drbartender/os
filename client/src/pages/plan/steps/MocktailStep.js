import React, { useState } from 'react';
import MakeItYoursPanel from './MakeItYoursPanel';

export default function MocktailStep({
  selected = [],
  onChange,
  mocktails = [],
  categories = [],
  notes = '',
  onNotesChange,
  addOns = {},
  toggleAddOn,
  addonPricing = [],
  syrupSelections = [],
  onSyrupToggle,
  proposalSyrups = [],
  phase = 'refinement',
  skipGate = false,
  onNext,
  onBack,
}) {
  // Gate: ask if they want mocktails before showing the picker
  // Auto-show picker if they already have selections (returning to step) or skipGate is true
  const [wantsMocktails, setWantsMocktails] = useState(
    skipGate || selected.length > 0 ? true : null
  );
  const [activeTab, setActiveTab] = useState(categories[0]?.id || 'fruity-refreshing');
  const [lastBrowseTab, setLastBrowseTab] = useState(categories[0]?.id || 'fruity-refreshing');

  const handleTabChange = (tabKey) => {
    if (tabKey !== 'your-menu') setLastBrowseTab(tabKey);
    setActiveTab(tabKey);
  };

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
  const filteredDrinks = mocktails.filter(d => d.category_id === activeTab);

  const selectedDrinks = mocktails.filter(d => selected.includes(d.id));

  // Count selected per category
  const countForCategory = (catId) => {
    if (catId === 'your-menu') return selected.length;
    return mocktails.filter(d => d.category_id === catId && selected.includes(d.id)).length;
  };

  // Gate screen: ask if they want to see the mocktail picker
  if (wantsMocktails === null) {
    return (
      <div>
        <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
            Mocktails
          </h2>
          <p className="text-muted">
            Would you like to include non-alcoholic drinks at your event?
            Great for kids, designated drivers, or anyone who prefers to skip the spirits.
          </p>
        </div>

        <div className="vibe-grid">
          <button
            className="vibe-card"
            onClick={() => setWantsMocktails(true)}
          >
            <span className="vibe-emoji">{'\uD83E\uDDC3'}</span>
            <span className="vibe-label">Yes, show me the menu</span>
            <span className="vibe-desc">Browse our handcrafted mocktail selection.</span>
          </button>
          <button
            className="vibe-card"
            onClick={() => {
              // Clear any stale mocktail selections and skip
              if (selected.length > 0) onChange([]);
              if (notes) onNotesChange('');
              onNext();
            }}
          >
            <span className="vibe-emoji">{'\u274C'}</span>
            <span className="vibe-label">No thanks, skip mocktails</span>
            <span className="vibe-desc">No non-alcoholic drinks needed.</span>
          </button>
        </div>

        <div className="step-nav">
          {onBack ? (
            <button className="btn btn-secondary" onClick={onBack}>Back</button>
          ) : <div />}
          <div />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Mocktail Selection
        </h2>
        <p className="text-muted">
          Choose the non-alcoholic drinks you'd like at your event. Browse categories
          and tap to add them to Your Menu.
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
                Your Mocktails ({selectedDrinks.length} selected)
              </h3>
              {selectedDrinks.length === 0 ? (
                <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
                  No mocktails selected yet. Browse the categories to add your favorites!
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

              {/* Additional notes */}
              <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Any other mocktail preferences?</label>
                  <textarea
                    className="form-textarea"
                    rows={3}
                    placeholder="E.g., kid-friendly options, nothing too sweet, specific flavor preferences..."
                    value={notes}
                    onChange={(e) => onNotesChange && onNotesChange(e.target.value)}
                  />
                </div>
              </div>

              {/* Navigation — on Your Menu */}
              <div className="step-nav mt-2">
                <button className="btn btn-secondary" onClick={() => handleTabChange(lastBrowseTab)}>Back</button>
                <button className="btn btn-primary" onClick={onNext}>
                  Continue
                </button>
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
                      <span className="drink-check-stylized">&#10003;</span>
                    </button>
                    {isSelected && (
                      <MakeItYoursPanel
                        drinkId={drink.id}
                        drinkName={drink.name}
                        phase={phase}
                        addOns={addOns}
                        toggleAddOn={toggleAddOn}
                        addonPricing={addonPricing}
                        syrupSelections={syrupSelections}
                        onSyrupToggle={onSyrupToggle}
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
              {selected.length} mocktail{selected.length !== 1 ? 's' : ''} selected
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
