import React, { useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import Drawer from '../adminos/Drawer';
import RecipeEditor from '../potions/RecipeEditor';
import { matchKey, rankDrinkMatches } from '../../utils/rankDrinkMatches';

// Client-requested drinks with no recipe yet, plus the two ways an admin
// resolves one in place (no navigation away from the shopping list):
//   Match existing: the text IS a drink we already have ("old fashion"). The
//     client's exact text is remembered as an alias on that drink, so the
//     server matcher resolves it on every future plan without an admin touch.
//   Add recipe: author a new recipe in the drawer (reuse-before-create).
// Fold-in happens via the modal's regenerate, confirm-gated because it
// replaces manual edits.
const foldPrompt = (name) => `Fold "${name}" into the list? Regenerating replaces your manual edits, and saving will set the list back to Needs review.`;

const DANGER = 'hsl(var(--danger-h) var(--danger-s) 55%)';

function drinkTags(drink) {
  return [
    (drink.ingredients || []).length > 0 ? 'Recipe ready' : 'No recipe',
    drink.table === 'mocktails' ? 'Mocktail' : null,
    drink.is_active === false ? 'Off menu' : null,
  ].filter(Boolean);
}

export default function NeedsRecipeSection({ needsRecipe, unresolved, onRegenerate }) {
  const [addingRecipe, setAddingRecipe] = useState(null); // name being created, or null
  const [addRecipeError, setAddRecipeError] = useState('');
  const [drawerTarget, setDrawerTarget] = useState(null); // { drink, type } or null
  const [pars, setPars] = useState(null);                 // lazy: fetched on first drawer open
  const [parsError, setParsError] = useState(false);
  const [rowCount, setRowCount] = useState(0);
  // Both admin drink lists, fetched once on first use (reuse lookup or the
  // Match-existing picker). The ref is the read-after-await source of truth;
  // the state mirror is what the picker renders from. Kept current as this
  // section creates drinks or appends aliases, so a later click sees what an
  // earlier one did.
  const drinkListsRef = useRef(null);
  const drinkListsPromiseRef = useRef(null);
  const [drinkLists, setDrinkLists] = useState(null);
  // Match-existing picker for the ONE row that has it open, or null.
  const [matching, setMatching] = useState(null); // { index, name, query, busy, error }
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

  const commitDrinkLists = (next) => {
    drinkListsRef.current = next;
    setDrinkLists(next);
  };

  const loadDrinkLists = () => {
    if (!drinkListsPromiseRef.current) {
      drinkListsPromiseRef.current = Promise.all([
        api.get('/cocktails/admin'),
        api.get('/mocktails/admin'),
      ]).then(([c, m]) => {
        commitDrinkLists({ cocktails: c.data.cocktails || [], mocktails: m.data.mocktails || [] });
      }).catch((err) => {
        drinkListsPromiseRef.current = null; // the next click retries
        throw err;
      });
    }
    return drinkListsPromiseRef.current;
  };

  // Reuse before create (spec §2): the same client string must land on the
  // SAME draft across re-clicks and across plans, never mint a "<slug>-2"
  // duplicate or dead-end on ConflictError. Normalized match against names
  // AND request_aliases of both admin lists, with the server matcher's key
  // (apostrophes stripped first so "jennys" reuses the "Jenny's" draft).
  const findExistingDrink = async (name) => {
    await loadDrinkLists();
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
      // Future re-clicks reuse it.
      commitDrinkLists({ ...drinkListsRef.current, cocktails: [...drinkListsRef.current.cocktails, res.data] });
      setRowCount(0);
      setDrawerTarget({ drink: res.data, type: 'cocktails', isNew: true });
    } catch (err) {
      setAddRecipeError(err?.message || `Could not add "${name}". Try again.`);
    } finally {
      setAddingRecipe(null);
    }
  };

  // ── Match existing ──────────────────────────────────────────────
  const openMatch = (index, name) => {
    setMatching({ index, name, query: name, busy: false, error: '' });
    if (pars === null) loadPars(); // a no-recipe pick opens the drawer, which needs the catalog
    loadDrinkLists().catch(() => {
      setMatching((m) => (m && m.index === index ? { ...m, error: 'Could not load the drink lists. Close and try again.' } : m));
    });
  };

  const drinkPool = useMemo(() => (drinkLists ? [
    ...drinkLists.cocktails.map((d) => ({ ...d, table: 'cocktails' })),
    ...drinkLists.mocktails.map((d) => ({ ...d, table: 'mocktails' })),
  ] : null), [drinkLists]);
  const suggestions = useMemo(
    () => (matching && drinkPool ? rankDrinkMatches(matching.query, drinkPool, { limit: 6 }) : []),
    [matching, drinkPool]
  );

  const pickMatch = async (drink) => {
    const { name } = matching;
    setMatching((m) => (m ? { ...m, busy: true, error: '' } : m));
    try {
      const res = await api.post(`/${drink.table}/${drink.id}/request-aliases`, { alias: name });
      const updated = res.data;
      commitDrinkLists({
        ...drinkListsRef.current,
        [drink.table]: drinkListsRef.current[drink.table].map((d) => (d.id === updated.id ? updated : d)),
      });
      setMatching(null);
      if ((updated.ingredients || []).length > 0) {
        if (window.confirm(foldPrompt(updated.name))) onRegenerate();
      } else {
        // The drink exists but has no recipe yet: author it right here. The
        // alias just written means the fold-in and any later Add recipe on
        // this text land on THIS drink, never a new one.
        setRowCount(0);
        setDrawerTarget({ drink: updated, type: drink.table, isNew: true });
      }
    } catch (err) {
      setMatching((m) => (m ? {
        ...m, busy: false, error: err?.fieldErrors?.alias || err?.message || 'Could not match. Try again.',
      } : m));
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
    if (target && rowCount > 0 && window.confirm(foldPrompt(target.drink.name))) {
      onRegenerate();
    }
  };

  const hasNeedsRecipe = Array.isArray(needsRecipe) && needsRecipe.length > 0;
  const hasUnresolved = Array.isArray(unresolved) && unresolved.length > 0;
  if (!hasNeedsRecipe && !hasUnresolved && !drawerTarget) return null;

  const actionsLocked = addingRecipe !== null || Boolean(matching?.busy);

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
            <div key={(entry.name || '') + '-' + i}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '0.75rem', padding: '0.25rem 0',
              }}>
                <span style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>{entry.name}</span>
                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => openMatch(i, entry.name)}
                    disabled={actionsLocked}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    Match existing
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => handleAddRecipe(entry.name)}
                    disabled={actionsLocked}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {addingRecipe === entry.name ? 'Adding…' : 'Add recipe'}
                  </button>
                </div>
              </div>

              {/* Anchored by index AND name: a regenerate replaces the list, and
                  a picker must never paint under a different request. */}
              {matching && matching.index === i && matching.name === entry.name && (
                <div style={{
                  margin: '0.25rem 0 0.5rem', padding: '0.6rem 0.7rem',
                  border: '1px solid var(--accent-line)', borderRadius: 'var(--radius)',
                  backgroundColor: 'var(--bg-1)',
                }}>
                  <p style={{ color: 'var(--ink-3)', fontSize: '0.78rem', margin: '0 0 0.4rem' }}>
                    Which of our drinks is "{matching.name}"? We'll remember it, so the next client who types this is matched automatically.
                  </p>
                  <input
                    type="text"
                    className="form-input"
                    aria-label="Search our drinks"
                    placeholder="Search our drinks"
                    value={matching.query}
                    onChange={(e) => setMatching((m) => (m ? { ...m, query: e.target.value } : m))}
                    disabled={matching.busy}
                    autoFocus
                  />
                  {drinkPool === null && !matching.error && (
                    <p style={{ color: 'var(--ink-3)', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>Loading drinks…</p>
                  )}
                  {drinkPool !== null && suggestions.length === 0 && (
                    <p style={{ color: 'var(--ink-3)', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>
                      No close match. Try another spelling, or use Add recipe.
                    </p>
                  )}
                  {suggestions.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.4rem' }}>
                      {suggestions.map((d) => (
                        <button
                          key={`${d.table}-${d.id}`}
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={actionsLocked}
                          onClick={() => pickMatch(d)}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', width: '100%', textAlign: 'left' }}
                        >
                          <span>{d.emoji ? `${d.emoji} ` : ''}{d.name}</span>
                          <span style={{ color: 'var(--ink-3)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{drinkTags(d).join(' · ')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {matching.error && (
                    <p style={{ color: DANGER, fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{matching.error}</p>
                  )}
                  <div style={{ marginTop: '0.5rem' }}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setMatching(null)} disabled={matching.busy}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {addRecipeError && (
            <p style={{ color: DANGER, fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
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
