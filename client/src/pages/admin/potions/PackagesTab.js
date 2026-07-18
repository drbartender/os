import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import PackageDetail from './PackageDetail';

// Potions · Packages tab. The ladder at a glance (grouped by category +
// bar_type, price points, a lazily-fetched directional margin, retired styling)
// on the left; the selected package's contents/slots/pricing/prose editor with
// live-margin + makeability rails on the right. This is the surface that
// retires the pricing spreadsheet and the four-disagreeing-sources problem.
// Package money is DOLLARS.
const GROUPS = [
  { id: 'cocktail', label: 'Hosted · Cocktail bar' },
  { id: 'bw', label: 'Hosted · Beer & wine' },
  { id: 'byob', label: 'BYOB · Service & classes' },
];

const num = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

function groupOf(pkg) {
  if (pkg.category === 'byob') return 'byob';
  if (pkg.bar_type === 'beer_and_wine') return 'bw';
  return 'cocktail'; // hosted full-bar + mocktail
}

function priceOf(pkg) {
  if (pkg.pricing_type === 'per_guest') {
    const small = num(pkg.base_rate_4hr_small);
    return small ? `$${num(pkg.base_rate_4hr)}/$${small}` : `$${num(pkg.base_rate_4hr)}`;
  }
  return `$${num(pkg.base_rate_4hr ?? pkg.base_rate_3hr)}`;
}

export default function PackagesTab({ onOpenRecipe }) {
  const [packages, setPackages] = useState(null);
  const [pars, setPars] = useState([]);
  const [margins, setMargins] = useState({}); // id -> margin_pct | null
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [pkgRes, parsRes] = await Promise.all([
        api.get('/admin/packages'),
        api.get('/potions/pars'),
      ]);
      const rows = pkgRes.data || [];
      setPackages(rows);
      setPars(parsRes.data.pars || []);
      setLoadError('');
      setSelectedId((prev) => (prev && rows.some((p) => p.id === prev) ? prev : (rows[0]?.id ?? null)));
    } catch (err) {
      setLoadError('Could not load packages.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Lazy per-package margin at 100 guests (decorative ladder readout; failures
  // stay silent so one bad row never blanks the list).
  useEffect(() => {
    if (!packages) return undefined;
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        packages.map((p) => api.get(`/admin/packages/${p.id}/margin?guests=100`)),
      );
      if (cancelled) return;
      const next = {};
      results.forEach((r, i) => { next[packages[i].id] = r.status === 'fulfilled' ? r.value.data.margin_pct : null; });
      setMargins(next);
    })();
    return () => { cancelled = true; };
  }, [packages]);

  // Reflect a slots/active edit from the detail pane back into the ladder row.
  const onPackageUpdated = useCallback((updated) => {
    setPackages((list) => (list ? list.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)) : list));
  }, []);

  const grouped = useMemo(() => {
    const buckets = { cocktail: [], bw: [], byob: [] };
    for (const p of packages || []) buckets[groupOf(p)].push(p);
    for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    return buckets;
  }, [packages]);

  if (loadError) {
    return (
      <div className="card"><div className="potions-state">
        <span className="text-muted">{loadError}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (!packages) return <div className="card"><div className="potions-state text-muted">Loading packages…</div></div>;
  if (packages.length === 0) return <div className="card"><div className="potions-state text-muted">No packages yet.</div></div>;

  return (
    <div className="pkg-grid">
      <div className="card pkg-master">
        <div className="pkg-master-list scroll-thin">
          {GROUPS.map((g) => {
            const rows = grouped[g.id];
            if (!rows || rows.length === 0) return null;
            return (
              <div key={g.id}>
                <div className="pkg-group-label">{g.label}</div>
                {rows.map((pkg) => {
                  const active = pkg.id === selectedId;
                  const pct = margins[pkg.id];
                  return (
                    <button
                      type="button"
                      key={pkg.id}
                      className={`pkg-row${active ? ' active' : ''}${pkg.is_active ? '' : ' retired'}`}
                      onClick={() => setSelectedId(pkg.id)}
                    >
                      <span className="pkg-row-main">
                        <span className="pkg-row-name">{pkg.name.replace(/^The /, '')}</span>
                        <span className="pkg-row-meta text-muted">{(pkg.bar_type || '').replace(/_/g, ' ')}</span>
                      </span>
                      <span className="pkg-row-side">
                        <span className="pkg-row-price">{priceOf(pkg)}</span>
                        {!pkg.is_active
                          ? <StatusChip kind="danger">Retired</StatusChip>
                          : (pct != null && <span className={`pkg-row-margin${pct < 30 ? ' is-low' : ''}`}>{pct}%</span>)}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {selectedId != null ? (
        <PackageDetail
          key={selectedId}
          packageId={selectedId}
          pars={pars}
          onPackageUpdated={onPackageUpdated}
          onOpenRecipe={onOpenRecipe}
        />
      ) : (
        <div className="card pkg-editor"><div className="potions-state text-muted">Pick a package to edit its contents.</div></div>
      )}
    </div>
  );
}
