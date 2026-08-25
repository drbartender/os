import React, { useState } from 'react';
import { AddonQtyStepper } from '../../../components/AddonControls';
import SyrupPicker from '../../../components/SyrupPicker';
import { isQuantityCapable } from '../../../utils/proposalRules';
import { isTimedPerGuestAddon, timedPerGuestRateLabel } from '../../../utils/addonRateLabel';

// Split the catalog into the loose remainder and the two folds. Exported so
// the predicates live in ONE place: `hosted` is the same test the money code
// runs (`pkgIsHosted` in ProposalEditorForm). bar_type is the only trustworthy
// class signal — the live class rows carry category 'byob' even though the
// schema comment says they seed as 'hosted', so keying on category would file
// every class under the wrong group.
export function partitionPackages(packages) {
  const loose = [], hosted = [], classes = [];
  for (const pkg of packages) {
    if (pkg.bar_type === 'class') classes.push(pkg);
    else if (pkg.pricing_type === 'per_guest') hosted.push(pkg);
    else loose.push(pkg);
  }
  return { loose, hosted, classes };
}

// One package row. Markup moved verbatim out of the old flat list so a folded
// card and a loose card stay pixel-identical.
function PackageCard({ pkg, checked, update }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
      border: checked ? '1px solid var(--ink-1)' : '1px solid var(--line-1)',
      background: checked ? 'var(--bg-2)' : 'transparent',
    }}>
      <input type="radio" name="edit-package" value={pkg.id} checked={checked}
        onChange={(e) => {
          update('package_id', e.target.value);
          update('addon_ids', []);
          update('addon_variants', {});
        }}
        style={{ marginTop: 3 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{pkg.name}</div>
        {pkg.description && <div className="tiny muted" style={{ marginTop: 2 }}>{pkg.description}</div>}
        <div className="tiny muted" style={{ marginTop: 4 }}>
          {pkg.pricing_type === 'per_guest' ? (
            <>
              ${Number(pkg.base_rate_4hr)}/guest (50+)
              {pkg.base_rate_4hr_small && <> · ${Number(pkg.base_rate_4hr_small)}/guest ({'<'}50)</>}
              {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/guest/hr extra</>}
            </>
          ) : (
            <>
              {pkg.base_rate_3hr && <>${Number(pkg.base_rate_3hr)}/3hr · </>}
              {pkg.base_rate_4hr && <>${Number(pkg.base_rate_4hr)}/4hr</>}
              {pkg.extra_hour_rate && <> · +${Number(pkg.extra_hour_rate)}/hr extra</>}
            </>
          )}
        </div>
      </div>
    </label>
  );
}

// A collapsed fold UNMOUNTS its radios. That is safe because editForm
// .package_id is the source of truth and every input is controlled — the DOM
// never holds a selection the form state does not. The header carries the
// selected name so a shut fold still tells you what the proposal is on.
function PackageGroup({ id, label, packages, checkedId, open, onToggle, update }) {
  const selected = packages.find(p => p.id === checkedId);
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
          border: '1px solid var(--line-1)', background: 'transparent',
          color: 'var(--ink-3)', font: 'inherit', fontSize: 12.5, textAlign: 'left',
        }}>
        <span aria-hidden="true" style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>
          <strong style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{label}</strong>
          {' · '}{packages.length}
          {selected && <>{' · '}<span style={{ color: 'var(--ink-1)' }}>{selected.name}</span></>}
        </span>
      </button>
      {open && (
        <div id={id} style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {packages.map(pkg => (
            <PackageCard key={pkg.id} pkg={pkg} checked={pkg.id === checkedId} update={update} />
          ))}
        </div>
      )}
    </div>
  );
}

// Package, Add-ons, Glassware, Class options, and Syrups sections of the
// proposal/event editor. Moved verbatim from ProposalDetailEditForm so
// ProposalEditorForm stays under the file-size cap. All FORM state lives in
// the parent and arrives through the callbacks; the only local state is which
// package folds are open, which is view-only and resets on every mount.
// (`selectedPkg` rides in as a prop because the class-options gate reads it;
// it stays derived in the parent alongside filteredAddons.)
export default function PackageSection({
  editForm, packages, filteredAddons, selectedPkg,
  update, toggleAddon, setAddonQty, setVariant,
}) {
  // Both folds start shut on every mount — the whole point of the grouping is
  // that opening the editor does not dump 15 package cards on screen.
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const toggleGroup = (key) => setOpenGroups(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const { loose, hosted, classes } = partitionPackages(packages);
  const checkedId = Number(editForm.package_id);

  return (
    <>
      {/* Package */}
      <div className="meta-k" style={{ marginBottom: 8 }}>Package</div>
      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        {loose.map(pkg => (
          <PackageCard key={pkg.id} pkg={pkg} checked={pkg.id === checkedId} update={update} />
        ))}
        {hosted.length > 0 && (
          <PackageGroup id="pkg-group-hosted" label="Hosted packages" packages={hosted}
            checkedId={checkedId} open={openGroups.has('hosted')}
            onToggle={() => toggleGroup('hosted')} update={update} />
        )}
        {classes.length > 0 && (
          <PackageGroup id="pkg-group-classes" label="Classes" packages={classes}
            checkedId={checkedId} open={openGroups.has('classes')}
            onToggle={() => toggleGroup('classes')} update={update} />
        )}
      </div>

      {/* Add-ons */}
      {filteredAddons.length > 0 && (
        <>
          <div className="meta-k" style={{ marginBottom: 8 }}>Add-ons</div>
          <div style={{ display: 'grid', gap: 4, marginBottom: 16 }}>
            {filteredAddons.map(addon => {
              const isBanquet = /banquet/i.test(addon.name || '');
              const checked = editForm.addon_ids.includes(addon.id);
              return (
                <React.Fragment key={addon.id}>
                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '8px 10px', borderRadius: 4, cursor: 'pointer',
                    border: checked ? '1px solid var(--ink-1)' : '1px solid transparent',
                    background: checked ? 'var(--bg-2)' : 'transparent',
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleAddon(addon.id)}
                      style={{ marginTop: 3 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {addon.name}
                        {isBanquet && <span className="tiny muted" style={{ marginLeft: 6 }}>(4hr min)</span>}
                      </div>
                      <div className="tiny muted">
                        {addon.billing_type === 'per_guest' && `$${Number(addon.rate)}/guest`}
                        {isTimedPerGuestAddon(addon) && timedPerGuestRateLabel(addon)}
                        {addon.billing_type === 'per_hour' && `$${Number(addon.rate)}/hr${isBanquet ? ' · 4hr min' : ''}`}
                        {addon.billing_type === 'flat' && `$${Number(addon.rate)} flat`}
                      </div>
                    </div>
                  </label>
                  {addon.slug === 'champagne-toast' && checked && (
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 8, marginLeft: 36,
                      padding: '4px 8px', cursor: 'pointer', fontSize: 12.5,
                    }}>
                      <input type="checkbox"
                        checked={(editForm.addon_variants || {})[String(addon.id)] === 'non-alcoholic-bubbles'}
                        onChange={e => setVariant(addon.id, e.target.checked ? 'non-alcoholic-bubbles' : undefined)} />
                      Non-alcoholic bubbles
                    </label>
                  )}
                  {/* Quantity stepper — quantity-capable add-ons only (extra
                      bartenders, barback, etc.). A sibling div (not nested in
                      the row <label>) so the +/− buttons don't toggle the
                      checkbox. */}
                  {isQuantityCapable(addon) && checked && (
                    <div style={{
                      display: 'flex', alignItems: 'center', marginLeft: 36,
                      padding: '4px 8px', fontSize: 12.5, color: 'var(--ink-2)',
                    }}>
                      <span>Quantity</span>
                      <AddonQtyStepper
                        value={(editForm.addon_quantities || {})[addon.id]}
                        onChange={(n) => setAddonQty(addon.id, n)}
                      />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </>
      )}

      {/* Glassware — gates Flavor Blaster validity in the server rule check */}
      <div style={{ marginBottom: 16 }}>
        <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox"
            checked={!!editForm.client_provides_glassware}
            onChange={e => update('client_provides_glassware', e.target.checked)} />
          Client provides their own glassware
        </label>
      </div>

      {/* Class options — class packages only */}
      {selectedPkg?.bar_type === 'class' && (
        <>
          <div className="meta-k" style={{ marginBottom: 8 }}>Class options</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div>
              <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Spirit focus</label>
              <select className="select" style={{ width: '100%' }}
                value={editForm.class_options?.spirit_category || ''}
                onChange={e => update('class_options', {
                  ...editForm.class_options,
                  spirit_category: e.target.value || null,
                })}>
                <option value="">Not specified</option>
                <option value="whiskey_bourbon">Whiskey / Bourbon</option>
                <option value="tequila_mezcal">Tequila / Mezcal</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <label className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer', paddingBottom: 6 }}>
                <input type="checkbox"
                  checked={editForm.class_options?.top_shelf_requested === true}
                  onChange={e => update('class_options', {
                    ...editForm.class_options,
                    top_shelf_requested: e.target.checked,
                  })} />
                Top Shelf
              </label>
            </div>
          </div>
        </>
      )}

      {/* Syrups */}
      <div className="meta-k" style={{ marginBottom: 8 }}>Handcrafted syrups</div>
      <div style={{ marginBottom: 16 }}>
        <SyrupPicker
          selected={editForm.syrup_selections || []}
          onChange={(syrups) => update('syrup_selections', syrups)}
          compact />
      </div>
    </>
  );
}
