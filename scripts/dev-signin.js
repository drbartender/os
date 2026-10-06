#!/usr/bin/env node
/*
 * Dev sign-in for interactive local review (Playwright MCP, or any Playwright
 * context). Mints a short-lived dev JWT for one account and writes it into a
 * Playwright init script that plants the token in localStorage on that
 * account's local dev host only. Prints the file's path, never the token.
 *
 * Usage:  node /home/drbartender/projects/os/scripts/dev-signin.js --as admin
 *         node /home/drbartender/projects/os/scripts/dev-signin.js --as staff --user 4569
 *         node /home/drbartender/projects/os/scripts/dev-signin.js --clear
 * Then:   await page.context().addInitScript({ path: '<printed path>' })
 *
 * Always invoke it by that absolute path: the permission rule Dallas added on
 * 2026-10-06 (~/.claude/settings.json) allows exactly that command. Default
 * account ids come from scripts/mobile-capture.manifest.json (accounts); hosts
 * follow getSiteContext() in client/src/App.js. Use one account per host per
 * browser context: two scripts for the same host both run, and the later one
 * wins. Never read the token back out of the browser (no localStorage
 * evaluate, no request-header dumps): that puts it in the transcript.
 *
 * DEV-ONLY BY CONSTRUCTION: scripts/lib/devDbGate.js refuses to connect or mint
 * unless DATABASE_URL is a postgres URL for the known dev branch. The token
 * lives 60 minutes and carries iss "drb-dev-signin"; the file is 0600 in a
 * 0700 directory under ~/.cache, expired files are pruned on every mint, and
 * --clear removes them all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { assertDevDatabase } = require('./lib/devDbGate');

function die(msg) { console.error('[dev-signin] ' + msg); process.exit(1); }

// The passwd entry, not $HOME: an empty or edited HOME must not move the
// credential directory into a working tree.
const DIR = path.join(os.userInfo().homedir, '.cache', 'drb-dev-signin');
const TTL_SECONDS = 60 * 60;
// The CRA dev ports (main checkout, lane). Another local app on another port
// must never receive the token.
const DEV_PORTS = ['3000', '3001'];

// key = the localStorage key the app reads on that host.
const KINDS = {
  admin: { host: 'localhost', key: 'token', table: 'users' },
  staff: { host: 'staff.localhost', key: 'token', table: 'users' },
  hired: { host: 'hiring.localhost', key: 'token', table: 'users' },
  applicant: { host: 'hiring.localhost', key: 'token', table: 'users' },
  client: { host: 'public.localhost', key: 'db_client_token', table: 'clients' },
};

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// Own keys only: an inherited name like "constructor" must not pass for a kind.
function ownValue(obj, key) {
  return key !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// The directory holds live credentials: refuse anything but a plain 0700
// directory this user owns (no symlink games).
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(DIR);
  if (st.isSymbolicLink() || !st.isDirectory()) die(`${DIR} is not a plain directory`);
  if (st.uid !== process.getuid()) die(`${DIR} is not owned by this user`);
  fs.chmodSync(DIR, 0o700);
}

function pruneExpired() {
  for (const name of fs.readdirSync(DIR)) {
    const p = path.join(DIR, name);
    try {
      if (Date.now() - fs.lstatSync(p).mtimeMs > TTL_SECONDS * 1000) fs.unlinkSync(p);
    } catch (e) { /* raced with another run; nothing to do */ }
  }
}

if (process.argv.includes('--clear')) {
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`[dev-signin] cleared ${DIR}`);
  process.exit(0);
}

const kindName = argValue('--as');
const kind = ownValue(KINDS, kindName);
if (!kind) die(`usage: --as ${Object.keys(KINDS).join('|')} [--user <id>], or --clear`);
const userArg = argValue('--user');
if (userArg !== undefined && !/^[1-9]\d*$/.test(userArg)) die('--user must be a positive integer id');

// ---- Environment gate: BEFORE any DB connection or token minting ----
assertDevDatabase(die);
if (!process.env.JWT_SECRET) die('JWT_SECRET missing');

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'mobile-capture.manifest.json'), 'utf8'));

(async () => {
  const id = userArg !== undefined ? Number(userArg) : (ownValue(manifest.accounts, kindName) || {}).id;
  if (!id) die(`no default id for "${kindName}" in mobile-capture.manifest.json; pass --user <id>`);

  // token_version is read live (the manifest's copy goes stale): auth() rejects
  // a token whose tokenVersion is behind the row's.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let row;
  try {
    const sql = kind.table === 'clients'
      ? 'SELECT id, token_version FROM clients WHERE id = $1'
      : 'SELECT id, role, onboarding_status, token_version FROM users WHERE id = $1';
    ({ rows: [row] } = await pool.query(sql, [id]));
  } finally {
    await pool.end();
  }
  if (!row) die(`no ${kind.table} row with id ${id} on the dev branch`);

  const tokenVersion = row.token_version ?? 0;
  const payload = kind.table === 'clients'
    ? { id: row.id, role: 'client', tokenVersion }
    : { userId: row.id, tokenVersion };
  // iss marks the token as this script's; verify() ignores it unless asked, so
  // dev auth is unchanged, and a server can refuse it by name.
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: TTL_SECONDS, issuer: 'drb-dev-signin' });
  const expMs = jwt.decode(token).exp * 1000;

  const body = [
    `// Generated by scripts/dev-signin.js: ${kindName} ${row.id} on http://${kind.host}, expires ${new Date(expMs).toISOString()}.`,
    '// Holds a live dev credential. Never copy, print, or commit it.',
    '(() => {',
    '  try {',
    '    if (window.top !== window) return;',
    `    if (location.protocol !== 'http:' || location.hostname !== ${JSON.stringify(kind.host)}) return;`,
    `    if (!${JSON.stringify(DEV_PORTS)}.includes(location.port)) return;`,
    `    if (Date.now() >= ${expMs}) return;`,
    `    localStorage.setItem(${JSON.stringify(kind.key)}, ${JSON.stringify(token)});`,
    '  } catch (e) { /* storage blocked: the page renders signed out */ }',
    '})();',
    '',
  ].join('\n');

  ensureDir();
  pruneExpired();
  const file = path.join(DIR, `${kindName}-${row.id}.js`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);

  const who = kind.table === 'clients' ? 'client' : `${row.role}, ${row.onboarding_status}`;
  console.log(`[dev-signin] ${kindName} ${row.id} (${who}) on http://${kind.host}:${DEV_PORTS.join('|')}, localStorage "${kind.key}", expires ${new Date(expMs).toISOString()}`);
  console.log(file);
})().catch((err) => die(err.message));
