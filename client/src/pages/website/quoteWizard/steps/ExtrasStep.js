import React from 'react';
import SyrupPicker from '../../../../components/SyrupPicker';
import { ADDON_ICONS } from '../../../../data/addonCategories';
import { ADDON_TAGLINES } from '../helpers';

export default function ExtrasStep({
  form,
  setForm,
  update,
  groupedAddons,
  toggleAddon,
  guestCount,
  glasswareRequirementMet,
  realGlasswareAddon,
  expandedAddons,
  toggleExpand,
  isIncludedByBundle,
  isUnavailableByBundle,
}) {
  return (
    <div className="wz-card">
      <h3>Customize your experience</h3>
      <p style={{ fontSize: '0.95rem', marginBottom: '1.25rem', color: 'var(--deep-brown)', opacity: 0.7 }}>
        Add extras to make your event unforgettable. All selections are optional.
      </p>
      {groupedAddons.length > 0 ? (
        groupedAddons.map(group => (
          <div key={group.key} className="wz-addon-category">
            <h4 className="wz-addon-category-heading">
              <span className="wz-addon-category-icon">{group.icon}</span>
              {group.label}
            </h4>
            {group.key === 'byob_support' && (
              <p className="wz-addon-category-note">Only available with The Core Reaction package</p>
            )}

            {group.addons.length > 0 && (
              <div className="wz-addon-list">
                {group.addons.map(addon => {
                  const isSyrupAddon = addon.slug === 'handcrafted-syrups';
                  const hasQty = addon.slug === 'banquet-server' || addon.slug === 'barback' || addon.slug === 'pre-batched-mocktail' || addon.slug === 'additional-bartender';
                  const isSelected = form.addon_ids.includes(addon.id);
                  const isIncluded = isIncludedByBundle(addon.slug);
                  const isUnavailable = isUnavailableByBundle(addon.slug);
                  const displayChecked = isIncluded || (isSelected && !isUnavailable);
                  const isBlocked = isIncluded || isUnavailable;
                  const isExpanded = (isSelected && !isUnavailable) || expandedAddons.has(addon.id);
                  const isDependent = !!addon.requires_addon_slug;
                  const addonQty = form.addon_quantities[addon.id] || 1;

                  const priceLabel = (() => {
                    if (isSyrupAddon) return '$30/bottle · 3 for $75';
                    switch (addon.billing_type) {
                      case 'per_guest': return `$${Number(addon.rate)}/guest`;
                      case 'per_guest_timed': return `$${Number(addon.rate)}/guest`;
                      case 'per_hour': return `$${Number(addon.rate)}/hr`;
                      case 'per_staff': return `$${Number(addon.rate)}/staff member`;
                      case 'per_100_guests': return `$${Number(addon.rate)}/100 guests`;
                      case 'flat': return `$${Number(addon.rate)}`;
                      default: return `$${Number(addon.rate)}`;
                    }
                  })();

                  // Flavor Blaster: locked tile when glassware requirement not met
                  if (addon.slug === 'flavor-blaster-rental' && !glasswareRequirementMet) {
                    return (
                      <div key={addon.id} className="wz-addon-option locked">
                        <div className="wz-addon-row">
                          <span className="wz-addon-icon">{ADDON_ICONS[addon.slug] || group.icon}</span>
                          <div className="wz-addon-content">
                            <div className="wz-addon-name">{addon.name}</div>
                            <div className="wz-addon-locked-message">
                              Aromatic finishing bubbles require proper glassware to form and present correctly. This enhancement is available with our real glassware upgrade.
                            </div>
                          </div>
                        </div>
                        <div className="wz-addon-unlock-actions">
                          {guestCount <= 100 && realGlasswareAddon && (
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => toggleAddon(realGlasswareAddon.id)}>
                              Add Real Glassware
                            </button>
                          )}
                          <button
                            type="button"
                            className={guestCount <= 100 && realGlasswareAddon ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                            onClick={() => setForm(f => ({ ...f, client_provides_glassware: true }))}
                          >
                            I'll provide my own
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={addon.id}
                      className={`wz-addon-option${isSelected && !isUnavailable ? ' selected' : ''}${isIncluded ? ' included' : ''}${isUnavailable ? ' unavailable' : ''}${isExpanded ? ' expanded' : ''}${isDependent ? ' dependent' : ''}`}
                    >
                      <div className="wz-addon-row" onClick={() => toggleAddon(addon.id)}>
                        <input
                          type="checkbox"
                          checked={displayChecked}
                          disabled={isBlocked}
                          onChange={() => toggleAddon(addon.id)}
                          onClick={e => e.stopPropagation()}
                        />
                        <span className="wz-addon-icon">{ADDON_ICONS[addon.slug] || group.icon}</span>
                        <div className="wz-addon-content">
                          <div className="wz-addon-name">{addon.name}</div>
                          {ADDON_TAGLINES[addon.slug] && !isUnavailable && (
                            <div className="wz-addon-tagline">{ADDON_TAGLINES[addon.slug]}</div>
                          )}
                          {isIncluded && <div className="wz-addon-included-label">INCLUDED</div>}
                          {!isIncluded && !isUnavailable && <div className="wz-addon-price">{priceLabel}</div>}
                        </div>
                        {(addon.description || isSyrupAddon) && (
                          <button
                            type="button"
                            className={`wz-addon-expand-btn${isExpanded ? ' open' : ''}`}
                            onClick={e => { e.stopPropagation(); toggleExpand(addon.id); }}
                            aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                          >
                            <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
                              <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                        )}
                      </div>
                      {/* Quantity adjuster for banquet server / barback */}
                      {hasQty && isSelected && (
                        <div className="wz-addon-qty">
                          <span>How many?</span>
                          <div className="wz-addon-qty-controls">
                            <button type="button" onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, addon_quantities: { ...f.addon_quantities, [addon.id]: Math.max(1, addonQty - 1) } })); }} disabled={addonQty <= 1}>-</button>
                            <span className="wz-addon-qty-value">{addonQty}</span>
                            <button type="button" onClick={e => { e.stopPropagation(); setForm(f => ({ ...f, addon_quantities: { ...f.addon_quantities, [addon.id]: Math.min(10, addonQty + 1) } })); }}>+</button>
                          </div>
                        </div>
                      )}
                      {addon.description && isExpanded && !isSyrupAddon && (
                        <div className="wz-addon-desc">{addon.description}</div>
                      )}
                      {/* Syrup picker — shown when syrup add-on is selected or expanded */}
                      {isSyrupAddon && isExpanded && (
                        <div className="wz-addon-syrup-section">
                          {isSelected ? (
                            <>
                              <p className="wz-syrup-pick-note">
                                Choose your flavors now, or skip and pick them later during your consultation.
                              </p>
                              <SyrupPicker
                                selected={form.syrup_selections}
                                onChange={(syrups) => update('syrup_selections', syrups)}
                                compact
                              />
                            </>
                          ) : (
                            <div className="wz-addon-desc">
                              {addon.description || 'Housemade cocktail syrups crafted with real ingredients. Choose from over 25 flavors. Each 750ml bottle makes 30-40 cocktails.'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))
      ) : (
        <p className="wz-no-addons">No add-ons available for this package. You can skip this step.</p>
      )}
    </div>
  );
}
