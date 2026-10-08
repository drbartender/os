'use strict';

// The Inbox engine (spec 5.7 as amended by 18, and spec 8). Two passes behind
// one 30-second in-process cache that the list, the item, the badge and the AI
// read job share:
//   pass 1: light headers (no message text) for every row since
//           INBOX_HISTORY_START, and the rules over them, which say who is
//           waiting, snoozed, or closed in the last 7 days;
//   pass 2: full rows (bodies, media, subjects) for those people only.
// Pass 1 is a header scan, not SQL aggregates, so its cost grows with all the
// traffic since the floor: a few thousand rows today. Past HEADER_WARN_ROWS
// (every pass-1 row: the five readers' headers, the AI reads and the taps) it
// warns once per process, in the log and in Sentry, the signal to move pass 1
// to aggregates. A source query that fails fails the whole load: a partial
// list that looks complete is the one thing Inbox must never show (spec 12).

const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { chicagoYmdOf } = require('../businessTime');
const { isBooked } = require('../proposalStatus');
const { LEGAL_HOLD_PROPOSAL_IDS } = require('../staleProposalSweep');
const cache = require('./cache');
const { INBOX_HISTORY_START, BADGE_TIMEOUT_MS, BADGE_MAX_AGE_MS, HEADER_WARN_ROWS } = require('./constants');
const { parsePersonKey } = require('./personKey');
const { loadPeopleIndex, latestPhoneOf } = require('./people');
const { SMS_HEADERS_SQL, mapSmsHeader } = require('./readSms');
const { TT_HEADERS_SQL, mapThumbtackHeader } = require('./readThumbtack');
const { ML_HEADERS_SQL, mapMessageLogHeader } = require('./readMessageLog');
const { PAL_HEADERS_SQL, mapProposalSendHeader } = require('./readProposalSends');
const { CALL_HEADERS_SQL, mapCallHeader } = require('./readCalls');
const { loadDetails, mergeDetails } = require('./details');
const { foldTaps } = require('./aliases');
const { normalizeEvents } = require('./normalize');
const { computeInbox } = require('./rules');
const { listPayload, itemPayload } = require('./payload');
const { chooseProposal, phoneDisplay } = require('./contextFormat');
const { loadFeeds } = require('./feeds');
const { aiReadStatus } = require('./aiStatus');
const { NotFoundError } = require('../errors');
const { last10 } = require('../phone');
const { loadContext } = require('./context');
const { buildReplyBlock } = require('./reply');

const ACTIONS_SQL = `
  SELECT id, person_key, action, until_at, user_id, created_at, undone_at
    FROM inbox_actions
   WHERE undone_at IS NULL AND created_at >= $1`;
const SEEN_SQL = 'SELECT person_key, seen_at, seen_by FROM inbox_seen';
const READS_SQL = `
  SELECT kind, subject_ref, person_key, status, needs_reply, holding, summary, promised_by, reason, attempts, created_at, updated_at
    FROM inbox_reads
   WHERE created_at >= $1`;
const PROPOSALS_SQL = `
  SELECT id, client_id, status, to_char(event_date, 'YYYY-MM-DD') AS event_date, created_at
    FROM proposals
   WHERE client_id = ANY($1::int[])`;

const CLIENT_EXISTS_SQL = 'SELECT 1 FROM clients WHERE id = $1';

class InboxMovedError extends NotFoundError {
  constructor(movedTo) {
    super('This conversation moved.');
    this.code = 'INBOX_MOVED';
    this.movedTo = movedTo;
  }
}

const defaultDeps = () => ({ computeSnapshot: null, legalHoldIds: LEGAL_HOLD_PROPOSAL_IDS });
let _deps = defaultDeps();
function __setEngineDeps(d) { _deps = { ..._deps, ...d }; cache.invalidate(); }
function __resetEngine() { _deps = defaultDeps(); cache.invalidate(); }

function groupBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const k = keyFn(item);
    const bucket = out.get(k) || [];
    bucket.push(item);
    out.set(k, bucket);
  }
  return out;
}

// Pass 1 past HEADER_WARN_ROWS: said once per process, in the log and, when
// Sentry is set up, there too (Render logs are not watched). Counts only:
// never a phone, a name or a body.
let headerWarningSent = false;
function warnHeaderRows(headerRows) {
  if (headerRows <= HEADER_WARN_ROWS || headerWarningSent) return;
  headerWarningSent = true;
  console.warn(`[inbox] pass 1 read ${headerRows} header rows (over ${HEADER_WARN_ROWS}): time to move it to SQL aggregates`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('[inbox] pass 1 passed HEADER_WARN_ROWS', { level: 'warning', extra: { headerRows, limit: HEADER_WARN_ROWS } });
  }
}

// Reads are never narrowed by person_key: the rules match a read by its
// subject_ref, so a read written before a re-key still counts (amendment 22).
function assembleSnapshot({ now, index, events, actions, seen, reads, proposals, feeds, fullKeys }) {
  const keep = (rows) => rows.filter((r) => fullKeys.has(r.person_key));
  return {
    now, index, feeds, fullKeys,
    eventsByPerson: groupBy(events, (e) => e.personKey),
    inputs: { actions, seen, reads, proposals, users: index.users },
    sInputs: { actions: keep(actions), seen: keep(seen), reads, proposals: keep(proposals), users: index.users },
  };
}

async function computeSnapshot({ now = new Date(), db = pool } = {}) {
  const floor = INBOX_HISTORY_START;
  const [index, sms, tt, ml, pal, calls, actions, seen, reads, feeds] = await Promise.all([
    loadPeopleIndex(db),
    db.query(SMS_HEADERS_SQL, [floor]),
    db.query(TT_HEADERS_SQL, [floor]),
    db.query(ML_HEADERS_SQL, [floor]),
    db.query(PAL_HEADERS_SQL, [floor]),
    db.query(CALL_HEADERS_SQL, [floor]),
    db.query(ACTIONS_SQL, [floor]),
    db.query(SEEN_SQL),
    db.query(READS_SQL, [floor]),
    loadFeeds({ now }, db),
  ]);
  warnHeaderRows(sms.rows.length + tt.rows.length + ml.rows.length + pal.rows.length + calls.rows.length
    + reads.rows.length + actions.rows.length);
  const headers = normalizeEvents([
    ...sms.rows.map((r) => mapSmsHeader(r, index)),
    ...tt.rows.map((r) => mapThumbtackHeader(r, index)),
    ...ml.rows.map((r) => mapMessageLogHeader(r)),
    ...pal.rows.map((r) => mapProposalSendHeader(r)),
    ...calls.rows.map((r) => mapCallHeader(r, index)),
  ].filter(Boolean));
  // Taps stored under a person's alias keys fold onto their current key.
  const taps = foldTaps({ actions: actions.rows, seen: seen.rows, events: headers, index });
  const clientIds = [...new Set([...headers.map((e) => e.personKey), ...taps.actions.map((a) => a.person_key)]
    .map((k) => parsePersonKey(k)).filter((k) => k && k.type === 'c').map((k) => Number(k.id)))];
  const proposalRows = clientIds.length ? (await db.query(PROPOSALS_SQL, [clientIds])).rows : [];
  const holds = new Set((_deps.legalHoldIds || []).map(Number));
  const proposals = proposalRows.map((p) => ({ ...p, person_key: `c-${p.client_id}`, legal_hold: holds.has(Number(p.id)) }));
  // Pass 1: the rules over light headers say whose rows are worth loading in full.
  const first = computeInbox({
    events: headers, actions: taps.actions, seen: taps.seen, reads: reads.rows, proposals, users: index.users, now, viewerId: null,
  });
  const fullKeys = new Set([...first.waiting, ...first.snoozed, ...first.handled].map((p) => p.personKey));
  // Pass 2: full rows for those people only.
  const wanted = headers.filter((e) => fullKeys.has(e.personKey));
  const full = mergeDetails(wanted, await loadDetails(wanted, db));
  const events = [...headers.filter((e) => !fullKeys.has(e.personKey)), ...full];
  return assembleSnapshot({ now, index, events, actions: taps.actions, seen: taps.seen, reads: reads.rows, proposals, feeds, fullKeys });
}

// maxAgeMs: how old a cached snapshot this caller accepts (CACHE_MS unless given).
function getSnapshot({ maxAgeMs } = {}) {
  return cache.getOrCompute(() => (_deps.computeSnapshot || computeSnapshot)({ now: new Date() }), { maxAgeMs });
}

function runRules(snap, viewerId, nameOf = null) {
  const events = [];
  for (const key of snap.fullKeys) events.push(...(snap.eventsByPerson.get(key) || []));
  return computeInbox({ events, ...snap.sInputs, now: snap.now, viewerId, nameOf });
}

function directoryFor(snap) {
  const today = chicagoYmdOf(snap.now);
  const props = groupBy(snap.inputs.proposals, (p) => p.person_key);
  return {
    // The person's real display name, or null: never a fallback label or a
    // phone number. This is the name lane inbox-ai's subjects carry.
    realNameOf(personKey) {
      const key = parsePersonKey(personKey);
      if (!key) return null;
      if (key.type === 'c') return (snap.index.clients.get(Number(key.id)) || {}).name || null;
      if (key.type === 's') return (snap.index.staff.get(Number(key.id)) || {}).name || null;
      if (key.type === 't') return (snap.index.leadsByNegotiation.get(key.id) || {}).customer_name || null;
      return null;
    },
    // What the page shows: the real name, else a label or the number.
    nameOf(personKey) {
      const key = parsePersonKey(personKey);
      if (!key) return 'Unknown';
      if (key.type === 'c') return (snap.index.clients.get(Number(key.id)) || {}).name || 'Client';
      if (key.type === 's') return (snap.index.staff.get(Number(key.id)) || {}).name || 'Staff';
      if (key.type === 't') return (snap.index.leadsByNegotiation.get(key.id) || {}).customer_name || 'Thumbtack lead';
      return phoneDisplay(latestPhoneOf(snap.eventsByPerson.get(personKey) || [])) || 'Unknown number';
    },
    kindOf(personKey) {
      const key = parsePersonKey(personKey);
      if (!key) return 'unknown';
      if (key.type === 'c') {
        const chosen = chooseProposal(props.get(personKey) || [], today);
        return chosen && isBooked(chosen.status) ? 'client' : 'lead';
      }
      if (key.type === 's') return 'staff';
      if (key.type === 't') return 'tt_lead';
      return 'unknown';
    },
  };
}

async function getInbox({ viewerId }) {
  const snap = await getSnapshot();
  const aiStatus = await aiReadStatus();
  return listPayload({ result: runRules(snap, viewerId), directory: directoryFor(snap), feeds: snap.feeds, aiStatus, generatedAt: snap.now });
}

async function fullEventsFor(snap, personKey, db = pool) {
  const events = snap.eventsByPerson.get(personKey) || [];
  if (snap.fullKeys.has(personKey) || !events.length) return events;
  return mergeDetails(events, await loadDetails(events, db));
}

// The person's own taps and proposals; every read, matched by subject_ref.
function inputsFor(snap, personKey) {
  const mine = (rows) => rows.filter((r) => r.person_key === personKey);
  const { actions, seen, reads, proposals, users } = snap.inputs;
  return { actions: mine(actions), seen: mine(seen), reads, proposals: mine(proposals), users };
}

// Does the key still name a person, and if not, where did they go (spec 4.2)?
// A key parsePersonKey rejects names no one (the route checks first; this is
// for any other caller).
async function resolveKey(personKey, snap, db = pool) {
  const key = parsePersonKey(personKey);
  if (!key) return { missing: true };
  const ix = snap.index;
  const hasEvents = (snap.eventsByPerson.get(personKey) || []).length > 0;
  if (key.type === 'c') {
    if (ix.clients.has(Number(key.id))) return {};
    const { rowCount } = await db.query(CLIENT_EXISTS_SQL, [Number(key.id)]);
    return rowCount ? {} : { missing: true };
  }
  if (key.type === 's') {
    if (ix.staffEligible.has(Number(key.id))) return {};
    const phone = ix.profilePhones.get(Number(key.id));
    const now = phone ? ix.resolvePhone(last10(phone), snap.now) : null;
    if (now && now !== personKey && (snap.eventsByPerson.get(now) || []).length) return { movedTo: now };
    return hasEvents ? {} : { missing: true };
  }
  if (key.type === 'p') {
    if (!/^\d{10}$/.test(key.id)) return { missing: true };
    // A key that still has events stays, as the alias fold keeps its taps
    // (aliases.js rule 1): its number may resolve elsewhere now (a newer
    // Thumbtack lead took it as a proxy) while its older texts stay under p-.
    if (hasEvents) return {};
    const now = ix.resolvePhone(key.id, snap.now);
    if (!now) return { missing: true }; // one of our own numbers
    if (now !== personKey) return { movedTo: now }; // e.g. an unknown number became a client
    return { missing: true };
  }
  const lead = ix.leadsByNegotiation.get(key.id);
  if (lead && lead.client_id) return { movedTo: `c-${lead.client_id}` };
  return lead || hasEvents ? {} : { missing: true };
}

async function getItem({ personKey, viewerId }) {
  const snap = await getSnapshot();
  const where = await resolveKey(personKey, snap);
  if (where.movedTo) throw new InboxMovedError(where.movedTo);
  if (where.missing) throw new NotFoundError('That conversation is not in the inbox.');
  const events = await fullEventsFor(snap, personKey);
  const inputs = inputsFor(snap, personKey);
  const state = computeInbox({ events, ...inputs, now: snap.now, viewerId }).people.get(personKey) || null;
  const [ctx, reply] = await Promise.all([
    loadContext({ personKey, index: snap.index, events, todayYmd: chicagoYmdOf(snap.now), legalHoldIds: _deps.legalHoldIds || [] }),
    buildReplyBlock({ personKey, events, index: snap.index, viewerId }),
  ]);
  return itemPayload({
    personKey, state, events, actions: inputs.actions, reads: inputs.reads, now: snap.now, viewerId,
    users: snap.index.users, directory: directoryFor(snap), context: ctx.context, legalHold: ctx.legalHold, reply,
  });
}

// The badge (spec 8): never rejects, and never waits past timeoutMs. It reads
// a snapshot up to BADGE_MAX_AGE_MS old (two 60-second polls; any write still
// clears it), so one open tab does not recompute the inbox on every poll, and
// a slow load keeps running and fills the cache for the next poll.
async function getWaitingCount({ timeoutMs = BADGE_TIMEOUT_MS } = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const work = getSnapshot({ maxAgeMs: BADGE_MAX_AGE_MS })
    .then((snap) => runRules(snap, null).waiting.length)
    .catch((err) => {
      console.warn('[inbox] badge count unavailable:', err && err.message);
      return null;
    });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// For lane inbox-ai's read job: subjects with the real name or null, never
// the legal-hold client (decision 31; computeInbox flags them, and this is
// where they stop). The same 30-second cached snapshot the page reads
// (amendment 18); only fresh: true bypasses it. maxAgeMs lets the job accept
// an older one, as the badge does (lane inbox-ai reads at BADGE_MAX_AGE_MS,
// so an always-on read job does not recompute the inbox every tick). A `now`
// is accepted and ignored.
async function getReadSubjects({ fresh = false, maxAgeMs } = {}) {
  if (fresh) cache.invalidate();
  const snap = await getSnapshot({ maxAgeMs });
  return runRules(snap, null, directoryFor(snap).realNameOf).subjects.filter((s) => !s.legalHold);
}

// For the text route: the person's full events and the index, optionally after
// a fresh load so the reply goes to the number they texted from seconds ago.
async function getPersonEvents(personKey, { fresh = false } = {}) {
  if (fresh) cache.invalidate();
  const snap = await getSnapshot();
  return { events: await fullEventsFor(snap, personKey), index: snap.index, now: snap.now };
}

// Test seam: a snapshot built from invented, already-full events, no DB.
function __fakeSnapshot({ now = new Date(), events = [] } = {}) {
  const normalized = normalizeEvents(events);
  const index = {
    users: [], clients: new Map(), staff: new Map(), staffEligible: new Set(), leadsByNegotiation: new Map(),
    latestLeadByClient: new Map(), profilePhones: new Map(), resolvePhone: () => null, isProxyPhone: () => false,
  };
  return assembleSnapshot({
    now, index, events: normalized, actions: [], seen: [], reads: [], proposals: [], feeds: [],
    fullKeys: new Set(normalized.map((e) => e.personKey)),
  });
}

module.exports = {
  getInbox, getItem, getWaitingCount, getReadSubjects, getPersonEvents, computeSnapshot,
  invalidate: () => cache.invalidate(), InboxMovedError, __setEngineDeps, __resetEngine, __fakeSnapshot,
};
