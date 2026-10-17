#!/usr/bin/env node
'use strict';
// A reverse block for PART of a conversion run (plan
// 2026-10-16-price-override-removal, lane conversion-tooling fix round). When a
// converted row moves after the forward block (a payment, an edit), the run's
// full reverse.sql refuses and restores nothing. This renders the reverse for
// the other rows under the run's own tag, so each still finds its activity
// record; the moved rows are settled by hand.
//
//   node scripts/override-conversion/reverse.js <changes.json> <out.sql> (--except <id,...> | --only <id,...>)
//
// Refuses a changes.json whose changes do not hash to its tag (not the change
// set the forward block was rendered from) and an out file that exists.

const fs = require('fs');
const { renderReverseBlock, runTag } = require('./doBlock');
const { parseIdList, readJson, writePrivate, argValue } = require('./shared');

function reverseCli(argv, { log = console.log } = {}) {
  const [changesFile, outFile] = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!changesFile || !outFile) throw new Error('usage: reverse.js <changes.json> <out.sql> (--except <id,...> | --only <id,...>)');
  const except = argValue(argv, '--except');
  const only = argValue(argv, '--only');
  if ((except === undefined) === (only === undefined)) throw new Error('name the rows with exactly one of --except or --only');
  if (fs.existsSync(outFile)) throw new Error(`${outFile} exists: write each block to a new file`);
  const run = readJson(changesFile);
  if (!run || !Array.isArray(run.changes) || run.changes.length === 0) throw new Error(`${changesFile} holds no change set`);
  if (run.tag !== runTag(run.changes)) {
    throw new Error(`${changesFile}: its changes do not hash to its run tag, so it is not the change set the forward block ran`);
  }
  const all = run.changes.map((c) => c.id);
  let onlyIds;
  if (only !== undefined) {
    onlyIds = parseIdList(only);
  } else {
    const skip = parseIdList(except);
    const stray = skip.filter((id) => !all.includes(id));
    if (stray.length) throw new Error(`--except names rows not in the change set: ${stray.join(', ')}`);
    onlyIds = all.filter((id) => !skip.includes(id));
  }
  writePrivate(outFile, renderReverseBlock(run.changes, { onlyIds }));
  log(`reverse for ${onlyIds.length} of ${all.length} bookings of run ${run.tag} written to ${outFile}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = reverseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`reverse.js: ${err && err.message}`);
    process.exit(1);
  }
}

module.exports = { reverseCli };
