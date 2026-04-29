import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import { ONBOARDING_ITEMS } from '../helpers';

// Onboarding paperwork checklist visible on the right rail when the applicant
// is in the in_progress (onboarding) stage. Each item maps to a boolean column
// on `onboarding_progress` which the server flattens onto the application row.
export default function OnboardingCard({ a, onReminder, reminderBusy }) {
  const pct = a.onboarding_progress ?? 0;
  const allDone = pct >= 1;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Onboarding paperwork</h3>
        <strong style={{ color: allDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--ink-1)' }}>
          {Math.round(pct * 100)}%
        </strong>
      </div>
      <div className="card-body">
        <div style={{ height: 6, background: 'var(--bg-2)', borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{
            height: '100%', width: `${pct * 100}%`,
            background: allDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--accent)',
            borderRadius: 99,
          }} />
        </div>
        <div className="vstack" style={{ gap: 6 }}>
          {ONBOARDING_ITEMS.map(it => {
            const isDone = !!a[it.key];
            return (
              <div key={it.key} className="hstack" style={{ gap: 10, padding: '6px 10px', borderRadius: 3 }}>
                <span style={{
                  width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  background: isDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'transparent',
                  border: '1px solid ' + (isDone ? 'hsl(var(--ok-h) var(--ok-s) 50%)' : 'var(--line-2)'),
                  color: 'var(--bg-0)', fontSize: 9, fontWeight: 700, flexShrink: 0,
                }}>{isDone ? '✓' : ''}</span>
                <span style={{
                  flex: 1, fontSize: 13,
                  color: isDone ? 'var(--ink-3)' : 'var(--ink-1)',
                  textDecoration: isDone ? 'line-through' : 'none',
                }}>{it.label}</span>
              </div>
            );
          })}
        </div>
        {!allDone && a.onboarding_blocker && (
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
            onClick={onReminder}
            disabled={reminderBusy}
          >
            <Icon name="mail" size={11} />
            {reminderBusy ? 'Sending…' : `Send reminder for ${a.onboarding_blocker}`}
          </button>
        )}
        {allDone && (
          <div className="tiny muted" style={{ marginTop: 12, textAlign: 'center' }}>
            Auto-flips to active staff on next sync.
          </div>
        )}
      </div>
    </div>
  );
}
