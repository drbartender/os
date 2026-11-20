'use strict';

// The Claude connector's two owner emails (spec 2026-11-19 sections 7.2 and 8): a new connection was
// made (sent at the code exchange), and a connection was cut off because a spent credential was presented again.
//
// Sent through server/utils/email.js's sendEmail, which honours the
// notifications gate (SEND_NOTIFICATIONS, live by default only in production)
// and throws when Resend returns an error (Resend itself never throws; the
// wrapper reads .error). The caller (grants.js) catches and reports, so a
// failed email never fails an approval or a revocation. The sender is
// injectable (__setSender) so no suite sends real mail.
//
// The address the request came from and its browser are shown so the owner can
// tell an approval he made from one someone tricked him into (spec section 8);
// no token, code or link is ever put in either email.

const { sendEmail } = require('../email');

let send = sendEmail;
function __setSender(fn) { send = fn || sendEmail; }

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function chicago(d) {
  return new Date(d).toLocaleString('en-US', {
    timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short',
  });
}

// Sent when the connection becomes real: Claude has exchanged the approval's
// code (tokens.exchangeCode), not at the Allow click.
async function sendGrantCreatedEmail({ to, connectedAt, approvedAt, requestedAt, callerAddress, userAgent, replaced }) {
  const lines = [
    `Claude was connected to the OS on ${chicago(connectedAt || approvedAt)} (Chicago time).`,
    approvedAt ? `You approved it with your passkey on ${chicago(approvedAt)}.` : null,
    requestedAt ? `The sign-in request started ${chicago(requestedAt)} from ${callerAddress || 'an unknown address'}${userAgent ? `, browser: ${userAgent}` : ''}.` : null,
    replaced ? 'It replaced the connection that was there before, which no longer works.' : null,
    'Claude can now read the business through its read-only tools.',
    'If you did not approve this: open Settings in the OS admin and press Disconnect in the Claude connection block. Then reset your password (on the login page, "Forgot your password?") or revoke your passkeys under Settings, Security; either one signs every session out.',
  ].filter(Boolean);
  return send({
    to,
    subject: 'Claude was connected to the OS',
    html: lines.map((l) => `<p>${esc(l)}</p>`).join('\n'),
    text: lines.join('\n\n'),
  });
}

async function sendReplayRevokedEmail({ to, kind, revokedAt }) {
  const what = kind === 'code_replay' ? 'a sign-in code' : 'a refresh token';
  const lines = [
    `The Claude connection was cut off on ${chicago(revokedAt)} (Chicago time).`,
    `${what[0].toUpperCase()}${what.slice(1)} that had already been used was presented again, which can mean a copy of it exists somewhere it should not.`,
    'Nothing more can be read through that connection. To use Claude with the OS again, connect it from Claude and approve it with your passkey.',
  ];
  return send({
    to,
    subject: 'The Claude connection was cut off',
    html: lines.map((l) => `<p>${esc(l)}</p>`).join('\n'),
    text: lines.join('\n\n'),
  });
}

module.exports = { sendGrantCreatedEmail, sendReplayRevokedEmail, __setSender };
