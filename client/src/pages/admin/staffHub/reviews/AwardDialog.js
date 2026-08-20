import React, { useEffect } from 'react';
import { fmt$fromCents } from '../../../../components/adminos/format';

/**
 * The award confirmation, moved verbatim out of the retired Reviews page
 * (spec §7).
 * Winners and the split are SERVER truth: this dialog renders the leaderboard
 * payload's shares and never recomputes them, so what the admin confirms is
 * exactly what the award writes.
 */
export default function AwardDialog({ quarter, shares, rowsById, inProgress, busy, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={`Award the ${quarter} review contest`}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center', padding: 16,
      }}
      data-app="admin-os"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460, maxWidth: '94vw',
          background: 'var(--bg-1)', color: 'var(--ink-1)',
          border: '1px solid var(--line-1)', borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '0.7rem 1rem', borderBottom: '1px solid var(--line-1)' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Award the {quarter} contest</h3>
        </div>
        <div style={{ padding: '1rem' }}>
          <p style={{ marginTop: 0 }}>
            This pays the winner{shares.length > 1 ? 's' : ''} below on the open pay period. It runs once:
            a second click creates nothing.
          </p>
          {inProgress && (
            <p style={{ marginTop: 0 }}>
              This quarter is still running, so you will be asked to confirm again. Events and reviews
              that land before it closes will not change the result.
            </p>
          )}
          <ul style={{ margin: '0 0 12px 0', paddingLeft: 18 }}>
            {shares.map(s => {
              const row = rowsById[s.user_id];
              return (
                <li key={s.user_id}>
                  {s.name}: {fmt$fromCents(s.amount_cents)}{' '}
                  {row && (
                    <span className="muted tiny">
                      ({row.named_five_stars} of {row.events_worked} events reviewed)
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" className="btn" onClick={onConfirm} disabled={busy}>
              {busy ? 'Awarding…' : 'Award now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
