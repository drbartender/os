'use strict';
// The admin phone's push channel (spec 2026-08-13-mobile-admin section 7,
// rewritten 2026-10-14). ONE module knows the seven kinds, builds each
// banner, and sends to a user's stored subscriptions. A send holds no DB
// connection across the network (the SERVER-17 lesson in pushDispatch.js), a
// dead subscription is pruned in its own short transaction, and nothing here
// ever throws into a caller: push can never fail a money path.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
// Module-level (not destructured) so tests can monkey-patch pushSender.sendPush.
const pushSender = require('./pushSender');

// The dispatch allowlist. A notifyAdminCategory call pushes ONLY when it names
// one of these; the screen draws them in this order under three headings.
const PUSH_KINDS = Object.freeze([
  'booking_signed',
  'booking_signed_paid',
  'payment_landed',
  'booking_last_minute',
  'drink_plan_submitted',
  'staffing_drop',
  'staffing_cover_swap',
]);
const KIND_SET = new Set(PUSH_KINDS);
const isPushKind = (kind) => typeof kind === 'string' && KIND_SET.has(kind);

// Kind plus record id: a retried send replaces its own banner, and two records
// of the same kind never collapse into one.
const pushTag = (kind, recordId) => (recordId === null || recordId === undefined ? kind : `${kind}:${recordId}`);

// The phone learns the key from the API, not from a build-time variable. Only
// a server that can also SIGN (private key present) advertises a public key,
// so the screen's "not set up on the server" state is truthful.
function publicKey() {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null;
}

// A subscription carries the surface it came from: 'admin' from the admin
// phone, absent from the staff portal. One user can hold both, so each channel
// names its own: 'admin' keeps the admin entries, 'staff' keeps the rest, and
// no surface keeps all (the prune, which removes by endpoint).
function subscriptionsOf(prefs, surface) {
  const subs = prefs && Array.isArray(prefs.push_subscriptions) ? prefs.push_subscriptions : [];
  const valid = subs.filter((s) => s && typeof s.endpoint === 'string' && s.keys);
  if (surface === 'admin') return valid.filter((s) => s.surface === 'admin');
  if (surface === 'staff') return valid.filter((s) => s.surface !== 'admin');
  return valid;
}

// Short transaction: re-read under FOR UPDATE and drop only the gone
// endpoints, so a concurrent subscribe of a different endpoint survives.
async function pruneGoneSubscriptions(userId, goneEndpoints) {
  if (!goneEndpoints.length) return;
  // The connect sits inside the try: a saturated or unreachable pool rejects
  // here, and that must land in the breadcrumb below, never in the caller.
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const fresh = subscriptionsOf(rows[0] && rows[0].prefs);
    const gone = new Set(goneEndpoints);
    const kept = fresh.filter((s) => !gone.has(s.endpoint));
    if (kept.length !== fresh.length) {
      await client.query(
        `UPDATE users SET staff_notification_preferences = jsonb_set(COALESCE(staff_notification_preferences, '{}'::jsonb), '{push_subscriptions}', $2::jsonb, true) WHERE id = $1`,
        [userId, JSON.stringify(kept)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    }
    Sentry.addBreadcrumb({ category: 'notifications', message: 'push_prune_failed', data: { user_id: userId, error: err && err.message } });
  } finally {
    if (client) client.release();
  }
}

// Send one banner to every subscription this user holds on the named surface
// ('admin' or 'staff'; none sends to all). Never throws.
// readFailed tells a failed subscription read apart from "no subscriptions":
// both have zero counts, and only the second is a true answer.
async function sendPushToUser({ userId, title, body, url, tag, icon, surface }) {
  const out = { subscriptions: 0, sent: 0, failed: 0, gone: 0, readFailed: false };
  let subs;
  try {
    const { rows } = await pool.query('SELECT staff_notification_preferences AS prefs FROM users WHERE id = $1', [userId]);
    subs = subscriptionsOf(rows[0] && rows[0].prefs, surface);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-push', step: 'read' } });
    return { ...out, readFailed: true, error: (err && err.message) || 'read_failed' };
  }
  out.subscriptions = subs.length;
  const goneEndpoints = [];
  for (const sub of subs) {
    let result;
    try {
      result = await pushSender.sendPush({ subscription: { endpoint: sub.endpoint, keys: sub.keys }, title, body, url, tag, icon });
    } catch (err) {
      result = { ok: false, error: err && err.message };
    }
    if (result && result.ok) out.sent += 1;
    else if (result && result.gone) { out.gone += 1; goneEndpoints.push(sub.endpoint); }
    else out.failed += 1;
  }
  // Belt and braces: the prune already swallows its own errors, but this call
  // keeps the never-throws contract even if a later edit to the prune does not.
  try {
    await pruneGoneSubscriptions(userId, goneEndpoints);
  } catch (err) {
    Sentry.addBreadcrumb({ category: 'notifications', message: 'push_prune_failed', data: { user_id: userId, error: err && err.message } });
  }
  return out;
}

// The revoke (webauthn.js) runs this inside its own transaction; pass its client.
async function deleteAllSubscriptions(userId, db = pool) {
  await db.query(
    `UPDATE users SET staff_notification_preferences = jsonb_set(COALESCE(staff_notification_preferences, '{}'::jsonb), '{push_subscriptions}', '[]'::jsonb, true) WHERE id = $1`,
    [userId]
  );
}

// Banner copy. A path for url (the worker resolves it against the origin).
// Client display name, event kind, date and amount only: the banner shows on
// a locked Android screen. No em dashes.
// The client name and the event kind can be authored unauthenticated on the
// public quote form, so both are clamped before they reach a banner: names to
// 60 characters, kinds to 40, a cut ending in an ellipsis. Counted and cut by
// code point, so an emoji at the cut is never split into a lone surrogate.
const clip = (s, n) => { const t = String(s === null || s === undefined ? '' : s).trim(); const cps = Array.from(t); return cps.length > n ? cps.slice(0, n - 1).join('').trimEnd() + '…' : t; };
const NAME_MAX = 60;
const KIND_MAX = 40;
const who = (clientName) => clip(clientName, NAME_MAX) || 'A client';
const kindOf = (eventTypeLabel) => clip(eventTypeLabel, KIND_MAX);
const eventUrl = (proposalId) => (proposalId ? `/events/${proposalId}` : '/staffing');
const forClient = (clientName) => (clientName ? ` for ${clip(clientName, NAME_MAX)}` : '');
// The event date ends the body when the site has it (decision 10).
const dated = (body, dateLabel) => (dateLabel ? `${body} · ${dateLabel}` : body);
const pushCopy = {
  bookingSigned: ({ clientName, eventTypeLabel, proposalId, dateLabel }) => ({
    kind: 'booking_signed', recordId: proposalId,
    title: `${who(clientName)} signed`,
    body: dated(`${kindOf(eventTypeLabel)}. Open the proposal.`, dateLabel),
    url: `/proposals/${proposalId}`,
  }),
  bookingSignedPaid: ({ clientName, eventTypeLabel, amount, proposalId, dateLabel }) => ({
    kind: 'booking_signed_paid', recordId: proposalId,
    title: `${who(clientName)} signed and paid`,
    body: dated(`${kindOf(eventTypeLabel)} · ${amount}`, dateLabel),
    url: eventUrl(proposalId),
  }),
  paymentLanded: ({ clientName, eventTypeLabel, amount, paymentType, proposalId, dateLabel }) => ({
    kind: 'payment_landed', recordId: proposalId,
    title: `Payment landed: ${amount}`,
    body: dated(`${who(clientName)} · ${kindOf(eventTypeLabel)}${paymentType ? ` (${paymentType})` : ''}`, dateLabel),
    url: eventUrl(proposalId),
  }),
  bankPaymentStarted: ({ clientName, eventTypeLabel, amount, initial, proposalId, dateLabel }) => ({
    kind: initial ? 'booking_signed_paid' : 'payment_landed', recordId: proposalId,
    title: `Bank payment started: ${amount}`,
    body: dated(`${who(clientName)} · ${kindOf(eventTypeLabel)}. Settles in four to six business days.`, dateLabel),
    url: eventUrl(proposalId),
  }),
  lastMinuteBooking: ({ eventTypeLabel, date, time, proposalId }) => ({
    kind: 'booking_last_minute', recordId: proposalId,
    title: 'Last-minute booking',
    body: `${kindOf(eventTypeLabel)} ${date} ${time}. Verify staffing now.`,
    url: eventUrl(proposalId),
  }),
  drinkPlanSubmitted: ({ clientName, eventTypeLabel, proposalId, dateLabel }) => ({
    kind: 'drink_plan_submitted', recordId: proposalId,
    title: 'Drink plan submitted',
    body: dated(`${who(clientName)} · ${kindOf(eventTypeLabel)}. Start the shopping list and the menu.`, dateLabel),
    url: eventUrl(proposalId),
  }),
  staffingDrop: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_drop', recordId: shiftId,
    title: `Shift dropped: ${dateLabel}`,
    body: `${kindOf(eventTypeLabel)}${forClient(clientName)} · ${position || 'staff'}. Needs restaffing.`,
    url: eventUrl(proposalId),
  }),
  staffingCover: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_cover_swap', recordId: shiftId,
    title: `Cover requested: ${dateLabel}`,
    body: `${kindOf(eventTypeLabel)}${forClient(clientName)} · ${position || 'staff'}. Teammates are being asked.`,
    url: eventUrl(proposalId),
  }),
  staffingSwap: ({ clientName, eventTypeLabel, dateLabel, position, proposalId, shiftId }) => ({
    kind: 'staffing_cover_swap', recordId: shiftId,
    title: `Swap proposed: ${dateLabel}`,
    body: `${kindOf(eventTypeLabel)}${forClient(clientName)} · ${position || 'staff'}. Approve it to confirm them.`,
    url: eventUrl(proposalId),
  }),
};

module.exports = { PUSH_KINDS, isPushKind, pushTag, publicKey, sendPushToUser, deleteAllSubscriptions, pushCopy };
