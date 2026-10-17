'use strict';
// The override conversion's forward and reverse DO blocks (plan
// 2026-10-16-price-override-removal, Task V3; spec 8.5, decision 10).
//
// Forward: one DO $conv$ block. It locks every target row, then per row checks
// the md5 of its money columns against the export (never updated_at, which a
// page view moves), writes in-place rows with jsonb operations (the line
// appended to adjustments and to the snapshot's copy, the breakdown row at the
// slot the transform computed with insertAdjustmentBreakdownRow, total set,
// override cleared) and live rows with their full after-snapshot, asserts each
// write touched one row, and logs one proposal_activity_log row that records
// the row's before-state and after-state md5. Then, from the written JSON
// alone, every row must add up the engine's way. Any failure aborts it all.
//
// Reverse: restores each row's money columns from the before-state its
// forward activity row recorded, only when the row is still exactly the
// after-state (that row's md5), and proves the restore reproduces the
// exported md5. Compact either way: ids, md5s and the new lines only, plus the
// live rows' snapshots.
//
// Every JSON literal is dollar-quoted with a tag proven absent from it. A
// change naming a legal-hold booking is refused, so no block can name one.

const crypto = require('crypto');
const { isLegalHold } = require('../../server/utils/legalHold');
const { validateAdjustments } = require('../../server/utils/adjustmentRules');
const { MONEY_MD5_EXPR } = require('./shared');
const { canonical, breakdownRow, KIND_LIVE, KIND_TERMINAL, KIND_BACKFILL } = require('./transform');

const BLOCK_TAG = '$conv$';
const ACTIONS = Object.freeze({
  [KIND_LIVE]: 'price_override_converted',
  [KIND_TERMINAL]: 'price_override_converted',
  [KIND_BACKFILL]: 'refund_line_backfilled',
});
const PLACEMENTS = Object.freeze(['before_last', 'end', 'none']);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The run's tag: the change set's own hash, shared by both blocks and every activity row. */
function runTag(changes) {
  const body = changes.map((c) => ({ id: c.id, kind: c.kind, money_md5: c.money_md5, lines: c.lines, after: c.after }));
  return crypto.createHash('sha256').update(canonical(body)).digest('hex').slice(0, 16);
}

function jsonLiteral(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('a block literal must be JSON');
  if (text.includes(BLOCK_TAG)) throw new Error('a literal holds the block tag');
  for (let n = 0; ; n += 1) {
    const tag = n === 0 ? '$j$' : `$j${n}$`;
    if ((text + tag).indexOf(tag) === text.length) return `${tag}${text}${tag}::jsonb`;
  }
}

function checkChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('nothing to convert');
  const seen = new Set();
  for (const c of changes) {
    if (!c || !Number.isSafeInteger(c.id) || c.id < 1) throw new Error('every change needs a positive integer id');
    if (seen.has(c.id)) throw new Error(`proposal ${c.id} appears twice`);
    seen.add(c.id);
    if (isLegalHold(c.id)) throw new Error('refusing a change set that names a booking on legal hold');
    if (typeof c.money_md5 !== 'string' || !/^[0-9a-f]{32}$/.test(c.money_md5)) throw new Error(`proposal ${c.id}: not an md5`);
    if (!ACTIONS[c.kind]) throw new Error(`proposal ${c.id}: unknown kind`);
    if (!PLACEMENTS.includes(c.placement)) throw new Error(`proposal ${c.id}: unknown breakdown placement`);
    if (!Array.isArray(c.lines) || validateAdjustments(c.lines).error) throw new Error(`proposal ${c.id}: an invalid line`);
    const source = c.kind === KIND_BACKFILL ? 'refund' : 'agreed_price';
    if (c.lines.some((l) => l.source !== source)) throw new Error(`proposal ${c.id}: a line of the wrong kind`);
    if (c.kind === KIND_BACKFILL ? c.lines.length === 0 : c.lines.length > 1) {
      throw new Error(`proposal ${c.id}: the wrong number of lines`);
    }
    // The block writes the breakdown rows as given and no in-block check reads
    // them, so they must be exactly the rows the lines make.
    if (!Array.isArray(c.breakdownRows) || canonical(c.breakdownRows) !== canonical(c.lines.map(breakdownRow))) {
      throw new Error(`proposal ${c.id}: breakdown rows do not match its lines`);
    }
    if (c.clearOverride !== (c.kind !== KIND_BACKFILL)) throw new Error(`proposal ${c.id}: the override flag does not match its kind`);
    if (!c.after || !isPlainObject(c.after.pricing_snapshot)) throw new Error(`proposal ${c.id}: no after-snapshot`);
    if (c.kind !== KIND_LIVE && !Number.isFinite(c.after.pricing_snapshot.total)) throw new Error(`proposal ${c.id}: no after total`);
  }
}

function wrap(body) {
  if (body.includes(BLOCK_TAG)) throw new Error('the block body holds the block tag');
  return `DO ${BLOCK_TAG}\n${body}\n${BLOCK_TAG};\n`;
}

/** @param {object[]} changes  planConversion().changes @returns {string} the forward DO block */
function renderForwardBlock(changes) {
  checkChanges(changes);
  const tag = runTag(changes);
  const n = changes.length;
  const count = (k) => changes.filter((c) => c.kind === k).length;
  const tuples = changes.map((c) => {
    const live = c.kind === KIND_LIVE;
    return `      (${c.id}, '${c.kind}', '${c.money_md5}', ${jsonLiteral(c.lines)}, ${jsonLiteral(c.breakdownRows)}, `
      + `'${c.placement}', ${live ? 'NULL::jsonb' : jsonLiteral(c.after.pricing_snapshot.total)}, ${c.clearOverride}, `
      + `${live ? jsonLiteral(c.after.pricing_snapshot) : 'NULL::jsonb'})`;
  });
  const fail = (msg) => `RAISE EXCEPTION 'override conversion ${tag}: ${msg}'`;
  return wrap(`-- Override conversion forward block, run ${tag}: ${n} bookings (${count(KIND_LIVE)} live, `
    + `${count(KIND_TERMINAL)} terminal, ${count(KIND_BACKFILL)} refund backfill).
-- Rendered by scripts/override-conversion/run.js (plan 2026-10-16-price-override-removal, Task V3). Never edit by hand.
DECLARE
  v_ids integer[] := '{${changes.map((c) => c.id).join(',')}}';
  c record;
  r record;
  v_n integer;
  v_md5 text;
  v_after_md5 text;
  v_before jsonb;
  v_snap jsonb;
  v_sub numeric;
  v_net numeric;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true); -- a lock wait fails fast and writes nothing
  PERFORM 1 FROM proposals WHERE id = ANY(v_ids) ORDER BY id FOR NO KEY UPDATE;
  SELECT count(*) INTO v_n FROM proposals WHERE id = ANY(v_ids);
  IF v_n IS DISTINCT FROM ${n} THEN
    ${fail(`% of ${n} bookings found`)}, v_n;
  END IF;

  FOR c IN
    SELECT * FROM (VALUES
${tuples.join(',\n')}
    ) AS t(id, kind, money_md5, lines, brows, placement, total, clear_override, snapshot)
    ORDER BY id
  LOOP
    SELECT ${MONEY_MD5_EXPR},
           jsonb_build_object('adjustments', adjustments, 'adjustments_is_null', adjustments IS NULL,
                              'pricing_snapshot', pricing_snapshot, 'total_price_override', total_price_override),
           pricing_snapshot
      INTO v_md5, v_before, v_snap
      FROM proposals WHERE id = c.id;
    IF v_md5 IS DISTINCT FROM c.money_md5 THEN
      ${fail('proposal % changed since the export')}, c.id;
    END IF;
    IF c.snapshot IS NOT NULL THEN
      v_snap := c.snapshot;
    ELSE
      v_snap := jsonb_set(v_snap, '{adjustments}', COALESCE(v_snap->'adjustments', '[]'::jsonb) || c.lines);
      IF c.placement = 'before_last' THEN
        v_snap := jsonb_set(v_snap, '{breakdown}',
          ((v_snap->'breakdown') - (-1)) || c.brows || jsonb_build_array((v_snap->'breakdown') -> (-1)));
      ELSIF c.placement = 'end' THEN
        v_snap := jsonb_set(v_snap, '{breakdown}', (v_snap->'breakdown') || c.brows);
      END IF;
      IF c.clear_override THEN
        v_snap := jsonb_set(v_snap, '{total_price_override}', 'null'::jsonb);
      END IF;
      v_snap := jsonb_set(v_snap, '{total}', c.total);
    END IF;
    IF v_snap IS NULL OR jsonb_typeof(v_snap) IS DISTINCT FROM 'object' THEN
      ${fail('proposal %: no snapshot to write')}, c.id;
    END IF;
    UPDATE proposals
       SET adjustments = COALESCE(adjustments, '[]'::jsonb) || c.lines,
           pricing_snapshot = v_snap,
           total_price_override = CASE WHEN c.clear_override THEN NULL ELSE total_price_override END
     WHERE id = c.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n IS DISTINCT FROM 1 THEN
      ${fail('proposal %: % rows written')}, c.id, v_n;
    END IF;
    SELECT ${MONEY_MD5_EXPR} INTO v_after_md5 FROM proposals WHERE id = c.id;
    INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
    VALUES (c.id,
            CASE WHEN c.kind = '${KIND_BACKFILL}' THEN '${ACTIONS[KIND_BACKFILL]}' ELSE '${ACTIONS[KIND_TERMINAL]}' END,
            'system',
            jsonb_build_object('run', '${tag}', 'kind', c.kind, 'lines', c.lines, 'before_md5', c.money_md5,
                               'after_md5', v_after_md5, 'before', v_before));
  END LOOP;

  -- Every written row adds up from its own JSON, the engine's way:
  -- max(0, subtotal + net of the lines) + gratuity = total_price = snapshot total.
  FOR r IN SELECT id, total_price, total_price_override, adjustments, pricing_snapshot
             FROM proposals WHERE id = ANY(v_ids) ORDER BY id LOOP
    IF r.total_price_override IS NOT NULL THEN
      ${fail('proposal % still carries an override')}, r.id;
    END IF;
    IF r.total_price IS NULL THEN
      ${fail('proposal % has no total_price')}, r.id;
    END IF;
    IF jsonb_typeof(r.adjustments) IS DISTINCT FROM 'array'
       OR r.adjustments IS DISTINCT FROM r.pricing_snapshot->'adjustments' THEN
      ${fail('proposal %: row and snapshot lines differ')}, r.id;
    END IF;
    v_sub := (r.pricing_snapshot->>'subtotal')::numeric;
    IF v_sub IS NULL THEN
      ${fail('proposal %: the snapshot has no subtotal')}, r.id;
    END IF;
    SELECT COALESCE(sum(CASE WHEN e->>'type' = 'discount' THEN -1 ELSE 1 END
                        * abs(COALESCE(NULLIF(btrim(e->>'amount'), '')::numeric, 0))), 0)
      INTO v_net FROM jsonb_array_elements(r.adjustments) AS e;
    IF round(GREATEST(0, v_sub + v_net) + COALESCE((r.pricing_snapshot->'gratuity'->>'total')::numeric, 0), 2)
       IS DISTINCT FROM r.total_price THEN
      ${fail('proposal %: the arithmetic does not add up to total_price')}, r.id;
    END IF;
    IF (r.pricing_snapshot->>'total')::numeric IS DISTINCT FROM r.total_price THEN
      ${fail('proposal %: the snapshot total is not total_price')}, r.id;
    END IF;
  END LOOP;
END`);
}

/**
 * @param {object[]} changes  the WHOLE change set the forward block was rendered from
 * @param {{ onlyIds?: number[] }} [opts]  restore only these rows (the rest of a run
 *   when some row moved after the forward block); the tag stays the whole run's,
 *   so each row still finds its activity record
 * @returns {string}
 */
function renderReverseBlock(changes, { onlyIds } = {}) {
  checkChanges(changes);
  const tag = runTag(changes);
  let subset = changes;
  if (onlyIds !== undefined) {
    if (!Array.isArray(onlyIds) || onlyIds.length === 0) throw new Error('a subset reverse names no rows');
    const ids = new Set(changes.map((c) => c.id));
    const stray = onlyIds.filter((id) => !ids.has(id));
    if (stray.length) throw new Error(`a subset reverse names rows not in the change set: ${stray.join(', ')}`);
    subset = changes.filter((c) => onlyIds.includes(c.id));
  }
  const n = subset.length;
  const tuples = subset.map((c) => `      (${c.id}, '${c.money_md5}', '${ACTIONS[c.kind]}')`);
  const fail = (msg) => `RAISE EXCEPTION 'override reversal ${tag}: ${msg}'`;
  return wrap(`-- Override conversion REVERSE block for run ${tag}: ${n} of ${changes.length} bookings. Restores each row's money columns from
-- the before-state its forward activity row recorded, only while the row is exactly as the forward block left it.
-- Rendered by scripts/override-conversion/run.js (plan 2026-10-16-price-override-removal, Task V3). Never edit by hand.
DECLARE
  v_ids integer[] := '{${subset.map((c) => c.id).join(',')}}';
  c record;
  v_n integer;
  v_md5 text;
  v_log jsonb;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true); -- a lock wait fails fast and writes nothing
  PERFORM 1 FROM proposals WHERE id = ANY(v_ids) ORDER BY id FOR NO KEY UPDATE;
  SELECT count(*) INTO v_n FROM proposals WHERE id = ANY(v_ids);
  IF v_n IS DISTINCT FROM ${n} THEN
    ${fail(`% of ${n} bookings found`)}, v_n;
  END IF;

  FOR c IN
    SELECT * FROM (VALUES
${tuples.join(',\n')}
    ) AS t(id, before_md5, action)
    ORDER BY id
  LOOP
    SELECT details INTO v_log FROM proposal_activity_log
     WHERE proposal_id = c.id AND action = c.action AND details->>'run' = '${tag}'
     ORDER BY id DESC LIMIT 1;
    IF v_log IS NULL THEN
      ${fail('proposal % has no record of the conversion')}, c.id;
    END IF;
    SELECT ${MONEY_MD5_EXPR} INTO v_md5 FROM proposals WHERE id = c.id;
    IF v_md5 IS DISTINCT FROM v_log->>'after_md5' THEN
      ${fail('proposal % changed since the conversion')}, c.id;
    END IF;
    UPDATE proposals
       SET adjustments = CASE WHEN (v_log->'before'->>'adjustments_is_null')::boolean THEN NULL
                              ELSE v_log->'before'->'adjustments' END,
           pricing_snapshot = v_log->'before'->'pricing_snapshot',
           total_price_override = (v_log->'before'->>'total_price_override')::numeric
     WHERE id = c.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n IS DISTINCT FROM 1 THEN
      ${fail('proposal %: % rows written')}, c.id, v_n;
    END IF;
    SELECT ${MONEY_MD5_EXPR} INTO v_md5 FROM proposals WHERE id = c.id;
    IF v_md5 IS DISTINCT FROM c.before_md5 THEN
      ${fail('proposal % did not restore to its exported state')}, c.id;
    END IF;
    INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
    VALUES (c.id, 'override_conversion_reversed', 'system', jsonb_build_object('run', '${tag}', 'reverses', c.action));
  END LOOP;
END`);
}

module.exports = { renderForwardBlock, renderReverseBlock, runTag, ACTIONS };
