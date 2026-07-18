import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { EnhancementsSection, FlagsSyrupsSection } from './RecipeEditorSections';

// Shared recipe editor (the drink dossier, recipe card v2 / spec §4.1). One
// structured recipe per drink, per single serving, plus enhancement
// assignments, a linked housemade syrup, and flags. The shopping-list
// generator resolves each row's generic ingredient to a recommended
// purchasable through the par catalog's aliases (server-side authority; the
// resolver below is a DISPLAY mirror only). Debounced whole-dossier autosave;
// Mark reviewed flushes any pending save first. Review states: empty / draft /
// reviewed.
//
// Amount is OPTIONAL per row: a row with an amount serializes to a structured
// { ingredient, amount, unit } object; a row with a name only serializes to a
// plain string (the server par-scales it). Both shapes are valid on the wire.
//
// Two layouts share this one engine:
//   - layout="stacked" (Recipes tab, design 1a): formula + every section open.
//   - layout="tabbed"  (default; shopping-list Add-recipe drawer, design 1b):
//     Formula / Enhancements / Flags & syrups behind in-card tabs.
const UNITS = ['oz', 'dash', 'each', 'splash'];
export const REVIEW = {
  reviewed: { label: 'Reviewed', short: 'OK', kind: 'ok' },
  draft:    { label: 'Draft, needs review', short: 'Draft', kind: 'warn' },
  empty:    { label: 'No recipe yet', short: 'Empty', kind: 'danger' },
};

// Display-only mirror of potionCatalog's alias resolution (normalize, exact,
// then longest-substring with head-noun preference). Generation authority
// stays server-side; this only paints the "→ Tito's Vodka · 1.75L" hints.
export function normalizeName(name) {
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

// Typeahead: par items whose name OR any alias contains the typed text.
// Alias hits rank ahead of raw item-name hits (aliases are what the generator
// actually matches on), prefix hits ahead of mid-string hits. Deduped by
// par + label so one par surfaces at most once per distinct alias.
function buildSuggestions(text, pars, limit = 6) {
  const norm = normalizeName(text);
  if (norm.length < 2) return [];
  const out = [];
  const seen = new Set();
  const push = (label, par, rank) => {
    const key = `${par.id}:${normalizeName(label)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, par, rank });
  };
  for (const par of pars || []) {
    for (const alias of par.ingredient_aliases || []) {
      const na = normalizeName(alias);
      if (na && na.includes(norm)) push(alias, par, na.startsWith(norm) ? 0 : 2);
    }
    const ni = normalizeName(par.item);
    if (ni.includes(norm)) push(par.item, par, ni.startsWith(norm) ? 1 : 3);
  }
  out.sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return out.slice(0, limit);
}

// Amount is optional. A row only blocks the save when it is named-but-broken:
// a non-empty amount that is not a positive number. A blank amount is fine
// (par-scaled). A row with no name at all is dropped before send but still
// blocks the debounce so the user sees "fix highlighted rows".
function rowProblems(row) {
  const problems = {};
  if (!String(row.ingredient || '').trim()) problems.ingredient = 'Name this ingredient to save.';
  const raw = String(row.amount ?? '').trim();
  if (raw !== '') {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      problems.amount = 'Amount must be above 0, or leave it blank for par scaling.';
    }
  }
  return problems;
}

// Inline add-par (spec §3): the six existing roles; section is derived from
// role (matches all existing par rows), never shown.
const PAR_ROLES = ['spirit', 'wine', 'beer', 'mixer', 'garnish', 'supplies'];
const deriveSection = (role) =>
  ['spirit', 'wine', 'beer'].includes(role) ? 'liquorBeerWine' : 'everythingElse';

// Hydrate a stored ingredient (string or object) into an editable row.
const toEditableRow = (r, fallbackUnit) =>
  typeof r === 'string'
    ? { ingredient: r, amount: '', unit: fallbackUnit, note: '', _legacy: true }
    : {
        ingredient: r.ingredient || '', amount: r.amount ?? '', unit: r.unit || fallbackUnit,
        note: r.note || '', override_item_id: r.override_item_id || '',
      };

const RecipeEditor = forwardRef(function RecipeEditor(
  { drink, type, pars, onDrinkChange, onParsChange, onRowsChange, goToPars, autoFocusName, layout = 'tabbed', onStickyUnitChange },
  ref
) {
  const toast = useToast();
  const uid = useId();
  const [rows, setRows] = useState([]);     // editable copy of the recipe
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error | blocked
  const saveTimer = useRef(null);
  // Pending debounced save, with its TARGET bound in: { drink, type, rows,
  // name, dossier }. Binding target+payload together (instead of live-reading
  // at fire time) is what makes a fast selection switch safe: a stale timer can
  // never write drink B's data onto drink A (code-review critical fix).
  const pendingRef = useRef(null);
  const inFlightRef = useRef(null);
  const lastPersistOkRef = useRef(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Dossier fields (enhancements / syrup / flags), kept as one object in state
  // for render and mirrored to a ref so the debounce binds the live snapshot.
  const [dossier, setDossier] = useState({ enhancements: [], syrupId: '', batchable: false, hostedVisible: true });
  const dossierRef = useRef(dossier);
  dossierRef.current = dossier;

  // Sticky unit: the last unit chosen becomes the default for new rows and
  // duplicated/legacy rows, and is surfaced in the batch strip. Persists across
  // drink switches (this component stays mounted; only `drink` changes).
  const [stickyUnit, setStickyUnit] = useState('oz');
  const stickyUnitRef = useRef(stickyUnit);
  stickyUnitRef.current = stickyUnit;

  // Ingredient typeahead: which row's dropdown is open + the highlighted item.
  const [activeSuggestRow, setActiveSuggestRow] = useState(null);
  const [suggestIndex, setSuggestIndex] = useState(0);

  // Tabbed layout (drawer) active tab.
  const [activeTab, setActiveTab] = useState('formula');

  // Name editing (spec §2): off-menu drafts only. Active drinks keep the
  // static name; the Menu tab remains their name editor.
  const [nameDraft, setNameDraft] = useState(drink.name);
  const nameDraftRef = useRef(drink.name);
  useEffect(() => {
    setNameDraft(drink.name);
    nameDraftRef.current = drink.name;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drink.id]);
  const nameEditable = drink.is_active === false;
  const nameProblem = nameEditable && !String(nameDraft || '').trim()
    ? 'Name this drink to save.' : null;

  // Inline add-par state (one open form at a time, keyed by row index).
  const [addingParForRow, setAddingParForRow] = useState(null);
  const [parForm, setParForm] = useState({ item: '', size: '', role: 'mixer' });
  const [parSaving, setParSaving] = useState(false);
  const [parError, setParError] = useState('');
  const lastParRoleRef = useRef('mixer'); // sticky add-par role across rows

  const aliasIndex = useMemo(() => buildAliasIndex(pars || []), [pars]);
  const parsById = useMemo(() => new Map((pars || []).map((p) => [p.id, p])), [pars]);

  // Focus by element id after the next paint (batch entry keyboard flow).
  const focusEl = useCallback((id) => {
    setTimeout(() => { const el = document.getElementById(id); if (el) el.focus(); }, 0);
  }, []);

  const persist = useCallback(async (drk, tp, nextRows, pendingName, dsr, extra = {}, { silent = false } = {}) => {
    const clean = nextRows
      .filter((r) => String(r.ingredient || '').trim())
      .map((r) => {
        const name = String(r.ingredient).trim();
        const raw = String(r.amount ?? '').trim();
        // Name only, no amount → plain string (server par-scales it).
        if (raw === '') return name;
        const out = { ingredient: name, amount: Number(raw), unit: r.unit };
        if (String(r.note || '').trim()) out.note = String(r.note).trim();
        if (r.override_item_id) out.override_item_id = r.override_item_id;
        return out;
      });
    if (!silent) setSaveState('saving');
    const run = (async () => {
      try {
        const body = { ingredients: clean, ...extra };
        if (dsr) {
          // Every save carries the full dossier snapshot. [] clears
          // enhancements; null clears the syrup; both are idempotent when
          // unchanged, so rows-saves and dossier-saves share one path.
          body.enhancements = dsr.enhancements || [];
          body.syrup_id = dsr.syrupId ? dsr.syrupId : null;
          body.batchable = !!dsr.batchable;
          body.hosted_visible = dsr.hostedVisible !== false;
        }
        // Renames ride the same PUT, drafts only; pendingName comes from the
        // same binding as the rows (never a live ref read at flush time).
        const trimmedName = String(pendingName || '').trim();
        if (drk.is_active === false && trimmedName && trimmedName !== drk.name) body.name = trimmedName;
        const res = await api.put(`/${tp}/${drk.id}`, body);
        // Pass the BOUND type back so the parent writes the cache under the same
        // drink type this PUT targeted (cocktail/mocktail ids are independent
        // slugs; a mid-debounce type switch must not cross the write).
        onDrinkChange(res.data, tp);
        if (!silent) setSaveState('saved');
        lastPersistOkRef.current = true;
        return true;
      } catch (err) {
        if (!silent) setSaveState('error');
        toast.error(err?.fieldErrors?.ingredients || err?.message || `Recipe save failed for ${drk.name}.`);
        lastPersistOkRef.current = false;
        return false;
      }
    })();
    inFlightRef.current = run;
    try { return await run; } finally {
      if (inFlightRef.current === run) inFlightRef.current = null;
    }
  }, [toast, onDrinkChange]);

  // Flush any pending debounced save for the PREVIOUS drink (never drop edits,
  // never cross-save), used on drink switch, unmount, and the drawer's fold-in
  // (via the imperative ref handle). Awaits a PUT already on the wire first.
  const flushPending = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (inFlightRef.current) await inFlightRef.current;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) return persist(pending.drink, pending.type, pending.rows, pending.name, pending.dossier, {}, { silent: true });
    return lastPersistOkRef.current;
  }, [persist]);

  // (Re)hydrate rows + dossier when the drink changes.
  const drinkKey = `${type}:${drink.id}`;
  useEffect(() => {
    flushPending();
    setRows((drink.ingredients || []).map((r) => toEditableRow(r, stickyUnitRef.current)));
    setDossier({
      enhancements: Array.isArray(drink.enhancements) ? drink.enhancements : [],
      syrupId: drink.syrup_id || '',
      batchable: !!drink.batchable,
      hostedVisible: drink.hosted_visible !== false,
    });
    setSaveState('saved');
    setAddingParForRow(null);
    setActiveSuggestRow(null);
    setActiveTab('formula');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drinkKey]);

  // Unmount (tab switch away / drawer close): flush rather than drop. Register
  // once with [] through a ref so the cleanup does not fire on every parent
  // re-render (which would flush armed debounces early).
  const flushRef = useRef(flushPending);
  useEffect(() => { flushRef.current = flushPending; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { flushRef.current(); }, []);

  // Live non-empty row count for the parent (drawer fold-in gating).
  useEffect(() => {
    onRowsChange?.(rows.filter((r) => String(r.ingredient || '').trim()).length);
  }, [rows, onRowsChange]);

  const scheduleSave = useCallback((nextRows) => {
    if (!drink) return;
    const hasProblems = nextRows.some((r) => Object.keys(rowProblems(r)).length > 0);
    const nameBad = drink.is_active === false && !String(nameDraftRef.current || '').trim();
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (hasProblems || nameBad) { pendingRef.current = null; setSaveState('blocked'); return; }
    setSaveState('dirty');
    pendingRef.current = { drink, type, rows: nextRows, name: nameDraftRef.current, dossier: dossierRef.current };
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persist(pending.drink, pending.type, pending.rows, pending.name, pending.dossier);
    }, 800);
  }, [drink, type, persist]);

  const updateRow = (i, patch) => {
    setRows((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      scheduleSave(next);
      return next;
    });
  };
  const addRow = () => {
    setRows((prev) => {
      const next = [...prev, { ingredient: '', amount: '', unit: stickyUnitRef.current, note: '' }];
      setSaveState('blocked'); // new row is incomplete until named
      return next;
    });
  };
  const addRowAndFocus = () => {
    const newIndex = rowsRef.current.length;
    addRow();
    focusEl(`${uid}-ing-${newIndex}`);
  };
  const deleteRow = (i) => {
    setRows((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      scheduleSave(next);
      return next;
    });
  };

  // Dossier writes: mutate the ref-snapshot, set state, and schedule a save
  // through the same debounce that rows use (server COALESCEs untouched cols).
  const setDossierField = useCallback((patch) => {
    const next = { ...dossierRef.current, ...patch };
    dossierRef.current = next;
    setDossier(next);
    scheduleSave(rowsRef.current);
  }, [scheduleSave]);

  const enhToggle = useCallback((slug) => {
    const list = dossierRef.current.enhancements || [];
    const next = list.some((e) => e.slug === slug)
      ? list.filter((e) => e.slug !== slug)
      : [...list, { slug, pitch: '' }];
    setDossierField({ enhancements: next });
  }, [setDossierField]);
  const enhPitch = useCallback((slug, val) => {
    setDossierField({ enhancements: (dossierRef.current.enhancements || []).map((e) => (e.slug === slug ? { ...e, pitch: val } : e)) });
  }, [setDossierField]);
  const enhToggleFlavor = useCallback((slug, fl) => {
    setDossierField({
      enhancements: (dossierRef.current.enhancements || []).map((e) => {
        if (e.slug !== slug) return e;
        const flavors = e.flavors || [];
        return { ...e, flavors: flavors.includes(fl) ? flavors.filter((f) => f !== fl) : [...flavors, fl] };
      }),
    });
  }, [setDossierField]);
  const enhAddCustom = useCallback((slug) => {
    const list = dossierRef.current.enhancements || [];
    if (list.some((e) => e.slug === slug) || list.length >= 10) return;
    setDossierField({ enhancements: [...list, { slug, pitch: '' }] });
  }, [setDossierField]);
  const enhRemoveCustom = useCallback((slug) => {
    setDossierField({ enhancements: (dossierRef.current.enhancements || []).filter((e) => e.slug !== slug) });
  }, [setDossierField]);

  const markReviewed = useCallback(async () => {
    if (!drink) return false;
    // Guard HERE, not only on the button: Save & next and Cmd/Ctrl+Enter call
    // this directly, and a blocked state (incomplete row / blank name) must not
    // silently drop rows and mark the drink reviewed.
    const hasProblems = rowsRef.current.some((r) => Object.keys(rowProblems(r)).length > 0);
    const nameBad = drink.is_active === false && !String(nameDraftRef.current || '').trim();
    if (hasProblems || nameBad) {
      setSaveState('blocked');
      toast.error('Fix highlighted rows first.');
      return false;
    }
    // Flush-before-Mark-reviewed (spec §4 concurrency rule): cancel the pending
    // timer, let a PUT already on the wire land, then fold rows + dossier + the
    // explicit review state into ONE PUT.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingRef.current = null;
    if (inFlightRef.current) await inFlightRef.current;
    const ok = await persist(drink, type, rowsRef.current, nameDraftRef.current, dossierRef.current, { recipe_review: 'reviewed' });
    if (ok) toast.success('Marked reviewed.');
    return ok;
  }, [drink, type, persist, toast]);

  // Duplicate-from (batch strip): copy another drink's formula in, then save.
  const duplicateFrom = useCallback((sourceDrink) => {
    if (!sourceDrink) return;
    const next = (sourceDrink.ingredients || []).map((r) => toEditableRow(r, stickyUnitRef.current));
    setRows(next);
    scheduleSave(next);
    toast.success(`Copied formula from ${sourceDrink.name}.`);
  }, [scheduleSave, toast]);

  useImperativeHandle(ref, () => ({ flush: flushPending, markReviewed, duplicateFrom }), [flushPending, markReviewed, duplicateFrom]);

  const submitInlinePar = async (rowIndex, rowIngredient) => {
    setParSaving(true); setParError('');
    try {
      const res = await api.post('/potions/pars', {
        item: parForm.item, size: parForm.size || null, role: parForm.role,
        section: deriveSection(parForm.role), qty_per_100: 1, in_full_bar: false,
        ingredient_aliases: [rowIngredient],
      });
      onParsChange?.(res.data.par);
      lastParRoleRef.current = parForm.role;
      // Pin the new par onto the row so it resolves immediately.
      if (res.data.par?.id != null) updateRow(rowIndex, { override_item_id: res.data.par.id });
      setAddingParForRow(null);
    } catch (err) {
      setParError(err?.fieldErrors
        ? Object.values(err.fieldErrors).join(' ')
        : (err?.message || 'Could not add the item. Try again.'));
    } finally {
      setParSaving(false);
    }
  };

  const saveLabel = {
    saved: 'Saved', dirty: 'Saving…', saving: 'Saving…',
    error: 'Save failed, edit to retry', blocked: 'Fix highlighted rows to save',
  }[saveState];

  const review = REVIEW[drink.recipe_review] || REVIEW.draft;
  const stacked = layout === 'stacked';

  // Typeahead keyboard on the ingredient input.
  const acceptSuggestion = (i, sug) => {
    if (!sug) return;
    updateRow(i, { ingredient: sug.label, override_item_id: sug.par.id });
    setActiveSuggestRow(null);
    focusEl(`${uid}-amt-${i}`);
  };
  const onIngredientKeyDown = (i, e, suggestions) => {
    if (e.metaKey || e.ctrlKey) return; // reserve Cmd/Ctrl+Enter for save-and-next (bubbles up)
    if (activeSuggestRow === i && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIndex((x) => Math.min(x + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIndex((x) => Math.max(x - 1, 0)); return; }
      if (e.key === 'Enter') { e.preventDefault(); acceptSuggestion(i, suggestions[Math.min(suggestIndex, suggestions.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setActiveSuggestRow(null); return; }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      focusEl(`${uid}-amt-${i}`);
    }
  };
  const onAmountKeyDown = (i, e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) return; // reserve Cmd/Ctrl+Enter for save-and-next (bubbles up)
    e.preventDefault();
    if (i === rows.length - 1) addRowAndFocus();
    else focusEl(`${uid}-ing-${i + 1}`);
  };

  const formulaTable = (
    <div className="tbl-wrap">
      <table className="tbl potions-recipe-table">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th className="potions-col-amount">Amount</th>
            <th>Unit</th>
            <th>Resolves to</th>
            {stacked && <th className="col-desc">Note</th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={stacked ? 6 : 5} className="text-muted potions-state">No recipe drafted yet. Add the first ingredient to start the formula, or duplicate from a nearby drink.</td></tr>
          )}
          {rows.map((row, i) => {
            const problems = rowProblems(row);
            const resolved = resolveDisplay(row, aliasIndex, parsById);
            const noAmount = String(row.amount ?? '').trim() === '';
            const suggestions = activeSuggestRow === i ? buildSuggestions(row.ingredient, pars || []) : [];
            return (
              <tr key={i}>
                <td className="potions-ing-cell">
                  <input
                    id={`${uid}-ing-${i}`}
                    className={`input potions-cell ${problems.ingredient ? 'potions-cell-bad' : ''}`}
                    value={row.ingredient}
                    autoComplete="off"
                    onChange={(e) => { updateRow(i, { ingredient: e.target.value, override_item_id: '' }); setActiveSuggestRow(i); setSuggestIndex(0); }}
                    onFocus={() => { if (String(row.ingredient || '').trim()) { setActiveSuggestRow(i); setSuggestIndex(0); } }}
                    onKeyDown={(e) => onIngredientKeyDown(i, e, suggestions)}
                    onBlur={() => setActiveSuggestRow((cur) => (cur === i ? null : cur))}
                    placeholder="Ingredient"
                    aria-label="Ingredient name"
                  />
                  {suggestions.length > 0 && (
                    <div className="potions-suggest">
                      {suggestions.map((s, si) => (
                        <button
                          type="button"
                          key={`${s.par.id}:${s.label}`}
                          className={`potions-suggest-item ${si === Math.min(suggestIndex, suggestions.length - 1) ? 'active' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); acceptSuggestion(i, s); }}
                        >
                          <span className="potions-suggest-alias">{s.label}</span>
                          {normalizeName(s.label) !== normalizeName(s.par.item) && (
                            <span className="text-muted"> → {s.par.item}{s.par.size ? ` · ${s.par.size}` : ''}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {problems.ingredient && <div className="potions-cell-error">{problems.ingredient}</div>}
                </td>
                <td className="potions-col-amount">
                  <input
                    id={`${uid}-amt-${i}`}
                    className={`input potions-cell potions-cell-num ${problems.amount ? 'potions-cell-bad' : ''}`}
                    value={row.amount}
                    inputMode="decimal"
                    onChange={(e) => updateRow(i, { amount: e.target.value })}
                    onKeyDown={(e) => onAmountKeyDown(i, e)}
                    aria-label="Amount (optional)"
                  />
                  {noAmount && !problems.amount && <div className="potions-par-scaled">par-scaled</div>}
                  {problems.amount && <div className="potions-cell-error">{problems.amount}</div>}
                </td>
                <td>
                  <select className="select potions-cell potions-cell-unit" value={row.unit}
                    onChange={(e) => { updateRow(i, { unit: e.target.value }); setStickyUnit(e.target.value); onStickyUnitChange?.(e.target.value); }}>
                    {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </td>
                <td className="potions-resolved">
                  {resolved ? (
                    <span className="text-small">→ {resolved.item}{resolved.size ? ` · ${resolved.size}` : ''}</span>
                  ) : (
                    <>
                      <button type="button" className="chip danger potions-chip-btn"
                        onClick={() => { setAddingParForRow(i); setParForm({ item: row.ingredient, size: '', role: lastParRoleRef.current }); setParError(''); }}
                        title="No catalog match. Add the item here, or alias an existing one on the Pars tab.">
                        <span className="chip-dot" />No match, add to pars
                      </button>
                      {goToPars && <button type="button" className="btn btn-ghost btn-sm" onClick={goToPars}>Pars tab</button>}
                    </>
                  )}
                  {!resolved && addingParForRow === i && (
                    <div className="potions-addpar">
                      <input className="input potions-cell" value={parForm.item}
                        onChange={(e) => setParForm((f) => ({ ...f, item: e.target.value }))}
                        placeholder="Item name" aria-label="New par item name" />
                      <input className="input potions-cell" value={parForm.size}
                        onChange={(e) => setParForm((f) => ({ ...f, size: e.target.value }))}
                        placeholder="750mL, 12 pack, ea." aria-label="New par item size" />
                      <select className="select potions-cell" value={parForm.role}
                        onChange={(e) => setParForm((f) => ({ ...f, role: e.target.value }))}
                        aria-label="New par item role">
                        {PAR_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <div className="hstack" style={{ gap: '0.4rem' }}>
                        <button type="button" className="btn btn-sm" onClick={() => submitInlinePar(i, row.ingredient)}
                          disabled={parSaving || !parForm.item.trim()}>
                          {parSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingParForRow(null)}>Cancel</button>
                      </div>
                      {parError && <div className="potions-cell-error">{parError}</div>}
                    </div>
                  )}
                </td>
                {stacked && (
                  <td className="col-desc">
                    <input className="input potions-cell" value={row.note || ''} placeholder="Note"
                      onChange={(e) => updateRow(i, { note: e.target.value })} />
                  </td>
                )}
                <td>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => deleteRow(i)} title="Remove row" aria-label={`Remove ${row.ingredient || 'row'}`}>×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const enhancementsBlock = (
    <EnhancementsSection
      enhancements={dossier.enhancements}
      onToggle={enhToggle}
      onPitch={enhPitch}
      onToggleFlavor={enhToggleFlavor}
      onAddCustom={enhAddCustom}
      onRemoveCustom={enhRemoveCustom}
    />
  );
  const flagsBlock = (
    <FlagsSyrupsSection
      syrupId={dossier.syrupId}
      onSyrup={(v) => setDossierField({ syrupId: v })}
      batchable={dossier.batchable}
      onBatchable={(v) => setDossierField({ batchable: v })}
      hostedVisible={dossier.hostedVisible}
      onHostedVisible={(v) => setDossierField({ hostedVisible: v })}
    />
  );

  return (
    <div className="card potions-detail">
      <div className="potions-detail-head">
        <div className="hstack" style={{ gap: '0.6rem' }}>
          <span className="potions-detail-emoji">{drink.emoji || ''}</span>
          <div>
            {nameEditable ? (
              <input
                className={`input potions-cell potions-name-input ${nameProblem ? 'potions-cell-bad' : ''}`}
                value={nameDraft}
                autoFocus={autoFocusName}
                maxLength={255}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  nameDraftRef.current = e.target.value;
                  scheduleSave(rowsRef.current);
                }}
                placeholder="Drink name"
                aria-label="Drink name"
              />
            ) : (
              <div className="potions-detail-name">{drink.name}</div>
            )}
            {nameProblem && <div className="potions-cell-error">{nameProblem}</div>}
            <div className="text-muted text-small">{review.label} · {saveLabel}</div>
          </div>
        </div>
        <div className="hstack" style={{ gap: '0.5rem' }}>
          <span className={`chip ${review.kind}`}><span className="chip-dot" />{review.short}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addRowAndFocus}>Add ingredient</button>
          <button type="button" className="btn btn-sm" onClick={markReviewed} disabled={saveState === 'saving' || saveState === 'blocked'}>Mark reviewed</button>
        </div>
      </div>

      {stacked ? (
        <>
          {formulaTable}
          <div className="potions-section">
            <div className="potions-section-label">Enhancements</div>
            {enhancementsBlock}
          </div>
          <div className="potions-section">
            <div className="potions-section-label">Flags &amp; syrups</div>
            {flagsBlock}
          </div>
          <div className="text-muted text-small potions-detail-foot">
            Amounts are per ONE serving. A missing amount falls back to par scaling, shown as par-scaled, never an error.
          </div>
        </>
      ) : (
        <>
          <div className="potions-tabbar">
            <div className="seg">
              <button type="button" className={activeTab === 'formula' ? 'active' : ''} onClick={() => setActiveTab('formula')}>Formula</button>
              <button type="button" className={activeTab === 'enh' ? 'active' : ''} onClick={() => setActiveTab('enh')}>Enhancements ({(dossier.enhancements || []).length})</button>
              <button type="button" className={activeTab === 'flags' ? 'active' : ''} onClick={() => setActiveTab('flags')}>Flags &amp; syrups</button>
            </div>
          </div>
          {activeTab === 'formula' && (
            <>
              {formulaTable}
              <div className="text-muted text-small potions-detail-foot">
                Amounts are per ONE serving. A missing amount falls back to par scaling, shown as par-scaled.
              </div>
            </>
          )}
          {activeTab === 'enh' && <div className="potions-section">{enhancementsBlock}</div>}
          {activeTab === 'flags' && <div className="potions-section">{flagsBlock}</div>}
        </>
      )}
    </div>
  );
});

export default RecipeEditor;
