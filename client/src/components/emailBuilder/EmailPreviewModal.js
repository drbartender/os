import React, { useState, useEffect } from 'react';
import api from '../../utils/api';

// Renders an accurate, exactly-as-sent preview by asking the server to compile
// the design (or a simple HTML body) into the full branded email shell, then
// showing it in an iframe.
export default function EmailPreviewModal({ design, htmlBody, onClose }) {
  const [html, setHtml] = useState('');
  const [device, setDevice] = useState('desktop');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const { data } = await api.post('/email-marketing/preview', { design_json: design, html_body: htmlBody });
        if (alive) setHtml(data.html || '');
      } catch (err) {
        if (alive) setError(err.message || 'Could not build preview.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [design, htmlBody]);

  const width = device === 'mobile' ? 390 : 640;

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width: width + 40 }}>
        <div style={header}>
          <strong>Email preview</strong>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className={`btn ${device === 'desktop' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDevice('desktop')}>Desktop</button>
            <button type="button" className={`btn ${device === 'mobile' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDevice('mobile')}>Mobile</button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          </span>
        </div>
        <div style={{ background: '#f0ebe6', padding: 16, maxHeight: '75vh', overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
          {loading && <div style={{ padding: 40, color: '#8a7d6f' }}>Building preview…</div>}
          {error && <div style={{ padding: 40, color: '#b3261e' }}>{error}</div>}
          {!loading && !error && (
            <iframe title="Email preview" srcDoc={html} sandbox="" style={{ width, height: '70vh', border: '1px solid #ddd', borderRadius: 8, background: '#fff' }} />
          )}
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px', zIndex: 1000 };
const panel = { background: '#fff', borderRadius: 12, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #eee' };
