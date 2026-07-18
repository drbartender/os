import React, { useState } from 'react';
import { SYRUPS } from '../../data/syrups';

// Recipe dossier sections, extracted from RecipeEditor to keep the editor under
// the file-size ratchet. These are presentational: all recipe state and
// persistence live in RecipeEditor; this file renders the Enhancements and the
// Flags & syrups sub-forms, shared by both the stacked (Recipes tab, design 1a)
// and tabbed (Add-recipe drawer, design 1b) layouts.

// The service-addon enhancements a drink can carry, with pitch labels and (for
// the smoke bubble) the bubble-flavor palette. Free-text slugs are still
// allowed via the custom row below; these four are the one-click knowns.
export const ENH_DEFS = [
  { slug: 'smoked-cocktail-kit', label: 'Smoked Cocktail', hint: 'Torch-smoked at the bar on demand' },
  { slug: 'flavor-blaster-rental', label: 'Smoke Bubble', hint: 'Aromatic bubble garnish, needs real glassware', flavors: ['wood', 'lemon', 'apple', 'coffee'] },
  { slug: 'carbonated-cocktails', label: 'Sparkling Upgrade', hint: 'Fresh carbonation live at the bar' },
  { slug: 'house-made-ginger-beer', label: 'Craft Ginger Beer', hint: 'Hand-pressed ginger, citrus, and cane sugar' },
];
const KNOWN_SLUGS = new Set(ENH_DEFS.map((d) => d.slug));

// One enhancement, known or custom. `row` is the stored assignment
// ({ slug, pitch, flavors? }) or undefined when the enhancement is off.
function EnhancementRow({ slug, label, hint, flavorPalette, row, onToggle, onPitch, onToggleFlavor, onRemove }) {
  const on = !!row;
  return (
    <div className="potions-enh-row">
      <label className="potions-enh-toggle">
        <input type="checkbox" checked={on} onChange={() => onToggle(slug)} />
        <span className="potions-enh-name">{label}</span>
        {onRemove && (
          <button type="button" className="btn btn-danger btn-sm"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(slug); }}
            title="Remove enhancement" aria-label={`Remove ${label}`}>×</button>
        )}
      </label>
      <div className="potions-enh-body">
        {on ? (
          <>
            <input className="input potions-cell" value={row.pitch || ''} maxLength={300}
              onChange={(e) => onPitch(slug, e.target.value)} placeholder="Per-drink pitch copy" aria-label={`${label} pitch copy`} />
            {flavorPalette && (
              <div className="potions-enh-flavors">
                <span className="potions-enh-flavors-label">Bubble flavors</span>
                {flavorPalette.map((fl) => {
                  const active = (row.flavors || []).includes(fl);
                  return (
                    <button type="button" key={fl} className={`potions-flavor-chip ${active ? 'active' : ''}`}
                      onClick={() => onToggleFlavor(slug, fl)} aria-pressed={active}>{fl}</button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <span className="text-muted text-small">{hint}</span>
        )}
      </div>
    </div>
  );
}

// enhancements: array of { slug, pitch, flavors? }. Renders the four known
// enhancements as one-click rows, any custom (migrated / free-text) slugs after
// them, and a free-text add for anything else.
export function EnhancementsSection({ enhancements, onToggle, onPitch, onToggleFlavor, onAddCustom, onRemoveCustom }) {
  const [customSlug, setCustomSlug] = useState('');
  const list = enhancements || [];
  const bySlug = {};
  for (const e of list) bySlug[e.slug] = e;
  const customRows = list.filter((e) => !KNOWN_SLUGS.has(e.slug));

  const addCustom = () => {
    const slug = customSlug.trim();
    if (!slug) return;
    onAddCustom(slug);
    setCustomSlug('');
  };

  return (
    <div className="potions-enh-section">
      {ENH_DEFS.map((def) => (
        <EnhancementRow key={def.slug} slug={def.slug} label={def.label} hint={def.hint} flavorPalette={def.flavors}
          row={bySlug[def.slug]} onToggle={onToggle} onPitch={onPitch} onToggleFlavor={onToggleFlavor} />
      ))}
      {customRows.map((e) => (
        <EnhancementRow key={e.slug} slug={e.slug} label={e.slug} hint="" row={e}
          onToggle={onToggle} onPitch={onPitch} onToggleFlavor={onToggleFlavor} onRemove={onRemoveCustom} />
      ))}
      <div className="potions-enh-add">
        <input className="input potions-cell" value={customSlug} maxLength={100}
          onChange={(e) => setCustomSlug(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); addCustom(); } }}
          placeholder="Other addon slug (e.g. specialty-vermouths)" aria-label="Custom enhancement slug" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={addCustom}
          disabled={!customSlug.trim() || list.length >= 10}>Add enhancement</button>
      </div>
    </div>
  );
}

// One linked housemade syrup (spec 4.1: one reference, not a matrix) plus the
// batchable / hosted-visible flags. `syrupId` is '' when none is linked.
export function FlagsSyrupsSection({ syrupId, onSyrup, batchable, onBatchable, hostedVisible, onHostedVisible }) {
  return (
    <div className="potions-flags-section">
      <div className="potions-flags-syrup">
        <span className="potions-flags-label">Housemade syrup</span>
        <select className="select potions-cell potions-syrup-select" value={syrupId || ''}
          onChange={(e) => onSyrup(e.target.value)} aria-label="Linked housemade syrup">
          <option value="">No linked syrup</option>
          {SYRUPS.map((sy) => <option key={sy.id} value={sy.id}>{sy.name}</option>)}
        </select>
        <span className="text-muted text-small">The linked syrup becomes a Lab upsell (+$30).</span>
      </div>
      <div className="potions-flags-row">
        <span className="potions-flags-label">Flags</span>
        <label className="potions-flag">
          <input type="checkbox" checked={!!batchable} onChange={(e) => onBatchable(e.target.checked)} />Batchable
        </label>
        <label className="potions-flag">
          <input type="checkbox" checked={hostedVisible !== false} onChange={(e) => onHostedVisible(e.target.checked)} />Hosted-visible
        </label>
      </div>
    </div>
  );
}
