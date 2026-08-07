import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';

export const centsToDollarString = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));

/**
 * Out-of-Area Bonus knob (spec 2026-08-06-contractor-duty-pay-design.md §6).
 * One amount field, in dollars, mapped to integer cents on the way out.
 *
 * Extracted from EventDetailPage.js, which crossed the 700-line soft cap.
 *
 * The suggested amount, the venue distance, and the unlocked warning all come
 * off the shift payload and are NEVER computed here: the bands live only in
 * server/utils/serviceArea.js (published-ambiguity rule), and this bundle ships
 * to the public marketing site.
 *
 * The $250 cap is enforced server-side and its message is surfaced verbatim, so
 * there is exactly one authority on how much a bonus may be.
 */
export default function OutOfAreaKnob({ shift, onSaved }) {
  const toast = useToast();
  const stored = centsToDollarString(shift.out_of_area_bonus_cents);
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setValue(stored); }, [stored]);

  const locked = !!shift.out_of_area_locked_at;
  const suggested = shift.suggested_bonus_cents;

  const save = async () => {
    setErr('');
    const trimmed = String(value).trim();
    let amountCents = null;
    if (trimmed !== '') {
      const dollars = Number(trimmed);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setErr('Enter a dollar amount above zero, or clear the field to remove the bonus.');
        return;
      }
      amountCents = Math.round(dollars * 100);
    }
    setSaving(true);
    try {
      await api.patch(`/shifts/${shift.id}/out-of-area`, { amount_cents: amountCents });
      toast.success(amountCents === null ? 'Out-of-Area Bonus removed.' : 'Out-of-Area Bonus saved.');
      await onSaved();
    } catch (e) {
      // api.js rejects a FLATTENED envelope: { message, code, fieldErrors, status }.
      const msg = e?.fieldErrors?.amount_cents || e?.message || 'Could not save the bonus.';
      setErr(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }} onClick={(ev) => ev.stopPropagation()}>
      <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="tiny muted">Out-of-Area Bonus $</span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          placeholder="0.00"
          disabled={saving}
          onChange={(e) => { setValue(e.target.value); setErr(''); }}
          style={{ width: 78 }}
          aria-label="Out-of-Area Bonus in dollars"
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          // A same-value Save stays submittable ONLY when it can still do
          // something: with the bonus unlocked and exactly one approved
          // staffer, re-saving the amount is how the admin triggers the
          // server's auto-lock, so disabling it would make the warning a dead
          // end. With 2+ approved the server cannot auto-lock, so a same-value
          // save is a pure no-op; keep it disabled there and let the warning
          // text point at the real fix (thin the roster to one, or wait).
          disabled={saving || (value === stored && !(shift.unlocked_warning && Number(shift.approved_count) === 1))}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {suggested != null && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={saving}
            onClick={() => { setValue(centsToDollarString(suggested)); setErr(''); }}
          >
            Use suggested ${centsToDollarString(suggested)}
          </button>
        )}
        {locked && <StatusChip kind="warn">Locked</StatusChip>}
      </div>
      {shift.venue_distance_miles != null && (
        <div className="tiny muted" style={{ marginTop: 2 }}>
          Venue is {shift.venue_distance_miles} mi out.
        </div>
      )}
      {locked && (
        <div className="tiny muted" style={{ marginTop: 2 }}>
          Locked when this staffer was approved. It can be raised, never lowered or removed.
        </div>
      )}
      {/* Money attached with nobody holding it pays no one, silently. Say so,
          and say the RIGHT thing: this only ever renders when the shift already
          has approved staff, so "wait for someone to be approved" would be
          wrong. One staffer is a one-click fix; two or more needs a decision. */}
      {shift.unlocked_warning && (
        <div className="tiny" style={{ marginTop: 2, color: 'var(--danger, #b00)' }}>
          {Number(shift.approved_count) === 1
            ? 'This bonus is not locked to the approved staffer yet. Save the amount to lock it to them.'
            : 'This bonus is locked to no one and will not pay. It locks once only one staffer holds the shift.'}
        </div>
      )}
      {err && <div className="tiny" style={{ marginTop: 2, color: 'var(--danger, #b00)' }}>{err}</div>}
    </div>
  );
}
