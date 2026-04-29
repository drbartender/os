import React, { useState, useMemo, useEffect } from 'react';
import api from '../../../../utils/api';
import { useToast } from '../../../../context/ToastContext';
import { SCORECARD_DIMS } from '../helpers';

const initialFromSaved = (saved) => {
  const out = {};
  SCORECARD_DIMS.forEach(d => { out[d.key] = saved?.[d.key] ?? null; });
  return out;
};

export default function ScorecardCard({ userId, initial, onSaved }) {
  const toast = useToast();
  const [scores, setScores] = useState(() => initialFromSaved(initial));
  const [saving, setSaving] = useState(null); // dim key currently saving

  // Sync if parent re-fetches (e.g. after another state change).
  useEffect(() => { setScores(initialFromSaved(initial)); }, [initial]);

  const total = useMemo(() =>
    SCORECARD_DIMS.reduce((s, d) => s + (scores[d.key] || 0), 0),
    [scores]);
  const avg = useMemo(() => {
    const filled = SCORECARD_DIMS.filter(d => scores[d.key] != null);
    return filled.length ? (filled.reduce((s, d) => s + scores[d.key], 0) / filled.length) : 0;
  }, [scores]);

  const setDim = async (key, n) => {
    const newVal = scores[key] === n ? null : n;
    const prev = scores[key];
    setScores(s => ({ ...s, [key]: newVal }));
    setSaving(key);
    try {
      await api.put(`/admin/applications/${userId}/scorecard`, { [key]: newVal });
      onSaved && onSaved();
    } catch {
      toast.error('Could not save score.');
      setScores(s => ({ ...s, [key]: prev }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Interview scorecard</h3>
        <span className="hstack tiny" style={{ gap: 10 }}>
          <span className="muted">Avg {avg ? avg.toFixed(1) : '—'}</span>
          <strong style={{ fontSize: 16, color: 'var(--ink-1)' }}>Total: {total} / 25</strong>
        </span>
      </div>
      <div className="card-body vstack" style={{ gap: 14 }}>
        {SCORECARD_DIMS.map(d => (
          <div key={d.key} className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>{d.label}</div>
            <div className="hstack" style={{ gap: 6 }} role="radiogroup" aria-label={d.label}>
              {[1, 2, 3, 4, 5].map(n => {
                const on = scores[d.key] != null && n <= scores[d.key];
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDim(d.key, n)}
                    disabled={saving === d.key}
                    title={`${n} of 5`}
                    aria-label={`${d.label} ${n} of 5`}
                    aria-pressed={on}
                    style={{
                      width: 36, height: 36, borderRadius: '50%',
                      border: '1px solid ' + (on ? 'var(--accent)' : 'var(--line-2)'),
                      background: on ? 'var(--accent)' : 'transparent',
                      cursor: saving === d.key ? 'wait' : 'pointer',
                      padding: 0, touchAction: 'manipulation',
                    }}
                  />
                );
              })}
            </div>
            <span className="tiny muted" style={{ width: 36, textAlign: 'right' }}>
              {scores[d.key] != null ? `${scores[d.key]}/5` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
