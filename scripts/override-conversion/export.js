#!/usr/bin/env node
'use strict';
// The override conversion's export (plan 2026-10-16-price-override-removal,
// Task V1 step 2; spec 8.5, decision 10): reads a Neon BRANCH over pg and
// writes JSON (chmod 600) to the session scratchpad. Nothing passes through
// an MCP call or a chat.
//
//   node scripts/override-conversion/export.js <uri-file> <out.json> [--expect-overrides <census-file>] [--also-held <id,...>]
//
// --expect-overrides names a file of the census's non-held override ids; any
// other override id in the export stops the run with exit 3 and writes nothing.
//
// One read-only REPEATABLE READ transaction: the candidate ids first, then the
// legal-hold seam (plus any --also-held ids, the rehearsal's synthetic hold)
// drops held ids, then one data query for the rest. A held booking's row is
// never read and its id reaches no data query: the refusal is by
// construction, not a filter on rows already read.

const fs = require('fs');
const path = require('path');
const {
  heldCheck, parseIdList, readUriFile, pgConfig, writePrivateJson, argValue, hasOverride, isLiveOverride,
} = require('./shared');

function loadSql() {
  const text = fs.readFileSync(path.join(__dirname, 'export.sql'), 'utf8');
  const parts = text.split(/^-- @@ /m).slice(1).map((part) => part.slice(part.indexOf('\n') + 1).trim());
  if (parts.length !== 2) throw new Error('export.sql must hold exactly two statements (candidates, rows)');
  return { candidatesSql: parts[0], rowsSql: parts[1] };
}

/**
 * @param {object} client  a pg client on the branch
 * @param {{ extraHeldIds?: number[], onlyIds?: number[]|null }} [opts]
 *   onlyIds narrows the candidates (tests); the real run never passes it.
 * @returns {Promise<{ exported_at: string, rows: object[] }>}
 */
async function exportConversion(client, { extraHeldIds = [], onlyIds = null } = {}) {
  const { candidatesSql, rowsSql } = loadSql();
  const isHeld = heldCheck(extraHeldIds);
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const candidates = (await client.query(candidatesSql)).rows.map((r) => r.id);
    let ids = candidates.filter((id) => !isHeld(id));
    if (onlyIds) ids = ids.filter((id) => onlyIds.includes(id));
    const rows = ids.length ? (await client.query(rowsSql, [ids])).rows : [];
    await client.query('COMMIT');
    for (const row of rows) {
      if (!ids.includes(row.id) || isHeld(row.id)) throw new Error('the export returned a row it never asked for');
    }
    return { exported_at: new Date().toISOString(), rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Runbook step 1: the export's override ids must be a subset of the census.
 * @param {{ extraHeldIds?: number[] }} [opts]  ids added to the legal-hold refusal
 * @returns {{ unexpected: number[], missing: number[] }} override ids outside
 *   the census (any one stops the run), and census ids that carry no override now
 */
function checkCensus(rows, censusIds, { extraHeldIds = [] } = {}) {
  // A held id in the census file is dropped first: the export never holds a
  // held row, so it would otherwise print as "no override now", and no held id
  // is ever compared or printed.
  const isHeld = heldCheck(extraHeldIds);
  const census = new Set(censusIds.map(Number).filter((id) => !isHeld(id)));
  const overrides = rows.filter(hasOverride).map((r) => r.id);
  return {
    unexpected: overrides.filter((id) => !census.has(id)),
    missing: [...census].filter((id) => !overrides.includes(id)).sort((a, b) => a - b),
  };
}

async function main(argv) {
  const [uriFile, outFile] = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!uriFile || !outFile) throw new Error('usage: export.js <uri-file> <out.json> [--also-held <id,...>]');
  const { Client } = require('pg');
  const client = new Client(pgConfig(readUriFile(uriFile)));
  await client.connect();
  try {
    const out = await exportConversion(client, { extraHeldIds: parseIdList(argValue(argv, '--also-held')) });
    const censusFile = argValue(argv, '--expect-overrides');
    if (censusFile) {
      const censusIds = parseIdList(fs.readFileSync(censusFile, 'utf8').split(/[\s,]+/).filter(Boolean).join(','));
      const { unexpected, missing } = checkCensus(out.rows, censusIds, { extraHeldIds: parseIdList(argValue(argv, '--also-held')) });
      if (missing.length) console.log(`census ids with no override now (no conversion needed): ${missing.join(', ')}`);
      if (unexpected.length) {
        console.error(`override ids outside the census, the run stops (nothing written): ${unexpected.join(', ')}`);
        process.exitCode = 3;
        return;
      }
    }
    writePrivateJson(outFile, out);
    const overrides = out.rows.filter(hasOverride);
    const live = overrides.filter(isLiveOverride).length;
    console.log(`exported ${out.rows.length} bookings (${live} live override, ${overrides.length - live} terminal override, `
      + `${out.rows.length - overrides.length} refund only) to ${outFile}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`export.js: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { exportConversion, checkCensus };
