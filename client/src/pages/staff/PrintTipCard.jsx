import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import '../../styles/drb-tokens.css';
import './PrintTipCard.css';

import {
  BizCardFrontA, BizCardBackA,
  FourBySixA, FiveBySevenA,
} from './PrintTipCard.layouts';
import { buildTipCardMarks } from '../../utils/tipCardMarks';

const SIZES = {
  bizcard: { label: 'Business card (3.5×2", 2-sided)', renderFront: BizCardFrontA, renderBack: BizCardBackA },
  '4x6':   { label: '4×6 photo (1-sided)',  renderFront: FourBySixA,  renderBack: null },
  '5x7':   { label: '5×7 photo (1-sided)',  renderFront: FiveBySevenA, renderBack: null },
};

const PAGE_SIZE_MAP = {
  bizcard: '3.5in 2in',
  '4x6': '4in 6in',
  '5x7': '5in 7in',
};

function handlePrint(size) {
  const styleId = 'print-tip-card-page-size';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  const pageSize = PAGE_SIZE_MAP[size] || PAGE_SIZE_MAP.bizcard;
  styleEl.textContent = `@page { size: ${pageSize}; margin: 0; }`;
  window.print();
}

export default function PrintTipCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [params, setParams] = useSearchParams();
  const size = SIZES[params.get('size')] ? params.get('size') : 'bizcard';

  useEffect(() => {
    api.get('/me/tip-page')
      .then((r) => setData(r.data))
      .catch((e) => setError(e?.message || 'Could not load your tip page.'));
  }, []);

  if (error) return <p style={{ padding: 24 }}>{error}</p>;
  if (!data) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!data.url) return <p style={{ padding: 24 }}>Your tip page isn't active yet.</p>;

  const { renderFront: Front, renderBack: Back } = SIZES[size];
  const name = data.preferred_name || 'your bartender';
  const marks = buildTipCardMarks(data);

  return (
    <div className="print-tip-card-root drb">
      {/* ─ controls (hidden on print) ─ */}
      <div className="print-controls" data-no-print>
        <h1>Print your tip card</h1>
        <p className="helper">
          Choose a size, then click "Print" — your browser will open its print dialog.
          Save as PDF and take it to a photo counter, or print at home.
        </p>
        <div className="size-picker">
          {Object.entries(SIZES).map(([key, s]) => (
            <label key={key} className={size === key ? 'selected' : ''}>
              <input
                type="radio"
                name="size"
                value={key}
                checked={size === key}
                onChange={() => setParams({ size: key })}
              />
              {s.label}
            </label>
          ))}
        </div>
        <button type="button" className="btn-primary" onClick={() => handlePrint(size)}>
          Print
        </button>
      </div>

      {/* ─ printable area ─ */}
      <div className={`print-stage size-${size}`} data-print-area>
        <div className="sheet">
          <Front name={name} tipUrl={data.url} headshotUrl={data.headshot_url} marks={marks} />
        </div>
        {Back && (
          <div className="page-break">
            <Back name={name} tipUrl={data.url} headshotUrl={data.headshot_url} />
          </div>
        )}
      </div>
    </div>
  );
}
