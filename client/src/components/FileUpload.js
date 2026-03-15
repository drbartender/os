import React, { useId } from 'react';

export default function FileUpload({ label, name, accept, helper, onChange, currentFile, camera }) {
  const inputId = useId();
  const cameraInputId = useId();

  function handleChange(e) {
    const file = e.target.files[0];
    if (file) onChange(name, file);
  }

  // Camera mode with no file yet: show two distinct picker buttons
  if (camera && !currentFile) {
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
          accept={accept || 'image/*'}
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
            <div className="file-upload-text">PDF, JPG, PNG accepted</div>
          </>
        )}
      </label>
      {helper && <p className="form-helper" id={`${inputId}-helper`}>{helper}</p>}
      <input
        id={inputId}
        type="file"
        name={name}
        accept={accept || '.pdf,.jpg,.jpeg,.png'}
        onChange={handleChange}
        aria-describedby={helper ? `${inputId}-helper` : undefined}
        className="visually-hidden"
      />
    </div>
  );
}
