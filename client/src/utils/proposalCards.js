// Turns one GET /proposals row into what the phone Proposals card shows
// (spec 2026-08-13-mobile-admin section 5; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Proposals tab).
// Pure: no React, no fetch, no clock unless the caller passes one. Lane ma-f1.
import { railParts } from './eventCards';
import { getEventTypeLabel } from './eventTypes';
import { fmt$ } from '../components/adminos/format';
import { proposalStatusMeta } from './proposalStatusMap';

// event_date is a DATE column; pg hands it over as a timestamp at the server's
// midnight, so the calendar day is the first ten characters (the desktop list
// slices the same way at admin/ProposalsDashboard.js:519).
export function ymdOf(value) {
  const s = value == null ? '' : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// Hours-grained relative time, the way the benchmark writes its meta lines
// ("viewed 5h ago", "sent 2d ago"). Days are whole 24-hour spans, not calendar
// days: the line answers "how long has this sat", not "which day".
export function agoLabel(ts, now = new Date()) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const dot = (parts) => parts.filter(Boolean).join(' · ');

// One line per pipeline stage, from the real timestamps (sent_at, last_viewed_at
// plus view_count, updated_at, created_at). The sent line reads "not opened"
// only while last_viewed_at is null: a re-send after the client opened it keeps
// last_viewed_at and view_count, so that row reads its view count instead and
// never contradicts the Unviewed chip (the route's unviewed predicate is
// last_viewed_at IS NULL AND status = 'sent'). The list card carries no
// accepted time, as the benchmark draws it; the detail's status line (lane
// ma-f2) reads accepted_at. No expiry exists on a proposal, so nothing
// "expiring" is shown.
export function proposalMeta(row, now = new Date()) {
  const ago = (ts) => agoLabel(ts, now);
  const views = Number(row.view_count || 0);
  switch (row.status) {
    case 'draft':
      return dot(['draft', row.created_at ? `created ${ago(row.created_at)}` : '']);
    case 'sent':
      return dot([
        row.sent_at ? `sent ${ago(row.sent_at)}` : 'sent',
        row.last_viewed_at ? (views > 0 ? `${views} ${views === 1 ? 'view' : 'views'}` : '') : 'not opened',
      ]);
    case 'viewed':
      return dot([
        row.last_viewed_at ? `viewed ${ago(row.last_viewed_at)}` : 'viewed',
        views > 0 ? `${views} ${views === 1 ? 'view' : 'views'}` : '',
      ]);
    case 'modified':
      return row.updated_at ? `modified by client ${ago(row.updated_at)}` : 'modified by client';
    case 'accepted': {
      const paid = Number(row.amount_paid || 0);
      return paid > 0 ? `accepted · ${fmt$(paid)} paid` : 'accepted · awaiting deposit';
    }
    default: {
      const { label } = proposalStatusMeta(row.status);
      return dot([String(label).toLowerCase(), row.updated_at ? ago(row.updated_at) : '']);
    }
  }
}

export function proposalCard(row, now = new Date()) {
  const ymd = ymdOf(row.event_date);
  const { label: chipLabel, kind: chipKind } = proposalStatusMeta(row.status);
  return {
    key: `p${row.id}`,
    id: row.id,
    ymd,
    noDate: !ymd,
    rail: ymd ? railParts(ymd) : { dow: '', day: '–', mon: '' },
    // The name comes from the client row the proposal points at, never derived.
    clientName: row.client_name || 'Unnamed client',
    kind: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
    guests: row.guest_count == null ? null : Number(row.guest_count),
    meta: proposalMeta(row, now),
    total: row.total_price == null ? '' : fmt$(row.total_price),
    chipLabel,
    chipKind,
  };
}
