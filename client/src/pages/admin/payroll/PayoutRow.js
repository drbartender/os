import React, { useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import EntityLink from '../../../components/EntityLink';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';
import EventLineItem from './EventLineItem';
import DutyLineRow from './DutyLineRow';
import PayPanel from './PayPanel';
import { EVENT_KIND_OPTIONS } from './dutyKinds';

function preferredHandle(payout) {
  switch (payout.preferred_payment_method) {
    case 'venmo': return payout.venmo_handle || null;
    case 'cashapp': return payout.cashapp_handle || null;
    case 'paypal': return payout.paypal_url || null;
    case 'zelle': return payout.zelle_handle || null;
    default: return null; // direct_deposit/check identifiers are bank PII and never surface
  }
}

// Queue row: name, method+handle tag, events/hours sub, amount, status chip,
// Pay button toggling the expansion. The expansion pairs the line editor
// (left) with the pay panel (right); History renders it with payable={false}
// for a read-only drill-in.
export default function PayoutRow({
  payout, period, expanded, onToggle, onLineSaved, onDutyChanged, onPaid, onRefetch, editable, payable,
}) {
  const toast = useToast();
  const events = payout.events || [];
  const dutyLines = payout.duty_lines || [];
  const hours = events.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const [addKind, setAddKind] = useState('');
  const [addShiftPick, setAddShiftPick] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // Derived, never stored (re-review NW2): a mounted row whose events list
  // changes must not strand the Add control behind a stale initializer.
  const addShift = events.length === 1 ? String(events[0].shift_id) : addShiftPick;

  // Manual duty line, EVENT kinds only (server refuses review kinds — their
  // idempotency keys exist only on the materializer path). The SHIFT is
  // required, never guessed: a NULL-shift manual line is invisible to
  // reconcile, can double-pay next to a later-attributed auto line, and
  // escapes the off-roster hold (payroll-ui review B2). Defaults come from
  // the per-kind policy amounts; the row's amount input is the edit surface.
  const addDutyLine = async () => {
    if (!addKind || !addShift || addBusy) return;
    setAddBusy(true);
    try {
      const opt = EVENT_KIND_OPTIONS.find((o) => o.kind === addKind);
      const { data } = await api.post('/admin/payroll/duty-lines', {
        payout_id: payout.id, kind: addKind,
        amount_cents: (opt && opt.default_cents) || 2000,
        shift_id: Number(addShift),
      });
      setAddKind('');
      onDutyChanged?.(payout.id, data.duty_line, data.payout_total_cents, { created: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAddBusy(false);
    }
  };
  const isPaid = payout.status === 'paid';
  const isNoDraw = payout.status === 'no_draw';
  // Paid rows show what was actually recorded; pending rows show the preference.
  const tagMethod = isPaid && payout.payment_method ? payout.payment_method : payout.preferred_payment_method;
  const tagHandle = isPaid && payout.payment_method ? payout.payment_handle : preferredHandle(payout);

  const [toggleBusy, setToggleBusy] = useState(false);
  // Flip pending <-> no_draw (owner rows, spec 2026-08-07). A park that would
  // CLOSE a processing period 409s server-side without confirm_finalize; the
  // handler confirms and retries, mirroring runProcess's force pattern.
  const toggleDraw = async (confirm = false) => {
    setToggleBusy(true);
    try {
      await api.post(`/admin/payroll/payouts/${payout.id}/toggle-draw`,
        confirm ? { confirm_finalize: true } : {});
      // Status + rollups (owed, possibly period close) changed: full refetch.
      onRefetch?.();
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 409 && msg.includes('confirm')) {
        // One-way door: parking the last pending payout closes the period.
        // `return await` keeps the outer finally from re-enabling the button
        // while the confirmed retry is in flight (fleet review: double-submit).
        const go = window.confirm('Parking this payout closes the period for good (no reopen). Continue?');
        if (go) return await toggleDraw(true);
        return;
      }
      toast.error(msg);
      if (err.status === 409) onRefetch?.();
    } finally {
      setToggleBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 8, ...(isNoDraw ? { opacity: 0.6 } : {}) }}>
      <div
        className="card-head"
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <EntityLink
            to={payout.contractor_id ? `/staffing/users/${payout.contractor_id}` : null}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ fontWeight: 600 }}>{payout.contractor_name}</span>
          </EntityLink>
          <span className="tiny muted">
            {paymentMethodLabel(tagMethod) || 'No method'}{tagHandle ? ` · ${tagHandle}` : ''}
          </span>
          <span className="tiny muted">
            {events.length} {events.length === 1 ? 'event' : 'events'} · {Number(hours.toFixed(2))} h
          </span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
          {isPaid
            ? <StatusChip kind="ok">Paid</StatusChip>
            : isNoDraw
              ? <StatusChip kind="neutral">No draw</StatusChip>
              : <StatusChip kind="info">Pending</StatusChip>}
          {payable && payout.status === 'pending' && (
            <button
              type="button" className="btn btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
              Pay
            </button>
          )}
          <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="card-body payrun-expansion">
          <div className="payrun-lines vstack" style={{ gap: 6 }}>
            {events.length === 0 && (
              <div className="muted tiny">No event lines on this payout.</div>
            )}
            {events.map(ev => (
              <EventLineItem
                key={ev.id}
                event={ev}
                editable={editable && !isPaid}
                onSaved={({ event, payout_total_cents }) => onLineSaved?.(event, payout_total_cents)}
              />
            ))}
            {(() => {
              // Read-only views (History, paid payouts) hide removed lines:
              // they are derivation memory, not archive information. The
              // section header gates on the FILTERED list so an all-removed
              // archive payout never renders an empty "Duty pay" block.
              const visibleDuty = dutyLines.filter((d) => (editable && !isPaid) || !d.removed_at);
              if (visibleDuty.length === 0 && !(editable && !isPaid && events.length > 0)) return null;
              return (
              <div className="vstack" style={{ gap: 6, paddingTop: 10, borderTop: '1px solid var(--line-1)' }}>
                <div className="tiny muted" style={{ fontWeight: 600 }}>Duty pay</div>
                {visibleDuty.map((d) => {
                    const ev = d.shift_id != null ? events.find((e) => e.shift_id === d.shift_id) : null;
                    return (
                      <div key={d.id} className="vstack" style={{ gap: 2 }}>
                        <DutyLineRow
                          line={d}
                          editable={editable && !isPaid}
                          onChanged={({ duty_line, payout_total_cents }) =>
                            onDutyChanged?.(payout.id, duty_line, payout_total_cents, {})}
                        />
                        <div className="tiny muted" style={{ paddingLeft: 24 }}>
                          {ev
                            ? `for the ${String(ev.event_date || '').slice(0, 10)} event`
                            : d.shift_id == null ? 'not tied to an event' : 'for a past event'}
                        </div>
                      </div>
                    );
                  })}
                {editable && !isPaid && events.length > 0 && (
                  <div className="hstack" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="input"
                      value={addKind}
                      onChange={(e) => setAddKind(e.target.value)}
                      disabled={addBusy}
                    >
                      <option value="">Add duty line…</option>
                      {EVENT_KIND_OPTIONS.map((o) => (
                        <option key={o.kind} value={o.kind}>{o.label}</option>
                      ))}
                    </select>
                    {events.length > 1 && (
                      <select
                        className="input"
                        value={addShift}
                        onChange={(e) => setAddShiftPick(e.target.value)}
                        disabled={addBusy}
                        aria-label="Which event this duty belongs to"
                      >
                        <option value="">Which event…</option>
                        {events.map((e) => (
                          <option key={e.shift_id} value={e.shift_id}>
                            {String(e.event_date || '').slice(0, 10)}{e.client_name ? ` · ${e.client_name}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button" className="btn btn-ghost btn-sm"
                      onClick={addDutyLine} disabled={!addKind || !addShift || addBusy}
                    >
                      {addBusy ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                )}
              </div>
              );
            })()}
            <div
              className="hstack"
              style={{ justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--line-1)' }}
            >
              <span className="tiny muted">Payout total</span>
              <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
            </div>
            {isPaid && payout.payment_reference && (
              <div className="tiny muted">Reference: {payout.payment_reference}</div>
            )}
            {/* Owner toggle: convert-to-payable on any no_draw row; park only
                for a takes_draw=false contractor, so nobody else's pending
                rows grow a park affordance. */}
            {payable && !isPaid && (isNoDraw || payout.takes_draw === false) && (
              <div className="hstack" style={{ gap: 8, paddingTop: 8 }}>
                <button
                  type="button" className="btn btn-ghost btn-sm" disabled={toggleBusy}
                  onClick={() => toggleDraw()}
                >
                  {toggleBusy ? 'Working…' : isNoDraw ? 'Convert to payable' : 'Park as no-draw'}
                </button>
                <span className="tiny muted">
                  {isNoDraw
                    ? 'Makes this payout owed and payable again.'
                    : 'Tracks it without owing it.'}
                </span>
              </div>
            )}
          </div>
          {payable && payout.status === 'pending' && (
            <PayPanel payout={payout} period={period} onPaid={onPaid} onDrift={onRefetch} />
          )}
        </div>
      )}
    </div>
  );
}
