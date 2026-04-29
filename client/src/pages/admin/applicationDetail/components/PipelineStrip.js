import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { AD_FLOW, stageOf } from '../helpers';

export default function PipelineStrip({ status, rejectionReason }) {
  const isRejected = status === 'rejected';
  const stage = stageOf(status);
  const stageIdx = AD_FLOW.findIndex(s => s.key === stage);

  return (
    <div style={{ marginTop: 22 }}>
      <div className="hstack" style={{ gap: 0, alignItems: 'stretch' }}>
        {AD_FLOW.map((s, i) => {
          const reached = !isRejected && i <= stageIdx;
          const current = !isRejected && i === stageIdx;
          const next = i === stageIdx + 1 && !isRejected;
          return (
            <div key={s.key} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                flex: 1, padding: '11px 12px', borderRadius: 4, fontSize: 11.5,
                background: current ? 'var(--ink-1)' : 'var(--bg-2)',
                color: current ? 'var(--bg-0)' : reached ? 'var(--ink-1)' : 'var(--ink-3)',
                border: '1px solid ' + (current ? 'var(--ink-1)' : 'var(--line-1)'),
                fontWeight: current ? 600 : 400,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 16, height: 16, borderRadius: '50%', display: 'inline-grid', placeItems: 'center',
                    background: current ? 'var(--bg-0)' : reached ? 'var(--ink-1)' : 'transparent',
                    color: current ? 'var(--ink-1)' : reached ? 'var(--bg-0)' : 'var(--ink-3)',
                    border: '1px solid ' + (reached || current ? 'var(--ink-1)' : 'var(--line-2)'),
                    fontSize: 9, fontWeight: 700,
                  }}>{reached ? '✓' : i + 1}</span>
                  <span>{s.label}</span>
                </span>
                {current && <span className="tiny" style={{ opacity: 0.7 }}>{s.verb}</span>}
                {next && <span className="tiny muted">next</span>}
              </div>
              {i < AD_FLOW.length - 1 && (
                <Icon name="arrow_right" size={11} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
              )}
            </div>
          );
        })}
      </div>
      {isRejected && (
        <div className="hstack" style={{ marginTop: 8, padding: '8px 12px', background: 'hsl(var(--danger-h) var(--danger-s) 50% / 0.08)', border: '1px solid hsl(var(--danger-h) var(--danger-s) 50% / 0.3)', borderRadius: 4 }}>
          <Icon name="x" size={11} />
          <span className="tiny" style={{ flex: 1 }}>
            Archived from pipeline · {rejectionReason || 'No reason on file.'}
          </span>
        </div>
      )}
    </div>
  );
}
