import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../utils/api';

/**
 * Logo upload widget on MenuDesignStep. Renders when selections.menuStyle
 * is 'custom' or 'house'. PNG/JPG up to 5 MB. Uploads via the public
 * token-gated POST /api/drink-plans/t/:token/logo route which atomically
 * persists the URL into selections.companyLogo on the server side using
 * the Postgres jsonb || merge operator (no read-merge-write race).
 *
 * Props:
 *   companyLogo - current logo URL or ''
 *   onUploadSuccess - callback(updatedSelections) called with the full
 *                     selections object returned by the upload route
 */
export default function LogoUploadField({ companyLogo, onUploadSuccess }) {
  const { token } = useParams();
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
      const res = await api.post(`/drink-plans/t/${token}/logo`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.selections) {
        onUploadSuccess(res.data.selections);
      }
    } catch (err) {
      // The api interceptor (client/src/utils/api.js) normalizes errors to
      // { message, code, fieldErrors, status }. fieldErrors.logo holds the
      // server-side validation message for this specific field.
      const fieldMsg = err.fieldErrors?.logo;
      setError(typeof fieldMsg === 'string' ? fieldMsg : (err.message || 'Upload failed. Please try again.'));
    } finally {
      setUploading(false);
      // Reset the input so re-uploading the same file fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = () => {
    onUploadSuccess({ companyLogo: '' });
  };

  const triggerPicker = () => fileInputRef.current?.click();

  return (
    <div className="logo-upload">
      <label className="form-label">Add your logo (optional)</label>
      <p className="logo-upload-help">For corporate events or branded weddings.</p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {companyLogo ? (
        <div className="logo-upload-preview">
          <img src={companyLogo} alt="Your uploaded logo" className="logo-upload-thumb" />
          <div className="logo-upload-preview-actions">
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
          </div>
        </div>
      ) : (
        <div className="logo-upload-empty">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={triggerPicker}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Choose logo file'}
          </button>
          <span className="logo-upload-hint">PNG or JPG, up to 5 MB.</span>
        </div>
      )}

      {error && <p className="logo-upload-error" role="alert">{error}</p>}
    </div>
  );
}
