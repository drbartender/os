import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';

const SPIRIT_OPTIONS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch', 'Bourbon', 'Mezcal', 'Cognac', 'Amaretto', 'Aperol', 'Other'];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ─── DrinkTable ───────────────────────────────────────────────────────────────

function DrinkTable({ drinks, categories, editingId, editForm, editFieldErrors, onStartEdit, onCancelEdit, onSaveEdit, onToggleActive, onEditFormChange, withSpirit = false, onReorder }) {
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnter = (index) => {
    dragOverItem.current = index;
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    const from = dragItem.current;
    const to = dragOverItem.current;
    setDragIndex(null);
    setDragOverIndex(null);
    dragItem.current = null;
    dragOverItem.current = null;
    if (from === null || to === null || from === to) return;
    const reordered = [...drinks];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    onReorder(reordered.map((d, i) => ({ id: d.id, sort_order: i })));
  };

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '32px', padding: '0.65rem 0.25rem' }}></th>
            <th style={{ width: '48px' }}>Emoji</th>
            <th>Name</th>
            <th className="col-desc">Description</th>
            {withSpirit && <th className="col-spirit" style={{ width: '100px' }}>Spirit</th>}
            {withSpirit && <th style={{ minWidth: '140px' }}>Ingredients</th>}
            {withSpirit && <th style={{ minWidth: '140px' }}>Upgrades</th>}
            <th style={{ width: '60px' }}>Active</th>
            <th style={{ width: '70px' }}></th>
          </tr>
        </thead>
        <tbody>
          {drinks.map((c, index) => (
            <tr
              key={c.id}
              draggable={editingId !== c.id}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnter={() => handleDragEnter(index)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => e.preventDefault()}
              className={[
                dragIndex === index ? 'row-dragging' : '',
                dragOverIndex === index && dragIndex !== index ? 'row-drag-over' : '',
              ].join(' ')}
              style={{ opacity: c.is_active ? 1 : 0.55 }}
            >
              {editingId === c.id ? (
                <>
                  <td></td>
                  <td><input className="form-input" style={{ width: '52px' }} value={editForm.emoji}
                    onChange={e => onEditFormChange({ emoji: e.target.value })} /></td>
                  <td>
                    <input className="form-input" value={editForm.name}
                      onChange={e => onEditFormChange({ name: e.target.value })} />
                    <FieldError error={editFieldErrors?.name} />
                  </td>
                  <td className="col-desc"><input className="form-input" value={editForm.description}
                    onChange={e => onEditFormChange({ description: e.target.value })} /></td>
                  {withSpirit && (
                    <td className="col-spirit">
                      <select className="form-input" style={{ minWidth: '110px' }} value={editForm.base_spirit}
                        onChange={e => onEditFormChange({ base_spirit: e.target.value })}>
                        <option value="">—</option>
                        {SPIRIT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  )}
                  {withSpirit && (
                    <td>
                      <input className="form-input" placeholder="e.g. Vodka, Lime Juice, Sprite"
                        value={editForm.ingredients || ''}
                        onChange={e => onEditFormChange({ ingredients: e.target.value })} />
                    </td>
                  )}
                  {withSpirit && (
                    <td>
                      <input className="form-input"
                        placeholder="e.g. specialty-vermouths, specialty-bitter-aperitifs"
                        title="Comma-separated addon slugs to charge when the package doesn't cover them"
                        value={editForm.upgrade_addon_slugs || ''}
                        onChange={e => onEditFormChange({ upgrade_addon_slugs: e.target.value })} />
                    </td>
                  )}
                  <td>
                    <input type="checkbox" checked={editForm.is_active}
                      onChange={e => onEditFormChange({ is_active: e.target.checked })} />
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => onSaveEdit(c.id)}>Save</button>
                      <button className="btn btn-sm btn-secondary" onClick={onCancelEdit}>Cancel</button>
                    </div>
                  </td>
                </>
              ) : (
                <>
                  <td className="drag-handle">⠿</td>
                  <td style={{ fontSize: '1.4rem' }}>{c.emoji}</td>
                  <td><strong>{c.name}</strong></td>
                  <td className="col-desc text-muted text-small"><span className="desc-cell-text">{c.description || '—'}</span></td>
                  {withSpirit && <td className="col-spirit text-muted text-small">{c.base_spirit || '—'}</td>}
                  {withSpirit && (
                    <td className="text-muted text-small">
                      <span className="desc-cell-text">
                        {Array.isArray(c.ingredients) && c.ingredients.length > 0 ? c.ingredients.join(', ') : '—'}
                      </span>
                    </td>
                  )}
                  {withSpirit && (
                    <td className="text-muted text-small">
                      <span className="desc-cell-text">
                        {Array.isArray(c.upgrade_addon_slugs) && c.upgrade_addon_slugs.length > 0 ? c.upgrade_addon_slugs.join(', ') : '—'}
                      </span>
                    </td>
                  )}
                  <td>
                    <button
                      className={`btn btn-sm ${c.is_active ? 'btn-success' : 'btn-secondary'}`}
                      onClick={() => onToggleActive(c)}
                      style={{ minWidth: '42px', fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
                    >
                      {c.is_active ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => onStartEdit(c)}>Edit</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── CategoryTable ────────────────────────────────────────────────────────────

function CategoryTable({ categories, drinkCounts, editingId, editForm, editFieldErrors, onStartEdit, onCancelEdit, onSaveEdit, onDelete, onEditFormChange, onReorder }) {
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnter = (index) => {
    dragOverItem.current = index;
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    const from = dragItem.current;
    const to = dragOverItem.current;
    setDragIndex(null);
    setDragOverIndex(null);
    dragItem.current = null;
    dragOverItem.current = null;
    if (from === null || to === null || from === to) return;
    const reordered = [...categories];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    onReorder(reordered.map((c, i) => ({ id: c.id, sort_order: i })));
  };

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '32px' }}></th>
            <th>Category Name</th>
            <th style={{ width: '80px' }}>Drinks</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {categories.map((cat, index) => {
            const count = drinkCounts[cat.id] || 0;
            return (
              <tr
                key={cat.id}
                draggable={editingId !== cat.id}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                className={[
                  dragIndex === index ? 'row-dragging' : '',
                  dragOverIndex === index && dragIndex !== index ? 'row-drag-over' : '',
                ].join(' ')}
              >
                {editingId === cat.id ? (
                  <>
                    <td></td>
                    <td>
                      <input className="form-input" value={editForm.label}
                        onChange={e => onEditFormChange({ label: e.target.value })} />
                      <FieldError error={editFieldErrors?.label} />
                    </td>
                    <td>{count}</td>
                    <td>
                      <div className="flex gap-1">
                        <button className="btn btn-sm" onClick={() => onSaveEdit(cat.id)}>Save</button>
                        <button className="btn btn-sm btn-secondary" onClick={onCancelEdit}>Cancel</button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="drag-handle">⠿</td>
                    <td><strong>{cat.label}</strong></td>
                    <td className="text-muted text-small">{count}</td>
                    <td>
                      <div className="flex gap-1">
                        <button className="btn btn-sm btn-secondary" onClick={() => onStartEdit(cat)}>Edit</button>
                        {count === 0 && (
                          <button className="btn btn-sm btn-danger" onClick={() => onDelete(cat.id)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CocktailMenuDashboard({ embedded = false }) {
  const toast = useToast();

  // ── Navigation ─────────────────────────────────────────────────
  const [drinkType, setDrinkType] = useState('cocktails');
  const [subTab, setSubTab] = useState('drinks');

  // ── Cocktail data ────────────────────────────────────────────────
  const [cocktailCategories, setCocktailCategories] = useState([]);
  const [cocktails, setCocktails] = useState([]);
  const [cocktailsLoading, setCocktailsLoading] = useState(true);

  const [editingCocktail, setEditingCocktail] = useState(null);
  const [editCocktailForm, setEditCocktailForm] = useState({});
  const [editCocktailError, setEditCocktailError] = useState('');
  const [editCocktailFieldErrors, setEditCocktailFieldErrors] = useState({});
  const [addCocktailCategory, setAddCocktailCategory] = useState(null);
  const [newCocktailForm, setNewCocktailForm] = useState({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '', ingredients: '', upgrade_addon_slugs: '' });
  const [addCocktailError, setAddCocktailError] = useState('');
  const [addCocktailFieldErrors, setAddCocktailFieldErrors] = useState({});

  const [editingCocktailCat, setEditingCocktailCat] = useState(null);
  const [editCocktailCatForm, setEditCocktailCatForm] = useState({});
  const [editCocktailCatError, setEditCocktailCatError] = useState('');
  const [editCocktailCatFieldErrors, setEditCocktailCatFieldErrors] = useState({});
  const [showAddCocktailCat, setShowAddCocktailCat] = useState(false);
  const [newCocktailCatForm, setNewCocktailCatForm] = useState({ id: '', label: '', sort_order: '' });
  const [addCocktailCatError, setAddCocktailCatError] = useState('');
  const [addCocktailCatFieldErrors, setAddCocktailCatFieldErrors] = useState({});

  // ── Mocktail data ────────────────────────────────────────────────
  const [mocktailCategories, setMocktailCategories] = useState([]);
  const [mocktails, setMocktails] = useState([]);
  const [mocktailsLoading, setMocktailsLoading] = useState(true);

  const [editingMocktail, setEditingMocktail] = useState(null);
  const [editMocktailForm, setEditMocktailForm] = useState({});
  const [editMocktailError, setEditMocktailError] = useState('');
  const [editMocktailFieldErrors, setEditMocktailFieldErrors] = useState({});
  const [addMocktailCategory, setAddMocktailCategory] = useState(null);
  const [newMocktailForm, setNewMocktailForm] = useState({ name: '', emoji: '', description: '', sort_order: '' });
  const [addMocktailError, setAddMocktailError] = useState('');
  const [addMocktailFieldErrors, setAddMocktailFieldErrors] = useState({});

  const [editingMocktailCat, setEditingMocktailCat] = useState(null);
  const [editMocktailCatForm, setEditMocktailCatForm] = useState({});
  const [editMocktailCatError, setEditMocktailCatError] = useState('');
  const [editMocktailCatFieldErrors, setEditMocktailCatFieldErrors] = useState({});
  const [showAddMocktailCat, setShowAddMocktailCat] = useState(false);
  const [newMocktailCatForm, setNewMocktailCatForm] = useState({ id: '', label: '', sort_order: '' });
  const [addMocktailCatError, setAddMocktailCatError] = useState('');
  const [addMocktailCatFieldErrors, setAddMocktailCatFieldErrors] = useState({});

  // ── Fetch ─────────────────────────────────────────────────────────
  const fetchCocktails = useCallback(async () => {
    try {
      const res = await api.get('/cocktails/admin');
      setCocktailCategories(res.data.categories || []);
      setCocktails(res.data.cocktails || []);
    } catch (err) {
      toast.error('Failed to load cocktails. Try refreshing.');
    } finally {
      setCocktailsLoading(false);
    }
  }, [toast]);

  const fetchMocktails = useCallback(async () => {
    try {
      const res = await api.get('/mocktails/admin');
      setMocktailCategories(res.data.categories || []);
      setMocktails(res.data.mocktails || []);
    } catch (err) {
      toast.error('Failed to load mocktails. Try refreshing.');
    } finally {
      setMocktailsLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchCocktails(); fetchMocktails(); }, [fetchCocktails, fetchMocktails]);

  // ── Cocktail CRUD ─────────────────────────────────────────────────
  const saveEditCocktail = async (id) => {
    setEditCocktailError('');
    setEditCocktailFieldErrors({});
    try {
      const body = { ...editCocktailForm };
      if (typeof body.ingredients === 'string') {
        body.ingredients = body.ingredients.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (typeof body.upgrade_addon_slugs === 'string') {
        body.upgrade_addon_slugs = body.upgrade_addon_slugs.split(',').map(s => s.trim()).filter(Boolean);
      }
      const res = await api.put(`/cocktails/${id}`, body);
      setCocktails(prev => prev.map(c => c.id === id ? { ...c, ...res.data } : c));
      setEditingCocktail(null);
      toast.success('Saved.');
    } catch (err) {
      setEditCocktailError(err.message || 'Failed to save cocktail.');
      setEditCocktailFieldErrors(err.fieldErrors || {});
    }
  };

  const toggleCocktailActive = async (c) => {
    if (c.is_active && !window.confirm('Remove this drink from the client menu?')) return;
    try {
      const res = await api.put(`/cocktails/${c.id}`, { is_active: !c.is_active });
      setCocktails(prev => prev.map(x => x.id === c.id ? { ...x, ...res.data } : x));
    } catch (err) {
      toast.error(err.message || 'Failed to update cocktail.');
    }
  };

  const addCocktail = async (categoryId) => {
    setAddCocktailError('');
    setAddCocktailFieldErrors({});
    if (!newCocktailForm.name.trim()) {
      setAddCocktailFieldErrors({ name: 'Name is required.' });
      return;
    }
    const id = slugify(newCocktailForm.name);
    try {
      const res = await api.post('/cocktails', {
        id,
        name: newCocktailForm.name.trim(),
        category_id: categoryId,
        emoji: newCocktailForm.emoji.trim() || null,
        description: newCocktailForm.description.trim() || null,
        sort_order: cocktails.filter(c => c.category_id === categoryId).length,
        base_spirit: newCocktailForm.base_spirit || null,
        ingredients: newCocktailForm.ingredients.split(',').map(s => s.trim()).filter(Boolean),
        upgrade_addon_slugs: newCocktailForm.upgrade_addon_slugs.split(',').map(s => s.trim()).filter(Boolean),
      });
      setCocktails(prev => [...prev, res.data]);
      setNewCocktailForm({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '', ingredients: '', upgrade_addon_slugs: '' });
      setAddCocktailCategory(null);
      toast.success('Cocktail created.');
    } catch (err) {
      setAddCocktailError(err.message || 'Failed to add cocktail.');
      setAddCocktailFieldErrors(err.fieldErrors || {});
    }
  };

  const reorderCocktails = async (categoryId, items) => {
    // Optimistic update
    setCocktails(prev => {
      const orderMap = new Map(items.map(({ id, sort_order }) => [id, sort_order]));
      return prev.map(c => orderMap.has(c.id) ? { ...c, sort_order: orderMap.get(c.id) } : c);
    });
    try {
      await api.post('/cocktails/reorder', { items });
    } catch (err) {
      toast.error('Reorder failed.');
    }
  };

  // Cocktail category CRUD
  const saveEditCocktailCat = async (id) => {
    setEditCocktailCatError('');
    setEditCocktailCatFieldErrors({});
    try {
      const res = await api.put(`/cocktails/categories/${id}`, editCocktailCatForm);
      setCocktailCategories(prev => prev.map(c => c.id === id ? { ...c, ...res.data } : c));
      setEditingCocktailCat(null);
      toast.success('Saved.');
    } catch (err) {
      setEditCocktailCatError(err.message || 'Failed to save category.');
      setEditCocktailCatFieldErrors(err.fieldErrors || {});
    }
  };

  const deleteCocktailCat = async (id) => {
    if (!window.confirm('Delete this category?')) return;
    try {
      await api.delete(`/cocktails/categories/${id}`);
      setCocktailCategories(prev => prev.filter(c => c.id !== id));
      toast.success('Deleted.');
    } catch (err) {
      toast.error(err.message || 'Failed to delete category.');
    }
  };

  const addCocktailCat = async () => {
    setAddCocktailCatError('');
    setAddCocktailCatFieldErrors({});
    if (!newCocktailCatForm.label.trim()) {
      setAddCocktailCatFieldErrors({ label: 'Label is required.' });
      return;
    }
    const id = newCocktailCatForm.id.trim() || slugify(newCocktailCatForm.label);
    try {
      const res = await api.post('/cocktails/categories', {
        id, label: newCocktailCatForm.label.trim(),
        sort_order: cocktailCategories.length,
      });
      setCocktailCategories(prev => [...prev, res.data].sort((a, b) => a.sort_order - b.sort_order));
      setNewCocktailCatForm({ id: '', label: '', sort_order: '' });
      setShowAddCocktailCat(false);
      toast.success('Category created.');
    } catch (err) {
      setAddCocktailCatError(err.message || 'Failed to add category.');
      setAddCocktailCatFieldErrors(err.fieldErrors || {});
    }
  };

  const reorderCocktailCategories = async (items) => {
    const orderMap = new Map(items.map(({ id, sort_order }) => [id, sort_order]));
    setCocktailCategories(prev =>
      prev.map(c => ({ ...c, sort_order: orderMap.get(c.id) ?? c.sort_order }))
          .sort((a, b) => a.sort_order - b.sort_order)
    );
    try {
      await api.post('/cocktails/categories/reorder', { items });
    } catch (err) {
      toast.error('Category reorder failed.');
    }
  };

  // ── Mocktail CRUD ─────────────────────────────────────────────────
  const saveEditMocktail = async (id) => {
    setEditMocktailError('');
    setEditMocktailFieldErrors({});
    try {
      const res = await api.put(`/mocktails/${id}`, editMocktailForm);
      setMocktails(prev => prev.map(m => m.id === id ? { ...m, ...res.data } : m));
      setEditingMocktail(null);
      toast.success('Saved.');
    } catch (err) {
      setEditMocktailError(err.message || 'Failed to save mocktail.');
      setEditMocktailFieldErrors(err.fieldErrors || {});
    }
  };

  const toggleMocktailActive = async (m) => {
    if (m.is_active && !window.confirm('Remove this drink from the client menu?')) return;
    try {
      const res = await api.put(`/mocktails/${m.id}`, { is_active: !m.is_active });
      setMocktails(prev => prev.map(x => x.id === m.id ? { ...x, ...res.data } : x));
    } catch (err) {
      toast.error(err.message || 'Failed to update mocktail.');
    }
  };

  const addMocktail = async (categoryId) => {
    setAddMocktailError('');
    setAddMocktailFieldErrors({});
    if (!newMocktailForm.name.trim()) {
      setAddMocktailFieldErrors({ name: 'Name is required.' });
      return;
    }
    const id = slugify(newMocktailForm.name);
    try {
      const res = await api.post('/mocktails', {
        id,
        name: newMocktailForm.name.trim(),
        category_id: categoryId,
        emoji: newMocktailForm.emoji.trim() || null,
        description: newMocktailForm.description.trim() || null,
        sort_order: mocktails.filter(m => m.category_id === categoryId).length,
      });
      setMocktails(prev => [...prev, res.data]);
      setNewMocktailForm({ name: '', emoji: '', description: '', sort_order: '' });
      setAddMocktailCategory(null);
      toast.success('Mocktail created.');
    } catch (err) {
      setAddMocktailError(err.message || 'Failed to add mocktail.');
      setAddMocktailFieldErrors(err.fieldErrors || {});
    }
  };

  const reorderMocktails = async (categoryId, items) => {
    setMocktails(prev => {
      const orderMap = new Map(items.map(({ id, sort_order }) => [id, sort_order]));
      return prev.map(m => orderMap.has(m.id) ? { ...m, sort_order: orderMap.get(m.id) } : m);
    });
    try {
      await api.post('/mocktails/reorder', { items });
    } catch (err) {
      toast.error('Reorder failed.');
    }
  };

  // Mocktail category CRUD
  const saveEditMocktailCat = async (id) => {
    setEditMocktailCatError('');
    setEditMocktailCatFieldErrors({});
    try {
      const res = await api.put(`/mocktails/categories/${id}`, editMocktailCatForm);
      setMocktailCategories(prev => prev.map(c => c.id === id ? { ...c, ...res.data } : c));
      setEditingMocktailCat(null);
      toast.success('Saved.');
    } catch (err) {
      setEditMocktailCatError(err.message || 'Failed to save category.');
      setEditMocktailCatFieldErrors(err.fieldErrors || {});
    }
  };

  const deleteMocktailCat = async (id) => {
    if (!window.confirm('Delete this category?')) return;
    try {
      await api.delete(`/mocktails/categories/${id}`);
      setMocktailCategories(prev => prev.filter(c => c.id !== id));
      toast.success('Deleted.');
    } catch (err) {
      toast.error(err.message || 'Failed to delete category.');
    }
  };

  const addMocktailCat = async () => {
    setAddMocktailCatError('');
    setAddMocktailCatFieldErrors({});
    if (!newMocktailCatForm.label.trim()) {
      setAddMocktailCatFieldErrors({ label: 'Label is required.' });
      return;
    }
    const id = newMocktailCatForm.id.trim() || slugify(newMocktailCatForm.label);
    try {
      const res = await api.post('/mocktails/categories', {
        id, label: newMocktailCatForm.label.trim(),
        sort_order: mocktailCategories.length,
      });
      setMocktailCategories(prev => [...prev, res.data].sort((a, b) => a.sort_order - b.sort_order));
      setNewMocktailCatForm({ id: '', label: '', sort_order: '' });
      setShowAddMocktailCat(false);
      toast.success('Category created.');
    } catch (err) {
      setAddMocktailCatError(err.message || 'Failed to add category.');
      setAddMocktailCatFieldErrors(err.fieldErrors || {});
    }
  };

  const reorderMocktailCategories = async (items) => {
    const orderMap = new Map(items.map(({ id, sort_order }) => [id, sort_order]));
    setMocktailCategories(prev =>
      prev.map(c => ({ ...c, sort_order: orderMap.get(c.id) ?? c.sort_order }))
          .sort((a, b) => a.sort_order - b.sort_order)
    );
    try {
      await api.post('/mocktails/categories/reorder', { items });
    } catch (err) {
      toast.error('Category reorder failed.');
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────
  const switchDrinkType = (type) => { setDrinkType(type); setSubTab('drinks'); };

  const sortedCocktailsInCat = (catId) =>
    cocktails.filter(c => c.category_id === catId).sort((a, b) => a.sort_order - b.sort_order);

  const sortedMocktailsInCat = (catId) =>
    mocktails.filter(m => m.category_id === catId).sort((a, b) => a.sort_order - b.sort_order);

  if (cocktailsLoading && mocktailsLoading) {
    return (
      <div className="page-container" style={{ textAlign: 'center', paddingTop: '2rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  const isCocktails = drinkType === 'cocktails';
  const activeCocktails = cocktails.filter(c => c.is_active).length;
  const activeMocktails = mocktails.filter(m => m.is_active).length;

  return (
    <div className={embedded ? '' : 'page-container wide'}>
      {/* ── Header ── */}
      {!embedded && (
        <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', margin: 0 }}>Drink Menu</h2>
            <p className="text-muted text-small mt-1">
              {activeCocktails} active cocktails · {activeMocktails} active mocktails
            </p>
          </div>
        </div>
      )}

      {/* ── Type tabs ── */}
      <div className="tab-nav mb-2">
        <button className={`tab-btn${isCocktails ? ' active' : ''}`} onClick={() => switchDrinkType('cocktails')}>
          🍸 Cocktails
        </button>
        <button className={`tab-btn${!isCocktails ? ' active' : ''}`} onClick={() => switchDrinkType('mocktails')}>
          🥤 Mocktails
        </button>
      </div>

      {/* ── Sub tabs ── */}
      <div className="tab-nav mb-2" style={{ borderBottom: '1px solid var(--border)', marginTop: '-0.5rem' }}>
        <button className={`tab-btn${subTab === 'drinks' ? ' active' : ''}`} style={{ fontSize: '0.78rem' }}
          onClick={() => setSubTab('drinks')}>Drinks</button>
        <button className={`tab-btn${subTab === 'categories' ? ' active' : ''}`} style={{ fontSize: '0.78rem' }}
          onClick={() => setSubTab('categories')}>Categories</button>
      </div>

      {/* ══ COCKTAILS ══ */}
      {isCocktails && subTab === 'drinks' && (
        <div>
          {/* Section-level banner for inline edit errors */}
          <FormBanner error={editCocktailError} fieldErrors={editCocktailFieldErrors} />
          {cocktailCategories.map(cat => {
            const catDrinks = sortedCocktailsInCat(cat.id);
            return (
              <div key={cat.id} className="card mb-2">
                <div className="flex-between mb-1">
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>{cat.label}</h3>
                  <button className="btn btn-sm btn-secondary" onClick={() => {
                    setAddCocktailCategory(cat.id);
                    setAddCocktailError('');
                    setAddCocktailFieldErrors({});
                    setNewCocktailForm({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '', ingredients: '', upgrade_addon_slugs: '' });
                  }}>+ Add Cocktail</button>
                </div>

                {addCocktailCategory === cat.id && (
                  <div className="card mb-1" style={{ background: 'var(--cream)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <div>
                        <input className="form-input" placeholder="Name *" value={newCocktailForm.name}
                          onChange={e => setNewCocktailForm(p => ({ ...p, name: e.target.value }))} />
                        <FieldError error={addCocktailFieldErrors?.name} />
                      </div>
                      <input className="form-input" placeholder="Emoji" value={newCocktailForm.emoji}
                        onChange={e => setNewCocktailForm(p => ({ ...p, emoji: e.target.value }))} />
                    </div>
                    <input className="form-input mb-1" placeholder="Description" value={newCocktailForm.description}
                      onChange={e => setNewCocktailForm(p => ({ ...p, description: e.target.value }))} />
                    <select className="form-input mb-1" value={newCocktailForm.base_spirit}
                      onChange={e => setNewCocktailForm(p => ({ ...p, base_spirit: e.target.value }))}>
                      <option value="">Base Spirit (optional)</option>
                      {SPIRIT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input className="form-input mb-1" placeholder="Ingredients (comma-separated, e.g. Vodka, Lime Juice, Sprite)"
                      value={newCocktailForm.ingredients}
                      onChange={e => setNewCocktailForm(p => ({ ...p, ingredients: e.target.value }))} />
                    <input className="form-input mb-1"
                      placeholder="Upgrade addon slugs (CSV, e.g. specialty-vermouths, specialty-bitter-aperitifs)"
                      title="Comma-separated addon slugs to charge when the package doesn't cover them"
                      value={newCocktailForm.upgrade_addon_slugs}
                      onChange={e => setNewCocktailForm(p => ({ ...p, upgrade_addon_slugs: e.target.value }))} />
                    <FormBanner error={addCocktailError} fieldErrors={addCocktailFieldErrors} />
                    <div className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => addCocktail(cat.id)}>Save</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setAddCocktailCategory(null)}>Cancel</button>
                    </div>
                  </div>
                )}

                {catDrinks.length === 0 ? (
                  <p className="text-muted text-small">No cocktails in this category.</p>
                ) : (
                  <DrinkTable
                    drinks={catDrinks}
                    categories={cocktailCategories}
                    editingId={editingCocktail}
                    editForm={editCocktailForm}
                    editFieldErrors={editCocktailFieldErrors}
                    withSpirit
                    onStartEdit={(c) => {
                      setEditingCocktail(c.id);
                      setEditCocktailForm({
                        name: c.name,
                        emoji: c.emoji || '',
                        description: c.description || '',
                        sort_order: c.sort_order,
                        category_id: c.category_id || '',
                        is_active: c.is_active,
                        base_spirit: c.base_spirit || '',
                        ingredients: (c.ingredients || []).join(', '),
                        upgrade_addon_slugs: Array.isArray(c.upgrade_addon_slugs) ? c.upgrade_addon_slugs.join(', ') : (c.upgrade_addon_slugs || ''),
                      });
                      setEditCocktailError('');
                      setEditCocktailFieldErrors({});
                    }}
                    onCancelEdit={() => { setEditingCocktail(null); setEditCocktailForm({}); setEditCocktailError(''); setEditCocktailFieldErrors({}); }}
                    onSaveEdit={saveEditCocktail}
                    onToggleActive={toggleCocktailActive}
                    onEditFormChange={(patch) => setEditCocktailForm(p => ({ ...p, ...patch }))}
                    onReorder={(items) => reorderCocktails(cat.id, items)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {isCocktails && subTab === 'categories' && (
        <div className="card">
          <div className="flex-between mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Cocktail Categories</h3>
            <button className="btn btn-sm" onClick={() => {
              setShowAddCocktailCat(true);
              setAddCocktailCatError('');
              setAddCocktailCatFieldErrors({});
            }}>+ Add Category</button>
          </div>
          <FormBanner error={editCocktailCatError} fieldErrors={editCocktailCatFieldErrors} />
          {showAddCocktailCat && (
            <div className="card mb-2" style={{ background: 'var(--cream)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div>
                  <input className="form-input" placeholder="Label *" value={newCocktailCatForm.label}
                    onChange={e => setNewCocktailCatForm(p => ({ ...p, label: e.target.value }))} />
                  <FieldError error={addCocktailCatFieldErrors?.label} />
                </div>
                <input className="form-input" placeholder="ID (auto if blank)" value={newCocktailCatForm.id}
                  onChange={e => setNewCocktailCatForm(p => ({ ...p, id: e.target.value }))} />
              </div>
              <FormBanner error={addCocktailCatError} fieldErrors={addCocktailCatFieldErrors} />
              <div className="flex gap-1">
                <button className="btn btn-sm" onClick={addCocktailCat}>Save</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddCocktailCat(false)}>Cancel</button>
              </div>
            </div>
          )}
          <CategoryTable
            categories={cocktailCategories}
            drinkCounts={Object.fromEntries(cocktailCategories.map(c => [c.id, cocktails.filter(x => x.category_id === c.id).length]))}
            editingId={editingCocktailCat}
            editForm={editCocktailCatForm}
            editFieldErrors={editCocktailCatFieldErrors}
            onStartEdit={(cat) => {
              setEditingCocktailCat(cat.id);
              setEditCocktailCatForm({ label: cat.label, sort_order: cat.sort_order });
              setEditCocktailCatError('');
              setEditCocktailCatFieldErrors({});
            }}
            onCancelEdit={() => { setEditingCocktailCat(null); setEditCocktailCatForm({}); setEditCocktailCatError(''); setEditCocktailCatFieldErrors({}); }}
            onSaveEdit={saveEditCocktailCat}
            onDelete={deleteCocktailCat}
            onEditFormChange={(patch) => setEditCocktailCatForm(p => ({ ...p, ...patch }))}
            onReorder={reorderCocktailCategories}
          />
        </div>
      )}

      {/* ══ MOCKTAILS ══ */}
      {!isCocktails && subTab === 'drinks' && (
        <div>
          <FormBanner error={editMocktailError} fieldErrors={editMocktailFieldErrors} />
          {mocktailCategories.map(cat => {
            const catDrinks = sortedMocktailsInCat(cat.id);
            return (
              <div key={cat.id} className="card mb-2">
                <div className="flex-between mb-1">
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>{cat.label}</h3>
                  <button className="btn btn-sm btn-secondary" onClick={() => {
                    setAddMocktailCategory(cat.id);
                    setAddMocktailError('');
                    setAddMocktailFieldErrors({});
                    setNewMocktailForm({ name: '', emoji: '', description: '', sort_order: '' });
                  }}>+ Add Mocktail</button>
                </div>

                {addMocktailCategory === cat.id && (
                  <div className="card mb-1" style={{ background: 'var(--cream)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <div>
                        <input className="form-input" placeholder="Name *" value={newMocktailForm.name}
                          onChange={e => setNewMocktailForm(p => ({ ...p, name: e.target.value }))} />
                        <FieldError error={addMocktailFieldErrors?.name} />
                      </div>
                      <input className="form-input" placeholder="Emoji" value={newMocktailForm.emoji}
                        onChange={e => setNewMocktailForm(p => ({ ...p, emoji: e.target.value }))} />
                    </div>
                    <input className="form-input mb-1" placeholder="Description" value={newMocktailForm.description}
                      onChange={e => setNewMocktailForm(p => ({ ...p, description: e.target.value }))} />
                    <FormBanner error={addMocktailError} fieldErrors={addMocktailFieldErrors} />
                    <div className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => addMocktail(cat.id)}>Save</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setAddMocktailCategory(null)}>Cancel</button>
                    </div>
                  </div>
                )}

                {catDrinks.length === 0 ? (
                  <p className="text-muted text-small">No mocktails in this category.</p>
                ) : (
                  <DrinkTable
                    drinks={catDrinks}
                    categories={mocktailCategories}
                    editingId={editingMocktail}
                    editForm={editMocktailForm}
                    editFieldErrors={editMocktailFieldErrors}
                    withSpirit={false}
                    onStartEdit={(m) => {
                      setEditingMocktail(m.id);
                      setEditMocktailForm({ name: m.name, emoji: m.emoji || '', description: m.description || '', sort_order: m.sort_order, category_id: m.category_id || '', is_active: m.is_active });
                      setEditMocktailError('');
                      setEditMocktailFieldErrors({});
                    }}
                    onCancelEdit={() => { setEditingMocktail(null); setEditMocktailForm({}); setEditMocktailError(''); setEditMocktailFieldErrors({}); }}
                    onSaveEdit={saveEditMocktail}
                    onToggleActive={toggleMocktailActive}
                    onEditFormChange={(patch) => setEditMocktailForm(p => ({ ...p, ...patch }))}
                    onReorder={(items) => reorderMocktails(cat.id, items)}
                  />
                )}
              </div>
            );
          })}
          {mocktailCategories.length === 0 && (
            <div className="card">
              <p className="text-muted">No mocktail categories yet. Switch to the Categories tab to add one.</p>
            </div>
          )}
        </div>
      )}

      {!isCocktails && subTab === 'categories' && (
        <div className="card">
          <div className="flex-between mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Mocktail Categories</h3>
            <button className="btn btn-sm" onClick={() => {
              setShowAddMocktailCat(true);
              setAddMocktailCatError('');
              setAddMocktailCatFieldErrors({});
            }}>+ Add Category</button>
          </div>
          <FormBanner error={editMocktailCatError} fieldErrors={editMocktailCatFieldErrors} />
          {showAddMocktailCat && (
            <div className="card mb-2" style={{ background: 'var(--cream)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div>
                  <input className="form-input" placeholder="Label *" value={newMocktailCatForm.label}
                    onChange={e => setNewMocktailCatForm(p => ({ ...p, label: e.target.value }))} />
                  <FieldError error={addMocktailCatFieldErrors?.label} />
                </div>
                <input className="form-input" placeholder="ID (auto if blank)" value={newMocktailCatForm.id}
                  onChange={e => setNewMocktailCatForm(p => ({ ...p, id: e.target.value }))} />
              </div>
              <FormBanner error={addMocktailCatError} fieldErrors={addMocktailCatFieldErrors} />
              <div className="flex gap-1">
                <button className="btn btn-sm" onClick={addMocktailCat}>Save</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddMocktailCat(false)}>Cancel</button>
              </div>
            </div>
          )}
          <CategoryTable
            categories={mocktailCategories}
            drinkCounts={Object.fromEntries(mocktailCategories.map(c => [c.id, mocktails.filter(x => x.category_id === c.id).length]))}
            editingId={editingMocktailCat}
            editForm={editMocktailCatForm}
            editFieldErrors={editMocktailCatFieldErrors}
            onStartEdit={(cat) => {
              setEditingMocktailCat(cat.id);
              setEditMocktailCatForm({ label: cat.label, sort_order: cat.sort_order });
              setEditMocktailCatError('');
              setEditMocktailCatFieldErrors({});
            }}
            onCancelEdit={() => { setEditingMocktailCat(null); setEditMocktailCatForm({}); setEditMocktailCatError(''); setEditMocktailCatFieldErrors({}); }}
            onSaveEdit={saveEditMocktailCat}
            onDelete={deleteMocktailCat}
            onEditFormChange={(patch) => setEditMocktailCatForm(p => ({ ...p, ...patch }))}
            onReorder={reorderMocktailCategories}
          />
        </div>
      )}
    </div>
  );
}
