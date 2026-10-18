#!/usr/bin/env node
'use strict';
// Runbook steps 1 and 5: the deployed-code guard on its own (shared.js
// assertDeployedCode; freshCompute.js and run.js also run it first). Fetches,
// then exits 0 only when server/ equals origin/main and the conversion tooling
// is committed; prints the origin/main sha to match against Render's live deploy.
//   node scripts/override-conversion/guard.js

const { assertDeployedCode } = require('./shared');

try {
  const { originMain } = assertDeployedCode();
  console.log(`code check passed: server/ is origin/main ${originMain.slice(0, 8)}, the conversion tooling is committed`);
} catch (err) {
  console.error(`guard.js: ${err && err.message}`);
  process.exit(1);
}
