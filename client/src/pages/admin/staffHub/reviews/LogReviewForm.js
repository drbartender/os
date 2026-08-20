import React, { useEffect, useState } from 'react';
import api from '../../../../utils/api';

/**
 * The manual Google review row, moved out of the retired Reviews page (spec
 * §7) into a
 * modal shell (the same fixed scrim + Escape close AwardDialog uses) so the
 * hub header's "Log a Google review" action can open it.
 *
 * The submit path is unchanged: date required, stars 1..5, excerpt 2000
 * characters max, POST /admin/staff-reviews, and the server's
 * duplicate_warning handed straight back to the caller.
 */
export default function LogReviewForm({ open, onClose, onCreated, onError }) {
  const [form, setForm] = useState({ review_date: '', stars: '5', excerpt: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    const stars = Number(form.stars);
    if (!form.review_date) return onError('Pick the review date.');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return onError('Stars must be 1 to 5.');
    if (form.excerpt.length > 2000) return onError('Excerpt is over 2000 characters.');
    setSaving(true);
    try {
      const res = await api.post('/admin/staff-reviews', {
        review_date: form.review_date,
        stars,
        excerpt: form.excerpt || null,
      });
      setForm({ review_date: '', stars: '5', excerpt: '' });
      onCreated(!!res.data?.duplicate_warning);
    } catch (err) {
      onError(err?.message || 'Failed to log the review.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Log a Google review"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center', padding: 16,
      }}
      data-app="admin-os"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          width: 460, maxWidth: '94vw',
          background: 'var(--bg-1)', color: 'var(--ink-1)',
          border: '1px solid var(--line-1)', borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '0.7rem 1rem', borderBottom: '1px solid var(--line-1)' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Log a Google review</h3>
        </div>
        <div style={{ padding: '1rem', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Review date</span>
            <input
              type="date"
              value={form.review_date}
              onChange={e => set('review_date', e.target.value)}
              required
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span className="muted">Stars</span>
            <select value={form.stars} onChange={e => set('stars', e.target.value)}>
              {[5, 4, 3, 2, 1].map(n => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, flex: '1 1 320px' }}>
            <span className="muted">Excerpt (optional, 2000 characters max)</span>
            <input
              type="text"
              value={form.excerpt}
              maxLength={2000}
              placeholder="Jane was dope behind the bar"
              onChange={e => set('excerpt', e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flex: '1 1 100%' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Log review'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
