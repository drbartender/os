import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';

const authHeader = () => { const t = localStorage.getItem('db_client_token'); return t ? { Authorization: `Bearer ${t}` } : {}; };
const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function ChangeRequestForm({ proposal, token, onSubmitted, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    guest_count: proposal.guest_count, event_duration_hours: proposal.event_duration_hours,
    num_bars: proposal.num_bars ?? 1, event_date: proposal.event_date ? String(proposal.event_date).slice(0, 10) : '',
    package_id: proposal.package_id, note: '',
  });
  // Package options for the swap selector (P8). Public endpoint, current package
  // preselected. Non-class only, but always keep the current package present so a
  // class booking can still see (and keep) its own selection.
  const [packages, setPackages] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api.get('/proposals/public/packages')
      .then(({ data }) => {
        if (cancelled) return;
        const list = (data || []).filter(p => p.bar_type !== 'class' || p.id === proposal.package_id);
        setPackages(list);
      })
      .catch(() => { /* selector falls back to the current package only */ });
    return () => { cancelled = true; };
  }, [proposal.package_id]);

  const proposed = useCallback(() => ({
    guest_count: Number(form.guest_count), event_duration_hours: Number(form.event_duration_hours),
    num_bars: Number(form.num_bars), package_id: Number(form.package_id),
    ...(form.event_date ? { event_date: form.event_date } : {}),
  }), [form]);

  const fetchPreview = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { data } = await api.post(`/client-portal/proposals/${token}/calculate`, proposed(), { headers: authHeader() });
      if (mine !== seq.current) return;
      setPreview(data.price_preview); setPreviewError(false);
    } catch (e) {
      if (mine !== seq.current) return;
      setPreview(null); setPreviewError(true);
      Sentry.captureException(e, { tags: { area: 'client-portal', surface: 'change-request-calculate' } });
    }
  }, [token, proposed]);

  useEffect(() => { const t = setTimeout(fetchPreview, 300); return () => clearTimeout(t); }, [fetchPreview]);

  const submit = async () => {
    if (!preview || previewError) { toast.error('We could not price this change. Please try again.'); return; }
    setSubmitting(true);
    try {
      await api.post(`/client-portal/proposals/${token}/change-requests`,
        { ...proposed(), note: form.note, acknowledged_total: preview.estimated_total },
        { headers: authHeader() });
      toast.success('Request sent. We will confirm shortly.');
      onSubmitted && onSubmitted();
    } catch (e) {
      if (e.status === 409 && e.code === 'PRICE_CHANGED') {
        toast.error('The price updated. Review the new estimate and submit again.');
        fetchPreview();
      } else if (e.status === 409) {
        toast.error('You already have a pending request for this event.');
      } else {
        toast.error(e.message || 'Could not send your request.');
      }
    } finally { setSubmitting(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Ensure the current package is always an option even before the list loads
  // or if the fetch failed, so the selector never renders empty.
  const packageOptions = packages.length
    ? packages
    : [{ id: proposal.package_id, name: proposal.package_name || 'Current package' }];

  return (
    <div className="cp-change-form">
      <h3>Request a change</h3>
      <label className="form-label">Package
        <select value={form.package_id} onChange={e => set('package_id', e.target.value)}>
          {packageOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="form-label">Guest count
        <input type="number" min="1" max="1000" value={form.guest_count} onChange={e => set('guest_count', e.target.value)} />
      </label>
      <label className="form-label">Duration (hours)
        <input type="number" min="1" max="12" step="0.5" value={form.event_duration_hours} onChange={e => set('event_duration_hours', e.target.value)} />
      </label>
      <label className="form-label">Number of bars
        <input type="number" min="1" max="10" value={form.num_bars} onChange={e => set('num_bars', e.target.value)} />
      </label>
      <label className="form-label">Event date (subject to availability)
        <input type="date" value={form.event_date} onChange={e => set('event_date', e.target.value)} />
      </label>
      <label className="form-label">Anything else
        <textarea value={form.note} onChange={e => set('note', e.target.value)} rows={3} />
      </label>

      <div className="cp-change-preview">
        {previewError && <div className="client-alert client-alert-error">We could not price this change. Adjust and try again.</div>}
        {preview && !previewError && (
          <>
            <div className="cp-leader"><span>Current total</span><span>{fmt(preview.current_total)}</span></div>
            <div className="cp-leader"><span>Estimated new total</span><span>{fmt(preview.estimated_total)}</span></div>
            <div className="cp-leader"><span>Change</span><span>{preview.delta >= 0 ? '+' : ''}{fmt(preview.delta)}</span></div>
            <p className="form-hint">Reductions are reviewed by our team; any refund is handled individually.</p>
          </>
        )}
      </div>

      <div className="cp-rx-actions">
        <button type="button" className="btn client-btn-primary" disabled={submitting || !preview || previewError} onClick={submit}>
          {submitting ? 'Sending...' : 'Send request'}
        </button>
        <button type="button" className="btn-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
