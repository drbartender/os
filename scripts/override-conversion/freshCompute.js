#!/usr/bin/env node
'use strict';
// The fresh compute for live override bookings (plan
// 2026-10-16-price-override-removal, Task V1 step 3; spec 8.2): each live
// booking priced at TODAY's catalog with its current inputs and no override,
// through computeCatalogSnapshot (proposalExtrasFold.js, the fold's own
// engine-args builder).
//
//   node scripts/override-conversion/freshCompute.js <uri-file> <export.json> <out.json> [--also-held <id,...>]
//
// server/db binds its pool when it loads, so the work runs in a child process
// whose DATABASE_URL is the branch URI before any server module loads
// (scripts/testdb-smoke.js precedent): nothing here can reach another
// database. The child loads each live row WHOLE (SELECT * ... FOR UPDATE; the
// export is a column subset and computeCatalogSnapshot refuses a partial
// row), checks it still matches the export's md5, prices it, and rolls back.
// A row the compute refuses is recorded with its reason (the transform lists
// it for Dallas) and never stops the others. Held ids are never loaded.

const path = require('path');
const { spawnSync } = require('child_process');
const {
  MONEY_MD5_EXPR, heldCheck, isLiveOverride, parseIdList, readUriFile, readJson, writePrivateJson, argValue,
  assertDeployedCode,
} = require('./shared');

const serviceCents = (s) => Math.round(Number(s.total) * 100) - Math.round(Number((s.gratuity && s.gratuity.total) || 0) * 100);
const shortMessage = (err) => String((err && err.message) || err).split('\n')[0].slice(0, 200);

/**
 * @param {object} client  a pg client (never the pool) on the branch
 * @param {object[]} rows  the export's rows
 * @returns {Promise<Array<{ id, money_md5, freshServiceCents?, snapshot?, error? }>>}
 */
async function computeFresh(client, rows, { extraHeldIds = [] } = {}) {
  const { computeCatalogSnapshot } = require('../../server/utils/proposalExtrasFold');
  const isHeld = heldCheck(extraHeldIds);
  const live = rows.filter((r) => isLiveOverride(r) && !isHeld(r.id)).sort((a, b) => a.id - b.id);
  const out = [];
  await client.query('BEGIN');
  try {
    for (const row of live) {
      await client.query('SAVEPOINT fresh_row');
      try {
        const whole = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
        if (!whole) throw new Error(`proposal ${row.id} not found`);
        if (isHeld(whole.id)) throw new Error(`proposal ${whole.id} is on legal hold`);
        const md5 = (await client.query(`SELECT ${MONEY_MD5_EXPR} AS m FROM proposals WHERE id = $1`, [whole.id])).rows[0].m;
        if (md5 !== row.money_md5) throw new Error(`proposal ${whole.id} changed since the export`);
        const snapshot = JSON.parse(JSON.stringify(await computeCatalogSnapshot(client, whole)));
        out.push({ id: whole.id, money_md5: md5, freshServiceCents: serviceCents(snapshot), snapshot });
        await client.query('RELEASE SAVEPOINT fresh_row');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT fresh_row');
        out.push({ id: row.id, money_md5: row.money_md5, error: shortMessage(err) });
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
  return out;
}

async function child(exportFile, outFile, extraHeldIds) {
  const { pool } = require('../../server/db'); // binds to the branch URI the parent set
  const client = await pool.connect();
  try {
    const fresh = await computeFresh(client, readJson(exportFile).rows, { extraHeldIds });
    writePrivateJson(outFile, { computed_at: new Date().toISOString(), rows: fresh });
    const refused = fresh.filter((f) => f.error).length;
    console.log(`fresh compute: ${fresh.length - refused} live bookings priced, ${refused} refused, written to ${outFile}`);
  } finally {
    client.release();
    await pool.end();
  }
}

// The CLI's parent: the deployed-code guard first, before any read or spawn.
function freshComputeCli(argv, { guard = assertDeployedCode, spawn = spawnSync } = {}) {
  guard();
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  const [uriFile, exportFile, outFile] = positional;
  if (!uriFile || !exportFile || !outFile) {
    throw new Error('usage: freshCompute.js <uri-file> <export.json> <out.json> [--also-held <id,...>]');
  }
  const uri = readUriFile(uriFile);
  const held = argValue(argv, '--also-held');
  const res = spawn(process.execPath,
    [__filename, '--child', path.resolve(exportFile), path.resolve(outFile), ...(held ? ['--also-held', held] : [])],
    { env: { ...process.env, DATABASE_URL: uri }, stdio: 'inherit', timeout: 600000 });
  if (res.status !== 0) throw new Error(`the compute child failed (exit ${res.status})`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const run = argv[0] === '--child'
    ? child(argv[1], argv[2], parseIdList(argValue(argv, '--also-held')))
    : Promise.resolve().then(() => freshComputeCli(argv));
  run.catch((err) => {
    console.error(`freshCompute.js: ${shortMessage(err)}`);
    process.exit(1);
  });
}

module.exports = { computeFresh, freshComputeCli };
