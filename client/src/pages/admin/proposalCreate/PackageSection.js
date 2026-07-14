import React, { useState } from 'react';
import { enforceHostedMinimum } from '../../../utils/proposalRules';
import Icon from '../../../components/adminos/Icon';
import FieldError from '../../../components/FieldError';
import PackageIncludesModal from '../../../components/adminos/PackageIncludesModal';
import { Lbl } from './helpers';

export default function PackageSection({ form, packages, update, merge, fieldErrors }) {
  const [infoPkg, setInfoPkg] = useState(null);

  if (packages.length === 0) {
    return <div className="muted tiny">Loading packages…</div>;
  }

  const selectedPkg = packages.find(p => p.id === Number(form.package_id));
  // Class packages carry bar_type === 'class' (their category is 'hosted' —
  // so category would mis-detect). Top Shelf is a class-only flow.
  const isClassPackage = selectedPkg?.bar_type === 'class';

  const rateLabel = (pkg) => {
    if (pkg.pricing_type === 'per_guest') {
      const big = pkg.base_rate_4hr ? `$${Number(pkg.base_rate_4hr)}/guest` : '';
      const small = pkg.base_rate_4hr_small ? `$${Number(pkg.base_rate_4hr_small)}/guest <50` : '';
      return [big, small].filter(Boolean).join(' · ');
    }
    const r3 = pkg.base_rate_3hr ? `$${Number(pkg.base_rate_3hr)}/3hr` : '';
    const r4 = pkg.base_rate_4hr ? `$${Number(pkg.base_rate_4hr)}/4hr` : '';
    const xtra = pkg.extra_hour_rate ? `+$${Number(pkg.extra_hour_rate)}/hr extra` : '';
    return [r3, r4, xtra].filter(Boolean).join(' · ');
  };

  const selectPkg = (pkg) => {
    const pkgIsHosted = pkg.pricing_type === 'per_guest';
    merge({
      package_id: String(pkg.id),
      addon_ids: [], addon_variants: {},
      guest_count: enforceHostedMinimum(form.guest_count, pkgIsHosted),
      class_options: pkg.bar_type === 'class' ? form.class_options : null,
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {packages.map(pkg => {
          const sel = Number(form.package_id) === pkg.id;
          return (
            <div
              key={pkg.id}
              role="button"
              tabIndex={0}
              onClick={() => selectPkg(pkg)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectPkg(pkg);
                }
              }}
              style={{
                flex: '1 1 200px', minWidth: 200, textAlign: 'left',
                padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
                background: sel ? 'var(--accent-soft)' : 'var(--bg-2)',
                border: sel ? '1px solid var(--accent)' : '1px solid var(--line-1)',
                color: 'var(--ink-1)',
                font: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <Icon name={sel ? 'check' : 'flask'} size={11} style={{ color: sel ? 'var(--accent)' : 'var(--ink-3)' }} />
                <strong style={{ fontSize: 13 }}>{pkg.name}</strong>
                <div className="spacer" style={{ flex: 1 }} />
                <span className="num tiny" style={{ color: 'var(--ink-2)' }}>{rateLabel(pkg)}</span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setInfoPkg(pkg); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
                style={{
                  marginTop: 2, padding: 0, background: 'transparent', border: 0,
                  color: 'var(--ink-3)', font: 'inherit', fontSize: 11,
                  textDecoration: 'underline', cursor: 'pointer',
                }}
              >
                What's included
              </button>
            </div>
          );
        })}
      </div>
      <FieldError error={fieldErrors?.package_id} />

      {/* Top Shelf — class packages only. The spirit category + custom-pricing
          request live in form.class_options; each control rewrites the whole
          object so the sibling field is preserved. */}
      {isClassPackage && (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 4,
          border: '1px solid var(--line-1)', background: 'var(--bg-2)',
          display: 'grid', gap: 8,
        }}>
          <Lbl text="Spirit category">
            <select
              className="select"
              value={form.class_options?.spirit_category || ''}
              onChange={(e) => merge({
                class_options: { ...form.class_options, spirit_category: e.target.value },
              })}
              style={{ width: '100%' }}
            >
              <option value="">Choose a spirit…</option>
              <option value="whiskey_bourbon">Whiskey / Bourbon</option>
              <option value="tequila_mezcal">Tequila / Mezcal</option>
            </select>
          </Lbl>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: 'pointer', fontSize: 12.5, color: 'var(--ink-1)',
          }}>
            <input
              type="checkbox"
              checked={!!form.class_options?.top_shelf_requested}
              onChange={(e) => merge({
                class_options: { ...form.class_options, top_shelf_requested: e.target.checked },
              })}
            />
            <span>Top Shelf requested (custom pricing)</span>
          </label>
        </div>
      )}

      <PackageIncludesModal open={!!infoPkg} pkg={infoPkg} onClose={() => setInfoPkg(null)} />
    </div>
  );
}
