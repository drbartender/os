import React from 'react';
import { tryParseArray } from '../helpers';

// 4-cell × 2-row quick-glance grid: the things that decide whether to bring
// someone in for an interview, all in one frame.
export default function ViabilityCard({ a }) {
  const positions = tryParseArray(a.positions_interested);
  const items = [
    ['Position(s)',     positions.join(', ') || '—'],
    ['Travel',          a.travel_distance || '—'],
    ['Transport',       a.reliable_transportation || '—'],
    ['Years',           a.bartending_years > 0 ? `${a.bartending_years} yr` : 'Entry-level'],
    ['Last bartended',  a.last_bartending_time || '—'],
    ['Setup conf.',     a.setup_confidence != null ? `${a.setup_confidence} / 5` : '—'],
    ['Works alone',     a.comfortable_working_alone || '—'],
    ['Saturdays',       a.available_saturdays || '—'],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h3>Hiring viability</h3>
        <span className="muted tiny">Quick glance</span>
      </div>
      <div className="card-body" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px 18px',
      }}>
        {items.map(([k, v]) => (
          <div key={k}>
            <div className="tiny muted" style={{
              marginBottom: 3, textTransform: 'uppercase',
              letterSpacing: '0.06em', fontSize: 9.5,
            }}>{k}</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-1)' }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
