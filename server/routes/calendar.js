const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, PermissionError } = require('../utils/errors');
const { buildBeoConfirmVEvents, detectCalendarApp } = require('../utils/staffCalendarFeedExt');
const { requireUuidToken } = require('../utils/tokens');

const router = express.Router();

// ─── Rate limiting (express-rate-limit, per-token) ───────────────
const calendarLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.params.token || req.ip });

// ─── Time parsing helpers ─────────────────────────────────────────

/**
 * Parse a shift time into { hours, minutes }. Accepts BOTH formats currently
 * stored in shifts.start_time/end_time:
 *   - 12-hour with period: "5:00 PM" (written by eventCreation.js auto-create)
 *   - 24-hour: "17:00" (written by the admin TimePicker)
 * Returns null if unparseable. Without dual support, manually-edited shifts
 * silently downgrade to all-day events in calendar feeds.
 */
function parseTime12(timeStr) {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();

  // 12-hour with AM/PM
  const m12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let hours = parseInt(m12[1]);
    const minutes = parseInt(m12[2]);
    const period = m12[3].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  // 24-hour HH:mm
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const hours = parseInt(m24[1]);
    const minutes = parseInt(m24[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
  }

  return null;
}

/**
 * Format a Date-like string "YYYY-MM-DD" and a 12-hour time string into
 * iCal DTSTART/DTEND value (e.g. "20260328T170000").
 * Returns null if time is unparseable.
 */
function formatICalDateTime(dateStr, timeStr) {
  const time = parseTime12(timeStr);
  if (!time) return null;
  const d = dateStr.replace(/-/g, '').slice(0, 8);
  return `${d}T${String(time.hours).padStart(2, '0')}${String(time.minutes).padStart(2, '0')}00`;
}

/**
 * Build DTSTART/DTEND for a shift, handling edge cases:
 *  - Missing end time → 4-hour default
 *  - Overnight (end < start) → end is next day
 *  - Unparseable times → all-day event
 */
function buildEventTimes(eventDate, startTimeStr, endTimeStr) {
  // pg returns DATE columns as JS Date objects whose String() is "Thu Apr 23 2026 ..." —
  // not a YYYY-MM-DD slice. Normalize explicitly so downstream date math doesn't crash.
  let dateOnly;
  if (eventDate instanceof Date) {
    if (isNaN(eventDate.getTime())) return { allDay: true, dtstart: '', dtend: '' };
    dateOnly = eventDate.toISOString().slice(0, 10);
  } else {
    dateOnly = String(eventDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return { allDay: true, dtstart: '', dtend: '' };
  }
  const icalDate = dateOnly.replace(/-/g, '');

  const startParsed = parseTime12(startTimeStr);
  if (!startParsed) {
    // All-day event fallback
    return { allDay: true, dtstart: icalDate, dtend: icalDate };
  }

  const startVal = formatICalDateTime(dateOnly, startTimeStr);

  let endVal;
  const endParsed = parseTime12(endTimeStr);
  if (!endParsed) {
    // Default 4-hour duration
    const endH = (startParsed.hours + 4) % 24;
    const nextDay = startParsed.hours + 4 >= 24;
    const endDate = nextDay ? nextDateStr(dateOnly) : dateOnly;
    endVal = `${endDate.replace(/-/g, '')}T${String(endH).padStart(2, '0')}${String(startParsed.minutes).padStart(2, '0')}00`;
  } else {
    const startMinutes = startParsed.hours * 60 + startParsed.minutes;
    const endMinutes = endParsed.hours * 60 + endParsed.minutes;
    if (endMinutes <= startMinutes) {
      // Overnight shift — end is next day
      const nextDay = nextDateStr(dateOnly);
      endVal = formatICalDateTime(nextDay, endTimeStr);
    } else {
      endVal = formatICalDateTime(dateOnly, endTimeStr);
    }
  }

  return { allDay: false, dtstart: startVal, dtend: endVal };
}

/** "2026-03-28" → "2026-03-29" */
function nextDateStr(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Format a JS Date/timestamp as iCal UTC timestamp: "20260328T170000Z" */
function toICalUTC(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Derive SEQUENCE from updated_at (epoch seconds, clamped to positive int) */
function toSequence(updatedAt) {
  if (!updatedAt) return 0;
  return Math.floor(new Date(updatedAt).getTime() / 1000);
}

// ─── iCal text helpers ────────────────────────────────────────────

/** Escape text for iCal property values */
function escapeICalText(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').replace(/\r/g, '');
}

/** Fold lines longer than 75 octets per RFC 5545 */
function foldLine(line) {
  const MAX = 75;
  if (Buffer.byteLength(line, 'utf8') <= MAX) return line;
  const parts = [];
  let remaining = line;
  let first = true;
  while (Buffer.byteLength(remaining, 'utf8') > MAX) {
    // For continuation lines, account for leading space
    const limit = first ? MAX : MAX - 1;
    let cut = limit;
    // Find a safe cut point (don't split multi-byte chars)
    while (cut > 0 && Buffer.byteLength(remaining.slice(0, cut), 'utf8') > limit) cut--;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    first = false;
  }
  if (remaining) parts.push(remaining);
  return parts.join('\r\n ');
}

/** Build a property line with folding */
function icalProp(name, value) {
  return foldLine(`${name}:${value}`);
}

// ─── Team list builder ────────────────────────────────────────────

/**
 * Fetch approved team members for a set of shift IDs.
 * Returns Map<shiftId, Array<{ user_id, name, position }>>
 */
async function fetchTeamsByShiftIds(shiftIds) {
  if (!shiftIds.length) return new Map();
  const result = await pool.query(`
    SELECT sr.shift_id, sr.user_id, sr.position,
      COALESCE(cp.preferred_name, u.email) AS name
    FROM shift_requests sr
    JOIN users u ON u.id = sr.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    WHERE sr.shift_id = ANY($1) AND sr.status = 'approved' AND sr.dropped_at IS NULL
    ORDER BY name ASC
  `, [shiftIds]);

  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.shift_id)) map.set(row.shift_id, []);
    map.get(row.shift_id).push(row);
  }
  return map;
}

/**
 * Format the team bullet list for an iCal description. currentUserId moves that
 * user to the top. Returns only the `• Name — Position` lines joined by REAL
 * newlines (single \n) — each description builder supplies its own header
 * ("Team:" admin-side, "Dr. Bartender Team:" staff-side) and lets escapeICalText
 * do the escaping. Joining with a literal '\\n' here was the double-escape bug.
 */
function formatTeamList(team, currentUserId) {
  if (!team || !team.length) return '';
  const sorted = [...team];
  if (currentUserId) {
    const me = sorted.findIndex(t => t.user_id === currentUserId);
    if (me > -1) {
      const [mine] = sorted.splice(me, 1);
      mine.name = `You (${mine.name})`;
      sorted.unshift(mine);
    }
  }
  return sorted.map(t => `• ${t.name} — ${t.position || 'Staff'}`).join('\n');
}

// ─── iCal document builder ────────────────────────────────────────

function buildICalFeed(events, calName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dr. Bartender//Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    icalProp('X-WR-CALNAME', escapeICalText(calName)),
    'X-WR-TIMEZONE:America/Chicago',
  ];

  for (const evt of events) {
    const times = buildEventTimes(evt.event_date, evt.start_time, evt.end_time);
    if (!times.dtstart || !times.dtend) continue; // skip events with unparseable dates

    lines.push('BEGIN:VEVENT');
    lines.push(icalProp('UID', `shift-${evt.id}@drbartender.com`));
    lines.push(icalProp('DTSTAMP', toICalUTC(new Date())));
    if (evt.updated_at) lines.push(icalProp('LAST-MODIFIED', toICalUTC(evt.updated_at)));
    lines.push(icalProp('SEQUENCE', String(toSequence(evt.updated_at))));

    if (times.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${times.dtstart}`);
      lines.push(`DTEND;VALUE=DATE:${times.dtend}`);
    } else {
      lines.push(`DTSTART;TZID=America/Chicago:${times.dtstart}`);
      lines.push(`DTEND;TZID=America/Chicago:${times.dtend}`);
    }

    lines.push(icalProp('SUMMARY', escapeICalText(evt.summary)));
    if (evt.location) lines.push(icalProp('LOCATION', escapeICalText(evt.location)));
    if (evt.description) lines.push(icalProp('DESCRIPTION', escapeICalText(evt.description)));
    lines.push(icalProp('STATUS', evt.cancelled ? 'CANCELLED' : 'CONFIRMED'));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ─── Description builders ─────────────────────────────────────────

function trimNotes(notes, maxLen = 500) {
  if (!notes) return '';
  return notes.length > maxLen ? notes.slice(0, maxLen) + '…' : notes;
}

/** Filter falsy, join with the middle-dot separator; null when nothing remains. */
function joinDot(items) {
  const parts = items.filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Render a minutes-of-day value as a 12-hour clock ("13:00" → "1:00 PM"). */
function fmt12(totalMin, withPeriod = true) {
  const m = ((totalMin % 1440) + 1440) % 1440;
  const period = Math.floor(m / 60) >= 12 ? 'PM' : 'AM';
  let h = Math.floor(m / 60) % 12;
  if (h === 0) h = 12;
  const base = `${h}:${String(m % 60).padStart(2, '0')}`;
  return withPeriod ? `${base} ${period}` : base;
}

/**
 * "Setup 1:00 PM · Service 2:00–6:00 PM" from setup_minutes_before/start/end.
 * Returns null when the start time is unparseable (so the line is skipped).
 * Setup is derived by subtracting setup_minutes_before (default 60) from start.
 */
function serviceWindow(shift) {
  const start = parseTime12(shift.start_time);
  if (!start) return null;
  const startMin = start.hours * 60 + start.minutes;
  const parts = [];
  const setupMin = Number(shift.setup_minutes_before ?? 60);
  if (Number.isFinite(setupMin) && setupMin > 0) parts.push(`Setup ${fmt12(startMin - setupMin)}`);
  const end = parseTime12(shift.end_time);
  if (end) {
    const endMin = end.hours * 60 + end.minutes;
    const samePeriod = (start.hours >= 12) === (end.hours >= 12);
    parts.push(`Service ${fmt12(startMin, !samePeriod)}–${fmt12(endMin)}`);
  } else {
    parts.push(`Service ${fmt12(startMin)}`);
  }
  return parts.join(' · ');
}

function buildAdminDescription(shift, teamList) {
  const money = shift.proposal_total ? `Total: $${Number(shift.proposal_total).toLocaleString()}` : null;
  const balance = (shift.proposal_total ?? null) === null ? null
    : (Number(shift.amount_paid || 0) >= Number(shift.proposal_total)
        ? 'Balance: paid'
        : `Balance: $${(Number(shift.proposal_total) - Number(shift.amount_paid || 0)).toLocaleString()}`);
  const notes = trimNotes(shift.notes);
  const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
  const lines = [
    joinDot([shift.guest_count && `Guests: ${shift.guest_count}`, money, balance]),
    joinDot([shift.client_name && `Client: ${shift.client_name}`, shift.client_phone, shift.client_email]),
    shift.location && `Venue: ${shift.location}`,
    serviceWindow(shift),
    teamList && `\nTeam:\n${teamList}`,
    notes && `\nNotes: ${notes}`,
    `\nOpen in OS: ${clientUrl}/events/shift/${shift.id}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildStaffDescription(shift, teamList) {
  const parts = [];
  if (shift.position) parts.push(`Position: ${shift.position}`);
  if (shift.start_time) {
    const timeLine = shift.end_time ? `${shift.start_time} – ${shift.end_time}` : shift.start_time;
    parts.push(timeLine);
  }
  if (teamList) { parts.push(''); parts.push(`Dr. Bartender Team:\n${teamList}`); }
  const notes = trimNotes(shift.notes);
  if (notes) { parts.push(''); parts.push(`Notes: ${notes}`); }
  return parts.join('\n');
}

// ─── Routes ───────────────────────────────────────────────────────

/** GET /api/calendar/feed/:token — iCal feed (public, token-gated) */
router.get('/feed/:token', requireUuidToken('token', 'Calendar feed not found'), calendarLimiter, asyncHandler(async (req, res) => {
  // Look up user by calendar token
  const userRes = await pool.query(
    'SELECT id, role FROM users WHERE calendar_token = $1',
    [req.params.token]
  );
  if (!userRes.rows[0]) throw new NotFoundError('Calendar feed not found');
  const user = userRes.rows[0];
  const isAdmin = user.role === 'admin' || user.role === 'manager';

  let shifts;
  if (isAdmin) {
    // Admin feed: all shifts within feed window, with client details.
    // 30-day backward cutoff added so subscribed calendars retain a small
    // tail of recent events for reference but don't redownload years of
    // history on every refresh.
    const result = await pool.query(`
      SELECT s.*,
        c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
        p.total_price AS proposal_total, p.amount_paid, p.guest_count
      FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE s.event_date >= CURRENT_DATE - INTERVAL '30 days'
        AND s.event_date <= CURRENT_DATE + INTERVAL '365 days'
      ORDER BY s.event_date ASC
    `);
    shifts = result.rows;
  } else {
    // Staff feed: only their approved shift requests.
    // 30-day backward cutoff matches admin feed.
    // Project drink_plans.finalized_at (latest, in case >1 plan per proposal —
    // schema allows it) so buildBeoConfirmVEvents can emit reminders for
    // BEO-finalized-but-not-yet-acked shifts. LEFT JOIN proposals + clients
    // for the BEO summary's client_name. Subquery (not LEFT JOIN) on
    // drink_plans avoids row-multiplication that would duplicate VEVENTs.
    const result = await pool.query(`
      SELECT s.*, sr.position,
        sr.status AS request_status,
        sr.beo_acknowledged_at,
        (SELECT MAX(dp.finalized_at)
           FROM drink_plans dp
          WHERE dp.proposal_id = s.proposal_id) AS finalized_at,
        COALESCE(c.name, s.client_name) AS client_name
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE sr.user_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
        AND s.event_date >= CURRENT_DATE - INTERVAL '30 days'
        AND s.event_date <= CURRENT_DATE + INTERVAL '365 days'
      ORDER BY s.event_date ASC
    `, [user.id]);
    shifts = result.rows;
  }

  // Fetch team data for all shifts
  const shiftIds = shifts.map(s => s.id);
  const teamsMap = await fetchTeamsByShiftIds(shiftIds);

  // Compute ETag and Last-Modified from latest updated_at
  let latestUpdate = null;
  for (const s of shifts) {
    if (s.updated_at && (!latestUpdate || new Date(s.updated_at) > latestUpdate)) {
      latestUpdate = new Date(s.updated_at);
    }
  }

  // Build events
  const events = shifts.map(s => {
    const team = teamsMap.get(s.id) || [];
    const teamStr = formatTeamList(team, isAdmin ? null : user.id);

    let summary, description;
    const eventTypeLabel = getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom });
    if (isAdmin) {
      summary = s.client_name ? `${s.client_name} — ${eventTypeLabel}` : eventTypeLabel;
      description = buildAdminDescription(s, teamStr);
    } else {
      summary = `Bartending — ${eventTypeLabel}`;
      description = buildStaffDescription(s, teamStr);
    }

    return {
      id: s.id,
      event_date: s.event_date,
      start_time: s.start_time,
      end_time: s.end_time,
      location: s.location,
      updated_at: s.updated_at,
      summary,
      description,
      cancelled: s.status === 'closed' || s.status === 'cancelled',
    };
  });

  const calName = isAdmin ? 'Dr. Bartender Events' : 'My Shifts — Dr. Bartender';
  let ical = buildICalFeed(events, calName);

  // BEO-confirm reminder VEVENTs — staff-side only. Admins don't ack BEOs,
  // so the admin feed never gets these. Spliced in just before END:VCALENDAR
  // so the calendar stays well-formed.
  if (!isAdmin) {
    const portalBaseUrl = process.env.STAFF_URL || 'https://staff.drbartender.com';
    const beoConfirmVEvents = buildBeoConfirmVEvents(shifts, portalBaseUrl);
    if (beoConfirmVEvents.length) {
      const beoBlock = beoConfirmVEvents.join('\r\n') + '\r\n';
      ical = ical.replace('END:VCALENDAR\r\n', `${beoBlock}END:VCALENDAR\r\n`);
    }
  }

  // Set headers
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="dr-bartender.ics"');
  res.set('Cache-Control', 'private, max-age=300');
  if (latestUpdate) {
    res.set('ETag', `"${latestUpdate.getTime()}"`);
    res.set('Last-Modified', latestUpdate.toUTCString());
  }

  res.send(ical);

  // Debounced last_ics_fetch_at + calendar-app detection. Fire-and-forget
  // AFTER res.send so a failed UPDATE never breaks feed delivery. Bounded by
  // a 10-minute window in SQL — most subscribed clients refresh every 15min
  // to an hour, so we end up with ~one stamp per real subscription cycle.
  try {
    const detectedApp = detectCalendarApp(req.get('User-Agent'));
    // Fire-and-forget; explicit no-await + .catch keeps a slow UPDATE from
    // blocking the response and a thrown error from becoming an unhandled
    // rejection.
    pool.query(
      `UPDATE users
          SET last_ics_fetch_at = NOW(),
              ui_preferences = jsonb_set(ui_preferences, '{calendar_subscribed_app}', $2::jsonb, true)
        WHERE id = $1
          AND (last_ics_fetch_at IS NULL OR last_ics_fetch_at < NOW() - INTERVAL '10 minutes')`,
      [user.id, JSON.stringify(detectedApp)]
    ).catch(() => { /* best-effort; never break feed */ });
  } catch { /* best-effort; never break feed */ }
}));

/** GET /api/calendar/event/:shiftId.ics — single event download (auth required) */
router.get('/event/:shiftId.ics', auth, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.shiftId, 10);
  // `:shiftId.ics` captures everything before `.ics`; a non-numeric path (foo.ics) yields
  // NaN, which casts-and-throws (22P02) into a 500. Reject it as a clean 404 first.
  if (!Number.isFinite(shiftId)) throw new NotFoundError('Event not found');
  const isAdmin = req.user.role === 'admin' || req.user.role === 'manager';

  // Verify access
  if (!isAdmin) {
    const check = await pool.query(
      "SELECT id FROM shift_requests WHERE shift_id = $1 AND user_id = $2 AND status = 'approved' AND dropped_at IS NULL",
      [shiftId, req.user.id]
    );
    if (!check.rows[0]) throw new PermissionError('Access denied');
  }

  // Fetch shift
  const result = await pool.query(`
    SELECT s.*,
      c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
      p.total_price AS proposal_total, p.amount_paid, p.guest_count,
      sr.position
    FROM shifts s
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN shift_requests sr ON sr.shift_id = s.id AND sr.user_id = $2 AND sr.status = 'approved' AND sr.dropped_at IS NULL
    WHERE s.id = $1
  `, [shiftId, req.user.id]);

  if (!result.rows[0]) throw new NotFoundError('Shift not found');
  const s = result.rows[0];

  // Fetch team
  const teamsMap = await fetchTeamsByShiftIds([shiftId]);
  const team = teamsMap.get(shiftId) || [];
  const teamStr = formatTeamList(team, isAdmin ? null : req.user.id);

  let summary, description;
  const eventTypeLabel = getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom });
  if (isAdmin) {
    summary = s.client_name ? `${s.client_name} — ${eventTypeLabel}` : eventTypeLabel;
    description = buildAdminDescription(s, teamStr);
  } else {
    summary = `Bartending — ${eventTypeLabel}`;
    description = buildStaffDescription(s, teamStr);
  }

  const event = {
    id: s.id,
    event_date: s.event_date,
    start_time: s.start_time,
    end_time: s.end_time,
    location: s.location,
    updated_at: s.updated_at,
    summary,
    description,
    cancelled: s.status === 'closed' || s.status === 'cancelled',
  };

  const ical = buildICalFeed([event], 'Dr. Bartender');
  const eventTypeLabelFn = getEventTypeLabel({ event_type: s.event_type, event_type_custom: s.event_type_custom });
  const filename = eventTypeLabelFn.replace(/[^a-zA-Z0-9 -]/g, '').replace(/\s+/g, '-').toLowerCase();

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}.ics"`);
  res.send(ical);
}));

/** GET /api/calendar/token — get current user's feed URL */
router.get('/token', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT calendar_token FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!result.rows[0]) throw new NotFoundError('User not found');

  const token = result.rows[0].calendar_token;
  // Build the feed URL using the server's own origin
  const apiBase = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
  const feedUrl = `${apiBase}/api/calendar/feed/${token}`;

  res.json({ token, feed_url: feedUrl });
}));

/** POST /api/calendar/token/regenerate — regenerate feed URL */
router.post('/token/regenerate', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'UPDATE users SET calendar_token = gen_random_uuid(), calendar_token_created_at = NOW() WHERE id = $1 RETURNING calendar_token',
    [req.user.id]
  );
  if (!result.rows[0]) throw new NotFoundError('User not found');

  const token = result.rows[0].calendar_token;
  const apiBase = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
  const feedUrl = `${apiBase}/api/calendar/feed/${token}`;

  res.json({ token, feed_url: feedUrl });
}));

module.exports = router;
