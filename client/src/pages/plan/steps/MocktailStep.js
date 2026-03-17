import React, { useState } from 'react';

export default function MocktailStep({
  selected = [],
  onChange,
  mocktails = [],
  categories = [],
  notes = '',
  onNotesChange,
  onNext,
  onBack,
}) {
  const [activeTab, setActiveTab] = useState(categories[0]?.id || 'fruity-refreshing');

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

              {/* Navigation — only on Your Menu */}
              <div className="step-nav mt-2">
                {onBack ? (
                  <button className="btn btn-secondary" onClick={onBack}>Back</button>
                ) : <div />}
                <button className="btn" onClick={onNext}>
                  Continue
                </button>
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
