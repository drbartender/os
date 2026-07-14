import React, { useState } from 'react';
import { isQuantityCapable } from '../../../utils/proposalRules';
import SyrupPicker from '../../../components/SyrupPicker';
import Icon from '../../../components/adminos/Icon';
import { fmt$ } from '../../../components/adminos/format';
import { AddonQtyStepper, BundleBadge, clampAddonQty } from '../../../components/AddonControls';

export default function AddonSection({ form, addons, toggleAddon, setForm, update, preview, isIncludedMap, isUnavailableMap }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const includedMap = isIncludedMap || {};
  const unavailableMap = isUnavailableMap || {};

  const selected = addons.filter(a => form.addon_ids.includes(a.id));
  const available = addons.filter(a => !form.addon_ids.includes(a.id));
  const matches = available
    .filter(a => !q || (a.name || '').toLowerCase().includes(q.toLowerCase()) || (a.applies_to || '').toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  const grouped = matches.reduce((g, a) => { (g[a.applies_to || 'Other'] = g[a.applies_to || 'Other'] || []).push(a); return g; }, {});

  const setAddonQty = (id, n) => setForm(f => ({
    ...f,
    addon_quantities: { ...f.addon_quantities, [id]: clampAddonQty(n) },
  }));

  // Lookup snapshot for actual computed total per addon
  const lineTotalFor = (addon) => {
    const snap = preview?.addons?.find(s => s.id === addon.id);
    if (snap?.amount != null) return Number(snap.amount);
    // Fallback: best-effort estimate
    if (addon.billing_type === 'per_guest') return Number(addon.rate) * (Number(form.guest_count) || 0);
    if (addon.billing_type === 'per_hour')  return Number(addon.rate) * (Number(form.event_duration_hours) || 0);
    return Number(addon.rate);
  };

  const labelFor = (addon) => {
    if (addon.billing_type === 'per_guest') return `${form.guest_count} × ${fmt$(addon.rate)}/g`;
    if (addon.billing_type === 'per_guest_timed') return `${form.guest_count} × ${fmt$(addon.rate)}/g (4hr)`;
    if (addon.billing_type === 'per_hour') return `${form.event_duration_hours} × ${fmt$(addon.rate)}/hr`;
    return Number(addon.rate) ? 'flat' : 'included';
  };

  return (
    <div>
      {/* Client-supplied glassware — gates Flavor Blaster availability */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', marginBottom: 8,
        border: '1px solid var(--line-1)', borderRadius: 4,
        background: 'var(--bg-2)', cursor: 'pointer', fontSize: 12.5,
      }}>
        <input
          type="checkbox"
          checked={!!form.client_provides_glassware}
          onChange={(e) => update('client_provides_glassware', e.target.checked)}
        />
        <span style={{ color: 'var(--ink-1)' }}>Client provides their own glassware</span>
      </label>

      {selected.length === 0 ? (
        <div style={{ padding: '10px 12px', border: '1px dashed var(--line-2)', borderRadius: 4, color: 'var(--ink-3)', fontSize: 12 }}>
          No add-ons. Type below to add. Items appear here as line items.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--line-1)', borderRadius: 4, overflow: 'hidden' }}>
          {selected.map((addon, i) => {
            const isIncluded = !!includedMap[addon.slug];
            const isUnavailable = !!unavailableMap[addon.slug];
            const isBundleLocked = isIncluded || isUnavailable;
            const showQty = isQuantityCapable(addon) && !isBundleLocked;
            const isSyrup = addon.slug === 'handcrafted-syrups';
            return (
            <div key={addon.id} style={{
              borderTop: i ? '1px solid var(--line-1)' : 'none',
              background: 'var(--bg-1)',
            }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '20px 1fr 110px 90px 24px',
                alignItems: 'center', gap: 10,
                padding: '7px 10px', fontSize: 12.5,
              }}>
                <Icon
                  name={
                    addon.billing_type === 'per_guest' ? 'users' :
                    addon.billing_type === 'per_hour' ? 'clock' :
                    /champagne|toast/i.test(addon.name) ? 'sparkles' :
                    /mocktail/i.test(addon.name) ? 'flask' :
                    /bartender|server/i.test(addon.name) ? 'userplus' :
                    'check'
                  }
                  size={13}
                  style={{ color: 'var(--ink-3)' }}
                />
                <div style={{ minWidth: 0 }}>
                  <span style={{ color: isBundleLocked ? 'var(--ink-3)' : 'var(--ink-1)' }}>{addon.name}</span>
                  {addon.applies_to && addon.applies_to !== 'all' && (
                    <span className="tiny" style={{ color: 'var(--ink-3)', marginLeft: 6 }}>· {addon.applies_to}</span>
                  )}
                  {isIncluded && <BundleBadge text="Included with bundle" />}
                  {isUnavailable && <BundleBadge text="Unavailable with bundle" />}
                  {addon.slug === 'champagne-toast' && !isBundleLocked && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 10 }}>
                      <input
                        type="checkbox"
                        checked={form.addon_variants[String(addon.id)] === 'non-alcoholic-bubbles'}
                        onChange={(e) => setForm(f => ({
                          ...f,
                          addon_variants: {
                            ...f.addon_variants,
                            [String(addon.id)]: e.target.checked ? 'non-alcoholic-bubbles' : undefined,
                          },
                        }))}
                      />
                      <span className="tiny" style={{ color: 'var(--ink-3)' }}>NA bubbles</span>
                    </label>
                  )}
                  {showQty && (
                    <AddonQtyStepper
                      value={form.addon_quantities[addon.id]}
                      onChange={(n) => setAddonQty(addon.id, n)}
                    />
                  )}
                </div>
                <span className="num tiny" style={{ color: 'var(--ink-3)', textAlign: 'right' }}>{labelFor(addon)}</span>
                <span className="num" style={{ textAlign: 'right', color: isBundleLocked ? 'var(--ink-3)' : 'var(--ink-1)' }}>{fmt$(lineTotalFor(addon))}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { if (!isBundleLocked) toggleAddon(addon.id); }}
                  disabled={isBundleLocked}
                  aria-label={isBundleLocked ? 'Locked by bundle' : 'Remove add-on'}
                  style={{ padding: 0, width: 24, height: 22 }}
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
              {/* Inline syrup-flavor picker — mirrors the wizard's ExtrasStep */}
              {isSyrup && !isBundleLocked && (
                <div style={{ padding: '0 10px 10px 40px' }}>
                  <SyrupPicker
                    selected={form.syrup_selections}
                    onChange={(syrups) => update('syrup_selections', syrups)}
                    compact
                  />
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/* Quick add */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <div className="input-group" style={{ padding: '0 10px' }}>
          <Icon name="plus" />
          <input
            placeholder="Add an add-on: champagne, glassware, banquet…"
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </div>
        {open && matches.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10,
            background: 'var(--bg-elev)', border: '1px solid var(--line-1)', borderRadius: 4, padding: 6,
            boxShadow: 'var(--shadow-pop)', maxHeight: 240, overflow: 'auto',
          }}>
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <div className="tiny mono" style={{ color: 'var(--ink-3)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {cat}
                </div>
                {items.map(a => {
                  const aIncluded = !!includedMap[a.slug];
                  const aUnavailable = !!unavailableMap[a.slug];
                  const aBlocked = aIncluded || aUnavailable;
                  return (
                  <div
                    key={a.id}
                    onMouseDown={() => { if (!aBlocked) { toggleAddon(a.id); setQ(''); setOpen(false); } }}
                    style={{
                      display: 'grid', gridTemplateColumns: '18px 1fr auto', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 3, cursor: aBlocked ? 'default' : 'pointer', fontSize: 12.5,
                      opacity: aBlocked ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) => { if (!aBlocked) e.currentTarget.style.background = 'var(--row-hover)'; }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Icon
                      name={
                        a.billing_type === 'per_guest' ? 'users' :
                        a.billing_type === 'per_hour' ? 'clock' :
                        /champagne|toast/i.test(a.name) ? 'sparkles' :
                        /mocktail/i.test(a.name) ? 'flask' :
                        /bartender|server/i.test(a.name) ? 'userplus' :
                        'check'
                      }
                      size={12}
                      style={{ color: 'var(--ink-3)' }}
                    />
                    <span style={{ color: aBlocked ? 'var(--ink-3)' : undefined }}>
                      {a.name}
                      {aIncluded && <BundleBadge text="Included with bundle" />}
                      {aUnavailable && <BundleBadge text="Unavailable with bundle" />}
                    </span>
                    <span className="tiny mono" style={{ color: 'var(--ink-3)' }}>
                      {!aBlocked && a.billing_type === 'per_guest'       && `${fmt$(a.rate)}/guest`}
                      {!aBlocked && a.billing_type === 'per_guest_timed' && `${fmt$(a.rate)}/guest`}
                      {!aBlocked && a.billing_type === 'per_hour'        && `${fmt$(a.rate)}/hr`}
                      {!aBlocked && a.billing_type === 'flat'            && (Number(a.rate) ? `${fmt$(a.rate)} flat` : 'included')}
                    </span>
                  </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
