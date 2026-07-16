import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import RecipeEditor, { normalizeName, REVIEW } from '../../../components/potions/RecipeEditor';

// Potions · Recipes tab (design master-detail). The master list, search, seg
// control, and data loading live here; the editable detail pane (rows,
// debounced autosave/flush, name editing, inline add-par) is the shared
// RecipeEditor, also mounted by the shopping-list Add-recipe drawer.
export default function RecipesTab({ focusDrinkId, onConsumeFocus, goToPars }) {
  const [drinkType, setDrinkType] = useState('cocktails');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);   // { cocktails: [...], mocktails: [...] }
  const [pars, setPars] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

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
            drink={selected}
            type={drinkType}
            pars={pars}
            onDrinkChange={(updated) => setData((prev) => ({
              ...prev,
              [drinkType]: prev[drinkType].map((d) => (d.id === updated.id ? { ...d, ...updated } : d)),
            }))}
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
