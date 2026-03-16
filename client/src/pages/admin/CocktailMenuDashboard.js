import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

const SPIRIT_OPTIONS = ['Vodka', 'Gin', 'Rum', 'Tequila', 'Whiskey', 'Scotch', 'Bourbon', 'Mezcal', 'Cognac', 'Amaretto', 'Aperol', 'Other'];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function CocktailMenuDashboard() {
  const [categories, setCategories] = useState([]);
  const [cocktails, setCocktails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('cocktails');

  // Edit state for cocktails
  const [editingCocktail, setEditingCocktail] = useState(null); // cocktail id being edited
  const [editCocktailForm, setEditCocktailForm] = useState({});
  const [addCocktailCategory, setAddCocktailCategory] = useState(null); // category id to add to
  const [newCocktailForm, setNewCocktailForm] = useState({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '' });
  const [cocktailError, setCocktailError] = useState('');

  // Edit state for categories
  const [editingCategory, setEditingCategory] = useState(null);
  const [editCategoryForm, setEditCategoryForm] = useState({});
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryForm, setNewCategoryForm] = useState({ id: '', label: '', sort_order: '' });
  const [categoryError, setCategoryError] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      const res = await api.get('/cocktails/admin');
      setCategories(res.data.categories || []);
      setCocktails(res.data.cocktails || []);
    } catch (err) {
      console.error('Failed to fetch cocktails:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ─── Cocktail actions ───────────────────────────────────────────

  const startEditCocktail = (c) => {
    setEditingCocktail(c.id);
    setEditCocktailForm({ name: c.name, emoji: c.emoji || '', description: c.description || '', sort_order: c.sort_order, category_id: c.category_id || '', is_active: c.is_active, base_spirit: c.base_spirit || '' });
    setCocktailError('');
  };

  const cancelEditCocktail = () => { setEditingCocktail(null); setEditCocktailForm({}); };

  const saveEditCocktail = async (id) => {
    try {
      const res = await api.put(`/cocktails/${id}`, editCocktailForm);
      setCocktails(prev => prev.map(c => c.id === id ? { ...c, ...res.data } : c));
      setEditingCocktail(null);
    } catch (err) {
      setCocktailError(err.response?.data?.error || 'Failed to save cocktail.');
    }
  };

  const toggleActive = async (c) => {
    try {
      const res = await api.put(`/cocktails/${c.id}`, { is_active: !c.is_active });
      setCocktails(prev => prev.map(x => x.id === c.id ? { ...x, ...res.data } : x));
    } catch (err) {
      console.error('Failed to toggle active:', err);
    }
  };

  const deleteCocktail = async (id) => {
    if (!window.confirm('Deactivate this cocktail? It will no longer appear in the client questionnaire.')) return;
    try {
      await api.delete(`/cocktails/${id}`);
      setCocktails(prev => prev.map(c => c.id === id ? { ...c, is_active: false } : c));
    } catch (err) {
      console.error('Failed to deactivate cocktail:', err);
    }
  };

  const addCocktail = async (categoryId) => {
    if (!newCocktailForm.name.trim()) { setCocktailError('Name is required.'); return; }
    const id = slugify(newCocktailForm.name);
    try {
      const res = await api.post('/cocktails', {
        id,
        name: newCocktailForm.name.trim(),
        category_id: categoryId,
        emoji: newCocktailForm.emoji.trim() || null,
        description: newCocktailForm.description.trim() || null,
        sort_order: parseInt(newCocktailForm.sort_order) || 0,
        base_spirit: newCocktailForm.base_spirit || null,
      });
      setCocktails(prev => [...prev, res.data]);
      setNewCocktailForm({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '' });
      setAddCocktailCategory(null);
      setCocktailError('');
    } catch (err) {
      setCocktailError(err.response?.data?.error || 'Failed to add cocktail.');
    }
  };

  // ─── Category actions ───────────────────────────────────────────

  const startEditCategory = (cat) => {
    setEditingCategory(cat.id);
    setEditCategoryForm({ label: cat.label, sort_order: cat.sort_order });
    setCategoryError('');
  };

  const cancelEditCategory = () => { setEditingCategory(null); setEditCategoryForm({}); };

  const saveEditCategory = async (id) => {
    try {
      const res = await api.put(`/cocktails/categories/${id}`, editCategoryForm);
      setCategories(prev => prev.map(c => c.id === id ? { ...c, ...res.data } : c));
      setEditingCategory(null);
    } catch (err) {
      setCategoryError(err.response?.data?.error || 'Failed to save category.');
    }
  };

  const deleteCategory = async (id) => {
    if (!window.confirm('Delete this category? This will fail if any cocktails are still assigned to it.')) return;
    try {
      await api.delete(`/cocktails/categories/${id}`);
      setCategories(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      setCategoryError(err.response?.data?.error || 'Failed to delete category.');
    }
  };

  const addCategory = async () => {
    if (!newCategoryForm.label.trim()) { setCategoryError('Label is required.'); return; }
    const id = newCategoryForm.id.trim() || slugify(newCategoryForm.label);
    try {
      const res = await api.post('/cocktails/categories', {
        id,
        label: newCategoryForm.label.trim(),
        sort_order: parseInt(newCategoryForm.sort_order) || 0,
      });
      setCategories(prev => [...prev, res.data].sort((a, b) => a.sort_order - b.sort_order));
      setNewCategoryForm({ id: '', label: '', sort_order: '' });
      setShowAddCategory(false);
      setCategoryError('');
    } catch (err) {
      setCategoryError(err.response?.data?.error || 'Failed to add category.');
    }
  };

  if (loading) {
    return (
      <div className="page-container" style={{ textAlign: 'center', paddingTop: '2rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="flex-between mb-2" style={{ flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>
            Cocktail Menu
          </h2>
          <p className="text-muted text-small mt-1">{cocktails.filter(c => c.is_active).length} active cocktails across {categories.length} categories</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-nav mb-2">
        <button className={`tab-btn${activeTab === 'cocktails' ? ' active' : ''}`} onClick={() => setActiveTab('cocktails')}>
          Cocktails
        </button>
        <button className={`tab-btn${activeTab === 'categories' ? ' active' : ''}`} onClick={() => setActiveTab('categories')}>
          Categories
        </button>
      </div>

      {/* ── Cocktails tab ── */}
      {activeTab === 'cocktails' && (
        <div>
          {cocktailError && <div className="alert alert-error mb-2">{cocktailError}</div>}
          {categories.map(cat => {
            const catCocktails = cocktails.filter(c => c.category_id === cat.id);
            return (
              <div key={cat.id} className="card mb-2">
                <div className="flex-between mb-1">
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>
                    {cat.label}
                  </h3>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => { setAddCocktailCategory(cat.id); setCocktailError(''); setNewCocktailForm({ name: '', emoji: '', description: '', sort_order: '', base_spirit: '' }); }}
                  >
                    + Add Cocktail
                  </button>
                </div>

                {addCocktailCategory === cat.id && (
                  <div className="card mb-1" style={{ background: 'var(--cream)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <input className="form-input" placeholder="Name *" value={newCocktailForm.name}
                        onChange={e => setNewCocktailForm(p => ({ ...p, name: e.target.value }))} />
                      <input className="form-input" placeholder="Emoji" value={newCocktailForm.emoji}
                        onChange={e => setNewCocktailForm(p => ({ ...p, emoji: e.target.value }))} />
                    </div>
                    <input className="form-input mb-1" placeholder="Description" value={newCocktailForm.description}
                      onChange={e => setNewCocktailForm(p => ({ ...p, description: e.target.value }))} />
                    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <input className="form-input" type="number" placeholder="Sort order (0)" value={newCocktailForm.sort_order}
                        onChange={e => setNewCocktailForm(p => ({ ...p, sort_order: e.target.value }))} />
                      <select className="form-input" value={newCocktailForm.base_spirit}
                        onChange={e => setNewCocktailForm(p => ({ ...p, base_spirit: e.target.value }))}>
                        <option value="">Base Spirit (optional)</option>
                        {SPIRIT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => addCocktail(cat.id)}>Save</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setAddCocktailCategory(null)}>Cancel</button>
                    </div>
                  </div>
                )}

                {catCocktails.length === 0 ? (
                  <p className="text-muted text-small">No cocktails in this category.</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Emoji</th>
                        <th>Name</th>
                        <th>Description</th>
                        <th>Spirit</th>
                        <th>Order</th>
                        <th>Active</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {catCocktails.map(c => (
                        <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.5 }}>
                          {editingCocktail === c.id ? (
                            <>
                              <td><input className="form-input" style={{ width: '60px' }} value={editCocktailForm.emoji}
                                onChange={e => setEditCocktailForm(p => ({ ...p, emoji: e.target.value }))} /></td>
                              <td><input className="form-input" value={editCocktailForm.name}
                                onChange={e => setEditCocktailForm(p => ({ ...p, name: e.target.value }))} /></td>
                              <td><input className="form-input" value={editCocktailForm.description}
                                onChange={e => setEditCocktailForm(p => ({ ...p, description: e.target.value }))} /></td>
                              <td>
                                <select className="form-input" style={{ width: '100px' }} value={editCocktailForm.base_spirit}
                                  onChange={e => setEditCocktailForm(p => ({ ...p, base_spirit: e.target.value }))}>
                                  <option value="">—</option>
                                  {SPIRIT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </td>
                              <td><input className="form-input" type="number" style={{ width: '70px' }} value={editCocktailForm.sort_order}
                                onChange={e => setEditCocktailForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))} /></td>
                              <td>
                                <input type="checkbox" checked={editCocktailForm.is_active}
                                  onChange={e => setEditCocktailForm(p => ({ ...p, is_active: e.target.checked }))} />
                              </td>
                              <td>
                                <div className="flex gap-1">
                                  <button className="btn btn-sm" onClick={() => saveEditCocktail(c.id)}>Save</button>
                                  <button className="btn btn-sm btn-secondary" onClick={cancelEditCocktail}>Cancel</button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{c.emoji}</td>
                              <td><strong>{c.name}</strong></td>
                              <td className="text-muted text-small">{c.description || '—'}</td>
                              <td className="text-muted text-small">{c.base_spirit || '—'}</td>
                              <td>{c.sort_order}</td>
                              <td>
                                <button
                                  className={`btn btn-sm ${c.is_active ? 'btn-success' : 'btn-secondary'}`}
                                  onClick={() => toggleActive(c)}
                                  style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                                >
                                  {c.is_active ? 'Active' : 'Inactive'}
                                </button>
                              </td>
                              <td>
                                <div className="flex gap-1">
                                  <button className="btn btn-sm btn-secondary" onClick={() => startEditCocktail(c)}>Edit</button>
                                  {c.is_active && (
                                    <button className="btn btn-sm btn-danger" onClick={() => deleteCocktail(c.id)}>Deactivate</button>
                                  )}
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Categories tab ── */}
      {activeTab === 'categories' && (
        <div className="card">
          <div className="flex-between mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: 0 }}>Categories</h3>
            <button className="btn btn-sm" onClick={() => { setShowAddCategory(true); setCategoryError(''); }}>+ Add Category</button>
          </div>

          {categoryError && <div className="alert alert-error mb-2">{categoryError}</div>}

          {showAddCategory && (
            <div className="card mb-2" style={{ background: 'var(--cream)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input className="form-input" placeholder="Label *" value={newCategoryForm.label}
                  onChange={e => setNewCategoryForm(p => ({ ...p, label: e.target.value }))} />
                <input className="form-input" placeholder="ID (auto-generated if blank)" value={newCategoryForm.id}
                  onChange={e => setNewCategoryForm(p => ({ ...p, id: e.target.value }))} />
                <input className="form-input" type="number" placeholder="Order" value={newCategoryForm.sort_order}
                  onChange={e => setNewCategoryForm(p => ({ ...p, sort_order: e.target.value }))} />
              </div>
              <div className="flex gap-1">
                <button className="btn btn-sm" onClick={addCategory}>Save</button>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowAddCategory(false)}>Cancel</button>
              </div>
            </div>
          )}

          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
                <th>Sort Order</th>
                <th>Cocktails</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {categories.map(cat => {
                const count = cocktails.filter(c => c.category_id === cat.id).length;
                return (
                  <tr key={cat.id}>
                    {editingCategory === cat.id ? (
                      <>
                        <td className="text-muted text-small">{cat.id}</td>
                        <td><input className="form-input" value={editCategoryForm.label}
                          onChange={e => setEditCategoryForm(p => ({ ...p, label: e.target.value }))} /></td>
                        <td><input className="form-input" type="number" style={{ width: '80px' }} value={editCategoryForm.sort_order}
                          onChange={e => setEditCategoryForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))} /></td>
                        <td>{count}</td>
                        <td>
                          <div className="flex gap-1">
                            <button className="btn btn-sm" onClick={() => saveEditCategory(cat.id)}>Save</button>
                            <button className="btn btn-sm btn-secondary" onClick={cancelEditCategory}>Cancel</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="text-muted text-small">{cat.id}</td>
                        <td><strong>{cat.label}</strong></td>
                        <td>{cat.sort_order}</td>
                        <td>{count}</td>
                        <td>
                          <div className="flex gap-1">
                            <button className="btn btn-sm btn-secondary" onClick={() => startEditCategory(cat)}>Edit</button>
                            {count === 0 && (
                              <button className="btn btn-sm btn-danger" onClick={() => deleteCategory(cat.id)}>Delete</button>
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
      )}
    </div>
  );
}
