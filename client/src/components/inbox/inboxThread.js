import { chicagoDay, chicagoTime, chicagoDayLabel } from '../../utils/chicagoDay';
import { channelLabel, threadChannel } from './inboxFormat';

// The thread's view model (spec section 4.2 Messages): oldest first, a day
// separator whenever the Chicago day changes, each bubble with its channel
// tag, Chicago time and, on our side, its author. System rows carry their
// own copy in `text`, composed by the server for the viewer (the mail lines
// "Auto-reply received", "Auto-reply sent" for our own, "Email bounced" and
// "Closed their inquiry on Zola." among them). A mail row adds its attachment
// count, and an inbound one its subject (our replies carry none).

// Our Gmail replies arrive with author_name null, as a Thumbtack Business
// row does, and by_email set (spec 2026-10-14 section 4.2): "by email"
// stands where an author would, never "Auto".
function authorOf(row) {
  if (row.auto) return 'Auto';
  if (row.author_name) return row.author_name;
  return row.by_email ? 'by email' : null;
}

// "1 attachment", "3 attachments": a count, never a name or a link.
function attachmentLine(row) {
  const n = Math.max(0, Math.floor(Number(row.attachments) || 0));
  if (n === 0) return null;
  return n === 1 ? '1 attachment' : `${n} attachments`;
}

// https only: a javascript: or data: URL is never a link (the server sends
// https media links; this holds even if one ever does not).
const HTTPS = /^https:\/\//i;

function mediaOf(row) {
  return (row.media || [])
    .filter((m) => m && typeof m.url === 'string' && HTTPS.test(m.url))
    .map((m, i) => ({
      key: `${row.ref}-m${i}`,
      url: m.url,
      label: /^image\//.test(m.content_type || '') ? 'Photo' : 'Attachment',
    }));
}

export function threadModel(thread, nowMs) {
  const rows = (thread || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const now = new Date(nowMs);
  const out = [];
  let lastDay = null;
  for (const row of rows) {
    const day = chicagoDay(row.at);
    if (day && day !== lastDay) {
      out.push({ type: 'day', key: `day-${day}`, label: chicagoDayLabel(row.at, now) });
      lastDay = day;
    }
    if (row.direction === 'system') {
      // A proposal send whose email and text both failed is a system line
      // that never arrived: it says so, like a failed bubble.
      out.push({ type: 'sys', key: row.ref, text: row.text || '', failure: row.failed ? (row.failure_reason || 'Not delivered') : null });
      continue;
    }
    const isOut = row.direction === 'out';
    const time = chicagoTime(row.at);
    const author = isOut ? authorOf(row) : null;
    const media = mediaOf(row);
    const attachments = attachmentLine(row);
    let body = row.text || '';
    if (!body && media.length === 0 && !attachments) body = '(no text)';
    out.push({
      type: 'msg',
      key: row.ref,
      out: isOut,
      tag: channelLabel(threadChannel(row)),
      meta: [author, time].filter(Boolean).join(' · '),
      subject: row.subject || null,
      body,
      media,
      attachments,
      relay: row.relay_lead_name ? `Thumbtack relay for ${row.relay_lead_name}` : null,
      failed: isOut && !!row.failed,
      failure: isOut && row.failed ? (row.failure_reason ? `Not delivered: ${row.failure_reason}` : 'Not delivered') : null,
    });
  }
  return out;
}
