import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt$, fmtDate, dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';

// Pure item builders + tab assembly for the Needs-attention tabbed card
// (spec 2026-07-14 §2-§3). Every builder returns rows in the queue-item
// contract ({id,type,priority,title,sub,meta,target,ref}) that NeedsYouStrip
// renders. buildPrepItems intentionally stays in PrepQueue.js.

const RANK = { danger: 0, warn: 1, info: 2 };

// Per-tab overflow row targets (spec §3): each tab's home surface.
const OVERFLOW_HREF = {
  staffing: '/events',
  prep: '/drink-plans?tab=submitted',
  clients: '/messages',
  money: '/dashboard?tab=payouts',
  sales: '/proposals?tab=active',
};

const worstPriority = (items) =>
  items.reduce((w, i) => (w === null || (RANK[i.priority] ?? 3) < RANK[w] ? i.priority : w), null);

// Unstaffed upcoming events (uncapped; the tab caps at render) plus the
// new-applications rollup. `unstaffed` is OverviewPage's derived list.
export function buildStaffingItems(unstaffed, newApplications) {
  const items = (unstaffed || []).map(e => {
    const open = parsePositionsCount(e) - approvedCount(e);
    const days = dayDiff(e.event_date.slice(0, 10));
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

export function buildMoneyItems(payoutBadge) {
  if (!payoutBadge) return [];
  return [{
    id: 'payouts-unmatched', type: 'payouts', priority: 'warn',
    title: `${payoutBadge} Stripe ${payoutBadge === 1 ? 'payout' : 'payouts'} unmatched`,
    sub: 'Settlement mirror', meta: String(payoutBadge), target: 'payouts', ref: null,
  }];
}

// Tab descriptors for NeedsYouStrip. Sales renders only when non-empty; the
// payroll status block is Money tab BODY content (admin-only), so it drives
// hasBody and (when overdue) the danger dot, never an item or the count.
export function computeTabs({ staffing, prep, clients, money, sales, payrollOverdue, isAdmin }) {
  const defs = [
    { key: 'staffing', label: 'Staffing', items: staffing || [] },
    { key: 'prep', label: 'Prep', items: prep || [] },
    { key: 'clients', label: 'Clients', items: clients || [] },
    { key: 'money', label: 'Money', items: money || [] },
  ];
  if ((sales || []).length > 0) defs.push({ key: 'sales', label: 'Sales', items: sales });
  return defs.map(t => {
    let dot = worstPriority(t.items);
    if (t.key === 'money' && payrollOverdue) dot = 'danger';
    return {
      ...t, count: t.items.length, dot, overflowHref: OVERFLOW_HREF[t.key],
      hasBody: t.items.length > 0 || (t.key === 'money' && isAdmin),
    };
  });
}

// Default active tab: worst dot wins, ties break by the fixed tab order
// already encoded in the array. Nothing anywhere: Money for admins (the
// payroll block is still worth a glance), null for managers (collapsed card).
export function defaultTabKey(tabs, isAdmin) {
  let best = null, bestRank = Infinity;
  tabs.forEach(t => {
    if (!t.dot) return;
    if (RANK[t.dot] < bestRank) { bestRank = RANK[t.dot]; best = t.key; }
  });
  if (best) return best;
  return isAdmin ? 'money' : null;
}
