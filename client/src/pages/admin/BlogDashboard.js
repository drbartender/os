import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import api, { API_BASE_URL } from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmtDate } from '../../components/adminos/format';

// TipTap is ~200 KB; load it only when the editor actually mounts so visiting
// the blog list (the more common path) doesn't pull the editor chunk.
const RichTextEditor = lazy(() => import('../../components/RichTextEditor'));

function resolveImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) {
    const base = API_BASE_URL.replace(/\/api$/, '');
    return `${base}${url}`;
  }
  return url;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function formatDate(d) {
  if (!d) return '—';
  return fmtDate(String(d).slice(0, 10), { year: 'numeric' });
}

const EMPTY_FORM = {
  title: '',
  slug: '',
  excerpt: '',
  cover_image_url: '',
  published: false,
  published_at: '',
  body: '',
};

// ─── Post Form ───────────────────────────────────────────────────

function PostForm({ form, setForm, onSubmit, onCancel, submitLabel, uploading, onUploadImage, error, fieldErrors }) {
  const handleTitleChange = (e) => {
    const title = e.target.value;
    const updates = { title };
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
          <FieldError error={fieldErrors?.title} />
        </div>
        <div className="form-group">
          <label className="form-label">Slug</label>
          <input className="form-input" value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} required />
          <FieldError error={fieldErrors?.slug} />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Excerpt</label>
        <textarea className="form-textarea" value={form.excerpt} onChange={e => setForm(f => ({ ...f, excerpt: e.target.value }))} rows={2} placeholder="Short summary for the blog index..." />
        <FieldError error={fieldErrors?.excerpt} />
      </div>

      <div className="form-group">
        <label className="form-label">Cover Image</label>
        {form.cover_image_url ? (
          <div className="blog-editor-image-preview">
            <img src={resolveImageUrl(form.cover_image_url)} alt="Cover" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, cover_image_url: '' }))}>Remove</button>
          </div>
        ) : (
          <label className="blog-editor-image-upload">
            <input type="file" accept=".jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={handleCoverUpload} />
            <span className="blog-editor-upload-placeholder">Click to upload a cover image</span>
          </label>
        )}
        <FieldError error={fieldErrors?.cover_image_url} />
      </div>

      <div className="form-group">
        <label className="form-label">Content</label>
        <Suspense fallback={<div className="muted" style={{ padding: '1rem 0' }}>Loading editor…</div>}>
          <RichTextEditor
            content={form.body}
            onChange={body => setForm(f => ({ ...f, body }))}
            onUploadImage={onUploadImage}
          />
        </Suspense>
        <FieldError error={fieldErrors?.body} />
      </div>

      <div className="two-col">
        <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" id="blog-published" checked={form.published} onChange={e => setForm(f => ({ ...f, published: e.target.checked }))} />
          <label htmlFor="blog-published" className="form-label" style={{ margin: 0 }}>Published</label>
        </div>
        <div className="form-group">
          <label className="form-label">Publish Date</label>
          <input
            className="form-input"
            type="date"
            value={form.published_at ? form.published_at.slice(0, 10) : ''}
            onChange={e => setForm(f => ({ ...f, published_at: e.target.value || '' }))}
            placeholder="Leave blank for current date"
          />
          <small style={{ color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>Leave blank to use today's date when published</small>
          <FieldError error={fieldErrors?.published_at} />
        </div>
      </div>

      <FormBanner error={error} fieldErrors={fieldErrors} />

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
        <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : submitLabel}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────

export default function BlogDashboard() {
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [createForm, setCreateForm] = useState({ ...EMPTY_FORM });
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM });
  const [uploading, setUploading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState({});
  const [editError, setEditError] = useState('');
  const [editFieldErrors, setEditFieldErrors] = useState({});

  const fetchPosts = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/blog');
      setPosts(data);
    } catch (err) {
      toast.error('Failed to load posts. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  const uploadImage = async (file) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const { data } = await api.post('/admin/blog/upload-image', formData);
      return resolveImageUrl(data.url);
    } catch (err) {
      toast.error(err.message || 'Image upload failed.');
      return null;
    } finally {
      setUploading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    setCreateFieldErrors({});
    try {
      const { _prevTitle, ...rest } = createForm;
      if (!rest.published_at) delete rest.published_at;
      const wasPublished = !!rest.published;
      await api.post('/admin/blog', rest);
      setCreateForm({ ...EMPTY_FORM });
      setShowCreateForm(false);
      toast.success(wasPublished ? 'Post published.' : 'Post saved.');
      fetchPosts();
    } catch (err) {
      setCreateError(err.message || 'Failed to create post.');
      setCreateFieldErrors(err.fieldErrors || {});
    }
  };

  const startEdit = async (post) => {
    // Claim the edit slot up front so the Edit/Delete buttons disable
    // immediately — prevents double-clicks and row-switch races during
    // the /admin/blog/:id fetch. Also clear editForm so a prior post's
    // data doesn't flash into the form while the fetch is in flight.
    setEditingId(post.id);
    setEditForm({ ...EMPTY_FORM });
    setShowCreateForm(false);
    setEditError('');
    setEditFieldErrors({});
    try {
      const { data: fullPost } = await api.get(`/admin/blog/${post.id}`);
      setEditForm({
        title: fullPost.title,
        slug: fullPost.slug,
        excerpt: fullPost.excerpt || '',
        cover_image_url: fullPost.cover_image_url || '',
        published: fullPost.published,
        published_at: fullPost.published_at || '',
        body: fullPost.body || '',
        _prevTitle: fullPost.title,
      });
    } catch (err) {
      setEditingId(null);
      toast.error(err.message || 'Failed to load post. Try again.');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setEditError('');
    setEditFieldErrors({});
    try {
      const { _prevTitle, ...rest } = editForm;
      if (!rest.published_at) delete rest.published_at;
      const previousPost = posts.find(p => p.id === editingId);
      const isFirstPublish = !!rest.published && previousPost && !previousPost.published;
      await api.put(`/admin/blog/${editingId}`, rest);
      setEditingId(null);
      toast.success(isFirstPublish ? 'Post published.' : 'Post saved.');
      fetchPosts();
    } catch (err) {
      setEditError(err.message || 'Failed to update post.');
      setEditFieldErrors(err.fieldErrors || {});
    }
  };

  const handleDelete = async (id, title) => {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/blog/${id}`);
      toast.success('Post deleted.');
      fetchPosts();
    } catch (err) {
      toast.error(err.message || 'Failed to delete post.');
    }
  };

  if (loading) return <div className="page"><div className="muted">Loading…</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Lab Notes</div>
          <div className="page-subtitle">Blog posts for the public site.</div>
        </div>
        <div className="page-actions">
          {!showCreateForm && !editingId && (
            <button type="button" className="btn btn-primary" onClick={() => { setShowCreateForm(true); setEditingId(null); setCreateError(''); setCreateFieldErrors({}); }}>
              <Icon name="plus" />New post
            </button>
          )}
        </div>
      </div>

      {showCreateForm && (
        <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: 'var(--gap)' }}>
          <div className="section-title" style={{ margin: 0, marginBottom: 12 }}>New post</div>
          <PostForm
            form={createForm}
            setForm={setCreateForm}
            onSubmit={handleCreate}
            onCancel={() => { setShowCreateForm(false); setCreateForm({ ...EMPTY_FORM }); setCreateError(''); setCreateFieldErrors({}); }}
            submitLabel="Create post"
            uploading={uploading}
            onUploadImage={uploadImage}
            error={createError}
            fieldErrors={createFieldErrors}
          />
        </div>
      )}

      {editingId && (
        <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: 'var(--gap)' }}>
          <div className="section-title" style={{ margin: 0, marginBottom: 12 }}>Edit post</div>
          <PostForm
            form={editForm}
            setForm={setEditForm}
            onSubmit={handleUpdate}
            onCancel={() => { setEditingId(null); setEditError(''); setEditFieldErrors({}); }}
            submitLabel="Save changes"
            uploading={uploading}
            onUploadImage={uploadImage}
            error={editError}
            fieldErrors={editFieldErrors}
          />
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Published</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {posts.length === 0 && (
                <tr><td colSpan={5} className="muted">No blog posts yet. Create your first one!</td></tr>
              )}
              {posts.map(post => (
                <tr key={post.id} style={{ opacity: editingId === post.id ? 0.5 : 1 }}>
                  <td><strong>{post.title}</strong></td>
                  <td>
                    <StatusChip kind={post.published ? 'ok' : 'neutral'}>
                      {post.published ? 'Published' : 'Draft'}
                    </StatusChip>
                  </td>
                  <td className="muted">{formatDate(post.published_at)}</td>
                  <td className="muted">{formatDate(post.created_at)}</td>
                  <td className="shrink">
                    <div className="hstack" style={{ gap: 4 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEdit(post)} disabled={!!editingId}>
                        <Icon name="pen" size={11} />Edit
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }} onClick={() => handleDelete(post.id, post.title)} disabled={!!editingId}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
