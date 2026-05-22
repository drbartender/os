import React from 'react';
import { ADDON_TAGLINES, priceLabel } from '../../helpers';
import { BYOB_BUNDLE_SLUGS, BUNDLE_INCLUDED } from '../../../../../utils/proposalRules';

// Decorative per-bundle glyphs and foot labels (lightest to fullest).
const BUNDLE_GLYPH = {
  'the-foundation': '⚗',
  'the-formula': '⚛',
  'the-full-compound': '⚜',
};
const BUNDLE_FOOT = {
  'the-formula': 'The middle',
  'the-full-compound': 'The works',
};

// The 3 BYOB bundles, hoisted out of the a-la-carte list into a featured band.
// No bundle is pre-selected; selecting a card routes through the wizard's
// toggleAddon, which runs the existing bundle mutex + include/unavailable rules.
export default function BundlePicker({ bundles, nameBySlug, selectedIds, onToggle }) {
  const ordered = BYOB_BUNDLE_SLUGS
    .map(slug => bundles.find(b => b.slug === slug))
    .filter(Boolean);
  const selected = ordered.find(b => selectedIds.includes(b.id)) || null;

  return (
    <div className="wz-bundle-band">
      <div className="wz-bundle-band-head">
        <div>
          <div className="wz-bundle-kicker">Lab notes · Where most BYOB events start</div>
          <div className="wz-bundle-band-title">Pick a starter recipe.</div>
        </div>
        {selected ? (
          <button type="button" className="wz-link-button" onClick={() => onToggle(selected.id)}>
            Skip the bundle ×
          </button>
        ) : (
          <span className="wz-bundle-band-hint">Or skip and go à la carte ↓</span>
        )}
      </div>
      <div className="wz-bundle-grid">
        {ordered.map(b => {
          const isSel = !!selected && selected.id === b.id;
          const popular = b.slug === 'the-foundation';
          const included = BUNDLE_INCLUDED[b.slug] || [];
          return (
            <button
              key={b.id}
              type="button"
              className={`wz-bundle${isSel ? ' selected' : ''}${popular ? ' popular' : ''}`}
              onClick={() => onToggle(b.id)}
              aria-pressed={isSel}
            >
              <div className="wz-bundle-head">
                <div>
                  <div className="wz-bundle-name">{b.name}</div>
                  <div className="wz-bundle-tag">{ADDON_TAGLINES[b.slug] || ''}</div>
                </div>
                <span className="wz-bundle-glyph" aria-hidden="true">
                  {BUNDLE_GLYPH[b.slug] || '⚗'}
                </span>
              </div>
              <ul>
                {included.map(slug => (
                  <li key={slug}>{nameBySlug[slug] || slug}</li>
                ))}
              </ul>
              <div className="wz-bundle-foot">
                <span>{popular ? 'Most picked' : (BUNDLE_FOOT[b.slug] || '')}</span>
                <strong>{priceLabel(b)}</strong>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
