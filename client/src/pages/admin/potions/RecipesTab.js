import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import RecipeEditor, { normalizeName, REVIEW } from '../../../components/potions/RecipeEditor';

// Potions · Recipes tab (design 1a: master-detail + batch-pass strip). The
// master list, search, seg control, and data loading live here; the editable
// detail pane (rows, debounced autosave/flush, name editing, inline add-par,
// enhancements/syrup/flags) is the shared RecipeEditor in its stacked layout.
// The batch strip drives the owner's one-time recipe pass: a progress meter,
// the sticky unit, Duplicate-from, and Save & next (also Cmd/Ctrl+Enter).
export default function RecipesTab({ focusDrinkId, onConsumeFocus, goToPars }) {
  const [drinkType, setDrinkType] = useState('cocktails');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);   // { cocktails: [...], mocktails: [...] }
  const [pars, setPars] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [stickyUnit, setStickyUnit] = useState('oz');
  const editorRef = useRef(null);

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

  const q = normalizeName(search);
  const list = useMemo(
    () => drinks.filter((d) => !q || normalizeName(d.name).includes(q)),
    [drinks, q]
  );

  const total = drinks.length;
  const reviewedCount = drinks.filter((d) => d.recipe_review === 'reviewed').length;
  const pct = total ? Math.round((reviewedCount / total) * 100) : 0;

  // Next unreviewed drink after the current one, wrapping around the visible
  // list (drafts count off recipe_review draft/empty, i.e. not 'reviewed').
  const nextDraftAfter = useCallback((currentId) => {
    if (list.length === 0) return null;
    const idx = list.findIndex((d) => d.id === currentId);
    for (let k = 1; k <= list.length; k++) {
      const d = list[(idx + k) % list.length];
      if (d && d.id !== currentId && d.recipe_review !== 'reviewed') return d;
    }
    return null;
  }, [list]);
  const nextDraft = selected ? nextDraftAfter(selected.id) : (list.find((d) => d.recipe_review !== 'reviewed') || null);

  const dupOpts = useMemo(
    () => drinks.filter((d) => selected && d.id !== selected.id && Array.isArray(d.ingredients) && d.ingredients.length > 0),
    [drinks, selected]
  );

  const applyDrinkChange = useCallback((updated, forType) => {
    setData((prev) => ({
      ...prev,
      [forType]: prev[forType].map((d) => (d.id === updated.id ? { ...d, ...updated } : d)),
    }));
  }, []);

  const handleSaveNext = useCallback(async () => {
    if (!editorRef.current || !selected) return;
    const ok = await editorRef.current.markReviewed();
    if (ok) {
      const nxt = nextDraftAfter(selected.id);
      if (nxt) setSelectedId(nxt.id);
    }
  }, [selected, nextDraftAfter]);

  const handleDuplicate = useCallback((sourceId) => {
    if (!sourceId) return;
    const src = drinks.find((d) => d.id === sourceId);
    if (src) editorRef.current?.duplicateFrom(src);
  }, [drinks]);

  const onKeyDown = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleSaveNext(); }
  }, [handleSaveNext]);

  if (loadError) {
    return (
      <div className="card"><div className="potions-state">
        <span className="text-muted">{loadError}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (!data) return <div className="card"><div className="potions-state text-muted">Loading recipes…</div></div>;

  return (
    <div className="potions-recipes" onKeyDown={onKeyDown}>
      <div className="hstack potions-toolbar">
        <div className="seg">
          <button type="button" className={drinkType === 'cocktails' ? 'active' : ''} onClick={() => setDrinkType('cocktails')}>Cocktails</button>
          <button type="button" className={drinkType === 'mocktails' ? 'active' : ''} onClick={() => setDrinkType('mocktails')}>Mocktails</button>
        </div>
        <span className="text-muted text-small">{reviewedCount} of {total} reviewed</span>
      </div>

      <div className="card potions-batch-strip">
        <div className="potions-batch-progress">
          <div className="potions-batch-progress-label">Recipe pass</div>
          <div className="potions-batch-bar"><div className="potions-batch-bar-fill" style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="potions-batch-count">{reviewedCount}/{total}</div>
        <div className="text-small potions-batch-next">Up next: <strong>{nextDraft ? nextDraft.name : 'all reviewed'}</strong></div>
        <div className="potions-batch-spacer" />
        <div className="text-muted text-small">Sticky unit: <span className="potions-batch-unit">{stickyUnit}</span></div>
        <select className="select potions-batch-dup" value="" disabled={dupOpts.length === 0}
          onChange={(e) => { handleDuplicate(e.target.value); e.target.value = ''; }} aria-label="Duplicate formula from">
          <option value="">Duplicate from…</option>
          {dupOpts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveNext} disabled={!selected}>
          Save &amp; next <span className="potions-kbd">⌘↵</span>
        </button>
      </div>

      <div className="potions-split">
        <div className="card potions-master">
          <div className="potions-master-search">
            <input className="input" placeholder="Find a recipe…" value={search} onChange={(e) => setSearch(e.target.value)} />
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
          <RecipeEditor
            ref={editorRef}
            drink={selected}
            type={drinkType}
            pars={pars}
            layout="stacked"
            onStickyUnitChange={setStickyUnit}
            onDrinkChange={applyDrinkChange}
            onParsChange={(par) => setPars((prev) => [...prev, par])}
            goToPars={goToPars}
          />
        ) : (
          <div className="card potions-detail"><div className="potions-state text-muted">Pick a drink to edit its recipe.</div></div>
        )}
      </div>
    </div>
  );
}
