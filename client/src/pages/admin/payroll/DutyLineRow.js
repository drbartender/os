import React, { useState, useRef, useEffect } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';

// One typed duty-pay line (spec 2026-08-06 §9): label from the PAYLOAD (never
// a client-side kind map), dollars amount mapped to integer cents on commit,
// note, the remove checkbox / restore link, and the held chip. Server rules
// mirrored client-side (spec §3.6 validation parity): integer cents, |x| <=
// $1,000, $0 allowed on EDIT (distinct from removal). Saves are serialized
// like EventLineItem's; a failed save toasts and leaves the draft for retry.
export default function DutyLineRow({ line, editable, onChanged }) {
  const toast = useToast();
  const [draft, setDraft] = useState({
    amount_dollars: (Number(line.amount_cents) / 100).toFixed(2),
    note: line.note || '',
  });
  // No saving state: inputs stay enabled during in-flight saves (queue
  // serializes; disabling swallowed the blur-then-click sequence, review W3).
  const inflight = useRef(0);
  const focused = useRef(false);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    setDraft((d) => {
      const next = {
        amount_dollars: (Number(line.amount_cents) / 100).toFixed(2),
        note: line.note || '',
      };
      if (inflight.current > 0 || focused.current) {
        next.amount_dollars = d.amount_dollars;
        next.note = d.note;
      }
      return next;
    });
  }, [line.id, line.amount_cents, line.note]);

  const removed = !!line.removed_at;
  const held = line.held_state === 'held';

  const call = (fn) => {
    inflight.current += 1;

    const dispatch = async () => {
      try {
        return await fn();
      } catch (err) {
        toast.error(err.message);
        return null;
      } finally {
        inflight.current -= 1;

      }
    };
    const p = saveQueue.current.then(dispatch);
    saveQueue.current = p.then(() => {}, () => {});
    return p;
  };

  const commitEdit = async () => {
    // A cleared amount box is a no-op, never a silent $0 (Number('') === 0;
    // zeroing a duty line is a deliberate decision, so it must be typed).
    const raw = String(draft.amount_dollars).trim();
    const cents = raw === '' ? Number(line.amount_cents) : Math.round(Number(raw) * 100);
    if (!Number.isInteger(cents) || Math.abs(cents) > 100000) {
      toast.error('Amount must be a whole-cent value within $1,000.');
      return;
    }
    // Send ONLY what changed: the server stamps admin_owned on amount edits
    // exclusively (spec §3.1 / review W7), so a note-only PATCH must not carry
    // amount_cents or the line silently opts out of auto re-derivation
    // (payroll-ui review B1).
    const patch = {};
    if (cents !== Number(line.amount_cents)) patch.amount_cents = cents;
    if (draft.note !== (line.note || '')) patch.note = draft.note || null;
    if (Object.keys(patch).length === 0) return;
    const data = await call(async () => (
      (await api.patch(`/admin/payroll/duty-lines/${line.id}`, patch)).data
    ));
    if (data) onChanged?.(data);
  };

  const toggleRemoved = async () => {
    const action = removed ? 'restore' : 'remove';
    const data = await call(async () => (
      (await api.post(`/admin/payroll/duty-lines/${line.id}/${action}`)).data
    ));
    if (data) onChanged?.(data);
  };

  return (
    <div className="hstack" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', opacity: removed ? 0.55 : 1 }}>
      <label className="hstack" style={{ gap: 4, alignItems: 'center' }} title={removed ? 'Restore this line' : 'Remove this line from the payout'}>
        {/* Not disabled while saving: the amount input's blur-commit fires
            first and would swallow this click via the disable (review W3);
            the saveQueue already serializes the two writes correctly. */}
        <input
          type="checkbox"
          aria-label={removed ? `Restore ${line.label || line.kind}` : `Remove ${line.label || line.kind}`}
          checked={!removed}
          onChange={editable ? toggleRemoved : undefined}
          disabled={!editable}
        />
      </label>
      <span className="tiny" style={{ minWidth: 130, textDecoration: removed ? 'line-through' : 'none' }}>
        {line.label || line.kind}
      </span>
      {removed ? (
        <span className="num tiny muted" style={{ textDecoration: 'line-through' }}>
          {fmt$fromCents(line.amount_cents)}
        </span>
      ) : (
        <span className="hstack" style={{ gap: 2, alignItems: 'center' }}>
          <span className="tiny">$</span>
          <input
            className="input num" type="number" step="0.01"
            style={{ width: 80 }}
            value={draft.amount_dollars}
            onChange={(e) => setDraft((d) => ({ ...d, amount_dollars: e.target.value }))}
            onFocus={() => { focused.current = true; }}
            onBlur={() => { focused.current = false; if (editable) commitEdit(); }}
            disabled={!editable}
          />
        </span>
      )}
      {held && <span className="tiny muted">(not in total until confirmed)</span>}
      <div style={{ flex: 1, minWidth: 120 }}>
        <input
          className="input" type="text" placeholder="Note (optional)"
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; if (editable && !removed) commitEdit(); }}
          disabled={!editable || removed}
          maxLength={500}
        />
      </div>
      {held && <StatusChip kind="warn">held: confirm or zero</StatusChip>}
      {line.origin === 'admin' && <span className="tiny muted">manual</span>}
    </div>
  );
}
