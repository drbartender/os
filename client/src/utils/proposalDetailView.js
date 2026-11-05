// Pure view-model for the phone proposal detail: the status line, the package
// lines, the client link, and which rows the screen offers (spec
// 2026-08-13-mobile-admin section 5 Detail and section 3, Plan decisions of
// 2026-11-05; benchmark docs/design-artifacts/2026-10-14-mobile-admin-shell.dc.html,
// Proposal detail). No React, no fetch, no clock unless the caller passes one.
//
// MONEY. Nothing here computes a price. The package lines are the stored
// pricing snapshot and the total and the amount paid are the proposal row,
// read through eventDetailView.js's financialsOf, so the event detail and this
// screen show one set of figures (law 8 untouched).
import { PUBLIC_SITE_URL } from './constants';
import { whenLabel } from './proposalCards';
import { proposalStatusMeta } from './proposalStatusMap';
import { headerOf, contactsOf, financialsOf, dollars } from './eventDetailView';

// A booking belongs to the event detail: these open /events/:id instead.
export const BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];
// The desktop's own sets (ProposalDetail.js): Resend (canResend), the first
// send (canSend) and Archive (ARCHIVABLE_STATUSES).
const RESEND_STATUSES = ['sent', 'viewed', 'accepted'];
const FIRST_SEND_STATUSES = ['draft', 'modified'];
const ARCHIVABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];
// The open statuses: the only ones that offer Edit details and the Client link.
const OPEN_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];

// Every stored archive_reason (the schema's CHECK), in the desktop's words
// (ProposalsDashboard.js).
const REASON_LABELS = {
  no_hire: 'No hire',
  client_cancelled: 'Client cancelled',
  we_cancelled: 'We cancelled',
  event_completed: 'Event completed',
  option_not_chosen: 'Option not chosen',
  event_passed: 'Event passed',
  other: 'Other',
};
export function archiveReasonLabel(reason) {
  return REASON_LABELS[reason] || '';
}

const text = (v) => String(v === null || v === undefined ? '' : v).trim();
const dot = (parts) => parts.filter(Boolean).join(' · ');

export function bookedTarget(proposal) {
  const p = proposal || {};
  return BOOKED_STATUSES.includes(p.status) && p.id ? `/events/${p.id}` : null;
}

// The rich header the chrome draws: the event detail's, with a proposal's
// fallback name. The kind stays its own value (getEventTypeLabel), never
// joined to the client's name.
export function proposalHeaderOf(proposal) {
  const p = proposal || {};
  return { ...headerOf(p), title: text(p.client_name) || 'Unnamed client' };
}

// Contacts: the client alone, the phone a tap to call and the email a tap to
// write, and no Text link. A plain sms: link sends from the phone's own
// number, and the owner does not want texts from his personal number
// (2026-09-30: "I don't want to text from my personal number"); the event
// detail's Text button waits on the phone Messages screen, and this screen
// adds no new one.
export function proposalContactsOf(proposal) {
  const c = contactsOf(proposal || {}, null);
  return { ...c, client: { ...c.client, smsHref: null } };
}

// The status line reads stored times only. "modified" carries no time and no
// "by client": only an admin sets that status and no column records a
// client's edit. A sent proposal reads "not opened yet" only while
// last_viewed_at is null, so a resend after a view keeps its views.
export function statusLineOf(proposal, now = new Date()) {
  const p = proposal || {};
  const when = (ts) => whenLabel(ts, now);
  const views = Number(p.view_count || 0);
  const sent = p.sent_at ? `sent ${when(p.sent_at)}` : 'sent';
  const viewed = () => dot([
    sent,
    p.last_viewed_at ? `viewed ${when(p.last_viewed_at)}` : 'viewed',
    views > 0 ? `${views} ${views === 1 ? 'view' : 'views'}` : '',
  ]);
  switch (p.status) {
    case 'draft':
      return 'draft · never sent';
    case 'sent':
      return p.last_viewed_at ? viewed() : `${sent} · not opened yet`;
    case 'viewed':
      return viewed();
    case 'modified':
      return `${sent} · modified`;
    case 'accepted': {
      const at = p.accepted_at || p.client_signed_at;
      const paid = Number(p.amount_paid || 0);
      return dot([at ? `accepted ${when(at)}` : 'accepted', paid > 0 ? `${dollars(paid)} paid` : 'awaiting deposit']);
    }
    case 'archived':
      return dot(['archived', archiveReasonLabel(p.archive_reason)]);
    default:
      return String(proposalStatusMeta(p.status).label || '').toLowerCase();
  }
}

export function chipOf(proposal) {
  const { label, kind } = proposalStatusMeta((proposal || {}).status);
  return { label, kind };
}

// Package & extras: the stored snapshot's lines (client-hidden ones flagged)
// and the row's total, exactly as the event detail's Financials lists them.
export function packageOf(proposal) {
  const fin = financialsOf(proposal || {}, null);
  return { lines: fin.lines, total: fin.total };
}

// The desktop's copy-link URL (ProposalDetail.js copyPublicLink), shown as the
// host, the path and the token's first six characters. A draft's link would
// let a client see an unsent quote and count a view, so it is not offered.
export function clientLinkOf(proposal, base = PUBLIC_SITE_URL) {
  const p = proposal || {};
  const token = text(p.token);
  if (p.status === 'draft' || !token) return { url: null, text: 'not sent yet', host: '', path: '' };
  // The host as the URL writes it: no scheme, no path.
  const host = String(base).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  // host and path apart: on a narrow phone the host shortens, the token stays.
  const path = `/proposal/${token.slice(0, 6)}`;
  return { url: `${base}/proposal/${token}`, text: `${host}${path}`, host, path };
}

// Which rows the screen offers, and how each acts.
//   mode 'offline'  a stored copy: the row reads "needs connection" and does nothing.
//   mode 'desktop'  the row opens desktop view (the interim until the phone's
//                   sheets land, and for good where the plan keeps it there).
// A legal-hold proposal offers nothing that writes or sends (law 15), and the
// hold fails closed: only an explicit false from the server reads as no hold.
// It also offers no client link, since a client's view writes to the row.
// An archived proposal is read-only: no action, no Edit details, no link.
export function gatesOf(proposal, { stale = false } = {}) {
  const p = proposal || {};
  const held = p.legal_hold !== false;
  const archived = p.status === 'archived';
  const open = !held && OPEN_STATUSES.includes(p.status);
  const mode = stale ? 'offline' : 'desktop';
  // An options group's sends and Edit details stay on desktop view for good:
  // its options go out together on the compare link, so a draft or modified
  // option reads "Send options", the desktop's Alternatives panel action (the
  // server refuses a solo first send, USE_GROUP_SEND).
  const grouped = p.group_id !== null && p.group_id !== undefined;

  let send = null;
  if (open && RESEND_STATUSES.includes(p.status)) send = { label: 'Resend proposal', mode };
  else if (open && FIRST_SEND_STATUSES.includes(p.status)) send = { label: grouped ? 'Send options' : 'Send proposal', mode };

  const archivable = open && ARCHIVABLE_STATUSES.includes(p.status) && !(Number(p.amount_paid) > 0);

  return {
    held,
    archived,
    grouped,
    send,
    archive: archivable ? { label: 'Archive', mode } : null,
    edit: open ? { mode } : null,
    link: open ? clientLinkOf(p) : null,
  };
}
