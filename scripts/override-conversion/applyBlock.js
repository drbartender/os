#!/usr/bin/env node
'use strict';
// Runs a rendered conversion block over pg against a conversion BRANCH: the dev
// rehearsal's forward and reverse runs (plan 2026-10-16-price-override-removal,
// Task V4). Prod's forward block runs through Neon MCP run_sql (runbook step 6),
// never through this script.
//
//   node scripts/override-conversion/applyBlock.js <uri-file> <block.sql>
//
// Refuses any URI file branch.js did not write and any file that is not one
// rendered block. Prints only success or the block's own RAISE message (ids
// and the run tag).

const fs = require('fs');
const path = require('path');
const { readUriFile, pgConfig } = require('./shared');
const { BRANCH_PREFIX } = require('./branch');

async function main([uriFile, sqlFile]) {
  if (!uriFile || !path.basename(uriFile).startsWith(BRANCH_PREFIX)) throw new Error('name a URI file branch.js wrote');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  if (!/^-- Override conversion /m.test(sql) || !sql.startsWith('DO $conv$') || !sql.trimEnd().endsWith('$conv$;')) {
    throw new Error(`${sqlFile} is not a rendered conversion block`);
  }
  const { Client } = require('pg');
  const client = new Client(pgConfig(readUriFile(uriFile)));
  await client.connect();
  try {
    await client.query(sql);
    console.log(`applied ${path.basename(sqlFile)}`);
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`applyBlock.js: ${err && err.message}`);
  process.exit(1);
});
