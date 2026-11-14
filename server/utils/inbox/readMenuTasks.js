'use strict';

// Reader: the menu tasks under a client (spec 2026-10-19 section 13.1): a change request on the latest
// menu proof, and a proof with no answer once its reminder falls due; only tasks open right now.
//
// One pass-1 query over each draft's latest proof (superseded_at IS NULL, the
// latest by sent_at, as menuProofs.loadLatestProof orders it) with its draft
// and proposal. It reads its own columns rather than loadLatestProof (one
// draft at a time, without the client or the release columns) and derives the
// proof's state with menuProofs.proofState over the shared token-life
// fragment (proofExpiredSql), never a copy. A task is open only while the
// latest proof's own state holds:
//   menu_changes    the state is changes, at answered_at;
//   menu_no_answer  the state is open and menuReminderDueAt (sent_at, the
//                   event date) is at or before now, at that due time.
// A release of its held file (the draft's released key is its approved key,
// for the proof's own pair) closes menu_no_answer always, and menu_changes
// only when the release came at or after the answer (released_at against
// answered_at), so a change request sent after a release still shows. A
// superseded or withdrawn proof, an approved one, or (with no event date) an
// unanswered link past its 30 days closes them; a change request outlives its
// link (proofState keeps an answer past the link's life, lane
// menu-approve-send), so it waits on Dallas until he approves again, releases,
// uploads or closes it. An older live file never closes them, so a second
// proof's change request always shows. Nor does the admin's own upload live on
// the proposal: no time is kept for a print key, so the reader cannot tell an
// upload made after a change request from one made before the proof was sent,
// and guessing would hide a later proof's tasks. The upload route withdraws
// the proof it settles (spec 10.3, lane menu-approve-send), and a withdrawn
// proof has no task. The upload changes only the no-answer task's words
// (spec 13.1, item n): while the print key is the admin's own upload (set and
// equal to neither the draft's released key nor its approved key, the
// query's owner_upload), a release would be refused, so the text drops
// "Release it for printing?"; owner_upload never closes or hides a task. A row the
// mapper cannot read (proofState or menuReminderDueAt throws) is skipped and
// reported once per process by its proof id alone (a Sentry warning and a
// log line, readJob.js's pattern), so one bad row never takes the Inbox
// down; a malformed legal-hold id still throws before any row is read.
// Never for a proposal with no client, an
// archived one, one with the no-menu mark, an event before today in Chicago
// (event dates compare as YYYY-MM-DD text), or any person the legal hold
// covers: the query skips the held proposals and every proposal of their
// clients, and the mapper skips every key in the engine's held key set
// (engine.legalHoldPersonKeys, as readJob.js refuses them). With no proofs
// it emits nothing.
//
// Each task is a system event under c-<client_id>, channel null (so the reply
// box never takes it), with its fixed text (spec section 28) and meta
// { source: 'menu_task', id: the proof id, proposalId, link }. The client's
// change note is never in pass 1: loadMenuTaskDetails loads it in pass 2
// (details.js) into meta.note, for the thread alone. Nothing here reaches the
// AI: classify.js keeps the task kinds out of the conversation and
// subjects.js never slices them. Lane menu-auto-start adds menu_ready and
// menu_failed here; classify.js already knows all four kinds.

const Sentry = require('@sentry/node');
const { proofExpiredSql, proofState } = require('../menuProofs');
const { menuReminderDueAt } = require('../menuReminder');
const { chicagoYmdOf } = require('../businessTime');

// The fixed texts (spec 2026-10-19 section 28), the row's need line.
const MENU_TASK_TEXTS = Object.freeze({
  menu_changes: 'Asked for menu changes',
  menu_no_answer: 'No answer on the menu yet. Release it for printing?',
});
// The no-answer text while the admin's own upload is live (spec 13.1, item n).
const NO_ANSWER_BESIDE_UPLOAD = 'No answer on the menu yet.';

// $1 the history floor, $2 today in Chicago (YYYY-MM-DD), $3 the held proposal
// ids. Built once at load from the shared token-life fragment (fixed text over
// two aliases; no input reaches the statement but through the parameters).
const MENU_TASKS_SQL = `
  SELECT DISTINCT ON (mp.draft_id)
         mp.id, mp.draft_id, mp.proposal_id, p.client_id, mp.sent_at,
         mp.answer, mp.answered_at, mp.superseded_at, mp.withdrawn_at,
         ${proofExpiredSql({ proof: 'mp', proposal: 'p' })} AS expired,
         to_char(p.event_date, 'YYYY-MM-DD') AS event_date,
         COALESCE(d.released_print_key IS NOT NULL
                  AND d.released_print_key = d.approved_print_key
                  AND mp.version = d.approved_version
                  AND mp.art_version = d.approved_art_version, FALSE) AS released,
         d.released_at,
         COALESCE(p.menu_print_key IS NOT NULL
                  AND p.menu_print_key IS DISTINCT FROM d.released_print_key
                  AND p.menu_print_key IS DISTINCT FROM d.approved_print_key, FALSE) AS owner_upload
    FROM menu_proofs mp
    JOIN menu_drafts d ON d.id = mp.draft_id
    JOIN proposals p ON p.id = mp.proposal_id
   WHERE mp.sent_at >= $1
     AND mp.superseded_at IS NULL
     AND p.client_id IS NOT NULL
     AND p.status IS DISTINCT FROM 'archived'
     AND p.menu_not_required IS NOT TRUE
     AND (p.event_date IS NULL OR to_char(p.event_date, 'YYYY-MM-DD') >= $2::text)
     AND p.id <> ALL($3::int[])
     AND NOT EXISTS (SELECT 1 FROM proposals h WHERE h.id = ANY($3::int[]) AND h.client_id = p.client_id)
   ORDER BY mp.draft_id, mp.sent_at DESC, mp.id DESC`;

const NOTES_SQL = `
  SELECT id, answer_note
    FROM menu_proofs
   WHERE id = ANY($1::int[]) AND answer = 'changes'`;

/**
 * The query's parameters: the floor, today in Chicago as of `now`, and the
 * held proposal ids. An id that is not a positive integer throws, so the
 * snapshot fails rather than read a held client as unheld.
 */
function menuTaskParams({ floor, now, legalHoldIds = [] }) {
  const ids = (Array.isArray(legalHoldIds) ? legalHoldIds : []).map(Number);
  if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    throw new Error('readMenuTasks: a legal-hold proposal id is not a positive integer');
  }
  return [floor, chicagoYmdOf(now), ids];
}

const refOf = (kind, proofId) => `mt:${kind}:${proofId}`;

// The Sentry seam (readJob.js's pattern) and the proof ids already reported
// this process, so a bad row warns once, not on every 30-second load.
let deps = { sentry: Sentry };
const reported = new Set();
function reportUnreadable(proofId) {
  if (reported.has(proofId)) return;
  reported.add(proofId);
  console.warn(`[inbox] menu proof ${proofId} could not be read; its task is skipped`);
  deps.sentry.captureMessage('[inbox] a menu proof row could not be read', {
    level: 'warning',
    tags: { area: 'inbox', issue: 'menu_task_row' },
    extra: { proof_id: proofId },
  });
}

function taskEvent(kind, row, personKey, at, text = MENU_TASK_TEXTS[kind]) { // eslint-disable-line security/detect-object-injection -- kind is one of this file's two literal kinds
  const id = Number(row.id);
  const proposalId = Number(row.proposal_id);
  return {
    ref: refOf(kind, id), personKey, channel: null, line: null, direction: 'system', at, author: null, kind, text,
    meta: { source: 'menu_task', id, proposalId, link: `/events/${proposalId}?menu=1` },
  };
}

/**
 * The open tasks among the query's rows, as of `now`. heldKeys: every person
 * key the legal hold covers (engine.loadLegalHold's keys); none of theirs is
 * ever emitted.
 */
// The one open task of a readable row, or null. Throws on a row it cannot read.
function taskOfRow(row, personKey, nowMs) {
  const state = proofState(row);
  if (state === 'changes') {
    // A null would read as 1970, so it is refused before the Date is built.
    const answeredAt = row.answered_at ? new Date(row.answered_at) : null;
    if (!answeredAt || !Number.isFinite(answeredAt.getTime())) throw new Error('readMenuTasks: answered_at is not a time');
    // A release settles a change request only when it came at or after it.
    if (row.released && row.released_at && new Date(row.released_at).getTime() >= answeredAt.getTime()) return null;
    return taskEvent('menu_changes', row, personKey, answeredAt);
  }
  if (state === 'open') {
    if (row.released) return null;
    const due = menuReminderDueAt({ sentAt: row.sent_at, eventDate: row.event_date || null });
    if (due.getTime() > nowMs) return null;
    return row.owner_upload === true
      ? taskEvent('menu_no_answer', row, personKey, due, NO_ANSWER_BESIDE_UPLOAD)
      : taskEvent('menu_no_answer', row, personKey, due);
  }
  return null;
}

function mapMenuTaskRows(rows, { now, heldKeys = new Set() } = {}) {
  const nowMs = new Date(now).getTime();
  const today = chicagoYmdOf(now);
  const out = [];
  for (const row of rows || []) {
    if (row.client_id === null || row.client_id === undefined) continue;
    const personKey = `c-${Number(row.client_id)}`;
    if (heldKeys.has(personKey)) continue;
    if (row.event_date && row.event_date < today) continue;
    let task;
    try {
      task = taskOfRow(row, personKey, nowMs);
    } catch {
      reportUnreadable(Number(row.id));
      continue;
    }
    if (task) out.push(task);
  }
  return out;
}

/** Pass 2: the client's change note for each change-request proof id, keyed by the task's ref. */
async function loadMenuTaskDetails(proofIds, db) {
  const out = new Map();
  if (!proofIds.length) return out;
  const { rows } = await db.query(NOTES_SQL, [proofIds]);
  for (const r of rows) out.set(refOf('menu_changes', Number(r.id)), { note: r.answer_note });
  return out;
}

function __setMenuTaskDeps(overrides) { deps = { ...deps, ...overrides }; }
function __resetMenuTaskDeps() { deps = { sentry: Sentry }; reported.clear(); }

module.exports = {
  MENU_TASKS_SQL, MENU_TASK_TEXTS, NO_ANSWER_BESIDE_UPLOAD, menuTaskParams, mapMenuTaskRows, loadMenuTaskDetails, __setMenuTaskDeps, __resetMenuTaskDeps,
};
