// gv-agent configuration. Four values come from the environment (gv-agent/.env
// on the box, loaded here and by the systemd unit's EnvironmentFile); the rest
// are fixed on purpose. The job budget must stay under the server's 3-minute
// lease window (spec section 6), so it is not env-tunable.
require('dotenv').config();
const os = require('os');
const path = require('path');

const home = process.env.HOME || os.homedir();
const expandHome = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

const CFG = Object.freeze({
  apiBase: (process.env.API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, ''),
  // No default: unset stays unset, and startup (secretProblem) refuses to run.
  secret: process.env.GV_AGENT_SECRET,
  // A credential for Dallas's whole Google account: mode 700, out of restic (spec law 11).
  profileDir: path.resolve(expandHome(process.env.GV_PROFILE_DIR || path.join(home, '.gvoice-profile'))),
  pollMs: 10000,
  // While Google wants a human (signed out, verify-it's-you), check back every
  // minute for the first hour, then every 5 minutes.
  outagePollMs: 60000,
  outageSlowPollMs: 300000,
  outageSlowAfterMs: 3600000,
  // Box-side daily cap (spec law 7), counted per Chicago day in gv-sent-count.json.
  dailyCap: 25,
  // Jobs the box may drive a browser for in one Chicago day, any outcome
  // (gv-attempt-count.json). Spent, it leases nothing until Chicago midnight.
  dailyAttemptCap: 60,
  // Measured from the moment the lease response arrives, so launch and navigation count.
  jobBudgetMs: 90000,
  dryRun: process.argv.includes('--dry-run'),
  // --dry-run only: the company 1922 line (server/utils/companyPhone.js), never a client.
  dryRunPhone: process.env.DRY_RUN_PHONE || '',
});

module.exports = { CFG };
