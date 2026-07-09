import React, { useState } from 'react';
import Icon from './Icon';

const PRESETS = [
  ['this-month', 'This month'], ['last-month', 'Last month'],
  ['this-quarter', 'This quarter'], ['ytd', 'Year to date'],
  ['last-12', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom'],
];
const LENSES = [['booked', 'Booked'], ['scheduled', 'Scheduled'], ['paid', 'Paid']];
// History control (spec §9): the CC tri-state, demoted to a ghost button that
// expands to three chips. The `include_cc` URL values and semantics are UNCHANGED
// (all / exclude / only, LAW); only the presentation and the labels change.
//   all     → All
//   exclude → Since May '26  (native records, post-cutover)
//   only    → Before May '26 (frozen CheckCherry ledger)
const HISTORY_LABEL = { all: 'All', exclude: "Since May '26", only: "Before May '26" };
const HISTORY_CHIPS = [['all', 'All'], ['exclude', "Since May '26"], ['only', "Before May '26"]];

export default function MetricsFilterBar({ filter }) {
  const { basis, includeCc, rawFrom, rawTo, activePreset, setPreset, setCustom, setBasis, setIncludeCc } = filter;
  const isCustom = activePreset === 'custom';
  const [histOpen, setHistOpen] = useState(false);
  const activeHistory = HISTORY_LABEL[includeCc] || 'All';

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

      <div className="history-ctrl" style={{ marginLeft: 'auto' }}>
        <button type="button" className="btn btn-ghost btn-sm history-btn"
          aria-expanded={histOpen} aria-haspopup="true"
          onClick={() => setHistOpen((o) => !o)}>
          History: {activeHistory} <Icon name="down" size={11} />
        </button>
        {histOpen && (
          <div className="metrics-seg history-chips" role="group" aria-label="History">
            {HISTORY_CHIPS.map(([v, l]) => (
              <button key={v} type="button"
                className={`metrics-seg-btn${includeCc === v ? ' is-active' : ''}`}
                aria-pressed={includeCc === v}
                onClick={() => { setIncludeCc(v); setHistOpen(false); }}>{l}</button>
            ))}
          </div>
        )}
      </div>

      <div className="metrics-seg" role="group" aria-label="Money lens">
        {LENSES.map(([v, l]) => (
          <button key={v} type="button"
            className={`metrics-seg-btn${basis === v ? ' is-active' : ''}`}
            aria-pressed={basis === v}
            onClick={() => setBasis(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}
