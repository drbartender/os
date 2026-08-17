import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt$, fmtDate, dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';

// Pure item builders + tab assembly for the Needs-attention tabbed card
// (spec 2026-07-14 §2-§3). Every builder returns rows in the queue-item
// contract ({id,type,priority,title,sub,meta,target,ref}) that NeedsYouStrip
// renders. buildPrepItems intentionally stays in PrepQueue.js.

const RANK = { danger: 0, warn: 1, info: 2 };

// How far out a dated staffing row is still "needs attention" (2026-08-17).
// Past this the work is real but not yet actionable-today, and it was burying
// the rows that are; /events remains the full forward view.
const STAFFING_HORIZON_DAYS = 14;

// Per-tab overflow row targets (spec §3): each tab's home surface.
const OVERFLOW_HREF = {
  staffing: '/events',
  prep: '/drink-plans?tab=submitted',
  clients: '/messages',
  sales: '/proposals?tab=active',
};

// Real-link target for a needs-attention queue item. Entity-backed items get a
// canonical link (cmd-click opens a new tab); hiring and other targetless items
// return null and stay plain text (the row onClick still navigates).
//
// Lives here rather than in NeedsYouStrip so the pure queue-item contract and
// the function that maps it to a URL sit together, and so its test does not have
// to import a component that transitively pulls in react-router and axios.
export function queueItemHref(a) {
  if (a.target === 'event') return `/events/${a.ref}`;
  if (a.target === 'shift') return `/events/shift/${a.ref}`;
  if (a.target === 'proposal') return `/proposals/${a.ref}`;
  if (a.target === 'client') return `/clients/${a.ref}`;
  if (a.target === 'drink-plan') return `/drink-plans/${a.ref}`;
  if (a.target === 'sms') return `/messages?client=${a.ref}`;
  if (a.target === 'user') return `/staffing/users/${a.ref}`;
  return null;
}

const worstPriority = (items) =>
  items.reduce((w, i) => (w === null || (RANK[i.priority] ?? 3) < RANK[w] ? i.priority : w), null);

// Unstaffed upcoming events inside the staffing horizon (uncapped within it;
// the tab caps at render) plus the new-applications rollup. `unstaffed` is
// OverviewPage's derived list, which still runs to the end of the calendar —
// the horizon is a display cut here, not a change to that list, so the page
// header's "N need staff" count still reports the true total.
export function buildStaffingItems(unstaffed, newApplications, uncertified = [], nameNotices = [], onAck) {
  const items = (unstaffed || []).map(e => ({ e, days: dayDiff(e.event_date.slice(0, 10)) }))
    .filter(({ days }) => days <= STAFFING_HORIZON_DAYS)
    .map(({ e, days }) => {
      const open = parsePositionsCount(e) - approvedCount(e);
      return {
        id: 'unstaffed-' + e.id, type: 'unstaffed', priority: days < 7 ? 'danger' : 'warn',
        title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
        sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
        meta: `${open} open`, target: e.proposal_id ? 'event' : 'shift', ref: e.proposal_id || e.id,
      };
    });
  if (newApplications > 0) {
    items.push({
      id: 'apps', type: 'application', priority: 'info',
      title: `${newApplications} new ${newApplications === 1 ? 'application' : 'applications'}`,
      sub: 'Review in hiring', meta: `${newApplications} new`, target: 'hiring', ref: null,
    });
  }

  // One row per person, each linking to their own detail page. A single
  // "N workers uncertified" row would link to /hiring, whose list INNER JOINs
  // applications and therefore omits every direct hire this is for.
  //
  // Scoped to the certification among staffable people only. Including the
  // resume, or every onboarding status, returns ~50 rows into a 6-row strip.
  // Same horizon as the unstaffed events above, applied as an ESCALATION cut
  // rather than a filter: a booking further out than STAFFING_HORIZON_DAYS
  // stops shouting and falls back to the standing "eligible" row, so nobody
  // uncertified ever disappears from the tab.
  (uncertified || []).forEach(u => {
    const nextDay = u.next_shift_date ? String(u.next_shift_date).slice(0, 10) : null;
    const booked = !!nextDay && dayDiff(nextDay) <= STAFFING_HORIZON_DAYS;
    const day = booked ? nextDay : null;
    items.push({
      id: `uncertified-${u.user_id}`, type: 'documents',
      priority: booked ? 'danger' : 'warn',
      title: `${u.name} has no alcohol certification`,
      sub: booked
        ? `Working ${fmtDate(day)} · ${dayDiff(day)}d out`
        : 'Can be assigned to shifts',
      meta: booked ? 'booked' : 'eligible',
      target: 'user', ref: u.user_id,
    });
  });

  // Informational: a staffer told us what to call them. Usually a pleasant
  // fact, occasionally a conversation. Never blocks the name (spec 3.5).
  for (const n of nameNotices || []) {
    items.push({
      id: 'name-' + n.user_id, type: 'name-notice', priority: 'info',
      title: `${n.legal_name || 'A staffer'} goes by ${n.preferred_name}`,
      sub: `shows as ${n.display_name || n.preferred_name}`,
      meta: 'Got it', metaAction: () => onAck(n.user_id),
      target: 'user', ref: n.user_id,
    });
  }

  // Sort by urgency before returning. NeedsYouStrip renders
  // `t.items.slice(0, TAB_CAP)` in ARRAY ORDER with TAB_CAP = 6, and the RANK
  // map here was previously used only to colour the tab dot. Without this,
  // these rows are appended last and six unstaffed events push a
  // "working Saturday with no certification" row into the "N more" overflow,
  // whose href is OVERFLOW_HREF.staffing = '/events'. That is the same
  // link-to-a-page-they-are-not-on failure this surface was built to replace.
  //
  // Array.prototype.sort is stable in Node 26 and every supported browser, so
  // equal-priority rows keep their existing relative order and the pre-existing
  // unstaffed-event cases are unaffected.
  //
  // Known limit, stated rather than overclaimed: stability also means that when
  // the unstaffed events are THEMSELVES 'danger' (six or more inside 7 days), a
  // 'danger' documents row still sorts behind them and can reach the overflow.
  // Ranking documents above unstaffed at equal priority is a product call about
  // which is more urgent, not a mechanical fix, so it is deliberately not made
  // here.
  items.sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
  return items;
}

// A human is waiting on Dallas: pending change requests (danger inside the
// 14-day edit window, mirroring the server's own urgency sort) then unread
// inbound SMS. Both endpoints are admin+manager.
export function buildClientItems(changeRequests, conversations) {
  const crs = (changeRequests || []).map(r => ({
    id: 'cr-' + r.id, type: 'change-request',
    priority: r.edit_window === 'inside_t14' ? 'danger' : 'warn',
    title: `${r.client_name || r.client_email || 'Client'} requested changes`,
    sub: `${getEventTypeLabel({ event_type: r.event_type, event_type_custom: r.event_type_custom })}${r.event_date ? ' · ' + fmtDate(String(r.event_date).slice(0, 10)) : ''}`,
    meta: 'review', target: 'proposal', ref: r.proposal_id,
  }));
  const sms = (conversations || []).filter(c => Number(c.unread_count) > 0).map(c => ({
    id: 'sms-' + c.client_id, type: 'sms', priority: 'warn',
    title: `${c.name || c.phone || 'Client'} · ${c.unread_count} unread`,
    sub: 'text message', meta: String(c.unread_count), target: 'sms', ref: c.client_id,
  }));
  return [...crs, ...sms];
}

// Sent but never viewed after 72h (a viewed proposal flips to viewed/modified,
// so still-'sent' means never seen). sent_at is TIMESTAMPTZ, hence Date.parse.
// The drip covers viewed-not-accepted; this is the personal-nudge cue only.
export function buildSalesItems(proposals, nowMs) {
  const cutoff = nowMs - 72 * 3600e3;
  return (proposals || [])
    .filter(p => p.status === 'sent' && p.sent_at && Date.parse(p.sent_at) < cutoff)
    .map(p => ({
      id: 'sales-' + p.id, type: 'proposal', priority: 'info',
      title: `${p.client_name || p.client_email || 'Client'} proposal unviewed`,
      sub: `sent ${Math.floor((nowMs - Date.parse(p.sent_at)) / 86400e3)}d ago · ${getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}`,
      meta: fmt$(Number(p.total_price || 0)), target: 'proposal', ref: p.id,
    }));
}

// Lead-call attention rows from GET /admin/lead-call-attention. NARROWED
// 2026-07-20: only system-fault chains surface (the machine could not place
// calls); missed and after-hours are deliberate non-items (the moment has
// passed; follow-up rides the normal email/SMS pipeline), so at healthy
// steady state this list is empty. Rendered in the Sales tab AHEAD of the
// aging sent-proposal items (OverviewPage prepends; array order is display
// order). Targets: proposal when the auto-draft exists, else the client
// record, else a plain-text row.
const LEAD_CALL_LABELS = {
  failed: 'call failed',
  skipped_unconfigured: 'call misconfigured',
  skipped_invalid_phone: 'call misconfigured',
};

export function buildLeadCallItems(rows, nowMs) {
  return (rows || []).map(r => {
    const ageMs = Math.max(0, nowMs - Date.parse(r.created_at));
    const hours = Math.floor(ageMs / 3600e3);
    const sub = hours < 1 ? 'just now' : hours < 24 ? `${hours}h ago` : `${Math.floor(ageMs / 86400e3)}d ago`;
    return {
      id: 'leadcall-' + r.id, type: 'lead-call', priority: 'warn',
      title: `${r.customer_name || 'Thumbtack lead'} ${LEAD_CALL_LABELS[r.status] || 'call failed'}`,
      sub,
      meta: '',
      target: r.proposal_id ? 'proposal' : (r.client_id ? 'client' : null),
      ref: r.proposal_id || r.client_id || null,
    };
  });
}

// Tab descriptors for NeedsYouStrip. Sales renders only when non-empty.
//
// The Money tab was REMOVED 2026-08-17. Its only queue item was the unmatched
// Stripe payout count, which the Band 2 Payouts button already carries with
// its own badge, and its body was the payroll status block — a standing money
// surface, not a triage item. Payroll now has its own Band 1 card
// (PayrollStatus.js, mounted by OverviewPage), so the payroll-overdue signal
// no longer routes through here to colour a dot.
export function computeTabs({ staffing, prep, clients, sales }) {
  const defs = [
    { key: 'staffing', label: 'Staffing', items: staffing || [] },
    { key: 'prep', label: 'Prep', items: prep || [] },
    { key: 'clients', label: 'Clients', items: clients || [] },
  ];
  if ((sales || []).length > 0) defs.push({ key: 'sales', label: 'Sales', items: sales });
  return defs.map(t => ({
    ...t, count: t.items.length, dot: worstPriority(t.items),
    overflowHref: OVERFLOW_HREF[t.key], hasBody: t.items.length > 0,
  }));
}

// Default active tab: worst dot wins, ties break by the fixed tab order
// already encoded in the array. Nothing anywhere returns null and the card
// collapses to its one-line clean state, for admins and managers alike.
export function defaultTabKey(tabs) {
  let best = null, bestRank = Infinity;
  tabs.forEach(t => {
    if (!t.dot) return;
    if (RANK[t.dot] < bestRank) { bestRank = RANK[t.dot]; best = t.key; }
  });
  return best;
}
