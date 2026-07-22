import React from 'react';
import { AddonQtyStepper } from '../../../components/AddonControls';
import SyrupPicker from '../../../components/SyrupPicker';
import { isQuantityCapable } from '../../../utils/proposalRules';

// Package, Add-ons, Glassware, Class options, and Syrups sections of the
// proposal/event editor. Moved verbatim from ProposalDetailEditForm so
// ProposalEditorForm stays under the file-size cap. Pure render: all state
// lives in the parent and arrives through the callbacks. (`selectedPkg` rides
// in as a prop because the class-options gate reads it; it stays derived in
// the parent alongside filteredAddons.)
export default function PackageSection({
  editForm, packages, filteredAddons, selectedPkg,
  update, toggleAddon, setAddonQty, setVariant,
}) {
  return (
    <>
      {/* Package */}
      <div className="meta-k" style={{ marginBottom: 8 }}>Package</div>
      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        {packages.map(pkg => {
          const checked = Number(editForm.package_id) === pkg.id;
          return (
            <label key={pkg.id} style={{
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
        })}
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
                        {addon.billing_type === 'per_guest_timed' && `$${Number(addon.rate)}/guest (4hr) + $${Number(addon.extra_hour_rate)}/guest/hr after`}
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
