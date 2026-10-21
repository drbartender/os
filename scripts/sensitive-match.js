#!/usr/bin/env node
'use strict';

// Sensitive-path matcher and tier computer. Reads scripts/sensitive-paths.txt
// (the single source of truth) and reports which of a given set of paths are
// sensitive, in which section, and what review tier a diff computes to
// (instruction rewrite spec 2026-10-19, sections 3.3 and 4.7, D11; step 2 lane
// sensitive-match-2). Consumers: scripts/lane-status.js today; the review skill
// (scripts/review-select.js), merge-lane.sh check and ship from steps 2 to 5.
//
// Globs: '*' matches within one path segment and never crosses '/'; '**' crosses
// slashes ('**/' is zero or more directories). Every other regex special is
// escaped. Sections come from '# section: <name>' header lines in the list; a
// list with no header reads as one 'money' section (today every listed path
// means the full fleet). The D11 hinge set and the docs allowlist live here as
// constants until the flip moves them into the list.
//
// Tier, per file: A when the path is in a money, auth-and-pii or
// client-money-surfaces section, or the content rule fires on its added lines.
// hinge for a D11 path with no content hit, for every unclassified path
// (.claude/**, root files, a path outside the repo), and for every unlisted file
// under scripts/ with no content hit that is not a .js, .mjs or .sh code file: a
// non-code file (a manifest or list), a .sql, .cjs or .jsx, a test (*.test.js)
// and scripts/content-rule-calibrate.js. The last three are heavier than the
// contract's B by the lane's ruling. B for any other server/ path, an unlisted
// .js, .mjs or .sh code file under scripts/, and any other code file whose added
// lines write a status (STATUS_WRITE). C for anything else under client/. docs
// for an allowlisted doc that is not sensitive or hinge. A review's floors are
// the union of the per-file tier floors; its label is the highest tier in the
// order A, hinge, B, C, docs.
//
// The status-write lift moves a client/ file from C to B, and the B floor is
// seams alone, so this module's floors drop the client lens for that file. The
// client lens still runs: it comes from the client/src/ path trigger in
// scripts/lib/lensTriggers.js, which review-select adds to the floors.
//
// Hits: contentRuleHits and statusWrites entries share one shape, {file, line,
// text, rule}. line is the added line's number in the new file and text is that
// line; a 'diff-unparsed' hit (code the rule could not read) has line 0 and text
// ''. file is the repo-relative path, or null, the one sentinel, for a diff
// section with no readable path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_LIST = path.join(__dirname, 'sensitive-paths.txt');
const REPO_ROOT = path.resolve(__dirname, '..');

const A_SECTIONS = Object.freeze(['money', 'auth-and-pii', 'client-money-surfaces']);
const SECTIONS = Object.freeze([...A_SECTIONS, 'hinge']);
const TIER_ORDER = Object.freeze(['A', 'hinge', 'B', 'C', 'docs']);

// Lens floors per tier (spec 3.3). The externals and verify ride tier A.
const TIER_FLOORS = Object.freeze({
  A: Object.freeze(['money', 'lifecycle', 'concurrency', 'outcomes-providers', 'access-egress', 'seams']),
  hinge: Object.freeze(['seams', 'access-egress']),
  B: Object.freeze(['seams']),
  C: Object.freeze(['client', 'seams']),
  docs: Object.freeze([]),
});

// The D11 hinge set, as globs, until the flip commit moves it into the list.
const HINGE_PATHS = Object.freeze([
  '.claude/skills/review/**',
  '.claude/agents/*.md',
  '.claude/settings.json',
  'scripts/sensitive-paths.txt',
  'scripts/sensitive-match.js',
  'scripts/static-checks.js',
  'scripts/merge-lane.sh',
  'scripts/ship.js',
  'scripts/push-gate.js',
  'scripts/post-ship-watch.js',
  'scripts/gen-docs.js',
  'scripts/lane-status.js',
  'scripts/board-write.sh',
  'scripts/lib/**',
  '.husky/*',
  'client/vercel.json',
  'docs/money-laws.md',
  'docs/runbooks/**',
  'AGENTS.md',
  'package.json',
  'package-lock.json',
  'client/package.json',
  'client/package-lock.json',
  '.node-version',
  'eslint.config.mjs',
  '.gitignore',
]);

// Docs-only (spec 4.7): every path on this list and none sensitive or hinge.
const DOCS_ALLOWLIST = Object.freeze(['docs/**', 'README.md', 'ARCHITECTURE.md']);

// The content rule's scope: code under these roots with these extensions, never
// tests. Widened past the plan's .js, .mjs and .sh after review 1 (M5): 25 .jsx
// files sit under client/src (TipPage.jsx among them) and money repairs ship as
// .sql (server/scripts/repairProposal54Balance.sql); .cjs rides along. No .ts or
// .tsx file exists under these roots (git ls-files, 2026-10-20), so none is listed.
const CODE_PATHS = Object.freeze({
  roots: Object.freeze(['server/', 'client/src/', 'scripts/']),
  extensions: Object.freeze(['.js', '.jsx', '.mjs', '.cjs', '.sh', '.sql']),
  exclude: Object.freeze(['**/*.test.js', '**/*.test.jsx', 'scripts/content-rule-calibrate.js']),
});

// The tier contract's B under scripts/: an unlisted .js, .mjs or .sh code file
// (isCodePath, so a test and the calibration script are not). Any other unlisted
// file there with no content hit is hinge: a non-code file, a .sql, .cjs or .jsx,
// a test, content-rule-calibrate.js (heavier than the contract's B, by ruling).
const SCRIPT_B_EXTENSIONS = Object.freeze(['.js', '.mjs', '.sh']);

// Pin git's diff output whatever the local config or attributes say: no colour,
// no external or textconv driver, text even for a '-diff' path, a/ and b/
// prefixes, and repo-relative paths from any cwd. Every git diff or show that
// reads content (tierFromGit, the calibration's showDiff) passes these, then
// '--end-of-options'. The calibration's name-only diff-tree call needs none of
// them: it reads names, not content, with -z, from the repo root.
const GIT_DIFF_FLAGS = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative']);

// Two variables git reads from the environment past those flags: GIT_DIFF_OPTS
// overrides --unified (-u0 hides the UPDATE above a write) and GIT_EXTERNAL_DIFF
// names a driver. Every git call here and in the calibration gets this env copy.
function gitEnv(env = process.env) {
  const out = { ...env };
  delete out.GIT_DIFF_OPTS;
  delete out.GIT_EXTERNAL_DIFF;
  // A replace ref would make diff, log and cat-file read another object under
  // the real sha while rev-parse still names the real one; every reader of
  // this env (the receipt library inherits it) sees the real content.
  out.GIT_NO_REPLACE_OBJECTS = '1';
  return out;
}

// Lines of context each side of a change. The update-money-table rule looks for
// the table name in the context too, so a status write added under an existing
// UPDATE fires; 25 covers every money-table UPDATE in the tree today (the
// furthest write sits 21 lines below its UPDATE, p99 8; measured 2026-10-20).
const DIFF_CONTEXT_LINES = 25;

// SQL keywords match in any case (update proposals set status ...). A money
// table as SQL may name it: bare, double-quoted, or schema-qualified
// (public.proposals, "public"."proposals").
const MONEY_TABLE = '(?:"?\\w+"?\\.)?"?(?:proposals|invoices|invoice_payments|proposal_payments|proposal_refunds|payouts|pay_periods|tips|shifts|service_extensions)\\b';
const MONEY_UPDATE = new RegExp(`\\bUPDATE\\s+${MONEY_TABLE}`, 'i');
const MONEY_INSERT = new RegExp(`\\bINSERT\\s+INTO\\s+${MONEY_TABLE}`, 'i');
const DO_UPDATE = /\bDO\s+UPDATE\s+SET\b/i;
// A money-table write in this text: UPDATE <money table>, or an upsert, INSERT
// INTO <money table> with ON CONFLICT ... DO UPDATE SET.
const writesMoneyTable = (text) => MONEY_UPDATE.test(text) || (MONEY_INSERT.test(text) && DO_UPDATE.test(text));
// A status write: SET status, or status = '...' or = $n where the status is not
// preceded on its line by WHERE, AND or OR (a comparison) and is not a query
// string's ?status= or &status=. It drives the B lift ("any other status write").
const STATUS_WRITE = /\bSET\s+status\b|(?<!\b(?:where|and|or)\b[^\n]*)(?<![?&])\bstatus\s*=\s*(?:['$]|CASE\b|COALESCE\s*\()/i;
// A status write or a status guard (WHERE ... AND status = '...'): what the
// update-money-table rule reads, because a guard on a money-table UPDATE decides
// which money rows move. Three status-guard defects in the calibration are caught
// only this way (measured 2026-10-20). A query string's ?status= is neither.
const STATUS_WRITE_OR_GUARD = /\bSET\s+status\b|(?<![?&])\bstatus\s*=\s*(?:['$]|CASE\b|COALESCE\s*\()/i;
const MONEY_COLUMNS = /\b(total_price|amount_paid|amount_due|external_paid|total_price_override|pricing_snapshot|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|gratuity_floor_rate|payout_id|deposit_amount)\b/;
const CONTENT_RULES = Object.freeze([
  // Any depth of resource path: stripe.refunds.create(, stripe.checkout.sessions.create(.
  { rule: 'stripe-call', re: /stripe\.\w+(?:\.\w+)+\(|getStripe\(\)\.\w+(?:\.\w+)+\(/ },
  { rule: 'money-helper', re: /\b(refundExecute|issueRefund|applyRefundReconciliation|executeRefund|deriveGratuityRate|calculateProposal)\(/ },
  { rule: 'money-column', re: /\b(total_price|amount_paid|amount_due|external_paid|line_total|rate_cents|wage_cents|amount_cents|gratuity_rate|payout_id|rate|quantity)\b/ },
  // Widened 2026-10-20 after calibration (lane sensitive-match-2) with these
  // unambiguous money words. Measured 2026-10-20 over 401 money defects: the rule
  // alone 66.8 percent; the sensitive list OR the rule 90.0 percent today and
  // 92.5 after the flip's list additions. The generic money-word set (amount,
  // price, total, paid, invoice, balance, tip) reached 88.3 percent alone but
  // fired on about a third of non-money code commits, so it was declined; Dallas
  // decides whether to widen. node scripts/content-rule-calibrate.js prints the
  // recall figures for the tree at hand; the false-positive sample was a one-off
  // measurement.
  { rule: 'money-word', re: /\b(refund\w*|payout\w*|gratuity\w*|pay_period\w*|tip_cents|net_cents|fee_cents|deposit_amount|balance_due\w*|invoice_payments|proposal_payments|proposal_refunds|accruePayouts\w*|splitEvenly|proRataFeeCents|pricing_snapshot|total_price_override|invoice_line_items)\b/ },
]);

// ---- globs ---------------------------------------------------------------------

// Turn a gitignore-style pattern into an anchored regex. One pass, so the '*'
// inside an emitted '(?:.*/)?' is never rewritten: '**/' is zero or more
// directories, '**' crosses slashes, '*' stays inside one segment.
function patternToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const HINGE_REGEXES = HINGE_PATHS.map(patternToRegex);
const DOCS_REGEXES = DOCS_ALLOWLIST.map(patternToRegex);
const CODE_EXCLUDE_REGEXES = CODE_PATHS.exclude.map(patternToRegex);

// Make a path canonical so callers can pass paths as git emits them, with a
// leading "./", backslashes or interior '..' interchangeably: trim, forward
// slashes, every leading "./" stripped, then path.posix.normalize. Blank is ''.
function normalize(p) {
  let s = String(p).replace(/\\/g, '/').trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s ? path.posix.normalize(s) : '';
}

// A normalized path that leaves the repo root: unclassified, so hinge and never
// docs, whatever its tail looks like.
function escapesRoot(np) {
  return np === '..' || np.startsWith('../') || np.startsWith('/');
}

// ---- the list ------------------------------------------------------------------

// A line that tries to be a section header: one or more '#', any punctuation or
// space, then 'section' or 'sections' followed by ':', '=' or '-', by a section
// word (money, auth, client, hinge), or by exactly one word and nothing else.
// Prose comments that merely open with the word ('# section 8). The webauthn
// routes ...' and '# sections 5.1 and 13; ...', lines 472 and 580 of today's
// list) stay comments. A header attempt that does not parse as
// '# section: <known name>' throws: a malformed header must never leave the
// patterns under it in the wrong section.
const HEADER_ATTEMPT = /^#+\W*sections?\s*[:=-]|^#+\W*sections?\s+(?:money|auth|client|hinge)\b|^#+\W*sections?\s+[A-Za-z][\w-]*\s*$/i;
const HEADER = /^#\s*section\s*:\s*([A-Za-z-]+)\s*$/i;

function loadPatterns(listFile = DEFAULT_LIST) {
  const out = [];
  let section = 'money';
  fs.readFileSync(listFile, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (HEADER_ATTEMPT.test(line)) {
      const m = HEADER.exec(line);
      const name = m && m[1].toLowerCase();
      if (!name || !SECTIONS.includes(name)) {
        throw new Error(`${listFile} line ${i + 1}: malformed section header (expected '# section: ${SECTIONS.join(' | ')}'): ${line}`);
      }
      section = name;
      return;
    }
    if (line.startsWith('#')) return;
    out.push({ pattern: line, regex: patternToRegex(line), section });
  });
  return out;
}

// Any tier A section outweighs hinge.
function sectionWeight(section) {
  return section === 'hinge' ? 1 : 2;
}

// [{path, pattern, section}] for the sensitive subset of `paths`. When a path
// matches patterns in several sections the heaviest section wins (the first such
// pattern names it), so list order can never lighten a path.
function matchSensitiveDetailed(paths, listFile = DEFAULT_LIST) {
  const patterns = loadPatterns(listFile);
  const list = Array.isArray(paths) ? paths : [paths];
  const out = [];
  for (const p of list) {
    const np = normalize(p);
    let hit = null;
    for (const pat of patterns) {
      if (pat.regex.test(np) && (!hit || sectionWeight(pat.section) > sectionWeight(hit.section))) hit = pat;
    }
    if (hit) out.push({ path: p, pattern: hit.pattern, section: hit.section });
  }
  return out;
}

// Return the subset of `paths` that match a sensitive pattern.
function matchSensitive(paths, listFile = DEFAULT_LIST) {
  return matchSensitiveDetailed(paths, listFile).map((h) => h.path);
}

// True if ANY of `paths` is sensitive.
function isSensitive(paths, listFile = DEFAULT_LIST) {
  return matchSensitive(paths, listFile).length > 0;
}

// ---- hinge, docs, code paths ---------------------------------------------------

function isHingePath(p) {
  const np = normalize(p);
  return HINGE_REGEXES.some((re) => re.test(np));
}

function isDocsAllowlisted(p) {
  const np = normalize(p);
  if (escapesRoot(np)) return false;
  return DOCS_REGEXES.some((re) => re.test(np));
}

// Every path on the docs allowlist and none of them sensitive or hinge (4.7).
function isDocsOnly(paths, listFile = DEFAULT_LIST) {
  const list = (Array.isArray(paths) ? paths : [paths]).map(normalize).filter(Boolean);
  if (list.length === 0) return false;
  if (!list.every(isDocsAllowlisted)) return false;
  if (list.some(isHingePath)) return false;
  return !isSensitive(list, listFile);
}

function isCodePath(p) {
  const np = normalize(p);
  if (!CODE_PATHS.roots.some((r) => np.startsWith(r))) return false;
  if (!CODE_PATHS.extensions.some((e) => np.endsWith(e))) return false;
  return !CODE_EXCLUDE_REGEXES.some((re) => re.test(np));
}

// ---- the content rule ----------------------------------------------------------

// Read a C-quoted string as git writes it ("a/caf\303\251.js"): octal escapes are
// bytes, the rest are the usual C escapes. Returns {value, end} or null.
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function readQuoted(s, start) {
  const parts = [];
  let lit = '';
  const flush = () => { if (lit) { parts.push(Buffer.from(lit, 'utf8')); lit = ''; } };
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { flush(); return { value: Buffer.concat(parts).toString('utf8'), end: i + 1 }; }
    if (c === '\\' && i + 1 < s.length) {
      flush();
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (oct) { parts.push(Buffer.from([parseInt(oct[0], 8) & 0xff])); i += 1 + oct[0].length; continue; }
      const n = s[i + 1];
      parts.push(Buffer.from([C_ESCAPES[n] !== undefined ? C_ESCAPES[n] : n.charCodeAt(0) & 0xff]));
      i += 2;
      continue;
    }
    lit += c;
    i += 1;
  }
  return null;
}

// One path as a diff header line carries it: C-quoted or bare, a trailing tab
// (git adds one after a name with a space) dropped, '/dev/null' as null, the
// prefix stripped. Returns undefined when the prefix is not the expected one.
function headerPath(raw, prefix) {
  let s = raw;
  if (s.startsWith('"')) {
    const q = readQuoted(s, 0);
    if (!q) return undefined;
    s = q.value;
  } else if (s.endsWith('\t')) {
    s = s.slice(0, -1);
  }
  if (s === '/dev/null') return null;
  if (prefix === '') return s;
  return s.startsWith(prefix) ? s.slice(prefix.length) : undefined;
}

// The two paths of a 'diff --git' line. The symmetric bare form allows spaces;
// otherwise the two tokens are read as quoted strings or space-free runs. A rename
// or copy with spaces is named exactly by its own 'rename from/to' lines.
function gitHeaderPaths(rest) {
  const sym = /^a\/(.+) b\/\1$/.exec(rest);
  if (sym) return [sym[1], sym[1]];
  const toks = [];
  let i = 0;
  while (i < rest.length && toks.length < 3) {
    if (rest[i] === ' ') { i += 1; continue; }
    if (rest[i] === '"') {
      const q = readQuoted(rest, i);
      if (!q) return [];
      toks.push(q.value);
      i = q.end;
    } else {
      const j = rest.indexOf(' ', i);
      toks.push(rest.slice(i, j < 0 ? rest.length : j));
      i = j < 0 ? rest.length : j;
    }
  }
  if (toks.length !== 2 || !toks[0].startsWith('a/') || !toks[1].startsWith('b/')) return [];
  return [toks[0].slice(2), toks[1].slice(2)];
}

// Parse a unified diff (git's form, with a/ and b/ prefixes) into one record per
// file section: {path, paths, hunks: [{context, added}], binary, isNew, deleted,
// renamedOrCopied}. path is the post-image path (the pre-image for a deletion) or
// null when the section names no path this parser can read; paths holds every
// path the section names, so a rename's old path is seen too. '\r' is stripped,
// and '---' / '+++' are headers only before the section's first '@@'.
function parseDiff(diffText) {
  const files = [];
  let cur = null;
  const finish = (f) => {
    const explicit = f.explicit.filter((p) => p);
    const names = explicit.length ? explicit : f.header.filter((p) => p);
    f.paths = [...new Set(names.map(normalize).filter(Boolean))];
    const post = f.newPath !== undefined ? f.newPath : f.header[1];
    const pre = f.oldPath !== undefined ? f.oldPath : f.header[0];
    if (f.newPath === null) f.deleted = true;
    f.path = normalize(post || pre || '') || null;
  };
  for (let line of String(diffText || '').split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('diff --git ')) {
      if (cur) finish(cur);
      cur = { header: gitHeaderPaths(line.slice('diff --git '.length)), explicit: [], oldPath: undefined, newPath: undefined, hunks: [], inHunks: false, binary: false, isNew: false, deleted: false, renamedOrCopied: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      // The new-file line of the hunk's first line; null when the header does not read.
      const m = /^@@+ (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @@/.exec(line);
      cur.inHunks = true;
      cur.hunks.push({ context: [], added: [], nextLine: m ? Number(m[1]) : null });
      continue;
    }
    if (!cur.inHunks) {
      let m;
      if (line.startsWith('--- ')) { cur.oldPath = headerPath(line.slice(4), 'a/'); cur.explicit.push(cur.oldPath); continue; }
      if (line.startsWith('+++ ')) { cur.newPath = headerPath(line.slice(4), 'b/'); cur.explicit.push(cur.newPath); continue; }
      if ((m = /^(rename|copy) (from|to) (.+)$/.exec(line))) {
        const p = headerPath(m[3], '');
        cur.renamedOrCopied = true;
        cur.explicit.push(p);
        if (m[2] === 'from') cur.oldPath = p; else cur.newPath = p;
        continue;
      }
      if (line.startsWith('new file mode')) { cur.isNew = true; continue; }
      if (line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') { cur.binary = true; continue; }
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    const isAdded = line.startsWith('+');
    if (!isAdded && !line.startsWith(' ') && line !== '') continue; // '-' and '\ No newline' hold no new-file line
    if (isAdded) hunk.added.push({ line: hunk.nextLine === null ? 0 : hunk.nextLine, text: line.slice(1) });
    else hunk.context.push(line.slice(1));
    if (hunk.nextLine !== null) hunk.nextLine += 1;
  }
  if (cur) finish(cur);
  return files;
}

// The content rule's hits for the parsed sections, each {file, line, text, rule}
// (the one hit shape, see tier). Every added line in a code path that fires the
// rule is a hit (one per line). 'update-money-table' arms per hunk, two ways:
//   - the money-table write (writesMoneyTable: an UPDATE or an upsert) is in the
//     hunk's added lines: any status word or money column there arms it;
//   - the write is only in the context (or split across context and added
//     lines): a money column or a STATUS_WRITE_OR_GUARD in the added lines arms it.
// In an armed hunk the hit is an added line that names the write (the UPDATE,
// the upsert's INSERT INTO or DO UPDATE SET) or writes or guards a status;
// any other added line takes the first of the other rules that matches. A code
// section reported as binary, and a section with no readable path (file null),
// are 'diff-unparsed' (line 0, text ''): the rule cannot see them, so they fail
// closed.
const unparsedHit = (file) => ({ file, line: 0, text: '', rule: 'diff-unparsed' });

function hitsFromSections(sections) {
  const hits = [];
  for (const f of sections) {
    if (!f.path) { hits.push(unparsedHit(null)); continue; }
    if (!isCodePath(f.path)) continue;
    if (f.binary && !f.deleted) { hits.push(unparsedHit(f.path)); continue; }
    for (const hunk of f.hunks) {
      const added = hunk.added.map((a) => a.text).join('\n');
      const whole = hunk.context.join('\n') + '\n' + added;
      const updateArmed = writesMoneyTable(added)
        ? MONEY_COLUMNS.test(added) || /\bstatus\b/i.test(added)
        : writesMoneyTable(whole) && (MONEY_COLUMNS.test(added) || STATUS_WRITE_OR_GUARD.test(added));
      const upsert = DO_UPDATE.test(whole);
      const writeLine = (t) => MONEY_UPDATE.test(t) || (upsert && MONEY_INSERT.test(t)) || DO_UPDATE.test(t) || STATUS_WRITE_OR_GUARD.test(t);
      for (const { line, text } of hunk.added) {
        if (updateArmed && writeLine(text)) { hits.push({ file: f.path, line, text, rule: 'update-money-table' }); continue; }
        const r = CONTENT_RULES.find(({ re }) => re.test(text));
        if (r) hits.push({ file: f.path, line, text, rule: r.rule });
      }
    }
  }
  return hits;
}

function contentRuleHits(diffText) {
  return hitsFromSections(parseDiff(diffText));
}

// ---- tier ----------------------------------------------------------------------

// {file, line, text, rule: 'status-write'} for every added line in a code path
// that writes a status (the tier contract's B rule "any other status write"; a
// money-table one is A above).
function statusWritesFromSections(sections) {
  const out = [];
  for (const f of sections) {
    if (!f.path || !isCodePath(f.path)) continue;
    for (const hunk of f.hunks) {
      for (const { line, text } of hunk.added) if (STATUS_WRITE.test(text)) out.push({ file: f.path, line, text, rule: 'status-write' });
    }
  }
  return out;
}

// The per-file tier; a status write lifts a lighter tier (C, docs) to B.
function tierForPath(p, { sensitiveSection, contentHit, statusWrite }) {
  const t = classify(p, { sensitiveSection, contentHit });
  return statusWrite && TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf('B') ? 'B' : t;
}

function classify(p, { sensitiveSection, contentHit }) {
  if (escapesRoot(p)) return contentHit ? 'A' : 'hinge'; // unclassified (L2)
  if (sensitiveSection === 'hinge') return contentHit ? 'A' : 'hinge';
  if (sensitiveSection !== undefined) return 'A'; // one of A_SECTIONS: loadPatterns throws on any other name
  if (contentHit) return 'A';
  if (isHingePath(p)) return 'hinge';
  if (p.startsWith('server/')) return 'B';
  if (p.startsWith('scripts/')) return isCodePath(p) && SCRIPT_B_EXTENSIONS.some((e) => p.endsWith(e)) ? 'B' : 'hinge';
  if (p.startsWith('client/')) return 'C';
  if (isDocsAllowlisted(p)) return 'docs';
  return 'hinge'; // unclassified (spec 3.3)
}

/**
 * Compute the review tier for a diff.
 * @param {object} o
 * @param {string[]} o.paths     changed paths (git diff --name-only)
 * @param {string}   o.diffText  the unified diff (added lines feed the content rule)
 * @param {string[]} [o.newPaths] paths added by the diff (a new route or middleware file widens the B floor)
 * @param {string[]} [o.deletedPaths] paths the diff deletes (exempt from the no-section rule below)
 * @param {string}   [o.listFile]
 *
 * Fails closed: the path set is the union of `paths` and every path a diff
 * section names (a rename's old path included), and a code path that is not
 * deleted but has no parsed diff section, or whose section is binary, is tier A
 * with a contentRuleHits entry {file, line: 0, text: '', rule: 'diff-unparsed'}.
 * A section whose path cannot be read at all makes the label A; its hit carries
 * file null. So does a non-empty diffText that parses to no section at all when
 * the path set is empty.
 *
 * Hits: every entry of contentRuleHits and statusWrites is {file, line, text,
 * rule}. line is the added line's number in the new file (from the hunk header)
 * and text that line; a diff-unparsed hit has line 0 and text ''. file is the
 * repo-relative path, or null (the one sentinel) for a section with no readable
 * path.
 *
 * Precondition: the fail-closed guarantees above and the context reach of the
 * update-money-table rule hold for a diff built the way tierFromGit builds it
 * (git diff with GIT_DIFF_FLAGS and --unified=DIFF_CONTEXT_LINES, the paths from
 * --name-status -z through parseNameStatus). A caller with its own diff should
 * call tierFromGit instead, or pass at least DIFF_CONTEXT_LINES lines of context:
 * with less, a status write further below its UPDATE than the context reaches is
 * not seen as a money-table write.
 */
function tier({ paths = [], diffText = '', newPaths = [], deletedPaths = [], listFile = DEFAULT_LIST }) {
  const sections = parseDiff(diffText);
  const given = (Array.isArray(paths) ? paths : [paths]).map(normalize).filter(Boolean);
  const sectioned = new Set(sections.flatMap((s) => s.paths));
  const list = [...new Set([...given, ...sectioned])];
  const deleted = new Set([
    ...deletedPaths.map(normalize),
    ...sections.filter((s) => s.deleted && s.path).map((s) => s.path),
  ]);
  const detailed = matchSensitiveDetailed(list, listFile);
  const sectionByPath = new Map(detailed.map((h) => [normalize(h.path), h.section]));
  const hits = hitsFromSections(sections);
  for (const p of list) {
    if (isCodePath(p) && !sectioned.has(p) && !deleted.has(p)) hits.push(unparsedHit(p));
  }
  // A diff with content that parses to no section (coloured, a plain diff -u, a
  // combined diff) and no path to pin it to says nothing this module can read:
  // it fails closed, a diff-unparsed hit with file null.
  if (list.length === 0 && sections.length === 0 && /\S/.test(String(diffText || ''))) hits.push(unparsedHit(null));
  const hitFiles = new Set(hits.map((h) => h.file));
  const statusWrites = statusWritesFromSections(sections);
  const statusFiles = new Set(statusWrites.map((w) => w.file));
  const tiersByFile = {};
  for (const p of list) {
    tiersByFile[p] = tierForPath(p, { sensitiveSection: sectionByPath.get(p), contentHit: hitFiles.has(p), statusWrite: statusFiles.has(p) });
  }
  const tiers = Object.values(tiersByFile);
  if (hitFiles.has(null)) tiers.push('A');
  // An empty path set says nothing about the change: hinge, never docs (4.7 makes
  // docs the tier where the gate skips both checks).
  if (tiers.length === 0) tiers.push('hinge');
  const label = TIER_ORDER.find((t) => tiers.includes(t));
  const floors = new Set();
  for (const t of new Set(tiers)) for (const lens of TIER_FLOORS[t]) floors.add(lens);
  // New files: the caller's list plus every section that is a new file or the
  // target of a rename or copy, so a caller holding only {paths, diffText} still
  // widens the floor for a new route or middleware file.
  const newSet = new Set([
    ...newPaths.map(normalize),
    ...sections.filter((s) => (s.isNew || s.renamedOrCopied) && !s.deleted && s.path).map((s) => s.path),
  ]);
  if (tiers.includes('B') && list.some((p) => newSet.has(p) && (p.startsWith('server/routes/') || p.startsWith('server/middleware/')))) {
    floors.add('access-egress');
  }
  const anyA = tiers.includes('A');
  return {
    tier: label,
    tiersByFile,
    floors: [...floors],
    externals: anyA,
    verify: anyA,
    tests: {
      smoke: anyA,
      suites: tiers.some((t) => t === 'A' || t === 'B' || t === 'hinge'),
      clientBuild: list.some((p) => p.startsWith('client/')),
    },
    matchedPaths: detailed,
    sections: [...new Set(detailed.map((h) => h.section))],
    contentRuleHits: hits,
    statusWrites,
    hingePaths: list.filter(isHingePath),
    docsOnly: isDocsOnly(list, listFile),
  };
}

/**
 * The tier for a git range, read the one way tier() is specified for: the
 * name-status -z read through parseNameStatus and the diff with GIT_DIFF_FLAGS
 * and --unified=DIFF_CONTEXT_LINES. The CLI's --tier runs this; review-select
 * calls it.
 * @param {{base: string, tip: string} | {staged: true}} range  two commits, or the staged index
 * @param {object} [o]
 * @param {string} [o.cwd]       the repo to read (default: the repo this script lives in)
 * @param {string} [o.listFile]
 * Throws 'tierFromGit: ...' for a malformed range or a ref that is not a commit.
 */
function tierFromGit(range, { cwd = REPO_ROOT, listFile = DEFAULT_LIST } = {}) {
  const git = (args, stderr = 'pipe') => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', stderr] });
  const r = range || {};
  const staged = r.staged === true;
  const isRef = (v) => typeof v === 'string' && v.length > 0;
  if (staged ? r.base !== undefined || r.tip !== undefined : !isRef(r.base) || !isRef(r.tip)) {
    throw new Error('tierFromGit: pass { base, tip } (two commits) or { staged: true }');
  }
  const refs = staged ? [] : [r.base, r.tip].map((ref) => {
    try {
      return git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], 'ignore').trim();
    } catch {
      throw new Error(`tierFromGit: ${ref} is not a commit in ${cwd}`);
    }
  });
  // '--' after the refs: a file named like a ref (main, HEAD, a sha) is never read as one.
  const diffArgs = (extra) => ['diff', ...GIT_DIFF_FLAGS, ...extra, ...(staged ? ['--cached'] : []), '--end-of-options', ...refs, '--'];
  const ns = parseNameStatus(git(diffArgs(['--name-status', '-z'])));
  const diffText = git(diffArgs([`--unified=${DIFF_CONTEXT_LINES}`]));
  return tier({ paths: ns.paths, diffText, newPaths: ns.newPaths, deletedPaths: ns.deletedPaths, listFile });
}

module.exports = {
  STATUS_WRITE,
  isSensitive,
  matchSensitive,
  matchSensitiveDetailed,
  loadPatterns,
  patternToRegex,
  HINGE_PATHS,
  isHingePath,
  DOCS_ALLOWLIST,
  isDocsAllowlisted,
  isDocsOnly,
  CODE_PATHS,
  isCodePath,
  contentRuleHits,
  TIER_FLOORS,
  TIER_ORDER,
  tier,
  tierFromGit,
  parseNameStatus,
  GIT_DIFF_FLAGS,
  gitEnv,
  DIFF_CONTEXT_LINES,
};

// ---- CLI -----------------------------------------------------------------------
// `node sensitive-match.js <path>...` or paths on stdin (one per line): prints the
// matched sensitive paths; exits 0 if any matched, 1 if none (grep-style).
// `node sensitive-match.js --tier --base <commit> --tip <commit>` or
// `--tier --staged`: prints the tier JSON for that diff; a missing or invalid
// flag or ref prints the usage line and exits 2.

const USAGE = 'usage: sensitive-match.js --tier --base <commit> --tip <commit> | --tier --staged\n';

// Parse `git diff --name-status -z`. A rename or copy contributes both paths and
// its new path counts as new; an add is new; a delete is deleted; every other
// status (M, T, U for unmerged, X, ...) contributes its path.
function parseNameStatus(z) {
  const toks = String(z || '').split('\0');
  const out = { paths: [], newPaths: [], deletedPaths: [] };
  let i = 0;
  while (i < toks.length) {
    const status = toks[i];
    if (!status) { i += 1; continue; }
    if (status[0] === 'R' || status[0] === 'C') {
      const [from, to] = [toks[i + 1], toks[i + 2]];
      if (from) out.paths.push(from);
      if (to) { out.paths.push(to); out.newPaths.push(to); }
      i += 3;
      continue;
    }
    const p = toks[i + 1];
    if (p) {
      out.paths.push(p);
      if (status[0] === 'A') out.newPaths.push(p);
      if (status[0] === 'D') out.deletedPaths.push(p);
    }
    i += 2;
  }
  return out;
}

// The flags are checked here; the refs and the git read are tierFromGit's, run
// from the process cwd. Any throw prints its message and the usage line, exit 2.
function tierCli(args) {
  const usage = (msg) => {
    if (msg) process.stderr.write(`sensitive-match.js: ${msg}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  };
  let range;
  if (args.length === 2 && args[1] === '--staged') {
    range = { staged: true };
  } else {
    const value = (flag) => {
      const i = args.indexOf(flag);
      const v = i < 0 ? undefined : args[i + 1];
      return v && !v.startsWith('-') ? v : null;
    };
    const base = value('--base');
    const tip = value('--tip');
    if (args.length !== 5 || !base || !tip) usage();
    range = { base, tip };
  }
  let result;
  try {
    result = tierFromGit(range, { cwd: process.cwd() });
  } catch (e) {
    usage(String((e && e.message) || e).split('\n')[0]);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--tier') tierCli(args);
  const emit = (paths) => {
    const matched = matchSensitive(paths);
    matched.forEach((p) => process.stdout.write(p + '\n'));
    process.exit(matched.length > 0 ? 0 : 1);
  };
  if (args.length > 0) {
    emit(args);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => emit(buf.split('\n').map((l) => l.trim()).filter(Boolean)));
  }
}
