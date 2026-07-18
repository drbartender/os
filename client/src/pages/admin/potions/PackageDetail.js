import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import { useToast } from '../../../context/ToastContext';
import MakeabilityPanel from './MakeabilityPanel';

// Potions · Packages · detail editor. The middle column edits structured
// package contents (category pars with split-par eligible bottles) plus the
// signature-slot config; the right rail shows the DIRECTIONAL live margin and
// the makeability preview. Pricing + marketing prose are read-only here:
// price changes stay deliberate (admin/DB), and `includes` is display-only by
// design (sales copy and machine truth may differ on purpose, not by accident).
// Contents money is DOLLARS. Server API: /api/admin/packages/:id (+ /items).

const TABS = [
  { id: 'contents', label: 'Contents' },
  { id: 'slots', label: 'Slots & coverage' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'prose', label: 'Prose' },
];

const num = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const money = (v) => (v == null || v === '' ? '—' : `$${num(v)}`);
const fmtSigned = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
const fieldError = (err) => {
  const fe = err.response?.data?.fieldErrors;
  return fe ? Object.values(fe)[0] : (err.response?.data?.error || 'Save failed.');
};

// ─── Eligible-bottle typeahead over the par catalog ──────────────
function BottleTypeahead({ pars, exclude, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (pars || [])
      .filter((p) => !exclude.has(p.id))
      .filter((p) => !needle || `${p.item} ${p.size || ''}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [pars, exclude, q]);

  return (
    <span className="pkg-typeahead">
      <input
        className="input pkg-typeahead-input"
        placeholder="Add bottle…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); e.target.blur(); } }}
        aria-label="Add eligible bottle"
      />
      {open && results.length > 0 && (
        <span className="pkg-typeahead-menu scroll-thin">
          {results.map((p) => (
            <button
              type="button"
              key={p.id}
              className="pkg-typeahead-item"
              onMouseDown={(e) => { e.preventDefault(); onPick(p.id); setQ(''); setOpen(false); }}
            >
              <span className="pkg-ta-name">{p.item}</span>
              <span className="pkg-ta-meta">{[p.size, p.cost != null ? `$${num(p.cost)}` : null].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ─── Directional live-margin rail ────────────────────────────────
function MarginRail({ packageId, version }) {
  const [inp, setInp] = useState({ guests: '100', hours: '4', labor: '', supplies: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const seeded = useRef(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (!packageId) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (inp.guests !== '') params.set('guests', inp.guests);
    if (inp.hours !== '') params.set('hours', inp.hours);
    if (inp.labor !== '') params.set('labor', inp.labor);
    if (inp.supplies !== '') params.set('supplies', inp.supplies);
    const delay = firstRun.current ? 0 : 300;
    firstRun.current = false;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/admin/packages/${packageId}/margin?${params.toString()}`, { signal: controller.signal });
        setData(res.data);
        setError('');
        if (!seeded.current) {
          seeded.current = true;
          setInp((prev) => ({
            ...prev,
            labor: prev.labor === '' ? String(res.data.inputs.labor_rate) : prev.labor,
            supplies: prev.supplies === '' ? String(res.data.inputs.supplies_per_guest) : prev.supplies,
          }));
        }
      } catch (err) {
        if (!controller.signal.aborted) setError('Could not compute margin.');
      }
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [packageId, version, inp]);

  const set = (key) => (e) => setInp((s) => ({ ...s, [key]: e.target.value }));

  return (
    <div className="card pkg-rail">
      <div className="pkg-rail-head">
        <span className="pkg-rail-label">Live margin</span>
        <span className="pkg-rail-hint">directional, not accounting</span>
      </div>
      <div className="pkg-margin-inputs">
        <label className="pkg-field"><span className="pkg-field-label">Guests</span>
          <input className="input pkg-num" inputMode="numeric" value={inp.guests} onChange={set('guests')} /></label>
        <label className="pkg-field"><span className="pkg-field-label">Hours</span>
          <select className="select" value={inp.hours} onChange={set('hours')}>
            <option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option>
          </select></label>
        <label className="pkg-field"><span className="pkg-field-label">Labor $/hr</span>
          <input className="input pkg-num" inputMode="decimal" value={inp.labor} onChange={set('labor')} /></label>
        <label className="pkg-field"><span className="pkg-field-label">Supplies $/g</span>
          <input className="input pkg-num" inputMode="decimal" value={inp.supplies} onChange={set('supplies')} /></label>
      </div>
      {error ? (
        <div className="pkg-rail-note text-muted">{error}</div>
      ) : !data ? (
        <div className="pkg-rail-note text-muted">Calculating…</div>
      ) : (
        <div className="pkg-margin-body">
          <div className="pkg-margin-line"><span>Revenue</span><span className="pkg-money">{fmtSigned(data.revenue)}</span></div>
          <div className="pkg-margin-line"><span className="text-muted">Liquor &amp; bottles</span><span className="pkg-money">{fmtSigned(-data.liquor_cost)}</span></div>
          <div className="pkg-margin-line"><span className="text-muted">Mixers &amp; supplies</span><span className="pkg-money">{fmtSigned(-data.supplies_cost)}</span></div>
          <div className="pkg-margin-line"><span className="text-muted">Labor · {data.inputs.bartenders} × {data.inputs.hours + 2}h</span><span className="pkg-money">{fmtSigned(-data.labor_cost)}</span></div>
          <div className="pkg-margin-line pkg-margin-total"><span>Total cost</span><span className="pkg-money">{fmtSigned(-data.total_cost)}</span></div>
          <div className="pkg-margin-margin">
            <span>Margin</span>
            <span className="pkg-margin-figs">
              <span className={`pkg-margin-big ${data.margin >= 0 ? 'is-pos' : 'is-neg'}`}>{data.margin_pct == null ? '—' : `${data.margin_pct}%`}</span>
              <span className="pkg-money">{fmtSigned(data.margin)}</span>
            </span>
          </div>
          {data.missing_costs > 0 && (
            <div className="pkg-warn">{data.missing_costs} eligible bottle{data.missing_costs === 1 ? '' : 's'} missing a cost. Set costs in the Pars tab for a truer margin.</div>
          )}
        </div>
      )}
      <div className="pkg-rail-foot text-muted">Revenue uses the package's own rates. Split pars share category volume, so "for show" bottles never multiply cost.</div>
    </div>
  );
}

export default function PackageDetail({ packageId, pars, onPackageUpdated, onOpenRecipe }) {
  const toast = useToast();
  const [pkg, setPkg] = useState(null);
  const [items, setItems] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('contents');
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ category: '', par: '1', unit: 'btl' });
  const focusSnapshot = useRef({});
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/admin/packages/${packageId}`);
      const { items: rows = [], ...rest } = res.data;
      setPkg(rest);
      setItems(rows);
      setLoadError('');
    } catch (err) {
      setLoadError('Could not load this package.');
    }
  }, [packageId]);
  useEffect(() => { load(); }, [load]);

  const parById = useMemo(() => {
    const map = new Map();
    for (const p of pars || []) map.set(p.id, p);
    return map;
  }, [pars]);

  // ── contents-row saves (PUT replaces the full row; provided-key PUT on the
  //    package handles slots/active). Every mutation bumps `version` so the
  //    margin + makeability rails recompute. ──
  const putItem = async (item, patch) => {
    const merged = { ...item, ...patch };
    const body = {
      category: merged.category,
      par_per_100: merged.par_per_100,
      unit: merged.unit,
      eligible_item_ids: merged.eligible_item_ids || [],
      sort_order: merged.sort_order ?? 0,
    };
    const prev = items;
    setItems((list) => list.map((it) => (it.id === item.id ? merged : it)));
    try {
      const res = await api.put(`/admin/packages/${packageId}/items/${item.id}`, body);
      setItems((list) => list.map((it) => (it.id === item.id ? res.data : it)));
      bump();
    } catch (err) {
      setItems(prev);
      toast.error(fieldError(err));
    }
  };

  const addBottle = (item, id) => {
    if ((item.eligible_item_ids || []).includes(id)) return;
    putItem(item, { eligible_item_ids: [...(item.eligible_item_ids || []), id] });
  };
  const removeBottle = (item, id) =>
    putItem(item, { eligible_item_ids: (item.eligible_item_ids || []).filter((x) => x !== id) });

  const addCategory = async () => {
    const category = addForm.category.trim();
    if (!category) return;
    try {
      const res = await api.post(`/admin/packages/${packageId}/items`, {
        category,
        par_per_100: Number(addForm.par) || 0,
        unit: (addForm.unit || 'btl').trim() || 'btl',
        eligible_item_ids: [],
        sort_order: (items.length + 1) * 10,
      });
      setItems((list) => [...list, res.data]);
      setAddForm({ category: '', par: '1', unit: 'btl' });
      setAdding(false);
      bump();
    } catch (err) {
      toast.error(fieldError(err));
    }
  };

  const removeCategory = async (item) => {
    if (!window.confirm(`Remove the "${item.category}" category row?`)) return;
    const prev = items;
    setItems((list) => list.filter((it) => it.id !== item.id));
    try {
      await api.delete(`/admin/packages/${packageId}/items/${item.id}`);
      bump();
    } catch (err) {
      setItems(prev);
      toast.error('Could not remove the category.');
    }
  };

  const savePackage = async (body) => {
    const prev = pkg;
    setPkg((p) => ({ ...p, ...body }));
    try {
      const res = await api.put(`/admin/packages/${packageId}`, body);
      setPkg(res.data);
      onPackageUpdated && onPackageUpdated(res.data);
      bump();
    } catch (err) {
      setPkg(prev);
      toast.error(fieldError(err));
    }
  };

  const setSlotKind = (kind) => {
    if (kind === null) return savePackage({ slot_kind: null, slot_count: null });
    return savePackage({ slot_kind: kind, slot_count: Number(pkg.slot_count) || (kind === 'hard' ? 2 : 4) });
  };
  const setSlotCount = (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10) { toast.error('Slots must be a whole number from 0 to 10.'); return; }
    savePackage({ slot_count: n });
  };

  if (loadError) {
    return (
      <div className="card pkg-editor"><div className="potions-state">
        <span className="text-muted">{loadError}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (!pkg) return <div className="card pkg-editor"><div className="potions-state text-muted">Loading package…</div></div>;

  const priceLabel = pkg.pricing_type === 'per_guest'
    ? `$${num(pkg.base_rate_4hr)}/guest${pkg.base_rate_4hr_small ? ` · $${num(pkg.base_rate_4hr_small)} under ${pkg.min_guests || 50}` : ''}`
    : `Flat $${num(pkg.base_rate_4hr ?? pkg.base_rate_3hr)}`;
  const subtitle = `${priceLabel} · ${(pkg.bar_type || '').replace(/_/g, ' ')}${pkg.min_total ? ` · min $${num(pkg.min_total)}` : ''}`;
  const slotKind = pkg.slot_kind || null;
  const includes = Array.isArray(pkg.includes) ? pkg.includes : [];

  const PRICING = [
    ['4-hour rate', money(pkg.base_rate_4hr)],
    ['4-hour rate (small event)', money(pkg.base_rate_4hr_small)],
    ['3-hour rate', money(pkg.base_rate_3hr)],
    ['3-hour rate (small event)', money(pkg.base_rate_3hr_small)],
    ['Extra hour', money(pkg.extra_hour_rate)],
    ['Extra hour (small event)', money(pkg.extra_hour_rate_small)],
    ['Minimum total', money(pkg.min_total)],
    ['Min billed guests', pkg.min_billed_guests == null ? '—' : String(pkg.min_billed_guests)],
    ['Small-event threshold', pkg.min_guests == null ? '—' : `${pkg.min_guests} guests`],
    ['Bartenders included', pkg.bartenders_included == null ? '—' : String(pkg.bartenders_included)],
    ['Guests per bartender', pkg.guests_per_bartender == null ? '—' : String(pkg.guests_per_bartender)],
    ['Pricing model', pkg.pricing_type === 'per_guest' ? 'Per guest' : 'Flat'],
  ];

  return (
    <div className="pkg-detail-grid">
      <div className="card pkg-editor">
        <div className="pkg-detail-head">
          <div>
            <div className="pkg-detail-title">{pkg.name}</div>
            <div className="pkg-detail-sub text-muted">{subtitle}</div>
          </div>
          <div className="hstack" style={{ gap: '0.6rem' }}>
            <StatusChip kind={pkg.is_active ? 'ok' : 'danger'}>{pkg.is_active ? 'Live' : 'Retired'}</StatusChip>
            <label className="pkg-active-toggle">
              <input type="checkbox" checked={!!pkg.is_active} onChange={() => savePackage({ is_active: !pkg.is_active })} />
              Active
            </label>
          </div>
        </div>

        <div className="pkg-tab-bar">
          <div className="seg">
            {TABS.map((t) => (
              <button type="button" key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>

        {tab === 'contents' && (
          <div className="pkg-tab-body">
            {items.length === 0 ? (
              <div className="potions-state text-muted">No contents yet. Add the first category.</div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl pkg-contents-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="pkg-col-par">Par / 100</th>
                      <th>Eligible bottles</th>
                      <th className="pkg-col-x" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const exclude = new Set(item.eligible_item_ids || []);
                      return (
                        <tr key={item.id}>
                          <td>
                            <input className="input pkg-cat-input" value={item.category} aria-label="Category name"
                              onFocus={(e) => { focusSnapshot.current[`${item.id}:category`] = e.target.value; }}
                              onChange={(e) => setItems((l) => l.map((it) => (it.id === item.id ? { ...it, category: e.target.value } : it)))}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next && next !== focusSnapshot.current[`${item.id}:category`]) putItem(item, { category: next });
                              }} />
                          </td>
                          <td className="pkg-col-par">
                            <span className="pkg-par-cell">
                              <input className="input pkg-num" value={item.par_per_100} aria-label="Par per 100 guests" inputMode="decimal"
                                onFocus={(e) => { focusSnapshot.current[`${item.id}:par`] = e.target.value; }}
                                onChange={(e) => setItems((l) => l.map((it) => (it.id === item.id ? { ...it, par_per_100: e.target.value } : it)))}
                                onBlur={(e) => { if (e.target.value !== focusSnapshot.current[`${item.id}:par`]) putItem(item, { par_per_100: Number(e.target.value) || 0 }); }} />
                              <input className="input pkg-unit-input" value={item.unit || ''} aria-label="Unit"
                                onFocus={(e) => { focusSnapshot.current[`${item.id}:unit`] = e.target.value; }}
                                onChange={(e) => setItems((l) => l.map((it) => (it.id === item.id ? { ...it, unit: e.target.value } : it)))}
                                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== focusSnapshot.current[`${item.id}:unit`]) putItem(item, { unit: v }); }} />
                            </span>
                          </td>
                          <td>
                            <div className="pkg-bottles">
                              {(item.eligible_item_ids || []).map((id) => {
                                const par = parById.get(id);
                                return (
                                  <span className="chip neutral pkg-bottle-chip" key={id}>
                                    {par ? par.item : id}
                                    <button type="button" className="pkg-chip-x" title="Remove bottle" aria-label="Remove bottle" onClick={() => removeBottle(item, id)}>×</button>
                                  </span>
                                );
                              })}
                              <BottleTypeahead pars={pars} exclude={exclude} onPick={(id) => addBottle(item, id)} />
                            </div>
                          </td>
                          <td className="pkg-col-x">
                            <button type="button" className="btn btn-danger btn-sm" title="Remove category" aria-label={`Remove ${item.category}`} onClick={() => removeCategory(item)}>×</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="pkg-contents-foot">
              {adding ? (
                <div className="pkg-add-row hstack">
                  <input className="input" placeholder="Category (e.g. Tequila)" value={addForm.category} autoFocus
                    onChange={(e) => setAddForm((f) => ({ ...f, category: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); if (e.key === 'Escape') setAdding(false); }} />
                  <input className="input pkg-num" placeholder="Par" value={addForm.par} inputMode="decimal" aria-label="Par per 100"
                    onChange={(e) => setAddForm((f) => ({ ...f, par: e.target.value }))} />
                  <input className="input pkg-unit-input" placeholder="unit" value={addForm.unit} aria-label="Unit"
                    onChange={(e) => setAddForm((f) => ({ ...f, unit: e.target.value }))} />
                  <button type="button" className="btn btn-sm" onClick={addCategory} disabled={!addForm.category.trim()}>Add</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(false)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>Add category</button>
              )}
              <span className="pkg-help text-muted">"For show" labels share the par, extra bottles never multiply cost.</span>
            </div>
          </div>
        )}

        {tab === 'slots' && (
          <div className="pkg-tab-body">
            <div className="pkg-field-group-label">Signature slots</div>
            <div className="hstack pkg-slot-controls">
              <div className="seg">
                <button type="button" className={slotKind === null ? 'active' : ''} onClick={() => setSlotKind(null)}>None</button>
                <button type="button" className={slotKind === 'hard' ? 'active' : ''} onClick={() => setSlotKind('hard')}>Hard</button>
                <button type="button" className={slotKind === 'featured' ? 'active' : ''} onClick={() => setSlotKind('featured')}>Featured</button>
              </div>
              {slotKind !== null && (
                <span className="hstack" style={{ gap: '0.35rem' }}>
                  <input className="input pkg-num" defaultValue={pkg.slot_count ?? ''} key={`${slotKind}:${pkg.slot_count}`} inputMode="numeric" aria-label="Slot count"
                    onBlur={(e) => { if (String(e.target.value) !== String(pkg.slot_count ?? '')) setSlotCount(e.target.value); }} />
                  <span className="text-muted text-small">slots</span>
                </span>
              )}
            </div>
            <p className="pkg-explainer text-muted">
              {slotKind === 'hard'
                ? 'Hard slots: the picks ARE the bar (no open spirits). Shopping buys exactly what the picks need, so every slot resolves.'
                : slotKind === 'featured'
                  ? 'Featured slots: the picks headline the menu; the basics plus the picks’ ingredients let the bartender improvise beyond it, just like a real bar.'
                  : 'No advertised signature slots. Any goodwill stays management discretion, never promised in the planner.'}
            </p>
            <p className="pkg-explainer text-muted">
              A drink is in-tier when every recipe ingredient resolves to a stocked bottle or a covered class. Gaps price
              through the class-to-add-on mapping. The makeability rail displays the engine's verdict, it never forms its own.
            </p>
          </div>
        )}

        {tab === 'pricing' && (
          <div className="pkg-tab-body">
            <div className="pkg-pricing-grid">
              {PRICING.map(([label, value]) => (
                <div className="pkg-pricing-field" key={label}>
                  <span className="pkg-field-label">{label}</span>
                  <span className="pkg-money pkg-pricing-value">{value}</span>
                </div>
              ))}
            </div>
            <p className="pkg-explainer text-muted">Read-only here. Price changes are rare and deliberate, made in the admin package settings. All amounts in dollars.</p>
          </div>
        )}

        {tab === 'prose' && (
          <div className="pkg-tab-body">
            <div className="hstack pkg-prose-head">
              <StatusChip kind="warn">Display-only</StatusChip>
              <span className="text-muted text-small">Marketing bullets shown to clients. Sales copy and machine truth may differ on purpose, never by accident. This never drives coverage.</span>
            </div>
            {includes.length === 0 ? (
              <div className="potions-state text-muted">No marketing bullets set.</div>
            ) : (
              <ul className="pkg-prose">
                {includes.map((line, i) => <li key={i}>{String(line)}</li>)}
              </ul>
            )}
            <p className="pkg-explainer text-muted">Placeholders like {'{hours}'} and {'{bartenders}'} render at quote time.</p>
          </div>
        )}
      </div>

      <div className="pkg-rail-stack">
        <MarginRail packageId={packageId} version={version} />
        <MakeabilityPanel packageId={packageId} version={version} hasItems={items.length > 0} onOpenRecipe={onOpenRecipe} />
      </div>
    </div>
  );
}
