import React from 'react';

/**
 * The Lab's two shelf sections.
 *
 * DrinkShelves — "Your drinks, enhanced": one shelf per submitted drink,
 * offering its dossier enhancements (per-drink addons; tapping adds the addon
 * with this drink on its drinks[] list) and its housemade-syrup upgrade
 * (labSyrupSelections). A menu with nothing to offer gets the full-strength
 * empty state (labState 6).
 *
 * EventShelf — "For the event": champagne toast (serving style + toast time,
 * coupe upgrade nested), real glassware, and the hosted NA add-ons. Which
 * cards render is driven by the server's event_addon_slugs ∩ addon_pricing.
 */

const money = (n) => `$${Number(n || 0).toLocaleString()}`;

function toggleDrinkOnAddon(additions, slug, drinkName) {
  const existing = additions.addOns[slug];
  const drinks = existing?.drinks || [];
  const has = drinks.includes(drinkName);
  const nextDrinks = has ? drinks.filter((d) => d !== drinkName) : [...drinks, drinkName];
  const addOns = { ...additions.addOns };
  if (nextDrinks.length === 0) {
    delete addOns[slug];
  } else {
    addOns[slug] = { ...(existing || {}), drinks: nextDrinks };
  }
  return { ...additions, addOns };
}

export function DrinkShelves({ drinks, addonPricing, additions, priceOf, locked, onChange }) {
  const addonBySlug = new Map((addonPricing || []).map((a) => [a.slug, a]));
  const enhanceable = (drinks || []).filter(
    (d) => d.syrup || (d.enhancements || []).some((e) => addonBySlug.has(e.slug))
  );

  return (
    <section className="pp2-lab-section">
      <h2>Your drinks, enhanced</h2>
      {enhanceable.length === 0 ? (
        <div className="pp2-lab-empty">Your bar is already at full strength.</div>
      ) : (
        enhanceable.map((drink) => (
          <div className="pp2-lab-shelf" key={`${drink.table}-${drink.id}`}>
            <div className="pp2-lab-shelf-head">
              <span className="pp2-lab-drink-emoji">{drink.emoji}</span>
              <span className="pp2-lab-drink-name">{drink.name}</span>
            </div>
            <div className="pp2-lab-cards">
              {(drink.enhancements || []).map((enh) => {
                const addon = addonBySlug.get(enh.slug);
                if (!addon) return null;
                const entry = additions.addOns[enh.slug];
                const active = !!entry && (entry.drinks || []).includes(drink.name);
                const flavorChoices = Array.isArray(enh.flavors) ? enh.flavors : [];
                const chosenFlavor = entry?.flavors?.[drink.name] || '';
                return (
                  <div className={`pp2-lab-card${active ? ' active' : ''}`} key={enh.slug}>
                    <div className="pp2-lab-card-body">
                      <div className="pp2-lab-card-title">{addon.name}</div>
                      {enh.pitch && <div className="pp2-lab-card-pitch">{enh.pitch}</div>}
                      {active && flavorChoices.length > 0 && (
                        <div className="pp2-lab-flavors">
                          {flavorChoices.map((f) => (
                            <button
                              key={f}
                              type="button"
                              disabled={locked}
                              className={`pp2-lab-chip${chosenFlavor === f ? ' active' : ''}`}
                              onClick={() => onChange((prev) => {
                                const e = prev.addOns[enh.slug] || {};
                                return {
                                  ...prev,
                                  addOns: {
                                    ...prev.addOns,
                                    [enh.slug]: { ...e, flavors: { ...(e.flavors || {}), [drink.name]: f } },
                                  },
                                };
                              })}
                            >
                              {f}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="pp2-lab-add"
                      disabled={locked}
                      onClick={() => onChange((prev) => toggleDrinkOnAddon(prev, enh.slug, drink.name))}
                    >
                      {active ? 'Added ✓' : `Add · ${money(priceOf(enh.slug))}`}
                    </button>
                  </div>
                );
              })}
              {drink.syrup && (
                <div className={`pp2-lab-card${additions.labSyrupSelections[drink.id] ? ' active' : ''}`}>
                  <div className="pp2-lab-card-body">
                    <div className="pp2-lab-card-title">Housemade {drink.syrup.name} syrup</div>
                    <div className="pp2-lab-card-pitch">
                      Made in our lab for this drink. We bring it; it comes off your shopping list.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pp2-lab-add"
                    disabled={locked}
                    onClick={() => onChange((prev) => {
                      const labSyrupSelections = { ...prev.labSyrupSelections };
                      if (labSyrupSelections[drink.id]) delete labSyrupSelections[drink.id];
                      else labSyrupSelections[drink.id] = [drink.syrup.id];
                      return { ...prev, labSyrupSelections };
                    })}
                  >
                    {additions.labSyrupSelections[drink.id] ? 'Added ✓' : `Add · ${money(drink.syrup.price)}`}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

const SERVING_STYLES = ['Passed on trays', 'Poured at the bar'];

export function EventShelf({ lab, additions, priceOf, locked, onChange }) {
  const addonBySlug = new Map((lab.addon_pricing || []).map((a) => [a.slug, a]));
  const slugs = (lab.event_addon_slugs || []).filter((s) => addonBySlug.has(s));
  if (slugs.length === 0) return null;

  const toastOn = !!additions.addOns['champagne-toast'];
  const toastEntry = additions.addOns['champagne-toast'] || {};
  const coupeAvailable = (lab.guest_count || 0) <= 100;
  // Smoke-bubble note on glassware, per canvas: bubbles need real glass.
  const bubblesPicked = Object.keys(additions.addOns).some((s) => /bubble/i.test(s)) ||
    (lab.drinks || []).some((d) => (d.enhancements || []).some((e) => /bubble/i.test(e.slug) && additions.addOns[e.slug]));

  const simpleToggle = (slug) => onChange((prev) => {
    const addOns = { ...prev.addOns };
    if (addOns[slug]) {
      delete addOns[slug];
      // The coupe upgrade only exists in service of the toast; removing the
      // toast must remove it too or it keeps billing with no visible control.
      if (slug === 'champagne-toast') delete addOns['champagne-coupe-upgrade'];
    } else {
      addOns[slug] = {};
    }
    return { ...prev, addOns };
  });

  const setToastMeta = (field, value) => onChange((prev) => ({
    ...prev,
    addOns: { ...prev.addOns, 'champagne-toast': { ...(prev.addOns['champagne-toast'] || {}), [field]: value } },
  }));

  const card = (slug, pitch, extra = null) => {
    const addon = addonBySlug.get(slug);
    if (!addon) return null;
    const active = !!additions.addOns[slug];
    return (
      <div className={`pp2-lab-card${active ? ' active' : ''}`} key={slug}>
        <div className="pp2-lab-card-body">
          <div className="pp2-lab-card-title">{addon.name}</div>
          <div className="pp2-lab-card-pitch">{pitch || addon.description}</div>
          {extra}
        </div>
        <button type="button" className="pp2-lab-add" disabled={locked} onClick={() => simpleToggle(slug)}>
          {active ? 'Added ✓' : `Add · ${money(priceOf(slug))}`}
        </button>
      </div>
    );
  };

  return (
    <section className="pp2-lab-section">
      <h2>For the event</h2>
      <div className="pp2-lab-cards">
        {slugs.includes('champagne-toast') && card(
          'champagne-toast',
          'Poured and ready at the moment that matters. We keep it classy.',
          toastOn && (
            <div className="pp2-lab-toast-config">
              <label>
                How should it be served?
                <select
                  value={toastEntry.servingStyle || ''}
                  disabled={locked}
                  onChange={(e) => setToastMeta('servingStyle', e.target.value)}
                >
                  <option value="">Choose…</option>
                  {SERVING_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label>
                When is the toast?
                <input
                  type="text"
                  placeholder="e.g. 8:30 PM, after speeches"
                  value={toastEntry.toastTime || ''}
                  disabled={locked}
                  onChange={(e) => setToastMeta('toastTime', e.target.value)}
                />
              </label>
            </div>
          )
        )}
        {slugs.includes('champagne-coupe-upgrade') && toastOn && coupeAvailable && card(
          'champagne-coupe-upgrade',
          'Real coupe glasses are available for events up to 100 guests.'
        )}
        {slugs.includes('real-glassware') && card(
          'real-glassware',
          'Actual glass in hand instead of premium plastic. The photos will thank you.',
          bubblesPicked && !additions.addOns['real-glassware'] && (
            <div className="pp2-lab-note">Required by your smoke bubbles</div>
          )
        )}
        {slugs.includes('non-alcoholic-beer') && card(
          'non-alcoholic-beer',
          'Athletic Brewing on ice for the guests who want a beer in hand without the proof.'
        )}
        {slugs.includes('soft-drink-addon') && card(
          'soft-drink-addon',
          "Ginger ale, cola, and lemon lime, stocked for the guests who aren't drinking at all."
        )}
        {slugs.includes('zero-proof-spirits') && card(
          'zero-proof-spirits',
          'Zero-proof spirits behind the bar, so the cocktail list works without the alcohol.'
        )}
      </div>
    </section>
  );
}
