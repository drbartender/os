import React, { useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { API_BASE_URL } from '../../utils/api';
import AudienceSelector from '../../components/AudienceSelector';
import EmailBlockBuilder from '../../components/emailBuilder/EmailBlockBuilder';
import useFormValidation from '../../hooks/useFormValidation';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';

const RichTextEditor = lazy(() => import('../../components/RichTextEditor'));

// Turn a stored `/api/...` upload path into an absolute URL the browser (and,
// once absolutized again server-side, the email) can load.
function resolveImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) return `${API_BASE_URL.replace(/\/api$/, '')}${url}`;
  return url;
}

export default function EmailCampaignCreate() {
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    type: 'blast',
    subject: '',
    html_body: '',
    reply_to: '',
    target_sources: [],
    target_event_types: [],
  });
  const [mode, setMode] = useState('design'); // 'design' (block builder) | 'simple' (rich text)
  const [blocks, setBlocks] = useState([]);
  const [selectedLeadIds, setSelectedLeadIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const uploadImage = async (file) => {
    try {
      const formData = new FormData();
      formData.append('image', file);
      const { data } = await api.post('/email-marketing/upload-image', formData);
      return resolveImageUrl(data.url);
    } catch (err) {
      toast.error(err.message || 'Image upload failed.');
      return null;
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate([{ field: 'name', label: 'Campaign Name' }], form);
    if (!result.valid) { setError(result.message); return; }
    setSaving(true);
    try {
      const useDesign = form.type === 'blast' && mode === 'design' && blocks.length > 0;
      const payload = {
        name: form.name.trim(),
        type: form.type,
        subject: form.subject || null,
        reply_to: form.reply_to || null,
        target_sources: form.target_sources.length > 0 ? form.target_sources : null,
        target_event_types: form.target_event_types.length > 0 ? form.target_event_types : null,
      };
      if (useDesign) {
        payload.design_json = { version: 1, blocks };
      } else {
        payload.html_body = form.html_body || null;
      }
      const res = await api.post('/email-marketing/campaigns', payload);
      toast.success('Draft saved.');
      navigate(`/email-marketing/campaigns/${res.data.id}`);
    } catch (err) {
      setError(err.message || 'Failed to create campaign.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="em-campaign-create">
      <h2>Create Campaign</h2>

      <form onSubmit={handleCreate}>
        <div className="em-form-grid">
          <div className={"form-group" + fieldClass('name')}>
            <label className="form-label">Campaign Name *</label>
            <input className={"form-input" + inputClass('name')} value={form.name} onChange={e => { setForm({ ...form, name: e.target.value }); clearField('name'); }} placeholder="Summer Wedding Promo" />
            <FieldError error={fieldErrors?.name} />
          </div>
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-input" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
              <option value="blast">One-off Blast</option>
              <option value="sequence">Drip Sequence</option>
            </select>
            <FieldError error={fieldErrors?.type} />
          </div>
        </div>

        {form.type === 'blast' && (
          <>
            <div className="form-group">
              <label className="form-label">Subject Line</label>
              <input className="form-input" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Your perfect event awaits..." />
              <FieldError error={fieldErrors?.subject} />
            </div>

            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <label className="form-label" style={{ margin: 0 }}>Email Design</label>
                <div className="em-mode-toggle" style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className={`btn ${mode === 'design' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('design')}>Designer</button>
                  <button type="button" className={`btn ${mode === 'simple' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('simple')}>Simple text</button>
                </div>
              </div>

              {mode === 'design' ? (
                <div style={{ marginTop: 10 }}>
                  <EmailBlockBuilder value={blocks} onChange={setBlocks} onUploadImage={uploadImage} />
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <Suspense fallback={<div className="muted" style={{ padding: '1rem 0' }}>Loading editor…</div>}>
                    <RichTextEditor
                      content={form.html_body}
                      onChange={val => setForm({ ...form, html_body: val })}
                      onUploadImage={uploadImage}
                      placeholder="Write your email content here..."
                    />
                  </Suspense>
                </div>
              )}
              <FieldError error={fieldErrors?.html_body} />
            </div>
          </>
        )}

        <div className="form-group">
          <label className="form-label">Reply-To Email (optional)</label>
          <input className="form-input" type="email" value={form.reply_to} onChange={e => setForm({ ...form, reply_to: e.target.value })} placeholder="hello@drbartender.com" />
          <FieldError error={fieldErrors?.reply_to} />
        </div>

        <div className="form-group">
          <label className="form-label">Target Audience</label>
          <AudienceSelector
            targetSources={form.target_sources}
            targetEventTypes={form.target_event_types}
            onChange={({ targetSources, targetEventTypes }) => setForm({ ...form, target_sources: targetSources, target_event_types: targetEventTypes })}
            selectedLeadIds={selectedLeadIds}
            onLeadIdsChange={setSelectedLeadIds}
          />
          <FieldError error={fieldErrors?.audience} />
        </div>

        <FormBanner error={error} fieldErrors={fieldErrors} />

        <div className="em-form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/email-marketing/campaigns')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create Campaign'}
          </button>
        </div>
      </form>
    </div>
  );
}
