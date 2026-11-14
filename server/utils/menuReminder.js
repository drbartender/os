// When an unanswered menu proof comes back to the Inbox (spec 2026-10-19 section 13.3, decision 11):
// menuReminderDueAt, a pure function of the proof's send time and the event date, in Chicago business time.
//
// The days between the send and the event are counted between calendar dates
// in Chicago (the send's Chicago date, never its GMT date, which is already
// tomorrow on a Chicago evening):
//   8 or more days out: 9:00 a.m. Chicago on the day a week before the event
//                       (Dallas: "a week out in my inbox is fine");
//   3 to 7 days out:    a day after the send;
//   2 or fewer:         at once (the send time itself);
//   no event date:      a day after the send.
// The Inbox reader (server/utils/inbox/readMenuTasks.js) computes it from the
// latest proof's sent_at, so approving again restarts the clock. An input it
// cannot read throws: a guessed time would open or hide a task wrongly.

const { chicagoYmdOf, eventLocalToUtc } = require('./businessTime');

const DAY_MS = 24 * 3600 * 1000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A YYYY-MM-DD that names a real calendar date, as days since the epoch; null otherwise.
function ymdDays(ymd) {
  const m = typeof ymd === 'string' ? YMD_RE.exec(ymd) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

function ymdOfDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant an unanswered proof sent at `sentAt` (a Date or anything
 * new Date() reads) falls due in the Inbox, for an event on `eventDate`
 * ('YYYY-MM-DD', or null/undefined when the event has no date).
 * @returns {Date}
 */
function menuReminderDueAt({ sentAt, eventDate } = {}) {
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt === null || sentAt === undefined ? NaN : sentAt);
  if (!Number.isFinite(sent.getTime())) throw new Error('menuReminderDueAt: sentAt is not a time');
  const dayAfter = new Date(sent.getTime() + DAY_MS);
  if (eventDate === null || eventDate === undefined) return dayAfter;
  const eventDays = ymdDays(eventDate);
  if (eventDays === null) throw new Error('menuReminderDueAt: eventDate is not a YYYY-MM-DD date');
  const days = eventDays - ymdDays(chicagoYmdOf(sent));
  if (days >= 8) return eventLocalToUtc(ymdOfDays(eventDays - 7), 9, 0, 'America/Chicago');
  if (days >= 3) return dayAfter;
  return new Date(sent.getTime());
}

module.exports = { menuReminderDueAt };
