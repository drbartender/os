'use strict';

// Reader: the menu tasks under a client (spec 2026-10-19 section 13.1): an auto-started menu ready to
// review or that couldn't be generated, a change request on the latest menu proof, and a proof with no
// answer once its reminder falls due; only tasks open right now.
//
// One pass-1 query, two branches (UNION ALL, task_row 'proof' or 'run'; a row
// without task_row reads as a proof row). The proof branch reads each draft's latest proof (superseded_at IS NULL, the
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
// subjects.js never slices them.
//
// The run branch (lane menu-auto-start; spec 8.3 and 13.1) reads each
// menu_auto_starts row with the proposal's current draft, its words, a summary
// of its pieces and whether the draft has any proof. For a row whose auto run
// (the guard row's run_id) is still the draft's current run, staleness being
// MENU_ART_STALE_MS by the database clock (menuDraftRead.stuck): words still
// open raise nothing while fresh and menu_failed "The menu run stopped
// partway. Open the menu to finish it." once stale; failed words raise
// menu_failed with content.words_error when it is one of the job's fixed
// texts (menuArtJobErrors.FIXED_TEXTS), else the not-started sentence; with
// the words done, a proof out raises nothing whatever the pieces are doing,
// a picture still drawing (any open piece fresh) raises nothing, and
// otherwise menu_ready opens, its " · <n> picture(s) failed" counting the
// failed pieces and any left open by a restart, at the run's finish (the
// latest of content.words_finished_at and the pieces' finished_at, else the
// attempt's own time). menu_failed is also open, at attempted_at, while the
// row has an error (the auto-start's own fixed sentence) and the proposal has
// no draft, or while it has neither a run nor an error and is older than 10
// minutes with no draft (a start that died: "The menu couldn't be started.
// Generate it from the event page."). Neither opens without a client. A
// draft made by a manual Generate since, or a run_id whose draft is gone,
// raises nothing. Both close on any
// print file or the mark, however they got there (the query skips those
// proposals). content.words_finished_at is a JSON ISO string with
// microseconds and an offset, read here by one strict pattern and parsed into
// an instant (never compared in SQL, where a malformed one would fail the
// whole read): a row whose stamp the mapper cannot read is skipped and
// reported once per process by its proposal id, as an unreadable proof row is
// by its proof id. Each run task's meta.id is its proposal id (the guard row's
// key), its ref mt:<kind>:<proposal id>.

const Sentry = require('@sentry/node');
const { proofExpiredSql, proofState } = require('../menuProofs');
const { menuReminderDueAt } = require('../menuReminder');
const { chicagoYmdOf } = require('../businessTime');
const { stuck } = require('../menuDraftRead');
const { FIXED_TEXTS } = require('../menuArtJobErrors');

// The fixed texts (spec 2026-10-19 section 28), the row's need line.
const MENU_TASK_TEXTS = Object.freeze({
  menu_ready: 'Menu ready to review',
  menu_failed: "Menu couldn't be generated: ",
  menu_changes: 'Asked for menu changes',
  menu_no_answer: 'No answer on the menu yet. Release it for printing?',
});
// The no-answer text while the admin's own upload is live (spec 13.1, item n).
const NO_ANSWER_BESIDE_UPLOAD = 'No answer on the menu yet.';
// The auto-start's own sentences, beside the job's (menuArtJobErrors.SENTENCES
// holds the rest): spec 8.3's capped start and anything else, which is also
// the sentence of a start that died, and the run whose words went stale. The
// auto-start stores the first two on its guard row; this reader shows each
// after "Menu couldn't be generated: ".
const AUTO_START_SENTENCES = Object.freeze({
  capped: "Today's menu art limit is reached. Generate it from the event page tomorrow.",
  notStarted: "The menu couldn't be started. Generate it from the event page.",
  // An auto run whose words step went stale (a restart while it was writing):
  // the run started, so the not-started sentence and its Start over are wrong.
  interrupted: 'The menu run stopped partway. Open the menu to finish it.',
});

// $1 the history floor, $2 today in Chicago (YYYY-MM-DD), $3 the held proposal
// ids. Built once at load from the shared token-life fragment (fixed text over
// two aliases; no input reaches the statement but through the parameters).
// Each branch pads the other's columns with typed NULLs, so both read alike.
const MENU_TASKS_SQL = `
  (SELECT DISTINCT ON (mp.draft_id)
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
                  AND p.menu_print_key IS DISTINCT FROM d.approved_print_key, FALSE) AS owner_upload,
         'proof' AS task_row, NULL::uuid AS run_id, NULL::uuid AS current_run_id, NULL::timestamptz AS attempted_at,
         NULL::text AS error_code, NULL::text AS error_sentence, NULL::text AS words_status,
         NULL::text AS words_heartbeat_at, NULL::text AS words_error, NULL::text AS words_finished_at,
         NULL::int AS pieces_open, NULL::timestamptz AS open_oldest_beat, NULL::timestamptz AS open_newest_beat,
         NULL::int AS pieces_failed,
         NULL::timestamptz AS pieces_finished_at, NULL::boolean AS has_proof, NULL::boolean AS dead_start,
         NULL::timestamptz AS db_now
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
   ORDER BY mp.draft_id, mp.sent_at DESC, mp.id DESC)
  UNION ALL
  (SELECT a.proposal_id AS id, d.id AS draft_id, a.proposal_id, p.client_id, NULL::timestamptz AS sent_at,
         NULL::text AS answer, NULL::timestamptz AS answered_at, NULL::timestamptz AS superseded_at,
         NULL::timestamptz AS withdrawn_at, NULL::boolean AS expired,
         to_char(p.event_date, 'YYYY-MM-DD') AS event_date, NULL::boolean AS released,
         NULL::timestamptz AS released_at, NULL::boolean AS owner_upload,
         'run' AS task_row, a.run_id, d.run_id AS current_run_id, a.attempted_at,
         a.error_code, a.error_sentence, d.content->>'words_status' AS words_status,
         d.content->>'words_heartbeat_at' AS words_heartbeat_at, d.content->>'words_error' AS words_error,
         d.content->>'words_finished_at' AS words_finished_at,
         pc.open AS pieces_open, pc.oldest_beat AS open_oldest_beat, pc.newest_beat AS open_newest_beat,
         pc.failed AS pieces_failed,
         pc.finished_at AS pieces_finished_at,
         EXISTS (SELECT 1 FROM menu_proofs x WHERE x.draft_id = d.id) AS has_proof,
         (a.run_id IS NULL AND a.error_code IS NULL AND a.attempted_at < NOW() - INTERVAL '10 minutes') AS dead_start,
         NOW() AS db_now
    FROM menu_auto_starts a
    JOIN proposals p ON p.id = a.proposal_id
    LEFT JOIN menu_drafts d ON d.proposal_id = a.proposal_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE mdp.status IN ('pending', 'working'))::int AS open,
             MIN(mdp.heartbeat_at) FILTER (WHERE mdp.status IN ('pending', 'working')) AS oldest_beat,
             MAX(mdp.heartbeat_at) FILTER (WHERE mdp.status IN ('pending', 'working')) AS newest_beat,
             COUNT(*) FILTER (WHERE mdp.status = 'failed')::int AS failed,
             MAX(mdp.finished_at) AS finished_at
        FROM menu_draft_pieces mdp
       WHERE mdp.draft_id = d.id) pc ON TRUE
   WHERE a.attempted_at >= $1
     AND p.client_id IS NOT NULL
     AND p.status IS DISTINCT FROM 'archived'
     AND p.menu_not_required IS NOT TRUE
     AND p.menu_print_key IS NULL
     AND (p.event_date IS NULL OR to_char(p.event_date, 'YYYY-MM-DD') >= $2::text)
     AND p.id <> ALL($3::int[])
     AND NOT EXISTS (SELECT 1 FROM proposals h WHERE h.id = ANY($3::int[]) AND h.client_id = p.client_id))`;

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

// The Sentry seam (readJob.js's pattern) and the rows already reported this
// process ('proof:<id>' or 'run:<proposal id>'), so a bad row warns once, not
// on every 30-second load.
let deps = { sentry: Sentry };
const reported = new Set();
function reportUnreadable(row) {
  const run = row.task_row === 'run';
  const id = Number(run ? row.proposal_id : row.id);
  const key = `${run ? 'run' : 'proof'}:${id}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(run ? `[inbox] menu auto-start ${id} could not be read; its task is skipped`
    : `[inbox] menu proof ${id} could not be read; its task is skipped`);
  deps.sentry.captureMessage(run ? '[inbox] a menu auto-start row could not be read' : '[inbox] a menu proof row could not be read', {
    level: 'warning',
    tags: { area: 'inbox', issue: 'menu_task_row' },
    extra: run ? { proposal_id: id } : { proof_id: id },
  });
}

function taskEvent(kind, row, personKey, at, text = MENU_TASK_TEXTS[kind]) { // eslint-disable-line security/detect-object-injection -- kind is one of this file's four literal kinds
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

const OPEN = new Set(['pending', 'working']);
const FIXED = new Set(FIXED_TEXTS);
const ERROR_SENTENCES = new Set([...FIXED_TEXTS, ...Object.values(AUTO_START_SENTENCES)]);
// A JSON ISO instant as Postgres writes one for a timestamptz: a date, a time
// with up to microseconds, and Z or an hours-and-minutes offset.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, and every repeat is bounded: no backtracking blow-up
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

// content.words_finished_at as an instant, or null when it was never stamped.
// Anything else stored there throws: the row is unreadable.
function stampOf(value) {
  if (value === null || value === undefined) return null;
  const at = typeof value === 'string' && ISO_INSTANT.test(value) ? new Date(value) : null;
  if (!at || !Number.isFinite(at.getTime())) throw new Error('readMenuTasks: words_finished_at is not an instant');
  return at;
}

const failedTask = (row, personKey, sentence) => taskEvent('menu_failed', row, personKey, new Date(row.attempted_at),
  `${MENU_TASK_TEXTS.menu_failed}${sentence}`);

// The one open run task of an auto-start row (header), or null. Throws on a row it cannot read.
function runTaskOf(row, personKey) {
  const hasDraft = row.draft_id !== null && row.draft_id !== undefined;
  if (row.error_code !== null && row.error_code !== undefined) {
    // A refusal stands until a run exists (a manual Generate since).
    if (hasDraft) return null;
    return failedTask(row, personKey, ERROR_SENTENCES.has(row.error_sentence) ? row.error_sentence : AUTO_START_SENTENCES.notStarted);
  }
  if (!row.run_id) return !hasDraft && row.dead_start === true ? failedTask(row, personKey, AUTO_START_SENTENCES.notStarted) : null;
  // The draft is gone, or a later run (a manual Generate) replaced the auto one.
  if (!hasDraft || row.current_run_id !== row.run_id) return null;
  const now = row.db_now;
  // a. Words open: in flight, or stopped partway (a restart while writing).
  if (OPEN.has(row.words_status)) {
    return stuck({ words_status: row.words_status, words_heartbeat_at: row.words_heartbeat_at }, now)
      ? failedTask(row, personKey, AUTO_START_SENTENCES.interrupted) : null;
  }
  // b. Words failed (or never written): the job's own fixed sentence.
  if (row.words_status !== 'done') {
    return failedTask(row, personKey, FIXED.has(row.words_error) ? row.words_error : AUTO_START_SENTENCES.notStarted);
  }
  // c. A proof out: the menu is with the client, whatever the pictures do.
  if (row.has_proof === true) return null;
  // d. A picture still drawing (any open one fresh; a just-created one is,
  // stamped as it was asked for): in flight. e. Every open picture stopped
  // (a restart): ready, those pictures counted as failed.
  const open = Number(row.pieces_open) || 0;
  if (open > 0 && !stuck({ status: 'working', heartbeat_at: row.open_newest_beat }, now)) return null;
  const finished = [stampOf(row.words_finished_at), row.pieces_finished_at ? new Date(row.pieces_finished_at) : null]
    .filter(Boolean).map((d) => d.getTime());
  const at = new Date(finished.length ? Math.max(...finished) : new Date(row.attempted_at).getTime());
  // f. Nothing open: ready, with the pictures that failed.
  const n = (Number(row.pieces_failed) || 0) + open;
  const text = n > 0 ? `${MENU_TASK_TEXTS.menu_ready} · ${n} ${n === 1 ? 'picture' : 'pictures'} failed` : MENU_TASK_TEXTS.menu_ready;
  return taskEvent('menu_ready', row, personKey, at, text);
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
      task = row.task_row === 'run' ? runTaskOf(row, personKey) : taskOfRow(row, personKey, nowMs);
    } catch {
      reportUnreadable(row);
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
  MENU_TASKS_SQL, MENU_TASK_TEXTS, NO_ANSWER_BESIDE_UPLOAD, AUTO_START_SENTENCES, menuTaskParams, mapMenuTaskRows, loadMenuTaskDetails, __setMenuTaskDeps, __resetMenuTaskDeps,
};
