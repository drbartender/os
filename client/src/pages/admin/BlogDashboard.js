import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const EMPTY_FORM = {
  title: '',
  slug: '',
  excerpt: '',
  cover_image_url: '',
  published: false,
  blocks: [{ type: 'text', content: '' }],
};

// ─── Block Editor ────────────────────────────────────────────────

function BlockEditor({ blocks, onChange, onUploadImage }) {
  const updateBlock = (index, updates) => {
    const next = blocks.map((b, i) => i === index ? { ...b, ...updates } : b);
    onChange(next);
  };

  const removeBlock = (index) => {
    if (blocks.length <= 1) return;
    onChange(blocks.filter((_, i) => i !== index));
  };

  const moveBlock = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addBlock = (type) => {
    const block = type === 'text'
      ? { type: 'text', content: '' }
      : { type: 'image', url: '', caption: '' };
    onChange([...blocks, block]);
  };

  const handleImageUpload = async (index, file) => {
    const url = await onUploadImage(file);
    if (url) updateBlock(index, { url });
  };

  return (
    <div className="blog-editor-blocks">
      {blocks.map((block, i) => (
        <div key={i} className="blog-editor-block">
          <div className="blog-editor-block-header">
            <span className="blog-editor-block-type">
              {block.type === 'text' ? 'Text' : 'Image'}
            </span>
            <div className="blog-editor-block-actions">
              <button type="button" className="btn-icon" onClick={() => moveBlock(i, -1)} disabled={i === 0} title="Move up">&uarr;</button>
              <button type="button" className="btn-icon" onClick={() => moveBlock(i, 1)} disabled={i === blocks.length - 1} title="Move down">&darr;</button>
              <button type="button" className="btn-icon btn-icon-danger" onClick={() => removeBlock(i)} disabled={blocks.length <= 1} title="Remove">&times;</button>
            </div>
          </div>
          {block.type === 'text' ? (
            <textarea
              className="form-textarea blog-editor-textarea"
              value={block.content}
              onChange={e => updateBlock(i, { content: e.target.value })}
              placeholder="Write your content here... Double line breaks become paragraphs."
              rows={6}
            />
          ) : (
            <div className="blog-editor-image-block">
              {block.url ? (
                <div className="blog-editor-image-preview">
                  <img src={block.url} alt="Uploaded" />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => updateBlock(i, { url: '' })}>Replace Image</button>
                </div>
              ) : (
                <label className="blog-editor-image-upload">
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png"
                    style={{ display: 'none' }}
                    onChange={e => {
                      if (e.target.files[0]) handleImageUpload(i, e.target.files[0]);
                    }}
                  />
                  <span className="blog-editor-upload-placeholder">Click to upload an image (JPEG or PNG)</span>
                </label>
              )}
              <input
                className="form-input"
                value={block.caption || ''}
                onChange={e => updateBlock(i, { caption: e.target.value })}
                placeholder="Caption (optional)"
              />
            </div>
          )}
        </div>
      ))}
      <div className="blog-editor-add-buttons">
        <button type="button" className="btn btn-secondary" onClick={() => addBlock('text')}>+ Text Block</button>
        <button type="button" className="btn btn-secondary" onClick={() => addBlock('image')}>+ Image Block</button>
      </div>
    </div>
  );
}

// ─── Post Form ───────────────────────────────────────────────────

function PostForm({ form, setForm, onSubmit, onCancel, submitLabel, uploading, onUploadImage }) {
  const handleTitleChange = (e) => {
    const title = e.target.value;
    const updates = { title };
    // Auto-generate slug only if slug is empty or matches auto-generated version of previous title
    if (!form.slug || form.slug === slugify(form._prevTitle || '')) {
      updates.slug = slugify(title);
    }
    updates._prevTitle = title;
    setForm(f => ({ ...f, ...updates }));
  };

  const handleCoverUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = await onUploadImage(file);
    if (url) setForm(f => ({ ...f, cover_image_url: url }));
  };

  return (
    <form onSubmit={onSubmit} className="blog-post-form">
      <div className="two-col">
        <div className="form-group">
          <label className="form-label">Title</label>
          <input className="form-input" value={form.title} onChange={handleTitleChange} required />
        </div>
        <div className="form-group">
          <label className="form-label">Slug</label>
          <input className="form-input" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} required />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Excerpt</label>
        <textarea className="form-textarea" value={form.excerpt} onChange={e => setForm(f => ({ ...f, excerpt: e.target.value }))} rows={2} placeholder="Short summary for the blog index..." />
      </div>

      <div className="form-group">
        <label className="form-label">Cover Image</label>
        {form.cover_image_url ? (
          <div className="blog-editor-image-preview">
            <img src={form.cover_image_url} alt="Cover" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, cover_image_url: '' }))}>Remove</button>
          </div>
        ) : (
          <label className="blog-editor-image-upload">
            <input type="file" accept=".jpg,.jpeg,.png" style={{ display: 'none' }} onChange={handleCoverUpload} />
            <span className="blog-editor-upload-placeholder">Click to upload a cover image</span>
          </label>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Content</label>
        <BlockEditor
          blocks={form.blocks}
          onChange={blocks => setForm(f => ({ ...f, blocks }))}
          onUploadImage={onUploadImage}
        />
      </div>

      <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input type="checkbox" id="blog-published" checked={form.published} onChange={e => setForm(f => ({ ...f, published: e.target.checked }))} />
        <label htmlFor="blog-published" className="form-label" style={{ margin: 0 }}>Published</label>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
        <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : submitLabel}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────

export default function BlogDashboard() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [createForm, setCreateForm] = useState({ ...EMPTY_FORM });
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const fetchPosts = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/blog');
      setPosts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  const uploadImage = async (file) => {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('image', file);
      const { data } = await api.post('/admin/blog/upload-image', formData);
      return data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'Image upload failed');
      return null;
    } finally {
      setUploading(false);
    }
  };

  const parseBody = (bodyStr) => {
    try {
      const parsed = JSON.parse(bodyStr);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // Fallback for plain text/HTML body
    return [{ type: 'text', content: bodyStr || '' }];
  };

  const serializeBlocks = (blocks) => JSON.stringify(blocks);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { blocks, _prevTitle, ...rest } = createForm;
      await api.post('/admin/blog', { ...rest, body: serializeBlocks(blocks) });
      setCreateForm({ ...EMPTY_FORM });
      setShowCreateForm(false);
      fetchPosts();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create post');
    }
  };

  const startEdit = (post) => {
    setEditingId(post.id);
    setShowCreateForm(false);
    setEditForm({
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt || '',
      cover_image_url: post.cover_image_url || '',
      published: post.published,
      blocks: parseBody(post.body),
      _prevTitle: post.title,
    });
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { blocks, _prevTitle, ...rest } = editForm;
      await api.put(`/admin/blog/${editingId}`, { ...rest, body: serializeBlocks(blocks) });
      setEditingId(null);
      fetchPosts();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update post');
    }
  };

  const handleDelete = async (id, title) => {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/blog/${id}`);
      fetchPosts();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete post');
    }
  };

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>Blog Posts</h1>
        {!showCreateForm && !editingId && (
          <button className="btn btn-primary" onClick={() => { setShowCreateForm(true); setEditingId(null); }}>New Post</button>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {showCreateForm && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2 style={{ marginBottom: '1rem' }}>New Post</h2>
          <PostForm
            form={createForm}
            setForm={setCreateForm}
            onSubmit={handleCreate}
            onCancel={() => { setShowCreateForm(false); setCreateForm({ ...EMPTY_FORM }); }}
            submitLabel="Create Post"
            uploading={uploading}
            onUploadImage={uploadImage}
          />
        </div>
      )}

      {editingId && (
        <div className="card" style={{ marginBottom: '2rem' }}>
          <h2 style={{ marginBottom: '1rem' }}>Edit Post</h2>
          <PostForm
            form={editForm}
            setForm={setEditForm}
            onSubmit={handleUpdate}
            onCancel={() => setEditingId(null)}
            submitLabel="Save Changes"
            uploading={uploading}
            onUploadImage={uploadImage}
          />
        </div>
      )}

      {posts.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>No blog posts yet. Create your first one!</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th style={{ width: '100px' }}>Status</th>
                <th style={{ width: '140px' }}>Published</th>
                <th style={{ width: '140px' }}>Created</th>
                <th style={{ width: '120px' }}></th>
              </tr>
            </thead>
            <tbody>
              {posts.map(post => (
                <tr key={post.id} style={{ opacity: editingId === post.id ? 0.5 : 1 }}>
                  <td><strong>{post.title}</strong></td>
                  <td>
                    <span className={`blog-status-pill ${post.published ? 'published' : 'draft'}`}>
                      {post.published ? 'Published' : 'Draft'}
                    </span>
                  </td>
                  <td>{formatDate(post.published_at)}</td>
                  <td>{formatDate(post.created_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(post)} disabled={!!editingId}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(post.id, post.title)} disabled={!!editingId}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
