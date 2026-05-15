import React, { useEffect } from 'react';
import { getPackageBySlug } from '../../data/packages';

const rateLabel = (pkg) => {
  if (!pkg) return '';
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

export default function PackageIncludesModal({ open, pkg, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !pkg) return null;

  const detail = getPackageBySlug(pkg.slug);
  const flatIncludes = Array.isArray(pkg.includes) ? pkg.includes : [];

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${pkg.name} — what's included`}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center', padding: 16,
      }}
      data-app="admin-os"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: '94vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-1)',
          color: 'var(--ink-1)',
          border: '1px solid var(--line-1)',
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
          padding: '0.7rem 1rem', borderBottom: '1px solid var(--line-1)',
        }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{pkg.name}</h3>
          <span className="num tiny" style={{ color: 'var(--ink-2)' }}>{rateLabel(pkg)}</span>
        </div>
        <div style={{ overflowY: 'auto', padding: '0.9rem 1rem' }}>
          {detail ? (
            <>
              {detail.description && (
                <p style={{ marginTop: 0, color: 'var(--ink-2)', fontStyle: 'italic' }}>
                  {detail.description}
                </p>
              )}
              {detail.sections.map((section, si) => (
                <div key={si} style={{ marginBottom: 12 }}>
                  <h4 style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--ink-1)' }}>{section.heading}</h4>
                  <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-1)' }}>
                    {section.items.map((item, i) => (
                      <li key={i} style={{ marginBottom: 2 }}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {detail.serviceIncludes && (
                <p style={{ marginTop: 12, color: 'var(--ink-3)', fontStyle: 'italic', fontSize: 12 }}>
                  {detail.serviceIncludes}
                </p>
              )}
            </>
          ) : (
            <>
              {pkg.description && (
                <p style={{ marginTop: 0, color: 'var(--ink-2)', fontStyle: 'italic' }}>
                  {pkg.description}
                </p>
              )}
              {flatIncludes.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-1)' }}>
                  {flatIncludes.map((item, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted tiny">No detailed inclusions available for this package.</p>
              )}
            </>
          )}
        </div>
        <div style={{
          padding: '0.7rem 1rem', borderTop: '1px solid var(--line-1)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
