#!/usr/bin/env node
'use strict';
// Seeds one synthetic booking of every conversion shape on a conversion branch,
// for the dev rehearsal (plan 2026-10-16-price-override-removal, Task V4).
//
//   node scripts/override-conversion/rehearsal-seed.js <uri-file>
//
// Refuses NODE_ENV=production and any URI file branch.js did not write. Prints
// the ids by shape and the synthetic held id to pass as --also-held. Synthetic
// labels and amounts only; the branch is deleted after the rehearsal.

const path = require('path');
const { readUriFile, pgConfig } = require('./shared');
const { BRANCH_PREFIX } = require('./branch');
const fx = require('./fixtures');

async function main([uriFile]) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run with NODE_ENV=production');
  if (!uriFile || !path.basename(uriFile).startsWith(BRANCH_PREFIX)) throw new Error('name a URI file branch.js wrote');
  const { Client } = require('pg');
  const client = new Client(pgConfig(readUriFile(uriFile)));
  await client.connect();
  try {
    await client.query('BEGIN');
    const ctx = await fx.createFixtureContext(client, `rehearsal-${Date.now()}`);
    const id = await fx.seedEveryShape(client, ctx);
    await client.query('COMMIT');
    console.log(`seeded ${Object.keys(id).length} shapes: ${JSON.stringify(id)}`);
    console.log(`synthetic legal hold: pass --also-held ${id.held}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`rehearsal-seed.js: ${err && err.message}`);
  process.exit(1);
});
