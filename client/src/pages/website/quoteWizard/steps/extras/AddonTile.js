import React, { useState } from 'react';
import { ADDON_ICONS } from '../../../../../data/addonCategories';
import { ADDON_TAGLINES, priceLabel } from '../../helpers';
import { isQuantityCapable } from '../../../../../utils/proposalRules';
import SyrupPicker from '../../../../../components/SyrupPicker';

// One add-on tile. The whole tile is the toggle control; the info chevron,
// quantity stepper, and syrup section stop propagation so they do not also
// toggle selection.
export default function AddonTile({
  addon, selected, included, unavailable, onToggle,
  quantities, setForm, syrupSelections,
  guestCount, glasswareRequirementMet, realGlasswareAddon,
}) {
  const [expanded, setExpanded] = useState(false);

  // Flavor Blaster: locked tile when the glassware requirement is not met.
  if (addon.slug === 'flavor-blaster-rental' && !glasswareRequirementMet) {
    const showGlassBtn = guestCount <= 100 && realGlasswareAddon;
    return (
      <div className="wz-tile wz-tile-locked">
        <div className="wz-tile-icon" aria-hidden="true">{ADDON_ICONS[addon.slug] || '✦'}</div>
        <div className="wz-tile-name">{addon.name}</div>
        <div className="wz-tile-locked-msg">
          Aromatic finishing bubbles need proper glassware to form and present
          correctly. Available with the real glassware upgrade.
        </div>
        <div className="wz-tile-unlock">
          {showGlassBtn && (
            <button type="button" className="btn btn-primary btn-sm"
              onClick={() => onToggle(realGlasswareAddon.id)}>
              Add Real Glassware
            </button>
          )}
          <button type="button"
            className={showGlassBtn ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
            onClick={() => setForm(f => ({ ...f, client_provides_glassware: true }))}>
            I'll provide my own
          </button>
        </div>
      </div>
    );
  }

  const isSyrup = addon.slug === 'handcrafted-syrups';
  const isLocked = included || unavailable;
  const hasDesc = !!addon.description;
  const hasQty = isQuantityCapable(addon);
  const q = quantities[addon.id] || 1;
  const cls = [
    'wz-tile',
    selected && !unavailable && 'selected',
    included && 'included',
    unavailable && 'unavailable',
    hasDesc && 'has-desc',
    expanded && 'expanded',
  ].filter(Boolean).join(' ');

  const setQty = (next) => setForm(f => ({
    ...f,
    addon_quantities: { ...f.addon_quantities, [addon.id]: next },
  }));

  return (
    <div
      className={cls}
      role="button"
      tabIndex={isLocked ? -1 : 0}
      aria-disabled={isLocked || undefined}
      aria-pressed={isLocked ? (included || undefined) : (selected && !unavailable)}
      onClick={() => !isLocked && onToggle(addon.id)}
      onKeyDown={(e) => {
        if (!isLocked && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onToggle(addon.id);
        }
      }}
    >
      <div className="wz-tile-icon" aria-hidden="true">{ADDON_ICONS[addon.slug] || '✦'}</div>
      <div className="wz-tile-name">{addon.name}</div>
      <div className="wz-tile-price">
        {included
          ? <span className="wz-pill-included">Included</span>
          : unavailable
            ? <span className="wz-pill-unavailable">Covered</span>
            : priceLabel(addon)}
      </div>
      {ADDON_TAGLINES[addon.slug] && (
        <div className="wz-tile-tagline">
          {unavailable
            ? 'Your bundle supersedes this, no need to add it.'
            : ADDON_TAGLINES[addon.slug]}
        </div>
      )}
      {hasDesc && (
        <button
          type="button"
          className={`wz-tile-info${expanded ? ' open' : ''}`}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          aria-expanded={expanded}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        >
          <svg width="11" height="7" viewBox="0 0 12 8" fill="none" aria-hidden="true">
            <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      {hasDesc && expanded && (
        <div className="wz-tile-desc" onClick={(e) => e.stopPropagation()}>
          {addon.description}
        </div>
      )}
      {hasQty && selected && !unavailable && (
        <div className="wz-tile-qty-row" onClick={(e) => e.stopPropagation()}>
          <span className="wz-tile-qty-label">How many?</span>
          <div className="wz-qty">
            <button type="button" aria-label="Decrease quantity"
              onClick={() => setQty(Math.max(1, q - 1))} disabled={q <= 1}>−</button>
            <span className="wz-qty-value">{q}</span>
            <button type="button" aria-label="Increase quantity"
              onClick={() => setQty(Math.min(10, q + 1))}>+</button>
          </div>
        </div>
      )}
      {isSyrup && selected && !unavailable && (
        <div className="wz-tile-syrup" onClick={(e) => e.stopPropagation()}>
          <p className="wz-tile-syrup-note">
            Choose your flavors now, or skip and pick them later at your Potion
            Planning consult.
          </p>
          <SyrupPicker
            selected={syrupSelections}
            onChange={(s) => setForm(f => ({ ...f, syrup_selections: s }))}
            compact
          />
        </div>
      )}
    </div>
  );
}
