import React, { useState, useRef } from 'react';
import api from '../utils/api';

export default function LeadImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.name.endsWith('.csv')) {
      setError('Please select a CSV file.');
      return;
    }
    setFile(f);
    setError('');

    // Preview first 5 rows
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim().replace(/['"]/g, ''));
      const rows = lines.slice(1, 6).map(line => line.split(',').map(c => c.trim().replace(/['"]/g, '')));
      setPreview({ headers, rows, totalRows: lines.length - 1 });
    };
    reader.readAsText(f);
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('/email-marketing/leads/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      if (onImported) onImported();
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content em-import-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Import Leads from CSV</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          {!result ? (
            <>
              <p className="em-import-instructions">
                Upload a CSV with columns: <strong>name</strong>, <strong>email</strong> (required),
                and optionally: company, event_type, location, lead_source, notes.
              </p>

              <div className="em-file-drop" onClick={() => fileRef.current?.click()}>
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFileSelect} style={{ display: 'none' }} />
                {file ? (
                  <p>{file.name} ({preview?.totalRows || 0} rows)</p>
                ) : (
                  <p>Click to select a CSV file</p>
                )}
              </div>

              {preview && (
                <div className="em-preview-table-wrap">
                  <p className="em-preview-label">Preview (first {preview.rows.length} of {preview.totalRows} rows):</p>
                  <table className="em-preview-table">
                    <thead>
                      <tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {error && <p className="form-error">{error}</p>}

              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleImport} disabled={!file || importing}>
                  {importing ? 'Importing...' : 'Import Leads'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="em-import-result">
                <p className="em-import-success">{result.imported} leads imported</p>
                {result.skipped > 0 && <p className="em-import-warn">{result.skipped} rows skipped</p>}
                {result.errors?.length > 0 && (
                  <ul className="em-import-errors">
                    {result.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                )}
              </div>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={onClose}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
