import React from 'react';

// Auto-derived flag chips. Server populates `flags` via enrichApplicationRow:
// 'BASSET' (cert file present), 'Referral' (referral_source set),
// 'No BASSET' (claimed experience but cert missing — soft warn).
export default function FlagsCard({ a }) {
  const flags = a.flags || [];
  return (
    <div className="card">
      <div className="card-head"><h3>Flags</h3></div>
      <div className="card-body hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
        {flags.length === 0 && <span className="tiny muted">None.</span>}
        {flags.map(f => {
          const isWarn = f.toLowerCase().startsWith('no ');
          const isReferral = f === 'Referral';
          return (
            <span
              key={f}
              className="tag"
              style={{
                color: isWarn
                  ? 'hsl(var(--warn-h) var(--warn-s) 50%)'
                  : isReferral
                  ? 'var(--accent)'
                  : 'var(--ink-2)',
                borderColor: 'currentColor',
              }}
            >{f}</span>
          );
        })}
      </div>
    </div>
  );
}
