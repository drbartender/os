import React from 'react';

const FLAVORS = [
  { key: 'fruity', label: 'Fruity' },
  { key: 'citrusy', label: 'Citrusy' },
  { key: 'herbal', label: 'Herbal' },
  { key: 'smoky', label: 'Smoky' },
  { key: 'sweet', label: 'Sweet' },
  { key: 'spicy', label: 'Spicy' },
  { key: 'classic', label: 'Classic' },
  { key: 'tropical', label: 'Tropical' },
];

export default function FlavorDirectionStep({ selected = [], onChange, dreamNotes = '', onDreamNotesChange }) {
  const toggleFlavor = (key) => {
    if (selected.includes(key)) {
      onChange(selected.filter(f => f !== key));
    } else {
      onChange([...selected, key]);
    }
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          What flavors excite you?
        </h2>
        <p className="text-muted">
          Pick as many as you like — this helps us point you toward the right drinks.
        </p>
      </div>

      <div className="flavor-chip-grid">
        {FLAVORS.map(flavor => (
          <button
            key={flavor.key}
            className={`flavor-chip${selected.includes(flavor.key) ? ' selected' : ''}`}
            onClick={() => toggleFlavor(flavor.key)}
            aria-pressed={selected.includes(flavor.key)}
          >
            {flavor.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="form-group">
          <label className="form-label">Describe your dream drink (optional)</label>
          <textarea
            className="form-textarea"
            rows={3}
            placeholder="E.g., something refreshing with a kick, or a smoky whiskey cocktail with a sweet finish..."
            value={dreamNotes}
            onChange={(e) => onDreamNotesChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
