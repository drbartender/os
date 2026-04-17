import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import RichTextEditor from '../../components/RichTextEditor';
import AudienceSelector from '../../components/AudienceSelector';
import useFormValidation from '../../hooks/useFormValidation';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';

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
  const [selectedLeadIds, setSelectedLeadIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    const result = validate([{ field: 'name', label: 'Campaign Name' }], form);
    if (!result.valid) { setError(result.message); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        subject: form.subject || null,
        html_body: form.html_body || null,
        reply_to: form.reply_to || null,
        target_sources: form.target_sources.length > 0 ? form.target_sources : null,
        target_event_types: form.target_event_types.length > 0 ? form.target_event_types : null,
      };
      const res = await api.post('/email-marketing/campaigns', payload);
      toast.success('Draft saved.');
      navigate(`/admin/email-marketing/campaigns/${res.data.id}`);
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
              <label className="form-label">Email Body</label>
              <RichTextEditor
                content={form.html_body}
                onChange={val => setForm({ ...form, html_body: val })}
                onUploadImage={() => Promise.resolve(null)}
                placeholder="Write your email content here..."
              />
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
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/admin/email-marketing/campaigns')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create Campaign'}
          </button>
        </div>
      </form>
    </div>
  );
}
