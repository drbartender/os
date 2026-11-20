'use strict';

// What the Claude connector's read tools call, in one injectable table: the hold, the shared reads, the Inbox engine, the text guards, Sentry and the clock.
//
// Every tool reaches the database only through what is named here, so a test
// can wrap each shared read and prove that every call site passed the hold
// exclusion it read for that call (connectorMcp.tools.test.js), and no suite
// reads the real held booking. The two small reads that are the tools' own
// (the held clients' names for the hand-made shift check, a booking's client
// id, the event-side drink plan) are SQL constants here, each a single
// parameterized SELECT.
//
// __setToolDeps(overrides) replaces entries for a test; __resetToolDeps()
// restores the real ones.

const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const legalHold = require('../../legalHold');
const { getClientDetail } = require('../../reads/clientDetail');
const { getProposalDetail } = require('../../reads/proposalDetail');
const { listProposals } = require('../../reads/proposalList');
const { listUpcomingEvents } = require('../../reads/upcomingEvents');
const { runGlobalSearch } = require('../../globalSearch');
const engine = require('../../inbox/engine');
const textGuards = require('../textGuards');
const callLog = require('../callLog');
const { notificationsEnabled } = require('../../notificationsEnabled');

// The held clients' names (law 1): a hand-made shift has no proposal for the
// exclusion to catch, only the client name typed on it. Bound to the client
// ids holdExclusion() returned, never read any other way, never logged.
const HELD_CLIENT_NAMES_SQL = 'SELECT name FROM clients WHERE id = ANY($1::int[])';

// The event-side drink plan, the canonical one (project rules): the plan the
// event page's DrinkPlanCard reads (GET /api/drink-plans/by-proposal/:id names
// the first by id when a proposal has two). Status columns only: the plan's
// token, its selections and its notes never leave.
const DRINK_PLAN_SQL = `
  SELECT id, status, serving_type, submitted_at, finalized_at, shopping_list_status
    FROM drink_plans
   WHERE proposal_id = $1
   ORDER BY id
   LIMIT 1`;

// The client of each booking a shift row names (the shift query carries the
// client's name but not their id), so a client's name is one withheld piece
// in every tool. Bound to proposal ids the hold-excluding read returned.
const CLIENT_IDS_SQL = 'SELECT id, client_id FROM proposals WHERE id = ANY($1::int[])';

async function clientIdsFor(proposalIds) {
  const ids = [...new Set((proposalIds || []).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(CLIENT_IDS_SQL, [ids]);
  return new Map(rows.map((r) => [r.id, r.client_id]));
}

async function heldClientNames(clientIds) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return [];
  const { rows } = await pool.query(HELD_CLIENT_NAMES_SQL, [clientIds]);
  return rows.map((r) => r.name).filter((n) => typeof n === 'string' && n.trim() !== '');
}

async function drinkPlanFor(proposalId) {
  const { rows } = await pool.query(DRINK_PLAN_SQL, [proposalId]);
  return rows[0] || null;
}

const defaults = () => ({
  holdExclusion: () => legalHold.holdExclusion(),
  getClientDetail,
  getProposalDetail,
  listProposals,
  listUpcomingEvents,
  runGlobalSearch,
  getInboxExcludingHold: engine.getInboxExcludingHold,
  getItemExcludingHold: engine.getItemExcludingHold,
  getPersonEvents: engine.getPersonEvents,
  holdPredicate: engine.holdPredicate,
  heldClientNames,
  clientIdsFor,
  drinkPlanFor,
  screenClientText: textGuards.screenClientText,
  stripDestinations: textGuards.stripDestinations,
  stripLinks: textGuards.stripLinks,
  // Sentry gets a message and tags only (law 8): never an argument, a result or an error's own text.
  captureMessage: (msg, ctx) => { if (process.env.SENTRY_DSN_SERVER) Sentry.captureMessage(msg, ctx); },
  // The call's own row (callLog.recordCall never throws).
  recordCall: callLog.recordCall,
  // Whether owner emails really go out (the tripwire refusal says so only then).
  notificationsOn: notificationsEnabled,
  now: () => new Date(),
});

let deps = defaults();
function getToolDeps() { return deps; }
function __setToolDeps(overrides) { deps = { ...deps, ...overrides }; }
function __resetToolDeps() { deps = defaults(); }

module.exports = { getToolDeps, __setToolDeps, __resetToolDeps, HELD_CLIENT_NAMES_SQL, DRINK_PLAN_SQL, CLIENT_IDS_SQL };
