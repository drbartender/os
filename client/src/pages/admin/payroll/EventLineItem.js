import React, { useState, useEffect, useRef } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

export default function EventLineItem({ event, editable, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState({
    hours: event.hours,
    rate_dollars: (Number(event.rate_cents) / 100).toFixed(2),
    late: !!event.late,
    adjustment_dollars: (Number(event.adjustment_cents) / 100).toFixed(2),
    adjustment_note: event.adjustment_note || '',
  });
  const [saving, setSaving] = useState(false);
  // Latest-wins guard for the amount+note pair: blurring the amount and then the
  // note fires two commits; a superseded (earlier) commit must not apply its
  // stale result over the newer one.
  const saveSeq = useRef(0);
  // Serialize saves: a commit dispatched while another is in flight waits for it,
  // so server write order always matches the admin's intent order.
  const saveQueue = useRef(Promise.resolve());
  // Count of saves queued or in flight; drives both the `saving` state and the
  // resync suppression below (a ref, not state, so async callbacks read fresh).
  const inflight = useRef(0);
  // True while either adjustment input (amount or note) has focus: a returning
  // save response must not clobber the note mid-typing.
  const adjFocused = useRef(false);

  // A positive reimbursement that the accrual sweep held because the worker fell
  // off the roster: tracked (adjustment_cents) but non-payable (line_total 0)
  // until an admin confirms it by editing the line (any PATCH re-arms it and
  // flips held_state to 'confirmed'). Structural column, never note text.
  const isHeldReimbursement = event.held_state === 'held';

  // Resync the draft from props after a successful PATCH (the server may
  // normalize values, and the parent merges the updated row into local state).
  // The adjustment pair is EXEMPT while a save is in flight or while either
  // adjustment input has focus: a returning response for the amount must not
  // clobber the note the admin is still typing.
  useEffect(() => {
    setDraft(d => {
      const next = {
        hours: event.hours,
        rate_dollars: (Number(event.rate_cents) / 100).toFixed(2),
        late: !!event.late,
        adjustment_dollars: (Number(event.adjustment_cents) / 100).toFixed(2),
        adjustment_note: event.adjustment_note || '',
      };
      if (inflight.current > 0 || adjFocused.current) {
        next.adjustment_dollars = d.adjustment_dollars;
        next.adjustment_note = d.adjustment_note;
      }
      return next;
    });
  }, [event.id, event.hours, event.rate_cents, event.late, event.adjustment_cents, event.adjustment_note]);

  const eventLabel = getEventTypeLabel({
    event_type: event.event_type, event_type_custom: event.event_type_custom,
  });

  // Serialized PATCH. Returns the response ({ event, payout_total_cents }) or
  // null on error. Callers decide whether to apply it (the adjustment path gates
  // on saveSeq so a superseded commit's stale result is dropped). A failed save
  // toasts and leaves the draft intact for retry.
  const save = (patch) => {
    inflight.current += 1;
    setSaving(true);
    const dispatch = async () => {
      try {
        const { data } = await api.patch(`/admin/payroll/payout-events/${event.id}`, patch);
        return data;
      } catch (err) {
        toast.error(err.response?.data?.error || err.message);
        return null;
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0) setSaving(false);
      }
    };
    const p = saveQueue.current.then(dispatch);
    saveQueue.current = p.then(() => {}, () => {});
    return p;
  };

  const commitHours = async () => {
    const n = Number(draft.hours);
    if (!Number.isFinite(n) || n === Number(event.hours)) return;
    const data = await save({ hours: n });
    if (data) onSaved?.(data);
  };
  const commitRate = async () => {
    const cents = Math.round(Number(draft.rate_dollars) * 100);
    if (!Number.isInteger(cents) || cents === Number(event.rate_cents)) return;
    const data = await save({ rate_cents: cents });
    if (data) onSaved?.(data);
  };
  const commitAdjustment = async () => {
    const cents = Math.round(Number(draft.adjustment_dollars) * 100);
    if (!Number.isInteger(cents)) return;
    if (cents === Number(event.adjustment_cents) && draft.adjustment_note === (event.adjustment_note || '')) return;
    // Bump AFTER the no-op guards: a guard-rejected call must not invalidate a
    // legitimate in-flight commit's sequence number.
    const seq = ++saveSeq.current;
    const data = await save({ adjustment_cents: cents, adjustment_note: draft.adjustment_note || null });
    if (!data) return;
    if (seq !== saveSeq.current) return; // a newer commit superseded this one
    onSaved?.(data);
  };
  const toggleLate = async () => {
    const next = !draft.late;
    setDraft(d => ({ ...d, late: next }));
    const data = await save({ late: next });
    if (data) onSaved?.(data);
  };

  return (
    <div className="vstack" style={{ gap: 6, padding: '10px 0', borderTop: '1px solid var(--line-1)' }}>
      <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 160 }}>
          <EntityLink to={event.shift_id ? `/events/shift/${event.shift_id}` : null}>
            <div className="tiny muted">{fmtDate(event.event_date)}</div>
            <div style={{ fontWeight: 600 }}>{eventLabel}</div>
          </EntityLink>
        </div>
        <div className="hstack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Hours</span>
          <input
            className="input num" type="number" step="0.25" min="0" max="24"
            style={{ width: 70 }}
            value={draft.hours}
            onChange={(e) => setDraft(d => ({ ...d, hours: e.target.value }))}
            onBlur={editable ? commitHours : undefined}
            disabled={!editable || saving}
          />
        </div>
        <div className="hstack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Rate</span>
          <span className="tiny">$</span>
          <input
            className="input num" type="number" step="0.50" min="0"
            style={{ width: 70 }}
            value={draft.rate_dollars}
            onChange={(e) => setDraft(d => ({ ...d, rate_dollars: e.target.value }))}
            onBlur={editable ? commitRate : undefined}
            disabled={!editable || saving}
          />
          <span className="tiny muted">/hr</span>
        </div>
        <label className="hstack" style={{ gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={draft.late} onChange={editable ? toggleLate : undefined} disabled={!editable || saving} />
          <span className="tiny">Late</span>
        </label>
      </div>

      <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="tiny muted">Wage <strong>{fmt$fromCents(event.wage_cents)}</strong></div>
        <div className="tiny muted">Gratuity <strong>{fmt$fromCents(event.gratuity_share_cents)}</strong></div>
        <div className="tiny muted">
          Card tip <strong>{fmt$fromCents(event.card_tip_net_cents)}</strong>
          {Number(event.card_tip_fee_cents) > 0 && (
            <span> (gross {fmt$fromCents(event.card_tip_gross_cents)}, fee {fmt$fromCents(event.card_tip_fee_cents)})</span>
          )}
        </div>
        <div className="tiny muted">
          Adjustment
          <span className="tiny"> $</span>
          <input
            className="input num" type="number" step="0.01"
            style={{ width: 80, marginLeft: 2 }}
            value={draft.adjustment_dollars}
            onChange={(e) => setDraft(d => ({ ...d, adjustment_dollars: e.target.value }))}
            onFocus={() => { adjFocused.current = true; }}
            onBlur={() => { adjFocused.current = false; if (editable) commitAdjustment(); }}
            disabled={!editable}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            className="input" type="text" placeholder="Adjustment note (optional)"
            value={draft.adjustment_note}
            onChange={(e) => setDraft(d => ({ ...d, adjustment_note: e.target.value }))}
            onFocus={() => { adjFocused.current = true; }}
            onBlur={() => { adjFocused.current = false; if (editable) commitAdjustment(); }}
            disabled={!editable}
            maxLength={500}
          />
        </div>
        <div className="num"><strong>{fmt$fromCents(event.line_total_cents)}</strong></div>
      </div>

      {isHeldReimbursement && (
        <div className="hstack" style={{ gap: 6 }}>
          <StatusChip kind="warn">reimbursement held: confirm or zero at payroll</StatusChip>
        </div>
      )}
    </div>
  );
}
