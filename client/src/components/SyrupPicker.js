import React, { useState } from 'react';
import {
  SYRUPS,
  SYRUP_CATEGORIES,
  SYRUP_PRICE_SINGLE,
  SYRUP_PRICE_3PACK,
  calculateSyrupCost,
} from '../data/syrups';

/**
 * SyrupPicker — reusable syrup selection component.
 *
 * Props:
 *   selected       — array of syrup IDs currently selected
 *   onChange        — (newSelected) => void
 *   recommended    — optional array of syrup IDs to highlight (from drink mapping)
 *   compact        — if true, uses a more compact layout (for embedding in wizard steps)
 */
export default function SyrupPicker({ selected = [], onChange, recommended = [], compact = false }) {
  const [activeCategory, setActiveCategory] = useState('all');

  const toggleSyrup = (id) => {
    if (selected.includes(id)) {
      onChange(selected.filter(s => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const filtered = activeCategory === 'all'
    ? SYRUPS
    : SYRUPS.filter(s => s.category === activeCategory);

  const cost = calculateSyrupCost(selected.length);

  // Sort: recommended first, then alphabetical
  const recSet = new Set(recommended);
  const sorted = [...filtered].sort((a, b) => {
    const aRec = recSet.has(a.id) ? 0 : 1;
    const bRec = recSet.has(b.id) ? 0 : 1;
    if (aRec !== bRec) return aRec - bRec;
    return a.name.localeCompare(b.name);
  });

  const categoryTabs = [
    { key: 'all', label: 'All' },
    ...SYRUP_CATEGORIES,
  ];

  return (
    <div className="syrup-picker">
      {/* Pricing banner */}
      <div className="syrup-pricing-banner">
        <span>${SYRUP_PRICE_SINGLE}/bottle</span>
        <span className="syrup-pricing-divider">|</span>
        <span className="syrup-pricing-deal">3 for ${SYRUP_PRICE_3PACK}</span>
      </div>

      {/* Category tabs */}
      <div className="syrup-category-tabs">
        {categoryTabs.map(cat => (
          <button
            key={cat.key}
            className={`syrup-cat-tab${activeCategory === cat.key ? ' active' : ''}`}
            onClick={() => setActiveCategory(cat.key)}
          >
            {cat.label}
            {cat.key !== 'all' && (() => {
              const count = selected.filter(id => SYRUPS.find(s => s.id === id)?.category === cat.key).length;
              return count > 0 ? <span className="syrup-cat-count">{count}</span> : null;
            })()}
          </button>
        ))}
      </div>

      {/* Syrup grid */}
      <div className={`syrup-grid${compact ? ' syrup-grid-compact' : ''}`}>
        {sorted.map(syrup => {
          const isSelected = selected.includes(syrup.id);
          const isRecommended = recSet.has(syrup.id);
          return (
            <button
              key={syrup.id}
              className={`syrup-chip${isSelected ? ' selected' : ''}${isRecommended ? ' recommended' : ''}`}
              onClick={() => toggleSyrup(syrup.id)}
            >
              <span className="syrup-chip-name">{syrup.name}</span>
              {syrup.seasonal && <span className="syrup-seasonal-tag">Seasonal</span>}
              {isRecommended && !isSelected && <span className="syrup-rec-tag">Recommended</span>}
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

      {/* Selection summary */}
      {selected.length > 0 && (
        <div className="syrup-summary">
          <div className="syrup-summary-count">
            {selected.length} syrup{selected.length !== 1 ? 's' : ''} selected
          </div>
          <div className="syrup-summary-cost">
            {cost.packs > 0 && (
              <span>{cost.packs} three-pack{cost.packs !== 1 ? 's' : ''}</span>
            )}
            {cost.packs > 0 && cost.singles > 0 && <span> + </span>}
            {cost.singles > 0 && (
              <span>{cost.singles} single{cost.singles !== 1 ? 's' : ''}</span>
            )}
            <span className="syrup-summary-total"> = ${cost.total}</span>
          </div>
          {/* Nudge toward 3-pack if close */}
          {cost.singles > 0 && (
            <div className="syrup-pack-nudge">
              Add {3 - cost.singles} more for the 3-pack discount (save ${3 * SYRUP_PRICE_SINGLE - SYRUP_PRICE_3PACK})
            </div>
          )}
        </div>
      )}
    </div>
  );
}
