import React, { useEffect, useRef } from 'react';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { formatMoney } from '../../utils/formatMoney';

/**
 * PayoutEventRow — one card per payout_events row (spec §6.7).
 *
 * Shows the event header (client name + event-type label + date) and the
 * full per-event breakdown that mirrors the design source's PayoutDetail
 * cards (wage, gratuity share, card-tip gross + fee + net, adjustments,
 * event total). All money is rendered through `formatMoney(integer cents)`;
 * negative adjustments render with a leading `-` and the `.neg` modifier on
 * the line value for the bordeaux/red accent.
 *
 * Props:
 *   event      — one row from `payouts.events[]` returned by
 *                GET /api/me/payouts/:periodId. Read defensively — every
 *                cents field falls back to 0 so a partial row doesn't crash.
 *   highlight  — when true, adds the `sp-highlight` CSS class (border +
 *                pulse animation) and scrolls the card into view on mount.
 *                Parent (PayoutDetail) sets this for the event row matching
 *                the `?shift=:shiftId` query param so the deep-link from a
 *                Past-shifts tap lands on the right line.
 *
 * Event identity: client name and event-type label are SEPARATE per the
 * CLAUDE.md cross-cutting rule. We never concatenate them into one title
 * string. Event-type label routes through `getEventTypeLabel(...)` with the
 * 'event' fallback (the helper handles `event_type_custom` + the 'other' →
 * 'event' rewrite).
 */
export default function PayoutEventRow({ event, highlight = false }) {
  const cardRef = useRef(null);

  // Scroll the matched event into view when the highlight flag flips on.
  // Browser sniffing for `scrollIntoView` isn't needed (all evergreen
  // browsers support it, including iOS Safari ≥ 14); the option `block:
  // 'center'` keeps the card centered in the viewport so it isn't tucked
  // behind the StaffShell topbar or the sticky tabs nav.
  useEffect(() => {
    if (!highlight) return;
    const node = cardRef.current;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    // requestAnimationFrame defers the scroll one tick so the page paints
    // first — without this, the scroll target can be at the wrong offset
    // when the parent's Suspense fallback flips out.
    const handle = window.requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [highlight]);

  if (!event) return null;

  const ev = event;
  const eventLabel = getEventTypeLabel({
    event_type: ev.event_type,
    event_type_custom: ev.event_type_custom,
  });
  const clientName = (ev.client_name || '').trim();
  const dateStr = fmtShortDate(ev.event_date);

  const wage = Number.isFinite(ev.wage_cents) ? ev.wage_cents : 0;
  const gratuity = Number.isFinite(ev.gratuity_share_cents) ? ev.gratuity_share_cents : 0;
  const tipGross = Number.isFinite(ev.card_tip_gross_cents) ? ev.card_tip_gross_cents : 0;
  const tipFee = Number.isFinite(ev.card_tip_fee_cents) ? ev.card_tip_fee_cents : 0;
  const tipNet = Number.isFinite(ev.card_tip_net_cents) ? ev.card_tip_net_cents : 0;
  const adjustment = Number.isFinite(ev.adjustment_cents) ? ev.adjustment_cents : 0;
  const lineTotal = Number.isFinite(ev.line_total_cents) ? ev.line_total_cents : 0;
  const rate = Number.isFinite(ev.rate_cents) ? ev.rate_cents : 0;
  const hours = Number.isFinite(Number(ev.hours)) ? Number(ev.hours) : 0;

  const className = ['sp-card', 'tight', highlight ? 'sp-highlight' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={cardRef} className={className}>
      <div className="sp-card-head">
        <div className="sp-card-title">
          {clientName || 'Event'}
        </div>
        <span className="sp-paystub-amount" style={{ fontSize: 16 }}>
          {formatMoney(lineTotal)}
        </span>
      </div>
      <div className="sp-paystub-events" style={{ marginTop: -4, marginBottom: 6 }}>
        {eventLabel}
        {dateStr ? ` · ${dateStr}` : ''}
      </div>

      <div className="sp-line">
        <div>
          <div className="sp-line-k">Wage</div>
          <div className="sp-line-sub">
            {formatHours(hours)} hrs &times; {formatMoney(rate)}/hr
          </div>
        </div>
        <div className="sp-line-v">{formatMoney(wage)}</div>
      </div>

      {gratuity > 0 && (
        <div className="sp-line">
          <div>
            <div className="sp-line-k">Gratuity share</div>
            <div className="sp-line-sub">Even split, net of card processing fees</div>
          </div>
          <div className="sp-line-v">{formatMoney(gratuity)}</div>
        </div>
      )}

      {tipGross > 0 && (
        <>
          <div className="sp-line">
            <div>
              <div className="sp-line-k">Card tips (gross)</div>
              <div className="sp-line-sub">Your even share of card tips from this event</div>
            </div>
            <div className="sp-line-v">{formatMoney(tipGross)}</div>
          </div>
          <div className="sp-line">
            <div>
              <div className="sp-line-k">Card processing fee</div>
              <div className="sp-line-sub">Stripe fee on your share</div>
            </div>
            <div className="sp-line-v neg">-{formatMoney(tipFee)}</div>
          </div>
          {tipNet > 0 && (
            <div className="sp-line">
              <div>
                <div className="sp-line-k">Card tips (net)</div>
                <div className="sp-line-sub">After processing fee</div>
              </div>
              <div className="sp-line-v">{formatMoney(tipNet)}</div>
            </div>
          )}
        </>
      )}

      {adjustment !== 0 && (
        <div className="sp-line">
          <div>
            <div className="sp-line-k">Adjustment</div>
            <div className="sp-line-sub">{ev.adjustment_note || '—'}</div>
          </div>
          <div className={'sp-line-v' + (adjustment < 0 ? ' neg' : '')}>
            {formatMoney(adjustment)}
          </div>
        </div>
      )}

      <div className="sp-line total">
        <div className="sp-line-k">Event total</div>
        <div className="sp-line-v">{formatMoney(lineTotal)}</div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Parse a 'YYYY-MM-DD' string into a noon-local Date and format short. Noon
// avoids the timezone-rollover bug where `new Date('2026-05-23')` lands on
// May 22 for negative UTC offsets.
function fmtShortDate(iso) {
  if (!iso) return '';
  const dateStr = String(iso).slice(0, 10);
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Drop trailing `.0` so 5.5h reads as `5.5` and 6h reads as `6`. Keeps
// half-hour shifts legible without leaking a floating-point representation
// like `5.50000001`.
function formatHours(h) {
  if (!Number.isFinite(h)) return '0';
  const rounded = Math.round(h * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace(/\.?0+$/, '');
}
