import React from 'react';
import { BYOB_BUNDLE_SLUGS } from '../../../../utils/proposalRules';
import BundlePicker from './extras/BundlePicker';
import AddonAccordion from './extras/AddonAccordion';

// Extras step: featured bundle band (BYOB only) + a-la-carte category accordion.
// All add-on rules live in proposalRules.js and run through toggleAddon; this
// component only arranges and presents.
export default function ExtrasStep({
  form, setForm, addons, groupedAddons, toggleAddon, guestCount,
  glasswareRequirementMet, realGlasswareAddon,
  isIncludedByBundle, isUnavailableByBundle, onSkipExtras, stepRoman,
}) {
  const isBundle = (a) => BYOB_BUNDLE_SLUGS.includes(a.slug);
  const bundles = groupedAddons.flatMap(g => g.addons).filter(isBundle);
  // Name map for bundle "included items": built from the full addons list so it
  // resolves even slugs that filterAddons hid from the visible set.
  const nameBySlug = Object.fromEntries((addons || []).map(a => [a.slug, a.name]));
  const accordionGroups = groupedAddons
    .map(g => ({ ...g, addons: g.addons.filter(a => !isBundle(a)) }))
    .filter(g => g.addons.length > 0);

  return (
    <div className="wz-card">
      <div className="wz-step-eyebrow">Step {stepRoman} · Apothecary Add-Ons</div>
      <div className="wz-title-row">
        <h3>Customize your experience.</h3>
        <button type="button" className="wz-skip-inline" onClick={onSkipExtras}>
          Skip this step →
        </button>
      </div>
      <p className="wz-reassure">
        <span className="wz-reassure-glyph" aria-hidden="true">⚗</span>
        <span>
          Every choice is optional, and <em>nothing here is final</em>. You can
          swap, add, or remove anything later, even after you book, during your
          Potion Planning consult.
        </span>
      </p>

      {bundles.length > 0 && (
        <BundlePicker
          bundles={bundles}
          nameBySlug={nameBySlug}
          selectedIds={form.addon_ids}
          onToggle={toggleAddon}
        />
      )}

      {accordionGroups.length > 0 ? (
        <div className="wz-acla">
          <div className="divider-ornate wz-acla-divider"><span>à la carte</span></div>
          <p className="wz-acla-lede">
            Add anything else your event needs, beyond what your bundle covers.
          </p>
          <AddonAccordion
            groups={accordionGroups}
            form={form}
            setForm={setForm}
            toggleAddon={toggleAddon}
            guestCount={guestCount}
            glasswareRequirementMet={glasswareRequirementMet}
            realGlasswareAddon={realGlasswareAddon}
            isIncludedByBundle={isIncludedByBundle}
            isUnavailableByBundle={isUnavailableByBundle}
          />
        </div>
      ) : bundles.length === 0 ? (
        <p className="wz-no-addons">
          No add-ons available for this package. You can skip this step.
        </p>
      ) : null}
    </div>
  );
}
