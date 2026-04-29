import React from 'react';
import Icon from '../../../../components/adminos/Icon';

const extOf = (name) => (name?.split('.').pop() || 'file').toLowerCase();

// Tiles for resume / BASSET / headshot. URLs are R2 public links written to
// applications.{resume,basset,headshot}_file_url at submit time.
export default function FilesBlock({ a }) {
  const files = [
    a.resume_file_url   && { label: 'Resume',   url: a.resume_file_url,   name: a.resume_filename   || 'resume.pdf' },
    a.basset_file_url   && { label: 'BASSET',   url: a.basset_file_url,   name: a.basset_filename   || 'basset.pdf' },
    a.headshot_file_url && { label: 'Headshot', url: a.headshot_file_url, name: a.headshot_filename || 'headshot.jpg' },
  ].filter(Boolean);

  if (files.length === 0) {
    return (
      <div className="card">
        <div className="card-head"><h3>Files</h3></div>
        <div className="card-body tiny muted">No files uploaded.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head"><h3>Files</h3><span className="k">{files.length}</span></div>
      <div className="card-body" style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10,
      }}>
        {files.map(f => (
          <a
            key={f.label}
            href={f.url}
            target="_blank"
            rel="noreferrer"
            style={{
              border: '1px solid var(--line-1)', borderRadius: 4, overflow: 'hidden',
              background: 'var(--bg-2)', textDecoration: 'none', color: 'inherit',
            }}
          >
            <div style={{
              height: 80, display: 'grid', placeItems: 'center', position: 'relative',
              background: 'var(--bg-1)',
            }}>
              <Icon name="clipboard" size={26} />
              <span className="tag" style={{
                position: 'absolute', top: 6, right: 6, textTransform: 'uppercase',
              }}>{extOf(f.name)}</span>
            </div>
            <div style={{ padding: '8px 10px' }}>
              <div className="tiny muted" style={{
                textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5, marginBottom: 2,
              }}>{f.label}</div>
              <div style={{
                fontSize: 11.5, color: 'var(--ink-2)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{f.name}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
