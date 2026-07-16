import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

// Shared recipe editor (extracted from the Recipes tab). One structured recipe
// per drink, per single serving; the shopping-list generator resolves each
// row's generic ingredient to a recommended purchasable through the par
// catalog's aliases (server-side authority; the resolver below is a DISPLAY
// mirror only). Debounced whole-recipe autosave; Mark reviewed flushes any
// pending save first. Review states: empty / draft / reviewed. Mounted in the
// Recipes tab detail pane and in the shopping-list Add-recipe drawer.
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

function rowProblems(row) {
  const problems = {};
  if (!String(row.ingredient || '').trim()) problems.ingredient = 'Name this ingredient to save.';
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) problems.amount = 'Fix amount to save.';
  if (!UNITS.includes(row.unit)) problems.unit = 'Pick a unit.';
  return problems;
}

// Inline add-par (spec §3): the six existing roles; section is derived from
// role (matches all existing par rows), never shown.
const PAR_ROLES = ['spirit', 'wine', 'beer', 'mixer', 'garnish', 'supplies'];
const deriveSection = (role) =>
  ['spirit', 'wine', 'beer'].includes(role) ? 'liquorBeerWine' : 'everythingElse';

const RecipeEditor = forwardRef(function RecipeEditor(
  { drink, type, pars, onDrinkChange, onParsChange, onRowsChange, goToPars, autoFocusName },
  ref
) {
  const toast = useToast();
  const [rows, setRows] = useState([]);     // editable copy of the recipe
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error | blocked
  const saveTimer = useRef(null);
  // Pending debounced save, with its TARGET bound in: { drink, type, rows, name }.
  // Binding target+payload together (instead of live-reading rows at fire
  // time) is what makes a fast selection switch safe: a stale timer can
  // never write drink B's rows onto drink A (code-review critical fix).
  const pendingRef = useRef(null);
  // The persist currently on the wire (null when idle) and whether the most
  // recent persist succeeded; flush() awaits the former and reports the latter
  // so the drawer's fold-in never regenerates over an uncommitted or failed save.
  const inFlightRef = useRef(null);
  const lastPersistOkRef = useRef(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Name editing (spec §2): off-menu drafts only. Active drinks keep the
  // static name; the Menu tab remains their name editor.
  const [nameDraft, setNameDraft] = useState(drink.name);
  const nameDraftRef = useRef(drink.name);
  useEffect(() => {
    setNameDraft(drink.name);
    nameDraftRef.current = drink.name;
    // Reset on drink switch only; depending on drink.name would clobber
    // in-progress typing after every rename persist.
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

  const aliasIndex = useMemo(() => buildAliasIndex(pars || []), [pars]);
  const parsById = useMemo(() => new Map((pars || []).map((p) => [p.id, p])), [pars]);

  const persist = useCallback(async (drink, type, nextRows, pendingName, extra = {}, { silent = false } = {}) => {
    const clean = nextRows
      .filter((r) => String(r.ingredient || '').trim())
      .map((r) => {
        const out = { ingredient: String(r.ingredient).trim(), amount: Number(r.amount), unit: r.unit };
        if (String(r.note || '').trim()) out.note = String(r.note).trim();
        if (r.override_item_id) out.override_item_id = r.override_item_id;
        return out;
      });
    if (!silent) setSaveState('saving');
    const run = (async () => {
      try {
        const body = { ingredients: clean, ...extra };
        // Renames ride the same PUT, drafts only; pendingName comes from the
        // same binding as the rows (never a live ref read at flush time).
        const trimmedName = String(pendingName || '').trim();
        if (drink.is_active === false && trimmedName && trimmedName !== drink.name) body.name = trimmedName;
        const res = await api.put(`/${type}/${drink.id}`, body);
        onDrinkChange(res.data);
        if (!silent) setSaveState('saved');
        lastPersistOkRef.current = true;
        return true;
      } catch (err) {
        if (!silent) setSaveState('error');
        // api.js rejects a plain { message, fieldErrors, status } object.
        toast.error(err?.fieldErrors?.ingredients || `Recipe save failed for ${drink.name}.`);
        lastPersistOkRef.current = false;
        return false;
      }
    })();
    inFlightRef.current = run;
    try { return await run; } finally {
      if (inFlightRef.current === run) inFlightRef.current = null;
    }
  }, [toast, onDrinkChange]);

  // Flush any pending debounced save for the PREVIOUS drink (never drop
  // edits, never cross-save), used on drink switch, unmount, and the drawer's
  // fold-in (via the imperative ref handle). Awaits a PUT already on the wire
  // first: the fold-in regenerate reads the drink tables, so returning before
  // an in-flight persist commits would fold a stale recipe. Returns false if
  // the flushed (or last) persist failed, so callers can skip the fold-in.
  const flushPending = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (inFlightRef.current) await inFlightRef.current;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) return persist(pending.drink, pending.type, pending.rows, pending.name, {}, { silent: true });
    return lastPersistOkRef.current;
  }, [persist]);

  useImperativeHandle(ref, () => ({ flush: flushPending }), [flushPending]);

  // (Re)hydrate the editable rows when the drink changes.
  const drinkKey = `${type}:${drink.id}`;
  useEffect(() => {
    flushPending();
    const structured = (drink.ingredients || []).map((r) =>
      typeof r === 'string'
        ? { ingredient: r, amount: '', unit: 'oz', note: '', _legacy: true }
        : { ingredient: r.ingredient || '', amount: r.amount ?? '', unit: r.unit || 'oz', note: r.note || '', override_item_id: r.override_item_id || '' }
    );
    setRows(structured);
    setSaveState('saved');
    setAddingParForRow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drinkKey]);

  // Unmount (tab switch away / drawer close): flush rather than drop. MUST be
  // registered once with [] deps through a ref: flushPending's identity tracks
  // the parents' inline callback props, and depending on it here made the
  // cleanup fire on every parent re-render, flushing armed debounces early
  // (full-fleet finding).
  const flushRef = useRef(flushPending);
  useEffect(() => { flushRef.current = flushPending; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { flushRef.current(); }, []);

  // Live non-empty row count for the parent (drawer fold-in gating). Fires on
  // every rows change, pre-save.
  useEffect(() => {
    onRowsChange?.(rows.filter((r) => String(r.ingredient || '').trim()).length);
  }, [rows, onRowsChange]);

  const scheduleSave = useCallback((nextRows) => {
    if (!drink) return;
    const hasProblems = nextRows.some((r) => Object.keys(rowProblems(r)).length > 0);
    // Read the name from the ref, not render state: scheduleSave runs
    // synchronously after a keystroke, before React re-renders.
    const nameBad = drink.is_active === false && !String(nameDraftRef.current || '').trim();
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (hasProblems || nameBad) { pendingRef.current = null; setSaveState('blocked'); return; }
    setSaveState('dirty');
    pendingRef.current = { drink, type, rows: nextRows, name: nameDraftRef.current };
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persist(pending.drink, pending.type, pending.rows, pending.name);
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
    if (!drink) return;
    // Flush-before-Mark-reviewed (spec §4 concurrency rule): cancel the
    // pending timer and fold everything into ONE PUT carrying the rows +
    // the explicit review state.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingRef.current = null;
    const ok = await persist(drink, type, rowsRef.current, nameDraftRef.current, { recipe_review: 'reviewed' });
    if (ok) toast.success('Marked reviewed.');
  };

  const submitInlinePar = async (rowIngredient) => {
    setParSaving(true); setParError('');
    try {
      const res = await api.post('/potions/pars', {
        item: parForm.item, size: parForm.size || null, role: parForm.role,
        section: deriveSection(parForm.role), qty_per_100: 1, in_full_bar: false,
        ingredient_aliases: [rowIngredient],
      });
      onParsChange?.(res.data.par);
      setAddingParForRow(null);
    } catch (err) {
      // Surface field-level errors (api.js rejects { message, fieldErrors }).
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
                  // Sync the ref BEFORE scheduleSave: the armed payload must carry THIS
                  // keystroke (the render-synced mirror would be one keystroke stale).
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
            <div className="text-muted text-small">
              {(REVIEW[drink.recipe_review] || REVIEW.draft).label} · {saveLabel}
            </div>
          </div>
        </div>
        <div className="hstack" style={{ gap: '0.5rem' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>Add ingredient</button>
          <button type="button" className="btn btn-sm" onClick={markReviewed} disabled={saveState === 'saving' || saveState === 'blocked'}>Mark reviewed</button>
        </div>
      </div>

      <div className="tbl-wrap">
        <table className="tbl potions-recipe-table">
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
                    <input className={`input potions-cell ${problems.ingredient ? 'potions-cell-bad' : ''}`} value={row.ingredient}
                      onChange={(e) => updateRow(i, { ingredient: e.target.value })} placeholder="Ingredient" />
                    {problems.ingredient && <div className="potions-cell-error">{problems.ingredient}</div>}
                  </td>
                  <td className="potions-col-amount">
                    <input className={`input potions-cell potions-cell-num ${problems.amount ? 'potions-cell-bad' : ''}`} value={row.amount}
                      onChange={(e) => updateRow(i, { amount: e.target.value })} inputMode="decimal" />
                    {problems.amount && <div className="potions-cell-error">{problems.amount}</div>}
                  </td>
                  <td>
                    <select className="select potions-cell potions-cell-unit" value={row.unit} onChange={(e) => updateRow(i, { unit: e.target.value })}>
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </td>
                  <td className="potions-resolved">
                    {resolved ? (
                      <span className="text-small">→ {resolved.item}{resolved.size ? ` · ${resolved.size}` : ''}</span>
                    ) : (
                      <>
                        <button type="button" className="chip danger potions-chip-btn"
                          onClick={() => { setAddingParForRow(i); setParForm({ item: row.ingredient, size: '', role: 'mixer' }); setParError(''); }}
                          title="No catalog match. Add the item here, or alias an existing one on the Pars tab.">
                          <span className="chip-dot" />No match
                        </button>
                        {goToPars && <button type="button" className="btn btn-ghost btn-sm" onClick={goToPars}>Pars tab</button>}
                      </>
                    )}
                    <select className="select potions-cell potions-cell-override" value={row.override_item_id || ''}
                      onChange={(e) => updateRow(i, { override_item_id: e.target.value })}
                      title="Override the purchasable this row resolves to">
                      <option value="">auto</option>
                      {(pars || []).map((p) => <option key={p.id} value={p.id}>{p.item}</option>)}
                    </select>
                    {!resolved && addingParForRow === i && (
                      <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
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
                          <button type="button" className="btn btn-sm" onClick={() => submitInlinePar(row.ingredient)}
                            disabled={parSaving || !parForm.item.trim()}>
                            {parSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingParForRow(null)}>Cancel</button>
                        </div>
                        {parError && <div className="potions-cell-error">{parError}</div>}
                      </div>
                    )}
                  </td>
                  <td className="col-desc">
                    <input className="input potions-cell" value={row.note || ''} placeholder="Note"
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
  );
});

export default RecipeEditor;
