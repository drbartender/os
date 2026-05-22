import React, { useState } from 'react';
import AddonTile from './AddonTile';

// Collapsible category accordion. First category open by default; open/close
// state is local and resets on step remount (acceptable).
export default function AddonAccordion({
  groups, form, setForm, toggleAddon, guestCount,
  glasswareRequirementMet, realGlasswareAddon,
  isIncludedByBundle, isUnavailableByBundle,
}) {
  const [openKeys, setOpenKeys] = useState(
    () => new Set(groups[0] ? [groups[0].key] : []),
  );

  const toggleKey = (key) => setOpenKeys(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="wz-accordion">
      {groups.map(group => {
        const open = openKeys.has(group.key);
        const count = group.addons.length;
        const selectedCount = group.addons.filter(
          a => form.addon_ids.includes(a.id) || isIncludedByBundle(a.slug),
        ).length;
        return (
          <div key={group.key} className={`wz-acc-row${open ? ' open' : ''}`}>
            <button type="button" className="wz-acc-head"
              aria-expanded={open} onClick={() => toggleKey(group.key)}>
              <span className="wz-acc-head-icon" aria-hidden="true">{group.glyph || '⚗'}</span>
              <span className="wz-acc-head-label">
                {group.label}
                <span className="wz-acc-meta"> · {group.blurb}</span>
              </span>
              {selectedCount > 0
                ? <span className="wz-acc-pill">{selectedCount} added</span>
                : <span className="wz-acc-count">{count} option{count !== 1 ? 's' : ''}</span>}
              <svg className="wz-acc-chev" viewBox="0 0 12 8" fill="none" aria-hidden="true">
                <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {open && (
              <div className="wz-acc-body">
                <div className="wz-acc-list">
                  {group.addons.map(addon => (
                    <AddonTile
                      key={addon.id}
                      addon={addon}
                      selected={form.addon_ids.includes(addon.id)}
                      included={isIncludedByBundle(addon.slug)}
                      unavailable={isUnavailableByBundle(addon.slug)}
                      onToggle={toggleAddon}
                      quantities={form.addon_quantities}
                      setForm={setForm}
                      syrupSelections={form.syrup_selections}
                      guestCount={guestCount}
                      glasswareRequirementMet={glasswareRequirementMet}
                      realGlasswareAddon={realGlasswareAddon}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
