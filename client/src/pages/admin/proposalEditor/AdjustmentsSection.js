// the editor's price adjustment rows (moved out of ProposalEditorForm), with the inline confirm
// before a refund line is removed or lowered below its recorded amount (asked once per line)

import React, { useState } from 'react';
import Icon from '../../../components/adminos/Icon';
import { adjAmount, adjLabel } from '../../../utils/adjustmentRules';
import AgreedPriceControl from './AgreedPriceControl';

// The editor's price adjustment rows, moved out of ProposalEditorForm (its
// line budget, the PackageSection precedent): each line's label, amount and
// "Client sees", then + Discount, + Surcharge and Set agreed price. Lines keep
// any `source` / `refund_id` markers they carry (spec 2026-10-16 section 3):
// an edit spreads the line, an added line has none.
//
// A refund line records money already refunded, so removing it or lowering
// its amount bills that money again. That change waits on an inline confirm
// and changes nothing until confirmed (spec section 5; no browser dialog).
// Lowering is measured against the amount the line was loaded with (the
// recorded refund, from loadedAdjustments by refund_id), and once the admin
// confirms a lowering for a refund line, typing on in that amount does not ask
// again; removing it still does. Any other edit withdraws a waiting confirm,
// so it can never land on a line that moved.
//
// onChange takes an updater, (lines) => lines, applied to the form's current
// lines.
export const REFUND_CONFIRM_TEXT = 'This line records money already refunded. Removing it bills that amount again.';

const DOLLAR = { position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 12, pointerEvents: 'none' };

export default function AdjustmentsSection({ adjustments, loadedAdjustments, onChange, preview, previewStale, override }) {
  const lines = adjustments || [];
  const [held, setHeld] = useState(null); // { index, kind: 'remove' | 'lower', op, refundId }
  const [lowered, setLowered] = useState(() => new Set()); // refund_ids whose lowering was confirmed
  const run = (op) => { setHeld(null); onChange(op); };
  // The recorded refund: the line's amount as loaded, else as it stands.
  const recorded = (line) => {
    const loaded = (loadedAdjustments || []).find((a) => a && a.source === 'refund' && a.refund_id === line.refund_id);
    return adjAmount(loaded || line);
  };

  const setField = (i, field, value) => {
    const op = (cur) => cur.map((a, idx) => (idx === i ? { ...a, [field]: value } : a));
    const line = lines[i];
    if (field === 'amount' && line && line.source === 'refund' && !lowered.has(line.refund_id)
      && adjAmount({ amount: value }) < recorded(line)) {
      setHeld({ index: i, kind: 'lower', op, refundId: line.refund_id });
      return;
    }
    run(op);
  };
  const confirmHeld = () => {
    if (held.kind === 'lower') setLowered((cur) => new Set(cur).add(held.refundId));
    run(held.op);
  };
  const remove = (i) => {
    const op = (cur) => cur.filter((_, idx) => idx !== i);
    if (lines[i] && lines[i].source === 'refund') {
      setHeld({ index: i, kind: 'remove', op });
      return;
    }
    run(op);
  };
  const add = (type) => run((cur) => [...cur, { type, label: '', amount: '', visible: true }]);

  return (
    <>
      <div className="meta-k" style={{ marginBottom: 8 }}>Price adjustments</div>
      <div style={{ marginBottom: 12 }}>
        {lines.map((adj, i) => (
          <div key={i} role="group" aria-label={adjLabel(adj)} style={{ marginBottom: 6 }}>
            <div className="hstack" style={{ gap: 6 }}>
              <span className={`chip ${adj.type === 'discount' ? 'ok' : 'danger'}`} style={{ flexShrink: 0 }}>
                {adj.type === 'discount' ? 'Discount' : 'Surcharge'}
              </span>
              <input className="input" placeholder="Label (e.g. Returning client)" aria-label="Label"
                value={adj.label}
                onChange={e => setField(i, 'label', e.target.value)}
                style={{ flex: 1 }} />
              <div style={{ position: 'relative' }}>
                <span style={DOLLAR}>$</span>
                <input className="input" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Amount"
                  value={adj.amount}
                  onChange={e => setField(i, 'amount', e.target.value)}
                  style={{ width: 110, paddingLeft: 18 }} />
              </div>
              <label className="hstack" style={{ gap: 4, fontSize: 11.5, cursor: 'pointer', flexShrink: 0 }}>
                <input type="checkbox" checked={!!adj.visible}
                  onChange={e => setField(i, 'visible', e.target.checked)} />
                Client sees
              </label>
              <button type="button" className="icon-btn" onClick={() => remove(i)} title="Remove" aria-label="Remove">
                <Icon name="x" size={12} />
              </button>
            </div>
            {held && held.index === i && (
              <div className="adj-confirm" role="alert">
                <span>{REFUND_CONFIRM_TEXT}</span>
                <span className="hstack" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-danger btn-sm" onClick={confirmHeld}>
                    {held.kind === 'remove' ? 'Remove it' : 'Lower it'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHeld(null)}>Keep it</button>
                </span>
              </div>
            )}
          </div>
        ))}
        <div className="hstack" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('discount')}>
            <Icon name="plus" size={11} />Discount
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => add('surcharge')}>
            <Icon name="plus" size={11} />Surcharge
          </button>
          <AgreedPriceControl adjustments={lines} preview={preview} previewStale={previewStale}
            override={override} onApply={(next) => run(() => next)} />
        </div>
      </div>
    </>
  );
}
