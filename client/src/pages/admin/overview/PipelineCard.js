import React from 'react';
import EntityLink from '../../../components/EntityLink';
import { fmt$ } from '../../../components/adminos/format';

const PIPELINE_COLORS = {
  draft: 'var(--ink-3)',
  sent: 'hsl(var(--info-h) var(--info-s) 62%)',
  viewed: 'var(--accent)',
  modified: 'hsl(var(--violet-h) var(--violet-s) 65%)',
  accepted: 'hsl(var(--ok-h) var(--ok-s) 52%)',
};

// Live pipeline (ignores the metrics filter). Each row links to the proposals
// list for that exact status per the spec §5 click map: draft uses the tab
// shorthand, everything else the status param. No date params (live). URLs depend
// on lane a's list filters, so the wiring lands here in b2, not b1.
function pipelineHref(key) {
  return key === 'draft' ? '/proposals?tab=draft' : `/proposals?status=${key}`;
}

export default function PipelineCard({ pipeline = [], loading = false, error = false }) {
  const maxPipelineValue = Math.max(1, ...pipeline.map(p => Number(p.value || 0)));
  return (
    <div className="card">
      <div className="card-head"><h3>Pipeline</h3><span className="k">Proposals</span></div>
      <div className="card-body" style={{ padding: '0.75rem 1rem' }}>
        {loading && pipeline.length === 0 && <div className="muted tiny">Loading…</div>}
        {!loading && error && pipeline.length === 0 && <div className="muted tiny">Pipeline unavailable right now.</div>}
        {!loading && !error && pipeline.length === 0 && <div className="muted tiny">No active proposals.</div>}
        {pipeline.map(row => {
          const value = Number(row.value || 0);
          return (
            <EntityLink key={row.key} to={pipelineHref(row.key)} className="pipe-row">
              <span style={{ color: 'var(--ink-2)' }}>{row.label}</span>
              <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, (value / maxPipelineValue) * 100)}%`, background: PIPELINE_COLORS[row.key] || 'var(--ink-3)' }} /></div>
              <span className="num muted" style={{ textAlign: 'right' }}>{row.count}</span>
              <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)', fontWeight: 600 }}>{fmt$(value)}</span>
            </EntityLink>
          );
        })}
      </div>
    </div>
  );
}
