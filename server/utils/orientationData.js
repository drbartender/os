const { pool } = require('../db');
const { resolveEventTimezone, formatEventLocalTime, DEFAULT_TZ } = require('./eventTimezone');
const { effectiveSetupMinutes } = require('./setupTime');

/**
 * Parse proposals.event_start_time (VARCHAR(20)) into {h, m}.
 * Handles both 24h ("17:00") and 12h ("5:00 PM") shapes, because the
 * proposal-create flow has historically taken either and there is no
 * canonicalization at write time.
 *
 * Returns null on anything unparseable; callers must treat null as
 * "we cannot place the event on the calendar; skip the .ics".
 */
function parseStartTimeToHM(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();

  // 12h: "5:00 PM" / "12:30 AM"
  const m12 = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const m = parseInt(m12[2], 10);
    const ampm = m12[3].toUpperCase();
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (ampm === 'AM') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return { h, m };
  }

  // 24h: "17:00"
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const m = parseInt(m24[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { h, m };
  }

  return null;
}

/**
 * Compute UTC start + end for the event from event_date (DATE),
 * event_start_time (VARCHAR), event_duration_hours (NUMERIC), and the event TZ.
 *
 * Implementation note: JS Date has no native "build from local fields in zone X"
 * primitive. We compute the offset between the wall-clock time in the event zone
 * and UTC by formatting a candidate UTC Date in the target zone and adjusting.
 * The two-pass approach below converges in one step for non-DST-transition days
 * and is correct for our use case (events do not span a DST transition).
 *
 * Returns null if any required field is missing or unparseable.
 */
function computeUtcStartEnd({ eventDate, startTimeStr, durationHours, tz }) {
  if (!eventDate || !startTimeStr || durationHours === null || durationHours === undefined) return null;
  const hm = parseStartTimeToHM(startTimeStr);
  if (!hm) return null;
  const zone = tz || DEFAULT_TZ;

  // eventDate is a DATE column; node-postgres gives us a Date at UTC midnight
  // or a YYYY-MM-DD string depending on driver config. Normalize.
  const dateStr = typeof eventDate === 'string'
    ? eventDate.slice(0, 10)
    : new Date(eventDate).toISOString().slice(0, 10);
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (!y || !mo || !d) return null;

  // First pass: assume the local time is also UTC, then ask the formatter
  // what wall-clock time that corresponds to in `zone`. The difference is the
  // offset we need to subtract.
  const naiveUtc = new Date(Date.UTC(y, mo - 1, d, hm.h, hm.m, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(naiveUtc).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const localAsUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) === 24 ? 0 : parseInt(parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  const offsetMs = localAsUtc - naiveUtc.getTime();
  const startUtc = new Date(naiveUtc.getTime() - offsetMs);
  const endUtc = new Date(startUtc.getTime() + Number(durationHours) * 3600 * 1000);
  return { startUtc, endUtc };
}

/**
 * Decide BYOB vs Hosted from the linked service_packages row.
 * The spec calls this `proposals.bar_option` but in the actual schema it's
 * derived from `service_packages.pricing_type`. Falls back to 'byob' on
 * missing data (safe default: the BYOB shopping-list copy is the broader
 * superset of guidance).
 */
function deriveBarOption(pkg) {
  if (pkg && pkg.pricing_type === 'per_guest') return 'hosted';
  return 'byob';
}

/**
 * Shape the receipt + balance section. Pure.
 */
function computeBalanceContext({ totalPrice, amountPaid, autopayEnrolled, balanceDueDate }) {
  const total = Number(totalPrice) || 0;
  const paid = Number(amountPaid) || 0;
  const balanceRemaining = Math.max(0, total - paid);
  const paidInFull = balanceRemaining <= 0.005;
  const dateStr = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', {
        timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;
  return {
    balanceRemaining,
    paidInFull,
    autopayEnrolled: !!autopayEnrolled,
    balanceVerb: autopayEnrolled ? 'runs' : 'due',
    dueLabel: autopayEnrolled ? 'runs on' : 'due on',
    formattedBalanceDueDate: dateStr,
  };
}

function buildPotionPlannerUrl(publicSiteUrl, token) {
  if (!token) return null;
  return `${publicSiteUrl}/plan/${token}`;
}

/**
 * Fetch the proposal + client + package + drink plan token in one query and
 * shape it into a ready-to-render payload. Returns null if the proposal can't
 * be loaded.
 *
 * Caller is responsible for sending the email (and the .ics attachment).
 * This function does no I/O beyond the single SELECT.
 */
async function buildOrientationPayload(proposalId, { publicSiteUrl }) {
  const r = await pool.query(`
    SELECT
      p.id,
      p.event_date,
      p.event_start_time,
      p.event_duration_hours,
      p.event_location,
      p.guest_count,
      p.total_price,
      p.amount_paid,
      p.balance_due_date,
      p.autopay_enrolled,
      p.event_timezone,
      p.setup_minutes_before,
      c.id      AS client_id,
      c.name    AS client_name,
      c.email   AS client_email,
      sp.name          AS package_name,
      sp.pricing_type  AS package_pricing_type,
      sp.bar_type      AS package_bar_type,
      dp.token  AS drink_plan_token
    FROM proposals p
    LEFT JOIN clients c           ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN drink_plans dp      ON dp.proposal_id = p.id
    WHERE p.id = $1
    LIMIT 1
  `, [proposalId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];

  const tz = resolveEventTimezone({ event_timezone: row.event_timezone });
  const utc = computeUtcStartEnd({
    eventDate: row.event_date,
    startTimeStr: row.event_start_time,
    durationHours: row.event_duration_hours,
    tz,
  });
  const barOption = deriveBarOption({ pricing_type: row.package_pricing_type });
  const balance = computeBalanceContext({
    totalPrice: row.total_price,
    amountPaid: row.amount_paid,
    autopayEnrolled: row.autopay_enrolled,
    balanceDueDate: row.balance_due_date,
  });

  const formattedEventDate = row.event_date
    ? new Date(row.event_date).toLocaleDateString('en-US', {
        timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;
  const formattedStartTime = utc
    ? formatEventLocalTime(utc.startUtc, tz, { hour: 'numeric', minute: '2-digit' })
    : (row.event_start_time || null);

  const setupMinutesBefore = effectiveSetupMinutes(
    { setup_minutes_before: row.setup_minutes_before },
    { pricing_type: row.package_pricing_type }
  );

  return {
    proposalId: row.id,
    clientName: row.client_name || 'there',
    clientEmail: row.client_email,
    eventDate: row.event_date,
    eventStartTime: row.event_start_time,
    eventDurationHours: Number(row.event_duration_hours) || 4,
    eventLocation: row.event_location,
    guestCount: row.guest_count,
    packageName: row.package_name || 'BYOB Classic',
    barOption,
    tz,
    utc,
    formattedEventDate,
    formattedStartTime,
    balance,
    setupMinutesBefore,
    potionPlannerUrl: buildPotionPlannerUrl(publicSiteUrl, row.drink_plan_token),
    drinkPlanToken: row.drink_plan_token,
  };
}

module.exports = {
  parseStartTimeToHM,
  computeUtcStartEnd,
  deriveBarOption,
  computeBalanceContext,
  buildPotionPlannerUrl,
  buildOrientationPayload,
};
