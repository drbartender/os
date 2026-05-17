/**
 * Pure lead-time tier computation. No DB, no side effects — the single source
 * of truth for booking-window policy. Mirrors the pricingEngine.js style.
 *
 * UTC math intentionally (consistent with the rest of the date code in this
 * codebase). No per-venue timezone — near-midnight edges may be off by a few
 * hours; accepted tradeoff.
 */

const FULL_PAYMENT_HOURS = 14 * 24; // 336 — reuses the existing balance_due_date window
const LAST_MINUTE_HOURS = 72;

function toUtcMs(eventDate, eventStartTime) {
  let y, m, d;
  if (eventDate instanceof Date) {
    y = eventDate.getUTCFullYear();
    m = eventDate.getUTCMonth();
    d = eventDate.getUTCDate();
  } else {
    const parts = String(eventDate).slice(0, 10).split('-').map(Number);
    y = parts[0]; m = parts[1] - 1; d = parts[2];
  }
  let hh = 0, mm = 0;
  if (eventStartTime) {
    const t = String(eventStartTime).split(':').map(Number);
    if (Number.isFinite(t[0])) hh = t[0];
    if (Number.isFinite(t[1])) mm = t[1];
  }
  return Date.UTC(y, m, d, hh, mm);
}

/**
 * @param {object} args
 * @param {string|Date} args.eventDate - 'YYYY-MM-DD' or a Date
 * @param {string|null} args.eventStartTime - 'HH:MM' (24h) or null
 * @param {Date} [args.now] - defaults to new Date()
 * @returns {{ hoursUntilEvent:number, fullPaymentRequired:boolean, lastMinuteHold:boolean }}
 */
function getBookingWindow({ eventDate, eventStartTime, now = new Date() }) {
  const eventMs = toUtcMs(eventDate, eventStartTime);
  const hoursUntilEvent = (eventMs - now.getTime()) / 3600000;
  return {
    hoursUntilEvent,
    fullPaymentRequired: hoursUntilEvent <= FULL_PAYMENT_HOURS,
    lastMinuteHold: hoursUntilEvent <= LAST_MINUTE_HOURS,
  };
}

module.exports = { getBookingWindow, FULL_PAYMENT_HOURS, LAST_MINUTE_HOURS };
