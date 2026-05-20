import React, { useRef, useState } from 'react';
import api from '../../utils/api';

// Defense in depth: even though the server sanitizes companyLogo on every PUT,
// admins click `<a href={companyLogo}>` here. A historical `javascript:` value
// stored before the server-side sanitizer landed could still execute in the
// admin session. The check mirrors the server-side allowlist: same-origin
// `/api/drink-plans/t/` OR absolute URL whose host matches our API origin.
// Anything else (attacker domain, javascript:, data:, file:, http: on the
// public internet) is refused.
function isSafeLogoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/api/drink-plans/t/')) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!u.pathname.startsWith('/api/drink-plans/t/')) return false;
    const apiUrl = process.env.REACT_APP_API_URL;
    if (!apiUrl) return false;
    return u.host === new URL(apiUrl).host;
  } catch {
    return false;
  }
}

/**
 * Admin-side logo widget on EventDetailPage. Shows the uploaded logo for a
 * drink plan regardless of menu type, with Replace, Remove, and Download
 * original actions. Hits the admin-authenticated logo routes from Task 2.
 *
 * Props:
 *   planId      - drink plan ID
 *   companyLogo - current logo URL or ''
 *   onChange    - callback(updatedSelections) called after Replace / Remove
 */
export default function EventDetailPlanLogo({ planId, companyLogo, onChange }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('logo', file);
      const res = await api.post(`/drink-plans/${planId}/logo`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.selections) onChange(res.data.selections);
    } catch (err) {
      // api interceptor normalizes the error to { message, fieldErrors, ... }.
      const fieldMsg = err.fieldErrors?.logo;
      setError(typeof fieldMsg === 'string' ? fieldMsg : (err.message || 'Upload failed.'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setError('');
    setUploading(true);
    try {
      const res = await api.delete(`/drink-plans/${planId}/logo`);
      if (res.data?.selections) onChange(res.data.selections);
    } catch (err) {
      setError(err.message || 'Failed to remove logo.');
    } finally {
      setUploading(false);
    }
  };

  const triggerPicker = () => fileInputRef.current?.click();

  return (
    <div className="admin-plan-logo">
      <h4 className="admin-plan-logo-title">Logo</h4>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      {companyLogo ? (
        <div className="admin-plan-logo-row">
          <img src={isSafeLogoUrl(companyLogo) ? companyLogo : ''} alt="Client logo" className="admin-plan-logo-thumb" />
          <div className="admin-plan-logo-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={triggerPicker}
              disabled={uploading}
            >
              {uploading ? 'Uploading...' : 'Replace'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleRemove}
              disabled={uploading}
            >
              Remove
            </button>
            {isSafeLogoUrl(companyLogo) && (
              <a
                href={companyLogo}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost btn-sm"
              >
                Download original
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="admin-plan-logo-empty">
          <span className="admin-plan-logo-empty-text">No logo uploaded.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={triggerPicker}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Upload logo'}
          </button>
        </div>
      )}
      {error && <p className="admin-plan-logo-error" role="alert">{error}</p>}
    </div>
  );
}
