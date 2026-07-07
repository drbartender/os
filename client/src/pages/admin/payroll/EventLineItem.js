import React, { useState, useEffect } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
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

  // Resync the draft from props after a successful PATCH (the server may
  // normalize values, and the parent merges the updated row into local state).
  useEffect(() => {
    setDraft({
      hours: event.hours,
      rate_dollars: (Number(event.rate_cents) / 100).toFixed(2),
      late: !!event.late,
      adjustment_dollars: (Number(event.adjustment_cents) / 100).toFixed(2),
      adjustment_note: event.adjustment_note || '',
    });
  }, [event.id, event.hours, event.rate_cents, event.late, event.adjustment_cents, event.adjustment_note]);

  const eventLabel = getEventTypeLabel({
    event_type: event.event_type, event_type_custom: event.event_type_custom,
  });

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/admin/payroll/payout-events/${event.id}`, patch);
      onSaved?.(data); // { event, payout_total_cents }
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const commitHours = () => {
    const n = Number(draft.hours);
    if (!Number.isFinite(n) || n === Number(event.hours)) return;
    save({ hours: n });
  };
  const commitRate = () => {
    const cents = Math.round(Number(draft.rate_dollars) * 100);
    if (!Number.isInteger(cents) || cents === Number(event.rate_cents)) return;
    save({ rate_cents: cents });
  };
  const commitAdjustment = () => {
    const cents = Math.round(Number(draft.adjustment_dollars) * 100);
    if (!Number.isInteger(cents)) return;
    if (cents === Number(event.adjustment_cents) && draft.adjustment_note === (event.adjustment_note || '')) return;
    save({ adjustment_cents: cents, adjustment_note: draft.adjustment_note || null });
  };
  const toggleLate = () => {
    const next = !draft.late;
    setDraft(d => ({ ...d, late: next }));
    save({ late: next });
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
            onBlur={editable ? commitAdjustment : undefined}
            disabled={!editable || saving}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            className="input" type="text" placeholder="Adjustment note (optional)"
            value={draft.adjustment_note}
            onChange={(e) => setDraft(d => ({ ...d, adjustment_note: e.target.value }))}
            onBlur={editable ? commitAdjustment : undefined}
            disabled={!editable || saving}
            maxLength={500}
          />
        </div>
        <div className="num"><strong>{fmt$fromCents(event.line_total_cents)}</strong></div>
      </div>
    </div>
  );
}
