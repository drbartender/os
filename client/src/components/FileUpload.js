import React, { useId, useState } from 'react';
import { checkFile, acceptFor, DEFAULT_KIND } from '../utils/uploadLimits';
import downscaleImage from '../utils/downscaleImage';

// Touch-first devices (phones/tablets) have a coarse pointer. On desktop with a mouse,
// the "Take Photo" affordance just falls through to a file picker, which is confusing —
// so we only render it on devices that can actually open a camera.
const hasTouchCamera = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

export default function FileUpload({ label, name, accept, helper, onChange, currentFile, camera, kind = DEFAULT_KIND }) {
  const inputId = useId();
  const cameraInputId = useId();
  const [error, setError] = useState('');

  // Validate at PICK time, before a single byte is sent. The old behaviour let
  // an oversized file upload for a full minute and then reported a bare
  // "network error", blaming the user's connection for our limit.
  async function handleChange(e) {
    const input = e.target;
    const picked = input.files[0];
    // Allow re-picking the same file after a rejection. jsdom rejects this
    // assignment in some versions, and it is a convenience, not a correctness
    // requirement, so a failure here must not break the pick.
    try { input.value = ''; } catch (err) { /* jsdom */ }
    if (!picked) return;

    const file = await downscaleImage(picked);
    const verdict = checkFile(file, kind);
    if (!verdict.ok) {
      setError(verdict.message);
      return;
    }
    setError('');
    onChange(name, file);
  }

  // Camera mode with no file yet AND on a touch device: show two distinct picker buttons
  if (camera && !currentFile && hasTouchCamera) {
    return (
      <div className="form-group">
        <label className="form-label">{label}</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <label htmlFor={cameraInputId} style={{ cursor: 'pointer', display: 'block' }}>
            <div className="file-upload-area" style={{ textAlign: 'center', padding: '1.25rem 1rem' }}>
              <span className="file-upload-icon" aria-hidden>📷</span>
              <div className="file-upload-text" style={{ fontWeight: 600 }}>Take Photo</div>
              <div className="file-upload-text" style={{ fontSize: '0.75rem', marginTop: '0.15rem' }}>Use camera</div>
            </div>
          </label>
          <label htmlFor={inputId} style={{ cursor: 'pointer', display: 'block' }}>
            <div className="file-upload-area" style={{ textAlign: 'center', padding: '1.25rem 1rem' }}>
              <span className="file-upload-icon" aria-hidden>📁</span>
              <div className="file-upload-text" style={{ fontWeight: 600 }}>Upload File</div>
              <div className="file-upload-text" style={{ fontSize: '0.75rem', marginTop: '0.15rem' }}>From device</div>
            </div>
          </label>
        </div>
        {helper && <p className="form-helper">{helper}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        {/* Camera capture input */}
        <input
          id={cameraInputId}
          type="file"
          accept="image/*"
          capture="user"
          onChange={handleChange}
          className="visually-hidden"
        />
        {/* Regular file picker */}
        <input
          id={inputId}
          type="file"
          name={name}
          accept={accept || acceptFor(kind)}
          onChange={handleChange}
          className="visually-hidden"
        />
      </div>
    );
  }

  // Default / file-already-selected state
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={inputId}>{label}</label>
      <label
        htmlFor={inputId}
        className={`file-upload-area ${currentFile ? 'has-file' : ''}`}
        style={{ cursor: 'pointer', display: 'block' }}
      >
        <span className="file-upload-icon" aria-hidden>
          {currentFile ? '📄' : (camera ? '📷' : '📎')}
        </span>
        {currentFile ? (
          <>
            <div className="file-upload-name">
              {typeof currentFile === 'string' ? currentFile : currentFile.name}
            </div>
            <div className="file-upload-text" style={{ marginTop: '0.25rem' }}>
              Click to replace
            </div>
          </>
        ) : (
          <>
            <div className="file-upload-text">Click to upload</div>
            <div className="file-upload-text">
              {kind === 'document' ? 'PDF, Word, or photo' : 'PDF or photo'}
            </div>
          </>
        )}
      </label>
      {helper && <p className="form-helper" id={`${inputId}-helper`}>{helper}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <input
        id={inputId}
        type="file"
        name={name}
        accept={accept || acceptFor(kind)}
        onChange={handleChange}
        aria-describedby={helper ? `${inputId}-helper` : undefined}
        className="visually-hidden"
      />
    </div>
  );
}
