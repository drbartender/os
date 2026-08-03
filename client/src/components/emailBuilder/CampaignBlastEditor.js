import React, { useState, lazy, Suspense } from 'react';
import api, { API_BASE_URL } from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import EmailBlockBuilder from './EmailBlockBuilder';
import EmailPreviewModal from './EmailPreviewModal';
import { normalizeBlocks } from './blockCatalog';

const RichTextEditor = lazy(() => import('../RichTextEditor'));

function resolveImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) return `${API_BASE_URL.replace(/\/api$/, '')}${url}`;
  return url;
}

/**
 * Edit + preview + test-send the body of a draft blast campaign. Wraps the
 * block designer (or simple rich text) and persists via PUT. Kept separate so
 * the detail page stays lean.
 */
export default function CampaignBlastEditor({ campaign, onSaved }) {
  const toast = useToast();
  const initialBlocks = normalizeBlocks(campaign.design_json && campaign.design_json.blocks);
  const [mode, setMode] = useState(initialBlocks.length ? 'design' : 'simple');
  const [subject, setSubject] = useState(campaign.subject || '');
  const [blocks, setBlocks] = useState(initialBlocks);
  const [html, setHtml] = useState(campaign.html_body || '');
  const [saving, setSaving] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const useDesign = mode === 'design' && blocks.length > 0;

  const uploadImage = async (file) => {
    try {
      const fd = new FormData();
      fd.append('image', file);
      const { data } = await api.post('/email-marketing/upload-image', fd);
      return resolveImageUrl(data.url);
    } catch (err) {
      toast.error(err.message || 'Image upload failed.');
      return null;
    }
  };

  // design_json: null is an explicit clear — without it the server COALESCEs
  // the old design back into place and a reload resurrects deleted/replaced
  // blocks over the newer body. Only send the clear when the campaign actually
  // HAS a stored design: for a plain simple-text campaign, merely visiting the
  // Designer tab (empty canvas) and saving must not wipe the existing body.
  const persist = async () => {
    const hadDesign = normalizeBlocks(campaign.design_json && campaign.design_json.blocks).length > 0;
    const payload = { subject: subject || null };
    if (mode === 'design' && blocks.length > 0) {
      payload.design_json = { version: 1, blocks };
    } else if (hadDesign) {
      payload.design_json = null; // stored design must not resurrect
      payload.html_body = mode === 'simple' ? (html || '') : '';
    } else {
      payload.html_body = html || null; // nothing to clear; preserve when empty
    }
    const res = await api.put(`/email-marketing/campaigns/${campaign.id}`, payload);
    return res.data;
  };

  const switchMode = (next) => {
    if (next === 'simple' && mode === 'design' && blocks.length > 0
        && !window.confirm('Switch to simple text? The designed blocks will be discarded when you save.')) {
      return;
    }
    setMode(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await persist();
      toast.success('Email saved.');
      if (onSaved) onSaved();
    } catch (err) {
      toast.error(err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    setTesting(true);
    try {
      await persist(); // save first so the test reflects the current design
      const { data } = await api.post(`/email-marketing/campaigns/${campaign.id}/test`, testEmail ? { email: testEmail } : {});
      toast.success(data.message || 'Test sent.');
      if (onSaved) onSaved();
    } catch (err) {
      toast.error(err.message || 'Failed to send test.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="em-blast-editor">
      <div className="form-group">
        <label className="form-label">Subject Line</label>
        <input className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your perfect event awaits..." />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <label className="form-label" style={{ margin: 0 }}>Email Design</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={`btn ${mode === 'design' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => switchMode('design')}>Designer</button>
          <button type="button" className={`btn ${mode === 'simple' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => switchMode('simple')}>Simple text</button>
        </div>
      </div>

      {mode === 'design' ? (
        <EmailBlockBuilder value={blocks} onChange={setBlocks} onUploadImage={uploadImage} />
      ) : (
        <Suspense fallback={<div className="muted" style={{ padding: '1rem 0' }}>Loading editor…</div>}>
          <RichTextEditor content={html} onChange={setHtml} onUploadImage={uploadImage} placeholder="Write your email content here..." />
        </Suspense>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save email'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setShowPreview(true)}>Preview</button>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <input className="form-input" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="Test to (defaults to you)" style={{ minWidth: 220 }} />
          <button type="button" className="btn btn-secondary" onClick={handleSendTest} disabled={testing}>{testing ? 'Sending…' : 'Send test'}</button>
        </span>
      </div>

      {showPreview && (
        <EmailPreviewModal
          design={useDesign ? { version: 1, blocks } : undefined}
          htmlBody={useDesign ? undefined : html}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
