import React from 'react';
import { tryParseArray } from '../helpers';

// Positions interested + experience type chips + raw experience description.
// We deliberately do NOT show the design's structured "place / role / when"
// rows — we don't collect work history that way. The free-text description
// renders as prose.
export default function SectionExperience({ a }) {
  const positions = tryParseArray(a.positions_interested);
  const types = tryParseArray(a.experience_types);

  return (
    <div className="card">
      <div className="card-head"><h3>Experience</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 14 }}>
          <div>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6,
            }}>Positions interested in</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {positions.length === 0
                ? <span className="tiny muted">—</span>
                : positions.map(p => (
                    <span key={p} className="tag" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                      {p}
                    </span>
                  ))}
            </div>
          </div>
          <div>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6,
            }}>Experience types</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {types.length === 0
                ? <span className="tiny muted">—</span>
                : types.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
        {a.bartending_experience_description && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6,
            }}>Their description</div>
            <div style={{
              fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap',
            }}>{a.bartending_experience_description}</div>
          </div>
        )}
      </div>
    </div>
  );
}
