'use strict';

/*
 * suiteWorker.js: one parallel worker of run-suites (2026-11-08). Forked by
 * the locked run with its own DATABASE_URL (a ci-suites-<n> branch) and the
 * dev-suite lock's descriptor as fd 3 (RUN_SUITES_WORKER_LOCK_FD=3; none when the
 * run is nested under a holder); it asks for a suite over IPC, runs it
 * through run-suites' runSuite (same argv, bound, logs and verdict), sends the
 * result back and asks again, until it is told it is done. When the run that
 * forked it goes away (the IPC channel closes) it exits after the suite in
 * hand, so a killed run never keeps handing out suites.
 *
 *   argv: <root> <logDir>
 */

const { runSuite } = require('../run-suites');

const [root, logDir] = process.argv.slice(2);
const LOCK_FD = process.env.RUN_SUITES_WORKER_LOCK_FD === '3' ? 3 : null;

process.on('disconnect', () => process.exit(1));
process.on('message', (msg) => {
  if (!msg || msg.done) {
    process.disconnect();
    process.exit(0);
  }
  const r = runSuite(root, msg.file, logDir, { quiet: true, lockFd: LOCK_FD });
  if (process.connected) process.send({ result: r });
});
process.send({ ready: true });
