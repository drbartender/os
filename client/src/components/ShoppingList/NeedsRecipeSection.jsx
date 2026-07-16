import React, { useRef, useState } from 'react';
import api from '../../utils/api';
import Drawer from '../adminos/Drawer';
import RecipeEditor, { normalizeName } from '../potions/RecipeEditor';

// Client-requested drinks with no recipe yet, plus the drawer that authors the
// recipe in place (no navigation away from the shopping list). Fold-in happens
// via the modal's regenerate, confirm-gated because it replaces manual edits.
export default function NeedsRecipeSection({ needsRecipe, unresolved, onRegenerate }) {
  const [addingRecipe, setAddingRecipe] = useState(null); // name being created, or null
  const [addRecipeError, setAddRecipeError] = useState('');
  const [drawerTarget, setDrawerTarget] = useState(null); // { drink, type } or null
  const [pars, setPars] = useState(null);                 // lazy: fetched on first drawer open
  const [parsError, setParsError] = useState(false);
  const [rowCount, setRowCount] = useState(0);
  const drinkListsRef = useRef(null);                     // { cocktails, mocktails } lazy cache
  const editorRef = useRef(null); // RecipeEditor flush handle (imperative ref)

  const loadPars = async () => {
    try {
      const res = await api.get('/potions/pars');
      setPars(res.data.pars || []);
      setParsError(false);
    } catch (err) {
      setPars([]);
      setParsError(true);
    }
  };

  // Reuse before create (spec §2): the same client string must land on the
  // SAME draft across re-clicks and across plans, never mint a "<slug>-2"
  // duplicate or dead-end on ConflictError. Normalized match against names
  // AND request_aliases of both admin lists.
  const findExistingDrink = async (name) => {
    if (!drinkListsRef.current) {
      const [c, m] = await Promise.all([
        api.get('/cocktails/admin'),
        api.get('/mocktails/admin'),
      ]);
      drinkListsRef.current = {
        cocktails: c.data.cocktails || [],
        mocktails: m.data.mocktails || [],
      };
    }
    // Mirror of the server matcher's matchKey (shoppingListGen.js): strip
    // apostrophes BEFORE normalizing so "jennys" reuses the "Jenny's" draft.
    const matchKey = (s) => normalizeName(String(s ?? '').replace(/['’]/g, ''));
    const norm = matchKey(name);
    for (const type of ['cocktails', 'mocktails']) {
      for (const drink of drinkListsRef.current[type]) {
        const names = [drink.name, ...(drink.request_aliases || [])];
        if (names.some((n) => matchKey(n) === norm)) return { drink, type };
      }
    }
    return null;
  };

  const handleAddRecipe = async (name) => {
    setAddingRecipe(name);
    setAddRecipeError('');
    try {
      if (pars === null) loadPars();
      const existing = await findExistingDrink(name);
      if (existing) {
        setRowCount((existing.drink.ingredients || []).length);
        setDrawerTarget({ ...existing, isNew: (existing.drink.ingredients || []).length === 0 });
        return;
      }
      const res = await api.post('/cocktails', {
        name, is_active: false, request_aliases: [name],
      });
      drinkListsRef.current.cocktails.push(res.data); // future re-clicks reuse it
      setRowCount(0);
      setDrawerTarget({ drink: res.data, type: 'cocktails', isNew: true });
    } catch (err) {
      setAddRecipeError(err?.message || `Could not add "${name}". Try again.`);
    } finally {
      setAddingRecipe(null);
    }
  };

  const closeDrawer = async () => {
    const target = drawerTarget;
    // Flush BEFORE deciding/folding: regenerate reads the drink tables, so an
    // edit still inside the editor's debounce (or a PUT still on the wire)
    // would fold in a stale recipe (review finding: silent incomplete list).
    // A failed flush already toasted; skip the fold-in prompt rather than
    // offer to fold a recipe that did not save.
    let flushedOk = true;
    try { flushedOk = (await editorRef.current?.flush()) !== false; } catch (_) { flushedOk = false; }
    setDrawerTarget(null);
    if (!flushedOk) return;
    if (target && rowCount > 0 && window.confirm(
      `Fold "${target.drink.name}" into the list? Regenerating replaces your manual edits, and saving will set the list back to Needs review.`
    )) {
      onRegenerate();
    }
  };

  const hasNeedsRecipe = Array.isArray(needsRecipe) && needsRecipe.length > 0;
  const hasUnresolved = Array.isArray(unresolved) && unresolved.length > 0;
  if (!hasNeedsRecipe && !hasUnresolved && !drawerTarget) return null;

  return (
    <>
      {/* ── Recipe ingredients missing from the par catalog (spec §4) ── */}
      {hasUnresolved && (
        <div style={{
          margin: '0.75rem 1.25rem 0', backgroundColor: 'var(--bg-2)',
          border: '1px solid var(--accent-line)', borderRadius: 'var(--radius)',
          padding: '0.75rem 0.875rem',
        }}>
          <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
            Missing from the par catalog (NOT on this list)
          </p>
          {unresolved.map((u, i) => (
            <div key={`${u.drink}-${u.ingredient}-${i}`} style={{ color: 'var(--ink-2)', fontSize: '0.85rem', padding: '0.15rem 0' }}>
              {u.drink}: {u.ingredient}
            </div>
          ))}
          <p style={{ color: 'var(--ink-3)', fontSize: '0.78rem', margin: '0.5rem 0 0' }}>
            Add the item from the recipe editor, or alias an existing one on the Pars tab, then regenerate.
          </p>
        </div>
      )}

      {/* ── Client-requested drinks with no recipe yet ── */}
      {hasNeedsRecipe && (
        <div style={{
          margin: '0.75rem 1.25rem 0',
          backgroundColor: 'var(--bg-2)',
          border: '1px solid var(--accent-line)',
          borderRadius: 'var(--radius)',
          padding: '0.75rem 0.875rem',
        }}>
          <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
            Client requested: recipe needed
          </p>
          {needsRecipe.map((entry, i) => (
            <div
              key={(entry.name || '') + '-' + i}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '0.75rem', padding: '0.25rem 0',
              }}
            >
              <span style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>{entry.name}</span>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => handleAddRecipe(entry.name)}
                disabled={addingRecipe !== null}
                style={{ whiteSpace: 'nowrap' }}
              >
                {addingRecipe === entry.name ? 'Adding…' : 'Add recipe'}
              </button>
            </div>
          ))}
          {addRecipeError && (
            <p style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
              {addRecipeError}
            </p>
          )}
        </div>
      )}

      {/* ── Recipe drawer (paints above the modal: same portal subtree) ── */}
      <Drawer
        open={!!drawerTarget}
        onClose={closeDrawer}
        crumb={<span className="drawer-crumb">{drawerTarget?.isNew === false ? 'Potions · Recipe' : 'Potions · New recipe'}</span>}
      >
        {drawerTarget && (
          pars === null ? (
            <div className="potions-state text-muted">Loading catalog…</div>
          ) : (
            <>
              {parsError && (
                <div className="potions-state text-muted">
                  Par catalog failed to load; every row will read No match.{' '}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={loadPars}>Retry</button>
                </div>
              )}
              <RecipeEditor
                ref={editorRef}
                drink={drawerTarget.drink}
                type={drawerTarget.type}
                pars={pars}
                autoFocusName
                onDrinkChange={(u) => setDrawerTarget((prev) => (prev ? { ...prev, drink: { ...prev.drink, ...u } } : prev))}
                onParsChange={(p) => setPars((prev) => [...(prev || []), p])}
                onRowsChange={setRowCount}
              />
            </>
          )
        )}
      </Drawer>
    </>
  );
}
