'use strict';

// Lens selection (instruction rewrite spec 2026-10-19, sections 3.2 and 3.3;
// plan 2026-10-20 step 2, lane review-tooling, the contract "Lens selection").
// A review runs the tier floors plus every lens whose trigger the diff matches.
// The triggers are named, <lens>.<slug>; each check in a lens file under
// .claude/agents/ ends its trigger line with the names that point at it, and
// the brief's section "Triggers that fired for you" lists the names that fired,
// so a lens reads those checks first. Consumers: scripts/review-select.js
// (selectLenses, forecastDiff) and scripts/review-brief.js (the names).
//
// TRIGGERS is {<lens>: {content: [{name, regex}], paths: [{name, glob, anyPath?}]}}
// for the nine lenses in the receipt's order (receiptVerdicts.LENSES). A path
// trigger may list several globs as several entries under one name.
//
// What a trigger reads:
//   content  the added lines of each file in a code path (sensitive-match's
//            isCodePath: server/, client/src/ or scripts/ with a code
//            extension, never a test, never content-rule-calibrate.js). A
//            file's added lines are joined with newlines and each regex runs
//            once over them, so SQL split across lines still fires. Removed
//            and context lines are never read. A diff section whose path
//            cannot be read is scanned as code: it fails closed, toward more
//            lenses.
//   paths    every changed path (a rename's old path included). A path
//            trigger fires on a code path only, like a content trigger, except
//            the two marked anyPath: client.paths (any path under client/src/,
//            a stylesheet included) and outcomes-providers.thumbtack-agent-paths
//            (the DOM agent sits outside the code roots). So a list or a
//            manifest under scripts/ (a hinge file) never fires the schema
//            lens, and neither does a test.
// The regexes are the contract's, with these widenings. The SQL-keyword
// triggers match in any case, because sensitive-match reads SQL keywords in any
// case and the server writes lowercase now() and interval: money.update-proposals,
// concurrency.for-update, .transaction and .on-conflict, business-time.current-date,
// .date-cast and .at-time-zone, outcomes-providers.commit, schema-data.ddl and
// .catalog-insert. The webhook triggers and concurrency.retry match in any case,
// so a camelCase identifier (handleWebhook, maxRetries, nextAttempt) fires them.
// lifecycle.set-status and concurrency.status-write fire on either the
// contract's regex (a SET status or a status = '...', a WHERE or AND guard
// included, the lines the lens checks point at) or sensitive-match's
// STATUS_WRITE (a parameterized write), imported, never copied, in any case; a
// JS === comparison fires neither. There is no
// money.paths: a path in a money section is tier A, whose floor brings the
// money lens. seams has no trigger; it sits on every non-docs floor.
//
// selectLenses returns the selected lenses in the receipt's order, each
// {name, firedBecause}: 'floor' first when a tier floor brings the lens, then
// every trigger name that fired for it, in TRIGGERS order. A floor lens whose
// triggers also fired carries both, so the brief can list its names.
//
// forecastDiff reads the plan's front matter, the `lenses:` line of one lane
// (free text, continued on more-indented lines), and returns the selected
// names it does not mention. A lens name counts as a mention as a whole word,
// in any case, with its hyphen written as a hyphen, a space or "and"
// (access-egress, access egress, access and egress); never inside a longer
// word or a hyphenated one (client-money-surfaces is not client). A lane
// with no lenses line forecasts nothing, so every selected lens comes back.

const fs = require('fs');
const path = require('path');
const { TIER_FLOORS, STATUS_WRITE, isCodePath, patternToRegex } = require('../sensitive-match');

// The status-write trigger: the contract's regex (a SET status or a status =
// '...', a WHERE guard included, which the lens checks point at; never a query
// string's ?status= or &status=, the tier's own guard) or sensitive-match's
// STATUS_WRITE (a parameterized write), in any case.
const CONTRACT_STATUS = /\bSET\s+status\b|(?<![?&])\bstatus\s*=\s*'/;
const STATUS_TRIGGER = new RegExp(`${CONTRACT_STATUS.source}|${STATUS_WRITE.source}`, 'i');
const { LENSES } = require('./receiptVerdicts');

const SCHEDULER_GLOBS = ['**/*Scheduler.js', '**/*Sweep.js', '**/*Reaper.js'];

const content = (name, regex) => ({ name, regex });
const pathsOf = (name, globs, extra = {}) => globs.map((glob) => ({ name, glob, ...extra }));

const TRIGGERS = {
  money: {
    content: [
      content('money.update-proposals', /UPDATE\s+proposals\s+SET/i),
      content('money.columns', /\b(total_price|amount_paid|amount_due|external_paid|total_price_override|pricing_snapshot|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|gratuity_floor_rate|payout_id|deposit_amount)\b/),
      content('money.stripe-calls', /stripe\.(refunds|paymentIntents|checkout|paymentLinks|customers|invoices|payouts)\./),
      content('money.helpers', /\b(refundExecute|applyRefundReconciliation|calculateProposal|getStripe)\(/),
    ],
    paths: [],
  },
  lifecycle: {
    content: [
      content('lifecycle.set-status', STATUS_TRIGGER),
      content('lifecycle.statuses', /_STATUSES\b/),
      content('lifecycle.archive-reason', /archive_reason/),
      content('lifecycle.pay-periods', /pay_periods/),
      content('lifecycle.set-interval', /setInterval\(/),
    ],
    paths: pathsOf('lifecycle.scheduler-paths', SCHEDULER_GLOBS),
  },
  concurrency: {
    content: [
      content('concurrency.for-update', /FOR UPDATE/i),
      content('concurrency.pool-connect', /pool\.connect\(/),
      content('concurrency.transaction', /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|SAVEPOINT/i),
      content('concurrency.on-conflict', /ON CONFLICT/i),
      content('concurrency.promise-all', /Promise\.all\(/),
      content('concurrency.row-count', /rowCount/),
      content('concurrency.retry', /retry|attempt/i),
      content('concurrency.timers', /setTimeout\(|setInterval\(/),
      content('concurrency.status-write', STATUS_TRIGGER),
      content('concurrency.provider-call', /stripe\.\w+\.\w+\(|twilio|resend|send(Email|SMS|Push)\(|fetch\(/),
    ],
    paths: pathsOf('concurrency.scheduler-paths', SCHEDULER_GLOBS),
  },
  'business-time': {
    content: [
      content('business-time.current-date', /CURRENT_DATE|CURRENT_TIMESTAMP|NOW\(\)/i),
      content('business-time.new-date', /new Date\(/),
      content('business-time.date-cast', /::date\b|\bDATE\b|INTERVAL '/i),
      content('business-time.at-time-zone', /AT TIME ZONE/i),
      content('business-time.date-helpers', /chicagoTodayYmd|toISOString|toLocaleDateString|setDate\(/),
      content('business-time.days', /_days?\b|Days?\b/),
    ],
    paths: [],
  },
  'outcomes-providers': {
    content: [
      content('outcomes-providers.catch', /catch\s*(\(|\{)/),
      content('outcomes-providers.ok-flag', /ok:\s*(true|false)/),
      content('outcomes-providers.skipped-failed', /'skipped'|'failed'|'notifications_off'/),
      content('outcomes-providers.process-env', /process\.env\./),
      content('outcomes-providers.twiml', /TwiML|<Response>|twiml/),
      content('outcomes-providers.webhook', /webhook/i),
      content('outcomes-providers.commit', /\bCOMMIT\b/i),
      content('outcomes-providers.provider-require', /require\('(stripe|twilio|resend|@anthropic-ai\/sdk|openai|@google\/genai|web-push|googleapis)'\)/),
      content('outcomes-providers.post-fetch', /\.post\(|fetch\(/),
      content('outcomes-providers.page-actions', /page\.(click|goto|fill|waitFor)\(/),
    ],
    paths: pathsOf('outcomes-providers.thumbtack-agent-paths', ['thumbtack-agent/**'], { anyPath: true }),
  },
  'access-egress': {
    content: [
      content('access-egress.router', /router\.(get|post|put|patch|delete)\(/),
      content('access-egress.auth', /\bauth\b|req\.user|requireOnboarded|role/),
      content('access-egress.rate-limit', /Limiter|rateLimit/),
      content('access-egress.logging', /console\.(log|error)\(|Sentry\./),
      content('access-egress.send', /send(Email|SMS|Push)\(|anthropicClient|openaiClient|geminiClient/),
      content('access-egress.response', /res\.(json|send|download)\(/),
      content('access-egress.webhook', /webhook/i),
      content('access-egress.public-token', /requireUuidToken|publicToken|\/t\/:token/),
      content('access-egress.export', /\.csv|exportCsv|Content-Disposition/),
    ],
    paths: pathsOf('access-egress.route-paths', ['server/routes/**', 'server/middleware/**']),
  },
  seams: { content: [], paths: [] },
  'schema-data': {
    content: [
      content('schema-data.ddl', /CREATE TABLE|ALTER TABLE|ADD COLUMN|CHECK \(|CREATE (UNIQUE )?INDEX/i),
      content('schema-data.catalog-insert', /INSERT INTO (service_addons|service_packages|cocktails|mocktails|par_)/i),
    ],
    paths: pathsOf('schema-data.schema-paths', ['server/db/schema.sql', 'server/db/index.js', 'server/scripts/**', 'scripts/**', '**/*seed*', '**/*Seed*']),
  },
  client: {
    content: [],
    paths: pathsOf('client.paths', ['client/src/**'], { anyPath: true }),
  },
};

for (const lens of Object.keys(TRIGGERS)) {
  for (const t of TRIGGERS[lens].paths) t.re = patternToRegex(t.glob);
}

const TRIGGER_NAMES = Object.freeze([...new Set(Object.values(TRIGGERS).flatMap((l) => [...l.content, ...l.paths].map((t) => t.name)))].sort());

// ---- the diff ---------------------------------------------------------------------

function normalize(p) {
  let s = String(p).replace(/\\/g, '/').trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s ? path.posix.normalize(s) : '';
}

// One C-quoted token as git writes it ("b/caf\303\251.js"): octal escapes are
// bytes, the rest the usual C escapes. null when it is not well formed.
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function unquote(token) {
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 2) return null;
  const bytes = [];
  const s = token.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(...Buffer.from(s[i], 'utf8'));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += oct[0].length;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) return null;
    bytes.push(C_ESCAPES[n] !== undefined ? C_ESCAPES[n] : n.charCodeAt(0) & 0xff);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

// The post-image path of a '+++ ' header value, null for /dev/null or a value
// that does not read.
function plusPath(raw) {
  let s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (s.startsWith('"')) s = unquote(s);
  if (s === null || s === '/dev/null' || !s.startsWith('b/')) return null;
  return normalize(s.slice(2)) || null;
}

// [{path, added: [text]}] per file section of a unified diff in git's form.
// path is null when the section names no post-image path this can read.
function addedLinesByFile(diffText) {
  const files = [];
  let cur = null;
  for (let line of String(diffText || '').split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('diff --git ')) {
      cur = { path: null, added: [], inHunks: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      cur.inHunks = true;
      continue;
    }
    if (!cur.inHunks) {
      if (line.startsWith('+++ ')) cur.path = plusPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return files.map(({ path: p, added }) => ({ path: p, added }));
}

// ---- triggers -----------------------------------------------------------------------

// {<lens>: [trigger names that fired]} for the diff's added lines and the
// changed paths, every lens present, names in TRIGGERS order.
function firedTriggers({ diffText = '', paths = [] } = {}) {
  const hit = new Set();
  for (const f of addedLinesByFile(diffText)) {
    if (f.path !== null && !isCodePath(f.path)) continue;
    if (f.added.length === 0) continue;
    const text = f.added.join('\n');
    for (const lens of LENSES) for (const t of TRIGGERS[lens].content) if (t.regex.test(text)) hit.add(t.name);
  }
  for (const p of (paths || []).map(normalize).filter(Boolean)) {
    const code = isCodePath(p);
    for (const lens of LENSES) for (const t of TRIGGERS[lens].paths) if ((t.anyPath || code) && t.re.test(p)) hit.add(t.name);
  }
  const out = {};
  for (const lens of LENSES) {
    out[lens] = [...new Set([...TRIGGERS[lens].content, ...TRIGGERS[lens].paths].map((t) => t.name))].filter((n) => hit.has(n));
  }
  return out;
}

/**
 * The lenses a review runs: the floors plus every lens a trigger fired for.
 * @param {object} o
 * @param {object} o.tiersByFile  {file: tier}, sensitive-match's tier result
 * @param {string[]} [o.floors]   the review's floors (the tier result's); default the union of the per-file floors
 * @param {string} [o.diffText]   a unified diff; its added lines feed the content triggers
 * @param {string[]} [o.paths]    the changed paths for the path triggers; default the files of tiersByFile
 * @returns {{name: string, firedBecause: string[]}[]} in the receipt's lens order
 */
function selectLenses({ tiersByFile = {}, floors, diffText = '', paths } = {}) {
  const floorSet = new Set(floors || Object.values(tiersByFile).flatMap((t) => TIER_FLOORS[t] || []));
  const fired = firedTriggers({ diffText, paths: paths || Object.keys(tiersByFile) });
  return LENSES.filter((lens) => floorSet.has(lens) || fired[lens].length > 0).map((lens) => ({
    name: lens,
    firedBecause: [...(floorSet.has(lens) ? ['floor'] : []), ...fired[lens]],
  }));
}

// ---- the forecast -------------------------------------------------------------------

const indentOf = (line) => /^ */.exec(line)[0].length;

// The free text of one lane's `lenses:` line in the plan's front matter, or
// null when the lane has none. Throws when the plan has no front matter or
// the lane is not in it.
function laneLensesLine(planPath, laneId) {
  const lines = fs.readFileSync(planPath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) throw new Error(`forecastDiff: ${planPath} has no front matter (a --- block at the top)`);
  const front = lines.slice(1, end);
  const start = front.findIndex((l) => {
    const m = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(l);
    return m && m[2] === laneId;
  });
  if (start < 0) throw new Error(`forecastDiff: no lane ${laneId} in ${planPath}'s front matter`);
  const dash = indentOf(front[start]);
  const keyIndent = dash + 2;
  for (let i = start + 1; i < front.length; i++) {
    const l = front[i];
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind <= dash) break;
    const m = /^\s*lenses:\s*(.*)$/.exec(l);
    if (ind !== keyIndent || !m) continue;
    const parts = [m[1]];
    for (let j = i + 1; j < front.length && front[j].trim() && indentOf(front[j]) > keyIndent; j++) parts.push(front[j].trim());
    return parts.join(' ').trim();
  }
  return null;
}

function mentionRegex(lens) {
  const words = lens.split('-').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z0-9_-])${words.join('[-\\s]+(?:and\\s+)?')}(?![A-Za-z0-9_-])`, 'i');
}

/**
 * The selected lenses the plan's lane did not forecast.
 * @param {(string|{name: string})[]} selected  lens names, or selectLenses' entries
 * @param {string} planPath
 * @param {string} laneId
 * @returns {string[]} the unforecast names, in the order given
 */
function forecastDiff(selected, planPath, laneId) {
  const line = laneLensesLine(planPath, laneId);
  const list = (selected || []).map((s) => (typeof s === 'string' ? s : s.name));
  if (line === null) return list;
  return list.filter((name) => !mentionRegex(name).test(line));
}

module.exports = {
  TRIGGERS,
  TRIGGER_NAMES,
  TIER_FLOORS,
  LENSES,
  addedLinesByFile,
  firedTriggers,
  selectLenses,
  forecastDiff,
  laneLensesLine,
  unquote,
  normalize,
};
