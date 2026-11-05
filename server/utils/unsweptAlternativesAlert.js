'use strict';
/**
 * Same-client alternatives the first-payment sweep left open (audit
 * 2026-11-05, M2).
 *
 * sweepClientAlternatives (proposalGroupCommit.js) archives a client's other
 * open, unpaid proposals only when they are dated the SAME day as the booking
 * that just paid: those are alternatives for one event. An open proposal on
 * another date may be a real second booking, so it is left alone and the
 * admin gets one routine_finance email per settle naming the rows to look at.
 *
 * Post-commit only: takes its own pooled connection (one-connection rule).
 * Never throws into a webhook tail; callers .catch() and log.
 */
const { pool } = require('../db');
const { notifyAdminCategory } = require('./adminNotifications');
const { ADMIN_URL } = require('./urls');
const { esc } = require('./htmlEscape');
const { getEventTypeLabel } = require('./eventTypes');

async function notifyUnsweptAlternatives(winnerProposalId, skippedIds) {
  const winnerId = Number(winnerProposalId);
  const ids = (skippedIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!Number.isInteger(winnerId) || ids.length === 0) return { alerted: false };

  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price,
            to_char(p.event_date, 'YYYY-MM-DD') AS event_ymd,
            c.name AS client_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1 OR p.id = ANY($2::int[])
      ORDER BY p.event_date NULLS LAST, p.id`,
    [winnerId, ids]
  );
  const winner = rows.find((r) => r.id === winnerId);
  const others = rows.filter((r) => r.id !== winnerId);
  if (!winner || others.length === 0) return { alerted: false };

  const describe = (r) => {
    const label = getEventTypeLabel({ event_type: r.event_type, event_type_custom: r.event_type_custom });
    return `#${r.id} ${label} on ${r.event_ymd || 'no date'} (${r.status}, $${Number(r.total_price || 0).toFixed(2)})`;
  };
  const who = winner.client_name || 'A client';
  const intro = `${who} just paid on proposal #${winner.id} (${winner.event_ymd || 'no date'}). `
    + `They still have ${others.length} open proposal${others.length === 1 ? '' : 's'} on other dates. `
    + 'Those were left open because a different date may be a separate booking; archive any that were really alternatives for the booked event.';

  const textLines = others.map((r) => `  ${describe(r)}  ${ADMIN_URL}/proposals/${r.id}`);
  const htmlItems = others
    .map((r) => `<li>${esc(describe(r))} &middot; <a href="${esc(`${ADMIN_URL}/proposals/${r.id}`)}">Open</a></li>`)
    .join('');

  await notifyAdminCategory({
    category: 'routine_finance',
    subject: `Open proposals left for ${who} after paying proposal #${winner.id}`,
    emailText: `${intro}\n\n${textLines.join('\n')}`,
    emailHtml: `<p>${esc(intro)}</p><ul>${htmlItems}</ul>`,
  });
  return { alerted: true };
}

module.exports = { notifyUnsweptAlternatives };
