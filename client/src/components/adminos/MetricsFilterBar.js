import React from 'react';

const PRESETS = [
  ['this-month', 'This month'], ['last-month', 'Last month'],
  ['this-quarter', 'This quarter'], ['ytd', 'Year to date'],
  ['last-12', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom'],
];
const LENSES = [['booked', 'Booked'], ['scheduled', 'Scheduled'], ['paid', 'Paid']];

export default function MetricsFilterBar({ filter }) {
  const { basis, rawFrom, rawTo, activePreset, setPreset, setCustom, setBasis } = filter;
  const isCustom = activePreset === 'custom';

  return (
    <div className="hstack" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
      <select className="input" value={activePreset}
        onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
        {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {isCustom && (
        <>
          <input type="date" className="input" aria-label="From date"
            value={rawFrom || ''} max={rawTo || undefined}
            onChange={(e) => setCustom({ from: e.target.value, to: rawTo })} />
          <span className="muted tiny">to</span>
          <input type="date" className="input" aria-label="To date"
            value={rawTo || ''} min={rawFrom || undefined}
            onChange={(e) => setCustom({ from: rawFrom, to: e.target.value })} />
        </>
      )}

      <div className="seg" role="group" aria-label="Money lens" style={{ marginLeft: 'auto' }}>
        {LENSES.map(([v, l]) => (
          <button key={v} type="button"
            className={`seg-btn${basis === v ? ' is-active' : ''}`}
            aria-pressed={basis === v}
            onClick={() => setBasis(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}
