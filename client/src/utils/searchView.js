// The phone global search's model (spec 2026-08-13-mobile-admin section 6
// and the 2026-09-15 Global search line; benchmark
// docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html, Global search;
// lane ma-f3). Pure: GET /admin/search's groups in, what the screen draws and
// where each row leads out. Class names live in SearchPhone.js, which the
// class contract test reads; this file has none.
import { railParts } from './eventCards';
import { proposalStatusMeta } from './proposalStatusMap';

// The endpoint's own bounds (server/utils/globalSearch.js): a trimmed term
// under 2 or over 100 characters gets empty groups without a query, and a
// group holds at most 6 rows, so a group of 6 may have more behind it.
export const MIN_TERM = 2;
export const MAX_TERM = 100;
export const GROUP_LIMIT = 6;

export function termState(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 'empty';
  if (t.length < MIN_TERM) return 'short';
  if (t.length > MAX_TERM) return 'long';
  return 'ok';
}

// Two letters at most, so any name fits the 34px tile (the benchmark joins
// every word's first letter).
export function initialsOf(name) {
  return String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => Array.from(w)[0]).join('').toUpperCase();
}

// The palette's order (CommandPalette.js RECORD_GROUPS).
const GROUPS = [
  { key: 'clients', label: 'Clients' },
  { key: 'proposals', label: 'Proposals' },
  { key: 'events', label: 'Events' },
  { key: 'staff', label: 'Staff' },
];

// Where a row leads, and the screen key it opens in desktop view for that
// visit only (MobileViewContext's setDesktopForVisit; the key is the one
// routeScreenKey gives the path; null opens in the phone chrome). Clients and
// staff have no phone screen, so the benchmark's Desktop tag opens their page
// in the desktop chrome. An event opens the phone event detail; a proposal
// opens the desktop proposal page inside the phone chrome until lane ma-f2
// draws the phone detail.
export function rowTarget(groupKey, id) {
  switch (groupKey) {
    case 'clients': return { path: `/clients/${id}`, screenKey: 'clients' };
    case 'staff': return { path: `/staffing/users/${id}`, screenKey: 'staffing' };
    case 'proposals': return { path: `/proposals/${id}`, screenKey: null };
    case 'events': return { path: `/events/${id}`, screenKey: null };
    default: return null;
  }
}

// A full group's More row opens the group's desktop list in desktop view,
// for that visit only (spec section 6). Only the desktop Proposals list takes
// a text filter (?q=, matched on the client's name and email); Events and
// Staff open on All because the search spans past events and every staff
// state.
export function moreTarget(groupKey, term) {
  switch (groupKey) {
    case 'clients': return { path: '/clients', screenKey: 'clients' };
    case 'proposals': return { path: `/proposals?q=${encodeURIComponent(String(term ?? '').trim())}`, screenKey: 'proposals-list' };
    case 'events': return { path: '/events?tab=all', screenKey: 'events-list' };
    case 'staff': return { path: '/staffing?tab=all', screenKey: 'staffing' };
    default: return null;
  }
}

// A booked event with no date keeps its rail, an en dash in the day slot
// (the Proposals list's rule).
function railLead(eventDate) {
  const ymd = eventDate ? String(eventDate).slice(0, 10) : '';
  const parts = ymd ? railParts(ymd) : null;
  if (parts && parts.day) return { kind: 'rail', rail: parts, noDate: false };
  return { kind: 'rail', rail: { dow: '', day: '–', mon: '' }, noDate: true };
}

// "Oct 24, 2026" from a YYYY-MM-DD, noon-anchored like railParts; '' for no
// date or one that does not parse.
function dateLabel(eventDate) {
  const ymd = eventDate ? String(eventDate).slice(0, 10) : '';
  const d = ymd ? new Date(`${ymd}T12:00:00`) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// One row. The kind sits on its own line under the name (Dallas, 2026-09-24,
// on the card family): a proposal shows the kind, then its date; an event
// shows the kind, its date being on the rail. A server that has not shipped
// the kind yet sends only the palette's detail ("kind · date"), which then
// stands in as the one meta line.
export function searchRow(groupKey, item) {
  const target = rowTarget(groupKey, item.id);
  if (!target) return null;
  const base = {
    key: `${groupKey}-${item.id}`,
    title: item.name || '',
    target,
    desktop: Boolean(target.screenKey),
    chip: null,
    kind: '',
  };
  if (groupKey === 'clients') {
    return { ...base, lead: { kind: 'icon', icon: 'users' }, meta: item.detail || '' };
  }
  if (groupKey === 'proposals') {
    const status = item.status ? proposalStatusMeta(item.status) : null;
    return {
      ...base,
      lead: { kind: 'icon', icon: 'clipboard' },
      kind: item.kind || '',
      meta: item.kind ? dateLabel(item.event_date) : item.detail || '',
      chip: status ? { label: status.label, kind: status.kind } : null,
    };
  }
  if (groupKey === 'events') {
    return {
      ...base,
      lead: railLead(item.event_date),
      kind: item.kind || '',
      meta: item.kind ? '' : item.detail || '',
    };
  }
  return { ...base, lead: { kind: 'initials', initials: initialsOf(item.name) }, meta: item.detail || '' };
}

export function searchGroups(results, term) {
  if (!results) return [];
  return GROUPS.map((g) => {
    const items = Array.isArray(results[g.key]) ? results[g.key] : [];
    const rows = items.map((it) => searchRow(g.key, it)).filter(Boolean);
    const full = rows.length >= GROUP_LIMIT;
    return {
      key: g.key,
      label: g.label,
      rows,
      full,
      count: full ? `${rows.length}+` : String(rows.length),
      moreLabel: `More ${g.label.toLowerCase()} on desktop`,
      more: full ? moreTarget(g.key, term) : null,
    };
  }).filter((g) => g.rows.length > 0);
}

// What went wrong, from the normalized error (utils/api.js): no response at
// all (offline, refused, the timeout) is status 0; the limiter answers 429.
export function errorKind(err) {
  const status = err && err.status;
  if (!status) return 'network';
  return status === 429 ? 'rate' : 'server';
}

// The one note under the field, in the benchmark's order. The copy is the
// benchmark's, word for word, except the failed-search notes, which the
// benchmark does not draw. They use the screen's own words rather than the
// server's message: the limiter's message says what the rate note says, and
// a 500's is the generic server line.
export function searchNote({ raw, offline, error, pending, resultsFor, groups }) {
  const t = String(raw ?? '').trim();
  const state = termState(t);
  if (offline) {
    return {
      icon: 'search', title: 'Search needs the server',
      body: 'Global search runs a live query. Nothing is cached on the phone. Reconnect to search.',
      micro: 'offline · field kept, results off', retry: false,
    };
  }
  if (state === 'long') {
    return {
      icon: 'x', title: 'Too long to search', body: 'The server stops at 100 characters. Trim the term down.',
      micro: `${t.length} characters`, retry: false,
    };
  }
  if (state === 'empty') {
    return {
      icon: 'search', title: 'Search every record',
      body: 'Clients, proposals, events and staff, by name, email, or phone number.',
      micro: 'phone match needs 3+ digits', retry: false,
    };
  }
  if (state === 'short') {
    return { icon: 'search', title: 'Keep typing', body: 'Nothing is searched until two characters.', micro: '', retry: false };
  }
  if (error && error.term === t) {
    if (error.kind === 'rate') {
      return { icon: 'clock', title: 'Too many searches', body: 'Wait a minute, then try again.', micro: '', retry: true };
    }
    if (error.kind === 'server') {
      return { icon: 'alert', title: 'Search failed', body: 'The server couldn’t run this search. Try again in a moment.', micro: '', retry: true };
    }
    return { icon: 'alert', title: 'Search didn’t answer', body: 'Check the signal, then try again.', micro: '', retry: true };
  }
  if (!pending && resultsFor === t && (!groups || groups.length === 0)) {
    return {
      icon: 'search', title: `No matches for “${t}”`,
      body: 'Try a last name, an email address, or the last four digits of a phone.', micro: '', retry: false,
    };
  }
  return null;
}

export function flightLabel(resultsFor) {
  return resultsFor ? `searching · showing “${resultsFor}”` : 'searching…';
}

// What the polite status line says.
export function liveSummary({ pending, note, groups }) {
  if (pending) return 'Searching';
  if (note) return note.title;
  const n = (groups || []).reduce((sum, g) => sum + g.rows.length, 0);
  if (!n) return '';
  const more = groups.some((g) => g.full);
  return `${n}${more ? '+' : ''} ${n === 1 && !more ? 'result' : 'results'}`;
}
