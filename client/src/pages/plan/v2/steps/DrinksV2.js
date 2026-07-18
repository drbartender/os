import React, { useState, useMemo } from 'react';
import ScopeBanner from '../../components/ScopeBanner';

// BYOB drink picking (spec §3.1): the fun part, uninterrupted. No syrup
// radios, no upsell panels, no dollar signs. Cocktails + mocktails share one
// screen, with the old planner's structure restored at real catalog scale:
// category pills/sidebar with counts, a "Your Menu" gathering view, a sticky
// selected-count footer, and a custom-request typeahead that teaches.
export default function DrinksV2({ plan, selections, updateSelections, catalog, quickPick }) {
  const mocktailsOnly = quickPick === 'mocktails';
  const showCocktails = !mocktailsOnly;
  const selected = selections.signatureDrinks || [];
  const selectedMocktails = selections.mocktails || [];
  const customs = selections.customCocktails || [];

  const tabs = useMemo(() => {
    const t = [];
    if (showCocktails) t.push(...catalog.cocktailCategories.map((c) => ({ key: c.id, label: c.label, table: 'cocktails' })));
    t.push(...catalog.mocktailCategories.map((c) => ({ key: `m-${c.id}`, label: catalog.mocktailCategories.length === 1 ? 'Mocktails' : c.label, table: 'mocktails', catId: c.id })));
    t.push({ key: 'your-menu', label: 'Your Menu' });
    return t;
  }, [catalog, showCocktails]);

  const [activeTab, setActiveTab] = useState(null);
  const [lastBrowseTab, setLastBrowseTab] = useState(null);
  const tab = activeTab || tabs[0]?.key;
  const changeTab = (key) => {
    if (key !== 'your-menu') setLastBrowseTab(key);
    setActiveTab(key);
  };

  const totalPicked = selected.length + selectedMocktails.length + customs.length;

  const countFor = (t) => {
    if (t.key === 'your-menu') return totalPicked;
    if (t.table === 'mocktails') {
      return catalog.mocktails.filter((d) => d.category_id === t.catId && selectedMocktails.includes(d.id)).length;
    }
    return catalog.cocktails.filter((d) => d.category_id === t.key && selected.includes(d.id)).length;
  };

  const toggleCocktail = (id) => {
    updateSelections('signatureDrinks', selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const toggleMocktail = (id) => {
    updateSelections('mocktails', selectedMocktails.includes(id) ? selectedMocktails.filter((x) => x !== id) : [...selectedMocktails, id]);
  };

  // Custom request typeahead: match against the live catalog so "we found it"
  // adds the real drink; a miss stays free text for the bar lead to source.
  const [customInput, setCustomInput] = useState('');
  const matches = useMemo(() => {
    const q = customInput.trim().toLowerCase();
    if (q.length < 2) return [];
    const pool = [
      ...(showCocktails ? catalog.cocktails.map((d) => ({ ...d, table: 'cocktails' })) : []),
      ...catalog.mocktails.map((d) => ({ ...d, table: 'mocktails' })),
    ];
    return pool.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 5);
  }, [customInput, catalog, showCocktails]);

  const addCustom = () => {
    const name = customInput.trim();
    if (!name) return;
    updateSelections('customCocktails', [...customs, name]);
    setCustomInput('');
  };
  const addMatch = (d) => {
    if (d.table === 'cocktails') { if (!selected.includes(d.id)) toggleCocktail(d.id); } else if (!selectedMocktails.includes(d.id)) toggleMocktail(d.id);
    setCustomInput('');
  };

  const activeTabDef = tabs.find((t) => t.key === tab);
  const browseList = activeTabDef && activeTabDef.key !== 'your-menu'
    ? (activeTabDef.table === 'mocktails'
      ? catalog.mocktails.filter((d) => d.category_id === activeTabDef.catId).map((d) => ({ ...d, table: 'mocktails' }))
      : catalog.cocktails.filter((d) => d.category_id === activeTabDef.key).map((d) => ({ ...d, table: 'cocktails' })))
    : [];

  const isPicked = (d) => (d.table === 'mocktails' ? selectedMocktails.includes(d.id) : selected.includes(d.id));
  const togglePick = (d) => (d.table === 'mocktails' ? toggleMocktail(d.id) : toggleCocktail(d.id));

  const yourMenuRows = [
    ...selected.map((id) => ({ id, table: 'cocktails', drink: catalog.cocktails.find((d) => d.id === id) })),
    ...selectedMocktails.map((id) => ({ id, table: 'mocktails', drink: catalog.mocktails.find((d) => d.id === id) })),
  ].filter((r) => r.drink);

  return (
    <div>
      <ScopeBanner
        tone="shopping"
        title="Builds your shopping list"
        body="Your choices here turn into your shopping list, down to the ice cube. We'll tell you exactly what and how much to buy."
      />
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          {mocktailsOnly ? 'Pick Your Mocktails' : 'Pick Your Potions'}
        </h2>
        <p className="text-muted">
          {mocktailsOnly
            ? 'Choose the non-alcoholic drinks your guests will love.'
            : 'Pick 2 to 4 cocktails. That’s the sweet spot for a fast line and a happy bar.'}
        </p>
      </div>

      {selected.length > 4 && (
        <div className="drink-count-warning">
          <div className="drink-count-warning-text">
            <strong>{selected.length} cocktails selected</strong>
            <span>
              We recommend 2 to 4 signature cocktails for the best guest experience. More than that and
              service slows down and the shopping list grows fast. Totally your call though!
            </span>
          </div>
        </div>
      )}

      <div className="category-pills">
        {tabs.map((t) => {
          const count = countFor(t);
          return (
            <button key={t.key} className={`category-pill${tab === t.key ? ' active' : ''}`} onClick={() => changeTab(t.key)}>
              {t.label}{count > 0 && <span style={{ marginLeft: '0.3rem', fontWeight: 700 }}>({count})</span>}
            </button>
          );
        })}
      </div>

      <div className="drink-picker-layout">
        <div className="category-sidebar">
          {tabs.map((t) => {
            const count = countFor(t);
            return (
              <button key={t.key} className={`category-sidebar-btn${tab === t.key ? ' active' : ''}`} onClick={() => changeTab(t.key)}>
                <span>{t.label}</span>
                {count > 0 && <span className={`badge ${t.key === 'your-menu' ? 'badge-approved' : 'badge-inprogress'}`}>{count}</span>}
              </button>
            );
          })}
        </div>

        <div>
          {tab === 'your-menu' ? (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '1rem' }}>
                Your Menu ({totalPicked} drink{totalPicked !== 1 ? 's' : ''} selected)
              </h3>
              {totalPicked === 0 ? (
                <p className="text-muted" style={{ color: 'var(--warm-brown)' }}>
                  No drinks selected yet. Browse the categories to add your favorites!
                </p>
              ) : (
                <div className="your-menu-list">
                  {yourMenuRows.map((row, i) => (
                    <div key={`${row.table}-${row.id}`} className="your-menu-item">
                      <span className="your-menu-number">{i + 1}.</span>
                      <span className="your-menu-emoji">{row.drink.emoji}</span>
                      <div className="your-menu-info">
                        <strong>{row.drink.name}</strong>
                        <span className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>{row.drink.description}</span>
                      </div>
                      <button className="btn btn-sm btn-danger" onClick={() => togglePick(row)} title="Remove">&times;</button>
                    </div>
                  ))}
                  {customs.map((name, i) => (
                    <div key={`custom-${name}-${i}`} className="your-menu-item">
                      <span className="your-menu-number">{yourMenuRows.length + i + 1}.</span>
                      <span className="your-menu-emoji">&#10024;</span>
                      <div className="your-menu-info">
                        <strong>{name}</strong>
                        <span className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>Custom request, our bar lead will look into sourcing it</span>
                      </div>
                      <button className="btn btn-sm btn-danger" onClick={() => updateSelections('customCocktails', customs.filter((_, j) => j !== i))} title="Remove">&times;</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="drink-card-list">
              {browseList.map((d) => (
                <button
                  key={d.id}
                  className={`drink-card-horizontal${isPicked(d) ? ' selected' : ''}`}
                  onClick={() => togglePick(d)}
                  aria-pressed={isPicked(d)}
                >
                  <span className="drink-card-emoji">{d.emoji}</span>
                  <div className="drink-card-info">
                    <span className="drink-card-name">{d.name}</span>
                    <span className="drink-card-desc">{d.description}</span>
                  </div>
                  <span className="drink-check-stylized">
                    <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
                      <path d="M1.5 6L5 9.5L12.5 1.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              ))}
              {browseList.length === 0 && (
                <div className="card"><p className="text-muted">Nothing in this category yet.</p></div>
              )}
            </div>
          )}

          {/* Custom request typeahead */}
          <div className="card" style={{ marginTop: '1.25rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Dreaming of something not listed?</label>
              <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
                Name it. If it's in our recipe book we'll add it straight to your menu. If not, our bar lead will look into sourcing it.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Aperol Spritz, Ranch Water..."
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (matches.length === 0) addCustom(); } }}
                />
                <button className="btn btn-primary" disabled={!customInput.trim()} onClick={addCustom} style={{ whiteSpace: 'nowrap' }}>Add</button>
              </div>
              {matches.length > 0 && (
                <div className="pp2-typeahead">
                  {matches.map((d) => (
                    <button key={`${d.table}-${d.id}`} className="pp2-typeahead-row" onClick={() => addMatch(d)}>
                      <span>{d.emoji} {d.name}</span>
                      <span className="pp2-typeahead-tag">On our menu</span>
                    </button>
                  ))}
                  <button className="pp2-typeahead-row" onClick={addCustom}>
                    <span>&#10024; Add "{customInput.trim()}"</span>
                    <span className="pp2-typeahead-tag sourced">Bar lead will source it</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {tab !== 'your-menu' && (
        <div className="drink-picker-sticky-footer">
          <div className="sticky-footer-info">
            <span className="sticky-footer-count">{totalPicked} drink{totalPicked !== 1 ? 's' : ''} selected</span>
          </div>
          <div className="sticky-footer-actions">
            <button className="btn btn-primary btn-sm" onClick={() => changeTab('your-menu')}>Review Your Menu</button>
          </div>
        </div>
      )}
      {tab === 'your-menu' && lastBrowseTab && (
        <div style={{ marginTop: '0.75rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => changeTab(lastBrowseTab)}>Back to browsing</button>
        </div>
      )}
    </div>
  );
}
