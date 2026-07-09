import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import { useToast } from '../../../context/ToastContext';

// Potions · Recipes tab (design master-detail). One structured recipe per
// drink, per single serving; the shopping-list generator resolves each row's
// generic ingredient to a recommended purchasable through the par catalog's
// aliases (server-side authority; the resolver below is a DISPLAY mirror
// only). Debounced whole-recipe autosave; Mark reviewed flushes any pending
// save first. Review states: empty / draft / reviewed.
const UNITS = ['oz', 'dash', 'each', 'splash'];
const REVIEW = {
  reviewed: { label: 'Reviewed', short: 'OK', kind: 'ok' },
  draft:    { label: 'Draft, needs review', short: 'Draft', kind: 'warn' },
  empty:    { label: 'No recipe yet', short: 'Empty', kind: 'danger' },
};

// Display-only mirror of potionCatalog's alias resolution (normalize, exact,
// then longest-substring with head-noun preference). Generation authority
// stays server-side; this only paints the "→ Tito's Vodka · 1.75L" hints.
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function buildAliasIndex(pars) {
  const index = [];
  for (const par of pars) {
    for (const alias of par.ingredient_aliases || []) {
      const norm = normalizeName(alias);
      if (norm) index.push({ alias: norm, par });
    }
  }
  index.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  return index;
}
function resolveDisplay(row, aliasIndex, parsById) {
  if (row.override_item_id && parsById.has(row.override_item_id)) {
    return parsById.get(row.override_item_id);
  }
  const norm = normalizeName(row.ingredient);
  if (!norm) return null;
  for (const entry of aliasIndex) if (entry.alias === norm) return entry.par;
  const lastToken = norm.split(' ').pop();
  let fallback = null;
  for (const entry of aliasIndex) {
    if (!norm.includes(entry.alias)) continue;
    if (entry.alias.split(' ').includes(lastToken)) return entry.par;
    if (!fallback) fallback = entry.par;
  }
  return fallback;
}

function rowProblems(row) {
  const problems = {};
  if (!String(row.ingredient || '').trim()) problems.ingredient = 'Name this ingredient to save.';
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) problems.amount = 'Fix amount to save.';
  if (!UNITS.includes(row.unit)) problems.unit = 'Pick a unit.';
  return problems;
}

export default function RecipesTab({ focusDrinkId, onConsumeFocus, goToPars }) {
  const toast = useToast();
  const [drinkType, setDrinkType] = useState('cocktails');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);   // { cocktails: [...], mocktails: [...] }
  const [pars, setPars] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [rows, setRows] = useState([]);     // editable copy of the selected recipe
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error | blocked
  const saveTimer = useRef(null);
  // Pending debounced save, with its TARGET bound in: { drink, type, rows }.
  // Binding target+payload together (instead of live-reading rows at fire
  // time) is what makes a fast selection switch safe — a stale timer can
  // never write drink B's rows onto drink A (code-review critical fix).
  const pendingRef = useRef(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const load = useCallback(async () => {
    try {
      const [c, m, p] = await Promise.all([
        api.get('/cocktails/admin'),
        api.get('/mocktails/admin'),
        api.get('/potions/pars'),
      ]);
      setData({ cocktails: c.data.cocktails || [], mocktails: m.data.mocktails || [] });
      setPars(p.data.pars || []);
      setLoadError('');
    } catch (err) {
      setLoadError('Could not load recipes. ');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const drinks = useMemo(() => (data ? data[drinkType] || [] : []), [data, drinkType]);
  const aliasIndex = useMemo(() => buildAliasIndex(pars), [pars]);
  const parsById = useMemo(() => new Map(pars.map((p) => [p.id, p])), [pars]);

  // Deep-link (?drink=<id> from the shopping-list Add-recipe flow).
  useEffect(() => {
    if (!focusDrinkId || !data) return;
    const inCocktails = (data.cocktails || []).some((d) => d.id === focusDrinkId);
    const inMocktails = (data.mocktails || []).some((d) => d.id === focusDrinkId);
    if (inCocktails || inMocktails) {
      setDrinkType(inCocktails ? 'cocktails' : 'mocktails');
      setSelectedId(focusDrinkId);
    }
    onConsumeFocus?.();
  }, [focusDrinkId, data, onConsumeFocus]);

  const selected = useMemo(() => {
    const list = drinks;
    const found = list.find((d) => d.id === selectedId);
    return found || list[0] || null;
  }, [drinks, selectedId]);

  const persist = useCallback(async (drink, type, nextRows, extra = {}, { silent = false } = {}) => {
    const clean = nextRows
      .filter((r) => String(r.ingredient || '').trim())
      .map((r) => {
        const out = { ingredient: String(r.ingredient).trim(), amount: Number(r.amount), unit: r.unit };
        if (String(r.note || '').trim()) out.note = String(r.note).trim();
        if (r.override_item_id) out.override_item_id = r.override_item_id;
        return out;
      });
    if (!silent) setSaveState('saving');
    try {
      const res = await api.put(`/${type}/${drink.id}`, { ingredients: clean, ...extra });
      setData((prev) => ({
        ...prev,
        [type]: prev[type].map((d) => (d.id === drink.id ? { ...d, ...res.data } : d)),
      }));
      if (!silent) setSaveState('saved');
      return true;
    } catch (err) {
      if (!silent) setSaveState('error');
      toast.error(err.response?.data?.fieldErrors?.ingredients || `Recipe save failed for ${drink.name}.`);
      return false;
    }
  }, [toast]);

  // Flush any pending debounced save for the PREVIOUS drink (never drop
  // edits, never cross-save), used on selection switch and unmount.
  const flushPending = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) persist(pending.drink, pending.type, pending.rows, {}, { silent: true });
  }, [persist]);

  // (Re)hydrate the editable rows when the selection changes.
  const selectedKey = selected ? `${drinkType}:${selected.id}` : '';
  useEffect(() => {
    flushPending();
    if (!selected) { setRows([]); return; }
    const structured = (selected.ingredients || []).map((r) =>
      typeof r === 'string'
        ? { ingredient: r, amount: '', unit: 'oz', note: '', _legacy: true }
        : { ingredient: r.ingredient || '', amount: r.amount ?? '', unit: r.unit || 'oz', note: r.note || '', override_item_id: r.override_item_id || '' }
    );
    setRows(structured);
    setSaveState('saved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Unmount (tab switch away): flush rather than drop.
  useEffect(() => () => { flushPending(); }, [flushPending]);

  const scheduleSave = useCallback((nextRows) => {
    if (!selected) return;
    const hasProblems = nextRows.some((r) => Object.keys(rowProblems(r)).length > 0);
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (hasProblems) { pendingRef.current = null; setSaveState('blocked'); return; }
    setSaveState('dirty');
    pendingRef.current = { drink: selected, type: drinkType, rows: nextRows };
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persist(pending.drink, pending.type, pending.rows);
    }, 800);
  }, [selected, drinkType, persist]);

  const updateRow = (i, patch) => {
    setRows((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      scheduleSave(next);
      return next;
    });
  };
  const addRow = () => {
    setRows((prev) => {
      const next = [...prev, { ingredient: '', amount: '', unit: 'oz', note: '' }];
      setSaveState('blocked'); // new row is incomplete until named
      return next;
    });
  };
  const deleteRow = (i) => {
    setRows((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      scheduleSave(next);
      return next;
    });
  };

  const markReviewed = async () => {
    if (!selected) return;
    // Flush-before-Mark-reviewed (spec §4 concurrency rule): cancel the
    // pending timer and fold everything into ONE PUT carrying the rows +
    // the explicit review state.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingRef.current = null;
    const ok = await persist(selected, drinkType, rowsRef.current, { recipe_review: 'reviewed' });
    if (ok) toast.success('Marked reviewed.');
  };

  if (loadError) {
    return (
      <div className="card"><div className="potions-state">
        <span className="text-muted">{loadError}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (!data) return <div className="card"><div className="potions-state text-muted">Loading recipes…</div></div>;

  const q = normalizeName(search);
  const list = drinks.filter((d) => !q || normalizeName(d.name).includes(q));
  const reviewedCount = drinks.filter((d) => d.recipe_review === 'reviewed').length;
  const saveLabel = {
    saved: 'Saved', dirty: 'Saving…', saving: 'Saving…',
    error: 'Save failed, edit to retry', blocked: 'Fix highlighted rows to save',
  }[saveState];

  return (
    <div className="potions-recipes">
      <div className="hstack potions-toolbar">
        <div className="seg">
          <button type="button" className={drinkType === 'cocktails' ? 'active' : ''} onClick={() => setDrinkType('cocktails')}>Cocktails</button>
          <button type="button" className={drinkType === 'mocktails' ? 'active' : ''} onClick={() => setDrinkType('mocktails')}>Mocktails</button>
        </div>
        <span className="text-muted text-small">{reviewedCount} of {drinks.length} reviewed</span>
      </div>

      <div className="potions-split">
        <div className="card potions-master">
          <div className="potions-master-search">
            <input className="form-input" placeholder="Find a recipe…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="potions-master-list scroll-thin">
            {list.length === 0 && <div className="potions-state text-muted">No drinks{q ? ' match' : ' yet'}.</div>}
            {list.map((d) => {
              const review = REVIEW[d.recipe_review] || REVIEW.draft;
              const active = selected && d.id === selected.id;
              return (
                <button type="button" key={d.id} className={`potions-master-row ${active ? 'active' : ''}`} onClick={() => setSelectedId(d.id)}>
                  <span className="potions-master-emoji">{d.emoji || ''}</span>
                  <span className="potions-master-name">{d.name}</span>
                  <StatusChip kind={review.kind}>{review.short}</StatusChip>
                </button>
              );
            })}
          </div>
        </div>

        {selected ? (
          <div className="card potions-detail">
            <div className="potions-detail-head">
              <div className="hstack" style={{ gap: '0.6rem' }}>
                <span className="potions-detail-emoji">{selected.emoji || ''}</span>
                <div>
                  <div className="potions-detail-name">{selected.name}</div>
                  <div className="text-muted text-small">
                    {(REVIEW[selected.recipe_review] || REVIEW.draft).label} · {saveLabel}
                  </div>
                </div>
              </div>
              <div className="hstack" style={{ gap: '0.5rem' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>Add ingredient</button>
                <button type="button" className="btn btn-sm" onClick={markReviewed} disabled={saveState === 'saving' || saveState === 'blocked'}>Mark reviewed</button>
              </div>
            </div>

            <div className="table-wrap">
              <table className="data-table potions-recipe-table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th className="potions-col-amount">Amount</th>
                    <th>Unit</th>
                    <th>Purchasable</th>
                    <th className="col-desc">Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="text-muted potions-state">No recipe drafted yet. Add the first ingredient to start the formula.</td></tr>
                  )}
                  {rows.map((row, i) => {
                    const problems = rowProblems(row);
                    const resolved = resolveDisplay(row, aliasIndex, parsById);
                    return (
                      <tr key={i}>
                        <td>
                          <input className={`form-input potions-cell ${problems.ingredient ? 'potions-cell-bad' : ''}`} value={row.ingredient}
                            onChange={(e) => updateRow(i, { ingredient: e.target.value })} placeholder="Ingredient" />
                          {problems.ingredient && <div className="potions-cell-error">{problems.ingredient}</div>}
                        </td>
                        <td className="potions-col-amount">
                          <input className={`form-input potions-cell potions-cell-num ${problems.amount ? 'potions-cell-bad' : ''}`} value={row.amount}
                            onChange={(e) => updateRow(i, { amount: e.target.value })} inputMode="decimal" />
                          {problems.amount && <div className="potions-cell-error">{problems.amount}</div>}
                        </td>
                        <td>
                          <select className="form-input potions-cell potions-cell-unit" value={row.unit} onChange={(e) => updateRow(i, { unit: e.target.value })}>
                            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </td>
                        <td className="potions-resolved">
                          {resolved ? (
                            <span className="text-small">→ {resolved.item}{resolved.size ? ` · ${resolved.size}` : ''}</span>
                          ) : (
                            <button type="button" className="chip danger potions-chip-btn" onClick={goToPars}
                              title="No catalog match. Alias an item or add one on the Pars tab.">
                              <span className="chip-dot" />No match
                            </button>
                          )}
                          <select className="form-input potions-cell potions-cell-override" value={row.override_item_id || ''}
                            onChange={(e) => updateRow(i, { override_item_id: e.target.value })}
                            title="Override the purchasable this row resolves to">
                            <option value="">auto</option>
                            {pars.map((p) => <option key={p.id} value={p.id}>{p.item}</option>)}
                          </select>
                        </td>
                        <td className="col-desc">
                          <input className="form-input potions-cell" value={row.note || ''} placeholder="Note"
                            onChange={(e) => updateRow(i, { note: e.target.value })} />
                        </td>
                        <td>
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => deleteRow(i)} title="Remove row" aria-label={`Remove ${row.ingredient || 'row'}`}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-muted text-small potions-detail-foot">
              Amounts are per ONE serving. Purchase quantities still follow the standard scaling; per-serving math comes later.
            </div>
          </div>
        ) : (
          <div className="card potions-detail"><div className="potions-state text-muted">Pick a drink to edit its recipe.</div></div>
        )}
      </div>
    </div>
  );
}
