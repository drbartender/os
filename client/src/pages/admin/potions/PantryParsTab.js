import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import Icon from '../../../components/adminos/Icon';
import { useToast } from '../../../context/ToastContext';

// Potions · Pars tab: the ONE master catalog. Every item carries its own
// call-on conditions (full-bar baseline, spirit/style keys, matching-mixer
// pairings, recipe aliases); the generator pulls what an event needs. The
// baseline qty is AT 100 GUESTS; the projected column previews scaling.
const SECTIONS = [
  { id: 'liquorBeerWine', label: 'Liquor · Beer · Wine' },
  { id: 'everythingElse', label: 'Everything Else' },
];
const ROLES = ['spirit', 'wine', 'beer', 'mixer', 'garnish', 'supplies'];

function scaleQty(qty, guests) {
  const q = Number(qty);
  if (!q) return '—';
  return Math.max(1, Math.ceil((q * guests) / 100));
}

function calledOnChips(row) {
  const chips = [];
  if (row.in_full_bar) chips.push({ kind: 'accent', text: 'Full bar' });
  if (row.role === 'supplies') chips.push({ kind: 'neutral', text: 'Always' });
  if (row.spirit_key) chips.push({ kind: 'info', text: `Spirit: ${row.spirit_key}` });
  if (row.style_key) chips.push({ kind: 'info', text: `Style: ${row.style_key}` });
  if ((row.paired_spirits || []).length > 0) chips.push({ kind: 'violet', text: `Pairs: ${row.paired_spirits.join(', ')}` });
  if (chips.length === 0) chips.push({ kind: 'neutral', text: 'Recipes only' });
  return chips;
}

export default function PantryParsTab() {
  const toast = useToast();
  const [pars, setPars] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [guests, setGuests] = useState(175);
  const [previewMode, setPreviewMode] = useState('all'); // all | full_bar | spirit_driven
  const [preview, setPreview] = useState(null);          // { mode, list } | null
  const [previewBusy, setPreviewBusy] = useState(false);
  const [adding, setAdding] = useState(null);            // section id | null
  const [addForm, setAddForm] = useState({ item: '', size: '', qty_per_100: 1, role: 'mixer' });
  const dragItem = useRef(null);
  const dragOver = useRef(null);
  // Pre-edit values captured on focus: controlled inputs update `row` on
  // every keystroke, so comparing blur value against LIVE row state can never
  // detect a change (code-review fix). Keyed `${row.id}:${field}`.
  const focusSnapshot = useRef({});

  const load = useCallback(async () => {
    try {
      const res = await api.get('/potions/pars');
      setPars(res.data.pars || []);
      setLoadError('');
    } catch (err) {
      setLoadError('Could not load the par catalog.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const bySection = useMemo(() => {
    const out = { liquorBeerWine: [], everythingElse: [] };
    for (const row of pars || []) if (out[row.section]) out[row.section].push(row);
    return out;
  }, [pars]);

  // Cost coverage: items with no cost set yet (feeds the package margin rail).
  const missingCost = useMemo(
    () => (pars || []).filter((r) => r.cost === null || r.cost === undefined || r.cost === '').length,
    [pars]
  );

  const visible = useCallback((row) => {
    if (previewMode === 'all') return true;
    if (previewMode === 'full_bar') return row.in_full_bar;
    // spirit_driven: spirits + paired mixers/garnishes + supplies (the
    // consult-mode pull), mirroring the generator's slices.
    return Boolean(row.spirit_key) || (row.paired_spirits || []).length > 0 || row.role === 'supplies';
  }, [previewMode]);

  const saveCell = async (row, patch) => {
    const prev = pars;
    setPars((p) => p.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    try {
      await api.put(`/potions/pars/${row.id}`, patch);
    } catch (err) {
      setPars(prev);
      toast.error(err.response?.data?.fieldErrors ? Object.values(err.response.data.fieldErrors)[0] : 'Save failed.');
    }
  };

  const removeRow = async (row) => {
    if (!window.confirm(`Remove "${row.item}" from the catalog?`)) return;
    try {
      await api.delete(`/potions/pars/${row.id}`);
      setPars((p) => p.filter((r) => r.id !== row.id));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not remove item.');
    }
  };

  const onDragEnd = async (sectionId) => {
    const from = dragItem.current;
    const to = dragOver.current;
    dragItem.current = null;
    dragOver.current = null;
    if (from === null || to === null || from === to) return;
    const sectionRows = bySection[sectionId];
    const reordered = [...sectionRows];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const items = reordered.map((r, i) => ({ id: r.id, sort_order: (i + 1) * 10 }));
    setPars((p) => {
      const others = p.filter((r) => r.section !== sectionId);
      const updated = reordered.map((r, i) => ({ ...r, sort_order: (i + 1) * 10 }));
      return [...others, ...updated].sort((a, b) =>
        a.section === b.section ? a.sort_order - b.sort_order : a.section.localeCompare(b.section));
    });
    try {
      await api.post('/potions/pars/reorder', { items });
    } catch (err) {
      toast.error('Reorder failed.');
      load();
    }
  };

  const submitAdd = async (sectionId) => {
    try {
      const res = await api.post('/potions/pars', { ...addForm, qty_per_100: Number(addForm.qty_per_100), section: sectionId });
      setPars((p) => [...p, res.data.par]);
      setAdding(null);
      setAddForm({ item: '', size: '', qty_per_100: 1, role: 'mixer' });
    } catch (err) {
      const fe = err.response?.data?.fieldErrors;
      toast.error(fe ? Object.values(fe)[0] : (err.response?.data?.error || 'Could not add item.'));
    }
  };

  useEffect(() => {
    if (!preview) return;
    const onKey = (e) => { if (e.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const runPreview = async () => {
    const mode = previewMode === 'spirit_driven' ? 'spirit_driven' : 'full_bar';
    setPreviewBusy(true);
    try {
      const res = await api.get(`/potions/preview?guests=${guests}&mode=${mode}`);
      setPreview({ mode, list: res.data.list });
    } catch (err) {
      toast.error('Preview failed.');
    } finally {
      setPreviewBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="card"><div className="potions-state">
        <span className="text-muted">{loadError}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (pars === null) return <div className="card"><div className="potions-state text-muted">Loading the catalog…</div></div>;

  return (
    <div className="potions-pars">
      <div className="card potions-pars-explainer">
        <div className="hstack" style={{ gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="potions-flask"><Icon name="flask" size={16} /></span>
          <div style={{ flex: 1, minWidth: '240px' }}>
            <strong>Baseline stock is set for 100 guests.</strong>
            <div className="text-muted text-small">
              The generator scales every quantity by the event's guest count. Edit the Qty @ 100 column;
              the projected column previews the scaled order. "Called on" shows when an item joins a list.
              Cost is the per-unit purchase price in dollars (blank means not costed yet); it feeds the package margin rail.
            </div>
            {missingCost > 0 && (
              <div className="potions-cost-warn text-small">
                {missingCost} item{missingCost === 1 ? '' : 's'} still need a cost.
              </div>
            )}
          </div>
          <div className="hstack" style={{ gap: '0.4rem', alignItems: 'center' }}>
            <span className="text-muted text-small">Show</span>
            <div className="seg">
              <button type="button" className={previewMode === 'all' ? 'active' : ''} onClick={() => setPreviewMode('all')}>All</button>
              <button type="button" className={previewMode === 'full_bar' ? 'active' : ''} onClick={() => setPreviewMode('full_bar')}>Full Bar</button>
              <button type="button" className={previewMode === 'spirit_driven' ? 'active' : ''} onClick={() => setPreviewMode('spirit_driven')}>Spirit-Driven</button>
            </div>
          </div>
          <div className="hstack" style={{ gap: '0.4rem', alignItems: 'center' }}>
            <span className="text-muted text-small">Preview at</span>
            <input className="input potions-cell potions-cell-num" type="number" min="1" max="1000" value={guests}
              onChange={(e) => setGuests(Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1)))} />
            <span className="text-muted text-small">guests</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={runPreview} disabled={previewBusy}>
              {previewBusy ? 'Generating…' : 'Preview shopping list'}
            </button>
          </div>
        </div>
      </div>

      {SECTIONS.map((section) => {
        const sectionRows = bySection[section.id];
        const shown = sectionRows.filter(visible);
        return (
          <div className="card potions-pars-card" key={section.id}>
            <div className="potions-card-head">
              <h3>{section.label} <span className="text-muted text-small">{shown.length}</span></h3>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(adding === section.id ? null : section.id)}>
                Add item
              </button>
            </div>

            {adding === section.id && (
              <div className="potions-add-row hstack">
                <input className="input potions-cell" placeholder="Item (e.g. Ginger Syrup)" value={addForm.item}
                  onChange={(e) => setAddForm((f) => ({ ...f, item: e.target.value }))} />
                <input className="input potions-cell potions-cell-size" placeholder="Size" value={addForm.size}
                  onChange={(e) => setAddForm((f) => ({ ...f, size: e.target.value }))} />
                <input className="input potions-cell potions-cell-num" type="number" min="0" value={addForm.qty_per_100}
                  onChange={(e) => setAddForm((f) => ({ ...f, qty_per_100: e.target.value }))} title="Qty at 100 guests" />
                <select className="select potions-cell potions-cell-unit" value={addForm.role}
                  onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => submitAdd(section.id)} disabled={!addForm.item.trim()}>Add</button>
              </div>
            )}

            <div className="tbl-wrap">
              <table className="tbl potions-pars-table">
                <thead>
                  <tr>
                    <th className="potions-col-grip"></th>
                    <th>Item</th>
                    <th>Size</th>
                    <th className="potions-col-cost">Cost $</th>
                    <th className="potions-col-amount">Qty @ 100</th>
                    <th className="potions-col-amount">@ {guests}</th>
                    <th className="col-desc">Called on</th>
                    <th className="col-spirit">Used by</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={9} className="text-muted potions-state">Nothing in this view.</td></tr>
                  )}
                  {shown.map((row) => {
                    const fullIndex = sectionRows.indexOf(row);
                    return (
                      <tr
                        key={row.id}
                        draggable={previewMode === 'all'}
                        onDragStart={() => { dragItem.current = fullIndex; }}
                        onDragEnter={() => { dragOver.current = fullIndex; }}
                        onDragOver={(e) => e.preventDefault()}
                        onDragEnd={() => onDragEnd(section.id)}
                      >
                        <td className="potions-col-grip">{previewMode === 'all' ? <span className="drag-handle">⠿</span> : null}</td>
                        <td>
                          <input className="input potions-cell" value={row.item} aria-label="Item name"
                            onFocus={(e) => { focusSnapshot.current[`${row.id}:item`] = e.target.value; }}
                            onChange={(e) => setPars((p) => p.map((r) => (r.id === row.id ? { ...r, item: e.target.value } : r)))}
                            onBlur={(e) => {
                              const orig = focusSnapshot.current[`${row.id}:item`];
                              const next = e.target.value.trim();
                              if (next && next !== orig) saveCell(row, { item: next });
                            }} />
                        </td>
                        <td>
                          <input className="input potions-cell potions-cell-size" value={row.size || ''} aria-label="Size"
                            onFocus={(e) => { focusSnapshot.current[`${row.id}:size`] = e.target.value; }}
                            onChange={(e) => setPars((p) => p.map((r) => (r.id === row.id ? { ...r, size: e.target.value } : r)))}
                            onBlur={(e) => {
                              const orig = focusSnapshot.current[`${row.id}:size`];
                              if (e.target.value !== orig) saveCell(row, { size: e.target.value });
                            }} />
                        </td>
                        <td className="potions-col-cost">
                          <input className="input potions-cell potions-cell-num" value={row.cost ?? ''} aria-label="Unit cost in dollars"
                            inputMode="decimal" placeholder="—"
                            onFocus={(e) => { focusSnapshot.current[`${row.id}:cost`] = e.target.value; }}
                            onChange={(e) => setPars((p) => p.map((r) => (r.id === row.id ? { ...r, cost: e.target.value } : r)))}
                            onBlur={(e) => {
                              const orig = focusSnapshot.current[`${row.id}:cost`];
                              const raw = e.target.value.trim();
                              if (raw === (orig ?? '').trim()) return;
                              if (raw === '') { saveCell(row, { cost: null }); return; }
                              const cost = Number(raw);
                              if (!Number.isFinite(cost) || cost < 0) { load(); return; } // revert bad input
                              saveCell(row, { cost });
                            }} />
                        </td>
                        <td className="potions-col-amount">
                          <input className="input potions-cell potions-cell-num" value={row.qty_per_100} aria-label="Quantity at 100 guests"
                            onFocus={(e) => { focusSnapshot.current[`${row.id}:qty`] = e.target.value; }}
                            onChange={(e) => setPars((p) => p.map((r) => (r.id === row.id ? { ...r, qty_per_100: e.target.value } : r)))}
                            onBlur={(e) => {
                              const orig = focusSnapshot.current[`${row.id}:qty`];
                              if (e.target.value !== orig) saveCell(row, { qty_per_100: Number(e.target.value) || 0 });
                            }} inputMode="decimal" />
                        </td>
                        <td className="potions-col-amount potions-projected">{scaleQty(row.qty_per_100, guests)}</td>
                        <td className="col-desc potions-chips">
                          {calledOnChips(row).map((chip, i) => (
                            <StatusChip key={i} kind={chip.kind} dot={false}>{chip.text}</StatusChip>
                          ))}
                        </td>
                        <td className="col-spirit">
                          {(row.used_by || []).length > 0
                            ? <span className="chip neutral" title={row.used_by.map((d) => d.name).join(', ')}>{row.used_by.length} recipe{row.used_by.length === 1 ? '' : 's'}</span>
                            : <span className="text-muted text-small">—</span>}
                        </td>
                        <td>
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => removeRow(row)} title="Remove from catalog" aria-label={`Remove ${row.item}`}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {preview && (
        <div className="potions-preview-scrim" onClick={() => setPreview(null)}>
          <div className="card potions-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="potions-card-head">
              <h3>Preview · {preview.mode === 'full_bar' ? 'Full Bar' : 'Spirit-Driven'} · {guests} guests</h3>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreview(null)}>Close</button>
            </div>
            <div className="potions-preview-cols scroll-thin">
              {[['Liquor · Beer · Wine', preview.list.liquorBeerWine], ['Everything Else', preview.list.everythingElse]].map(([label, items]) => (
                <div key={label}>
                  <div className="text-muted text-small potions-preview-label">{label}</div>
                  {(items || []).map((item, i) => (
                    <div key={i} className="potions-preview-line">
                      <span>{item.item}{item.size ? ` (${item.size})` : ''}</span>
                      <span className="potions-projected">{item.qty}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="text-muted text-small">Read-only preview. Nothing is saved.</div>
          </div>
        </div>
      )}
    </div>
  );
}
