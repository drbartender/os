import React from 'react';
import { fmt$ } from '../../../components/adminos/format';

// Ported verbatim from the old Dashboard pipeline card. Rows are NOT links yet;
// lane b2 wires each row to the proposals list per the click map (B2.5).
const PIPELINE_COLORS = {
  draft: 'var(--ink-3)',
  sent: 'hsl(var(--info-h) var(--info-s) 62%)',
  viewed: 'var(--accent)',
  modified: 'hsl(var(--violet-h) var(--violet-s) 65%)',
  accepted: 'hsl(var(--ok-h) var(--ok-s) 52%)',
};

export default function PipelineCard({ pipeline = [], loading = false }) {
  const maxPipelineValue = Math.max(1, ...pipeline.map(p => Number(p.value || 0)));
  return (
    <div className="card">
      <div className="card-head"><h3>Pipeline</h3><span className="k">Proposals</span></div>
      <div className="card-body" style={{ padding: '0.75rem 1rem' }}>
        {loading && pipeline.length === 0 && <div className="muted tiny">Loading…</div>}
        {!loading && pipeline.length === 0 && <div className="muted tiny">No active proposals.</div>}
        {pipeline.map(row => {
          const value = Number(row.value || 0);
          return (
            <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 50px 80px', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 12 }}>
              <span style={{ color: 'var(--ink-2)' }}>{row.label}</span>
              <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, (value / maxPipelineValue) * 100)}%`, background: PIPELINE_COLORS[row.key] || 'var(--ink-3)' }} /></div>
              <span className="num muted" style={{ textAlign: 'right' }}>{row.count}</span>
              <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)', fontWeight: 600 }}>{fmt$(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
