'use strict';

// The withheld pieces of client-written text (spec 2026-11-19 section 7.6, guard 1): one call-log row per piece, ever, and one owner email per call listing that call's fresh pieces.
//
// A piece is the same words about the same subject (tools/text.js builds its
// withheld_ref, the same in every tool). recordWithheld writes each piece's
// row with INSERT ... ON CONFLICT DO NOTHING on the unique withheld_ref: a
// row back means this call is the first to meet the piece; no row means it
// was logged (and emailed) before; a failed insert is reported to Sentry and
// treated as not logged at all, so no email claims it and the next read
// tries again. The rows are written before the tool answers.
//
// The owner's email is a digest: at most one per call, listing the call's
// fresh pieces, each named by what the owner can open (the person or booking
// and its admin page), why it was held back (its pattern) and the tool in
// plain words, never the text. The call's own row also names every piece it
// held back (record_ids "withheld:<ref>", tools/run.js), so the settings
// block shows it even when the email did not go out and its row was deleted. It is
// sent detached, after the answer. When it is not sent (the send throws,
// notifications are gated off and sendEmail skips it, or no owner address is
// found), this call's fresh rows are deleted by id, so a later read finds the
// pieces absent, writes them again and retries the email; the reason goes to
// Sentry. No schema change is needed for that (lane connector-tools, fix
// round 1). sendEmail is called with meta.skipLog, so the alert writes no
// message_log row (law 6). Everything external is injectable
// (__setWithheldDeps) so no suite sends mail.

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { sendEmail } = require('../email');
const { ADMIN_URL } = require('../urls');

const OWNER_EMAIL_SQL = 'SELECT email FROM users WHERE id = $1';
const INSERT_WITHHELD_SQL = `
  INSERT INTO connector_calls (grant_id, caller_address, method, tool_name, record_ids, client_id, outcome, withheld_ref)
  VALUES ($1, $2, 'tools/call', $3, $4::text[], $5, 'withheld', $6)
  ON CONFLICT (withheld_ref) WHERE outcome = 'withheld' DO NOTHING
  RETURNING id`;
const DELETE_WITHHELD_SQL = "DELETE FROM connector_calls WHERE id = ANY($1::bigint[]) AND outcome = 'withheld'";

// The tools in the plain words the settings block uses (ClaudeConnection.js TOOL_TEXT).
const TOOL_WORDS = Object.freeze({
  waiting_on_you: 'Waiting on you',
  upcoming_events: 'Upcoming events',
  money_owed: 'Money owed',
  search: 'Search',
  client: 'Client details',
  proposal_or_event: 'Proposal or event details',
  thread: 'Message thread',
});

const cap = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const intOrNull = (v) => (Number.isInteger(v) ? v : null);

const defaults = () => ({
  send: sendEmail,
  captureMessage: (msg, ctx) => { if (process.env.SENTRY_DSN_SERVER) Sentry.captureMessage(msg, ctx); },
  ownerEmail: async (userId) => {
    const { rows } = await pool.query(OWNER_EMAIL_SQL, [userId]);
    return rows[0] ? rows[0].email : null;
  },
  // Resolves the new row's id, null when the piece was logged before; throws on a failed insert.
  insertRow: async ({ grantId, callerAddress, toolName, record, clientId, ref }) => {
    const { rows } = await pool.query(INSERT_WITHHELD_SQL, [
      intOrNull(grantId), cap(callerAddress, 64), cap(toolName, 64), [cap(record, 100)], intOrNull(clientId), cap(ref, 128),
    ]);
    return rows[0] ? Number(rows[0].id) : null;
  },
  deleteRows: async (ids) => { await pool.query(DELETE_WITHHELD_SQL, [ids]); },
});
let deps = defaults();
// The newest detached email chain, for a suite to wait on (__drain).
let tail = Promise.resolve();
function __drain() { return tail; }
function __setWithheldDeps(overrides) { deps = overrides ? { ...deps, ...overrides } : defaults(); }

function report(msg, tags) {
  try {
    deps.captureMessage(msg, { level: 'error', tags: { component: 'connector', ...tags } });
  } catch (_) { /* telemetry must never break a tool call; static-checks: allow swallowed-catch */ }
}

function chicago(d) {
  return new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Why a piece was held back, by the pattern that decided it.
function reasonFor(pattern) {
  if (pattern === 'not-a-phone' || pattern === 'not-an-email') return 'a contact field that is not a phone number or an email address';
  if (pattern === 'too-long') return 'too long to screen';
  if (pattern === 'not-text') return 'not text the OS could screen';
  return 'it reads like instructions written for an AI';
}

/** The digest: one email naming each fresh piece by what the owner can open, and why it was held back. */
function digestEmail({ to, pieces, toolName, at }) {
  const tool = TOOL_WORDS[toolName] || 'a connector tool';
  const items = pieces.map((p) => {
    const what = p.open && p.open.label ? p.open.label : p.record;
    const url = p.open && p.open.path ? `${ADMIN_URL}${p.open.path}` : null;
    const why = reasonFor(p.pattern);
    return { text: `${what} (${p.record}), held back because ${why}${url ? `: ${url}` : ''}`, what, url, record: p.record, why };
  });
  const intro = `On ${chicago(at)} (Chicago time) Claude read ${pieces.length === 1 ? 'a piece' : `${pieces.length} pieces`} of client-written text through the connector's ${tool} tool (a message, a name, a note or a contact field), and the OS held the words back: Claude was shown "withheld, read it in the OS" in their place.`;
  const after = [
    'Open each one in the OS to read it. If it is ordinary, nothing more is needed; if one wording keeps being held back, the pattern list can be changed.',
    'A piece is emailed once, in the email of the call that first held it back. The Claude connection block in Settings lists the recent calls, and a call that held a piece back names it there.',
  ];
  return {
    to,
    subject: 'Claude was shown a withheld message',
    html: [
      `<p>${esc(intro)}</p>`,
      `<ul>${items.map((i) => `<li>${esc(i.what)} (${esc(i.record)}), held back because ${esc(i.why)}${i.url ? `: <a href="${esc(i.url)}">${esc(i.url)}</a>` : ''}</li>`).join('')}</ul>`,
      ...after.map((l) => `<p>${esc(l)}</p>`),
    ].join('\n'),
    text: [intro, ...items.map((i) => `- ${i.text}`), ...after].join('\n\n'),
    meta: { skipLog: true },
  };
}

async function forget(ids, why, toolName) {
  report('connector_withheld_email_not_sent', { tool: toolName, reason: why });
  try {
    await deps.deleteRows(ids);
  } catch (_) {
    report('connector_withheld_rows_not_cleared', { tool: toolName });
  }
}

/**
 * Log each withheld piece once; email the owner one digest of the pieces this
 * call logged first. Never throws. Resolves the number of fresh pieces (the
 * email goes out detached).
 * @param {{grantId: number, userId: number, callerAddress?: string}} ctx
 * @param {{toolName: string, pieces: {ref: string, record: string, open?: object}[], clientId?: number|null, now?: Date}} args
 */
async function recordWithheld(ctx, { toolName, pieces, clientId = null, now = new Date() }) {
  const fresh = [];
  for (const piece of pieces || []) {
    if (!piece || !piece.ref) continue;
    try {
      const id = await deps.insertRow({
        grantId: ctx.grantId, callerAddress: ctx.callerAddress, toolName, record: piece.record, clientId, ref: piece.ref,
      });
      if (id !== null) fresh.push({ ...piece, id });
    } catch (_) {
      // Not logged: no email claims it, and the next read writes it again.
      report('connector_withheld_row_failed', { tool: toolName });
    }
  }
  if (fresh.length) {
    const ids = fresh.map((p) => p.id);
    tail = Promise.resolve()
      .then(async () => {
        const to = await deps.ownerEmail(ctx.userId);
        if (!to) return forget(ids, 'no_owner_address', toolName);
        const sent = await deps.send(digestEmail({ to, pieces: fresh, toolName, at: now }));
        // sendEmail answers dev-skipped when notifications are gated off or no
        // provider key is set: nothing went out, so nothing is marked emailed.
        if (sent && sent.id === 'dev-skipped') return forget(ids, 'notifications_off', toolName);
        return undefined;
      })
      .catch(() => forget(ids, 'send_failed', toolName));
  }
  return fresh.length;
}

module.exports = {
  recordWithheld, digestEmail, reasonFor, __setWithheldDeps, __drain, OWNER_EMAIL_SQL, INSERT_WITHHELD_SQL, DELETE_WITHHELD_SQL, TOOL_WORDS,
};
