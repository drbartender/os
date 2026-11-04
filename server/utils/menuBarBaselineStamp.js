// The one-time bar baseline for menu drafts made before the per-line bar check, stamped by the server itself at its first production boot after the deploy (spec 2026-10-19 section 17, lane menu-bar-baseline).
//
// A draft fingerprinted before bar_lines existed reads its bar as unchanged
// (menuDraftRead.computeDiff) until it has a baseline. Stamping it on the
// first page read took any bar change made before that read as the baseline;
// a script needs a production connection this repo's dev box cannot hold. So
// the server stamps every such draft at boot, from today's picks
// (legacyBarBaseline): a category the stored lines prove came or went since
// Generate still reads as a change, so the card flags it.
//
// It writes plan_fingerprint only (bar_lines and bar_hash), one conditional
// UPDATE per draft whose WHERE skips a draft a Generate or an Update draft
// stamped in between. It never writes content, so no draft PATCH can clobber
// it or be clobbered; the line keys are derived by Update draft under its row
// lock (keyBarLines). It bumps no version (an approved draft stays approved),
// and the menu_drafts updated_at trigger skips a write that changes only the
// fingerprint, so the card's Saved time does not move. It skips the legal-hold
// proposal (money law 15, isLegalHold, which fails closed) and a draft whose
// proposal has no plan, and lists a legacy draft whose words are not done yet
// (its words land unstamped). A row that fails is listed and the rest go on.
//
// runAtBoot logs one line of counts and draft ids (never content) and reports
// a failure to Sentry, never throwing. The production scheduler block in
// server/index.js runs it at boot and again once the outgoing instance of the
// deploy has stopped serving, since that instance's shipped code can still
// finish or rewrite a draft without a baseline; once every draft is stamped it
// selects only the skipped ones. Update draft gives any draft it reaches first
// the same baseline.
'use strict';

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { loadEventPlan, loadCatalogMaps, normalizePlan, buildFingerprint, legacyBarBaseline } = require('./menuDrinkSource');
const { keyBarLines } = require('./menuAlsoAtBar');
const { isLegalHold } = require('./legalHold');

const SELECT_SQL = `
  SELECT d.id AS draft_id, d.proposal_id, d.content
    FROM menu_drafts d
   WHERE jsonb_typeof(d.plan_fingerprint) = 'object'
     AND NOT d.plan_fingerprint ? 'bar_lines'
     AND jsonb_typeof(d.content) = 'object'
     AND d.content->>'words_status' = 'done'
     AND ($1::int[] IS NULL OR d.id = ANY($1::int[]))
   ORDER BY d.id`;

// Legacy drafts whose words are not done: listed, since their words land without a baseline.
const PENDING_SQL = `
  SELECT d.id AS draft_id
    FROM menu_drafts d
   WHERE jsonb_typeof(d.plan_fingerprint) = 'object'
     AND NOT d.plan_fingerprint ? 'bar_lines'
     AND NOT (jsonb_typeof(d.content) = 'object' AND d.content->>'words_status' = 'done')
     AND ($1::int[] IS NULL OR d.id = ANY($1::int[]))
   ORDER BY d.id`;

const STAMP_SQL = `
  UPDATE menu_drafts
     SET plan_fingerprint = plan_fingerprint || jsonb_build_object('bar_lines', $2::jsonb, 'bar_hash', $3::text)
   WHERE id = $1 AND jsonb_typeof(plan_fingerprint) = 'object' AND NOT plan_fingerprint ? 'bar_lines'`;

const labelsDiffer = (a, b) => Object.keys(a).some((k) => !Object.prototype.hasOwnProperty.call(b, k))
  || Object.keys(b).some((k) => !Object.prototype.hasOwnProperty.call(a, k));

// onlyDraftIds is a test seam: production passes nothing and reads every draft.
async function stampLegacyBarBaselines({ db = pool, onlyDraftIds = null } = {}) {
  const out = { stamped: [], flagged: [], unkeyed: [], raced: [], legalHold: [], noPlan: [], failed: [], pending: [] };
  out.pending = (await db.query(PENDING_SQL, [onlyDraftIds])).rows.map((r) => Number(r.draft_id));
  const { rows } = await db.query(SELECT_SQL, [onlyDraftIds]);
  if (!rows.length) return out;
  const maps = await loadCatalogMaps(db);
  let firstError = null;
  for (const row of rows) {
    const id = Number(row.draft_id);
    // isLegalHold fails closed and throws only when its list is missing: that
    // stops the run before any plan read or write, as it should.
    if (isLegalHold(row.proposal_id)) { out.legalHold.push(id); continue; }
    try {
      const plan = await loadEventPlan(row.proposal_id, db);
      if (!plan) { out.noPlan.push(id); continue; }
      const normalized = normalizePlan(plan, maps);
      const today = buildFingerprint(normalized).bar_lines;
      const keyed = keyBarLines(row.content.also_at_bar);
      const base = legacyBarBaseline(keyed.lines, normalized);
      const r = await db.query(STAMP_SQL, [id, base.bar_lines, base.bar_hash]);
      if (r.rowCount !== 1) { out.raced.push(id); continue; }
      out.stamped.push(id);
      if (labelsDiffer(base.bar_lines, today)) out.flagged.push(id);
      if (keyed.unkeyed) out.unkeyed.push(id);
    } catch (err) {
      out.failed.push(id);
      firstError = firstError || err;
    }
  }
  if (firstError) out.error = firstError;
  return out;
}

function runAtBoot({ logger = console, stamp = stampLegacyBarBaselines } = {}) {
  return Promise.resolve()
    .then(() => stamp())
    .then((r) => {
      const seen = r.stamped.length + r.raced.length + r.legalHold.length + r.noPlan.length + r.failed.length + r.pending.length;
      if (seen) {
        logger.log(`[menu-bar-baseline] stamped ${r.stamped.length} draft(s) ${JSON.stringify(r.stamped)}; `
          + `flagged as changed since Generate ${JSON.stringify(r.flagged)}; lines left unkeyed ${JSON.stringify(r.unkeyed)}; `
          + `skipped: legal hold ${r.legalHold.length}, no plan ${JSON.stringify(r.noPlan)}, stamped meanwhile ${JSON.stringify(r.raced)}, `
          + `words not done ${JSON.stringify(r.pending)}; failed ${JSON.stringify(r.failed)}`);
      }
      if (r.error) {
        logger.error(`[menu-bar-baseline] ${r.failed.length} draft(s) failed and stay unstamped until the next run: ${r.error.message}`);
        Sentry.captureException(r.error, { tags: { task: 'menu-bar-baseline' } });
      }
      return r;
    })
    .catch((err) => {
      logger.error(`[menu-bar-baseline] failed, nothing more stamped this boot: ${err.message}`);
      Sentry.captureException(err, { tags: { task: 'menu-bar-baseline' } });
      return null;
    });
}

module.exports = { stampLegacyBarBaselines, runAtBoot };
