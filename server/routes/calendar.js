const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// ─── Rate limiting (express-rate-limit, per-token) ───────────────
const calendarLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.params.token || req.ip });

// ─── Time parsing helpers ─────────────────────────────────────────

/**
 * Parse a 12-hour time string like "5:00 PM" into { hours, minutes }.
 * Returns null if unparseable.
 */
function parseTime12(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return { hours, minutes };
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
  const dateOnly = String(eventDate).slice(0, 10); // "YYYY-MM-DD"
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
      COALESCE(cp.preferred_name, u.first_name || ' ' || u.last_name, u.email) AS name
    FROM shift_requests sr
    JOIN users u ON u.id = sr.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    WHERE sr.shift_id = ANY($1) AND sr.status = 'approved'
    ORDER BY name ASC
  `, [shiftIds]);

  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.shift_id)) map.set(row.shift_id, []);
    map.get(row.shift_id).push(row);
  }
  return map;
}

/** Format team list for iCal description. currentUserId moves that user to top. */
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
  const lines = sorted.map(t => `• ${t.name} — ${t.position || 'Staff'}`);
  return `Dr. Bartender Team:\\n${lines.join('\\n')}`;
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
    lines.push('BEGIN:VEVENT');
    lines.push(icalProp('UID', `shift-${evt.id}@drbartender.com`));
    lines.push(icalProp('DTSTAMP', toICalUTC(new Date())));
    if (evt.updated_at) lines.push(icalProp('LAST-MODIFIED', toICalUTC(evt.updated_at)));
    lines.push(icalProp('SEQUENCE', String(toSequence(evt.updated_at))));

    const times = buildEventTimes(evt.event_date, evt.start_time, evt.end_time);
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

function buildAdminDescription(shift, teamList) {
  const parts = [];
  if (shift.client_name) parts.push(`Client: ${shift.client_name}`);
  if (shift.client_phone) parts.push(`Phone: ${shift.client_phone}`);
  if (shift.client_email) parts.push(`Email: ${shift.client_email}`);
  if (shift.guest_count) parts.push(`Guests: ${shift.guest_count}`);
  if (shift.proposal_total) parts.push(`Total: $${Number(shift.proposal_total).toLocaleString()}`);
  if (teamList) { parts.push(''); parts.push(teamList); }
  const notes = trimNotes(shift.notes);
  if (notes) { parts.push(''); parts.push(`Notes: ${notes}`); }
  return parts.join('\\n');
}

function buildStaffDescription(shift, teamList) {
  const parts = [];
  if (shift.position) parts.push(`Position: ${shift.position}`);
  if (shift.start_time) {
    const timeLine = shift.end_time ? `${shift.start_time} – ${shift.end_time}` : shift.start_time;
    parts.push(timeLine);
  }
  if (teamList) { parts.push(''); parts.push(teamList); }
  const notes = trimNotes(shift.notes);
  if (notes) { parts.push(''); parts.push(`Notes: ${notes}`); }
  return parts.join('\\n');
}

// ─── Routes ───────────────────────────────────────────────────────

/** GET /api/calendar/feed/:token — iCal feed (public, token-gated) */
router.get('/feed/:token', calendarLimiter, async (req, res) => {
  try {
    // Look up user by calendar token
    const userRes = await pool.query(
      'SELECT id, role FROM users WHERE calendar_token = $1',
      [req.params.token]
    );
    if (!userRes.rows[0]) return res.status(404).send('Not found');
    const user = userRes.rows[0];
    const isAdmin = user.role === 'admin' || user.role === 'manager';

    let shifts;
    if (isAdmin) {
      // Admin feed: all shifts within feed window, with client details
      const result = await pool.query(`
        SELECT s.*,
          c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
          p.total_price AS proposal_total, p.guest_count
        FROM shifts s
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        WHERE s.event_date <= CURRENT_DATE + INTERVAL '365 days'
        ORDER BY s.event_date ASC
      `);
      shifts = result.rows;
    } else {
      // Staff feed: only their approved shift requests
      const result = await pool.query(`
        SELECT s.*, sr.position,
          sr.status AS request_status
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        WHERE sr.user_id = $1 AND sr.status = 'approved'
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
      if (isAdmin) {
        summary = s.client_name ? `${s.event_name} — ${s.client_name}` : s.event_name;
        description = buildAdminDescription(s, teamStr);
      } else {
        summary = `Bartending — ${s.event_name}`;
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
    const ical = buildICalFeed(events, calName);

    // Set headers
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="dr-bartender.ics"');
    res.set('Cache-Control', 'private, max-age=300');
    if (latestUpdate) {
      res.set('ETag', `"${latestUpdate.getTime()}"`);
      res.set('Last-Modified', latestUpdate.toUTCString());
    }

    res.send(ical);
  } catch (err) {
    console.error('Calendar feed error:', err);
    res.status(500).send('Server error');
  }
});

/** GET /api/calendar/event/:shiftId.ics — single event download (auth required) */
router.get('/event/:shiftId.ics', auth, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.shiftId);
    const isAdmin = req.user.role === 'admin' || req.user.role === 'manager';

    // Verify access
    if (!isAdmin) {
      const check = await pool.query(
        "SELECT id FROM shift_requests WHERE shift_id = $1 AND user_id = $2 AND status = 'approved'",
        [shiftId, req.user.id]
      );
      if (!check.rows[0]) return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch shift
    const result = await pool.query(`
      SELECT s.*,
        c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
        p.total_price AS proposal_total, p.guest_count,
        sr.position
      FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN shift_requests sr ON sr.shift_id = s.id AND sr.user_id = $2 AND sr.status = 'approved'
      WHERE s.id = $1
    `, [shiftId, req.user.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Shift not found' });
    const s = result.rows[0];

    // Fetch team
    const teamsMap = await fetchTeamsByShiftIds([shiftId]);
    const team = teamsMap.get(shiftId) || [];
    const teamStr = formatTeamList(team, isAdmin ? null : req.user.id);

    let summary, description;
    if (isAdmin) {
      summary = s.client_name ? `${s.event_name} — ${s.client_name}` : s.event_name;
      description = buildAdminDescription(s, teamStr);
    } else {
      summary = `Bartending — ${s.event_name}`;
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
    const filename = s.event_name ? s.event_name.replace(/[^a-zA-Z0-9 -]/g, '').replace(/\s+/g, '-').toLowerCase() : 'event';

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}.ics"`);
    res.send(ical);
  } catch (err) {
    console.error('Calendar event download error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/calendar/token — get current user's feed URL */
router.get('/token', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT calendar_token FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    const token = result.rows[0].calendar_token;
    // Build the feed URL using the server's own origin
    const apiBase = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
    const feedUrl = `${apiBase}/api/calendar/feed/${token}`;

    res.json({ token, feed_url: feedUrl });
  } catch (err) {
    console.error('Calendar token fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/calendar/token/regenerate — regenerate feed URL */
router.post('/token/regenerate', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET calendar_token = gen_random_uuid(), calendar_token_created_at = NOW() WHERE id = $1 RETURNING calendar_token',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    const token = result.rows[0].calendar_token;
    const apiBase = process.env.RENDER_EXTERNAL_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
    const feedUrl = `${apiBase}/api/calendar/feed/${token}`;

    res.json({ token, feed_url: feedUrl });
  } catch (err) {
    console.error('Calendar token regenerate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
