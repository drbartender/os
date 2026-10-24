#!/usr/bin/env node
'use strict';

// The receipt check over a push range (instruction rewrite step 3, lane
// range-check; spec 2026-10-19 sections 3.7, 3.10, 4.7, 4.8 and D2; plan
// 2026-10-22 decisions 8, 9 and 18). ship and the pre-push hook call the one
// function, checkRange({base, tip, cwd}), and refuse on any problem.
//
// Every commit in base..tip, oldest first:
//   - a merge commit is a problem (main holds squashes only), and so is a
//     commit with no parent;
//   - a commit whose own diff is docs-only (gatePaths.touches over parent and
//     commit, which reads sensitive-match.isDocsOnly; an empty diff is not
//     docs-only) needs nothing;
//   - any other commit needs a receipt: the one under receipt.commitKey of the
//     commit (a revert receipt there whose tip names another commit is that
//     commit's, a patch-id twin's, and is passed over), else the one under
//     the commit's tree (a quick fix keys its staged tree). It must be state
//     final, its key field must be the key it was found under, and its kind
//     must fit where it was found (under the commit key: lane, commit,
//     squash, revert, comment-only; under the tree: quick-fix, comment-only).
// Then by kind:
//   revert        accepted only on the tree proof of decision 9, recomputed
//                 here: the message names the reverted commit (This reverts
//                 commit <sha>), that commit is an ancestor of origin/main, and
//                 in a temporary index (GIT_INDEX_FILE) read-tree of the parent
//                 plus apply --cached --reverse of the reverted commit's diff
//                 writes exactly the commit's tree. A reverted field in the
//                 receipt, when present, must name the same commit. A revert
//                 of a revert re-lands a change and is refused here: it needs
//                 a lane or quick-fix receipt. The proof is revertProof,
//                 exported: ship runs the same function before it writes a
//                 revert receipt, so the two never disagree.
//   comment-only  accepted on its proof field naming a file in the receipt
//                 directory (no lens, no tests).
//   every other   judged from the receipt directory, never from its summary:
//                 the tier recomputed with sensitive-match.tierFromGit over
//                 parent..commit must not be above the receipt's tier; the
//                 verdict tables are parsed again from every file the reports
//                 list names, per lens in seq order (receipt.parseVerdictTable,
//                 receipt.mergeVerdicts, receipt.coverage over this check's own
//                 file list, the generated docs excluded), and every file needs
//                 a pass from every lens that reported and every floor lens of
//                 the recomputed tiers: a finding row passes only when every id
//                 its note names is fixed or rejected in the triage, a not
//                 reached row only when the receipt allowed not reached for that
//                 lens and file, and an escalate row never; every finding any
//                 report raised (a row naming it or not) must be fixed or
//                 rejected in the triage; a malformed report of a lens stands
//                 only when a later well-formed report of that lens follows it
//                 in seq order; at tier A a verify report is needed,
//                 and every verify report must be well formed, holding a
//                 finding or the No findings record; the tests are read again from the files the tests
//                 entries name: at tier A a smoke entry whose summary.json has
//                 skipped false, no did_not_run and total_fail 0, at tiers A, B
//                 and hinge a suites entry whose summary.json has total_fail 0,
//                 each suite's TAP log (the smoke's too) parsing with found true,
//                 fail 0 and cancelled 0 (a suites run that reached nothing stands), and for
//                 a client/ file a latest build entry with exit 0 whose log has
//                 a compile success line and no failure line.
// The PII scan: piiShapes.findInDiff over the pinned diff in the pre-step's
// allowlisted mode, over each commit's own diff against its parent (docs-only
// commits included, so a line added and removed inside the range is caught)
// and over base..tip; every hit is a problem naming the commit (per commit),
// the file, the line and the shape, never the text. Each commit's message,
// subject and body, is scanned the same way (git revert's sha line and the
// two attribution trailers aside, messageShapes), and a hit names the commit
// and the shape.
//
// checkRange never reads index.json, written_by or a receipt's counts. Every
// git call fails closed: an error is a problem, never a pass. Every text it
// returns or prints names a commit by sha7, a file by path (masked when the
// path itself carries a shape), and never a word of a report, a log or a
// reason; a commit subject is masked through piiShapes.mask.
//
// Returns {ok, docs_only, commits: [{sha, subject, docs_only, kind,
// receipt_key, problems}], pii: [{file, line, shape}], problems}. sha and
// receipt_key are full ids (data for the caller); problems at the top level
// hold every problem, the per-commit ones included, in order.
//
// CLI: node scripts/lib/rangeCheck.js <base>..<tip> prints one line per
// commit and its problems, then the range problems; exit 0 clean, 1 on any
// problem, 2 usage.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./receipt');
const SM = require('../sensitive-match');
const GP = require('./gatePaths');
const { parse: parseTap } = require('./tapSummary');
const PII = require('./piiShapes');

const MAX_BUFFER = 256 * 1024 * 1024;
const S = R.short;
const SUITE_TIERS = Object.freeze(['A', 'B', 'hinge']);
const UNDER_KEY = Object.freeze(['lane', 'commit', 'squash', 'revert', 'comment-only']);
const UNDER_TREE = Object.freeze(['quick-fix', 'comment-only']);
const CLEARED = Object.freeze(['fixed', 'rejected']);
// An id a row's note names: receiptVerdicts.js's NOTE_ID, the same token.
const NOTE_ID = /(?<=^|[\s([{*_,;/])[HML]\d+(?=$|[\s:)\]}*_,.;/])/g;
const REVERTS = /^This reverts commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)\b/m;
const BUILD_FAILED = /Failed to compile/;
const BUILD_COMPILED = /Compiled successfully|Compiled with warnings/;
// The pre-step's diff (piiShapes.js --find --added): plain, added lines only.
const PII_DIFF = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/']);
// The reverted commit's diff, whole: binary content, full ids, no renames.
const REVERT_DIFF = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--ignore-submodules=none']);

// ---- git, failing closed ----------------------------------------------------------

function git(what, args, { cwd, env = R.gitEnv(), input } = {}) {
  const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw new Error(`git ${what} failed (exit ${r.status === null ? 'none' : r.status})`);
  return r.stdout;
}

// fn() or the problem its throw names; never a pass.
function attempt(fn, problems, prefix) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    problems.push(`${prefix}${err && err.message ? err.message : String(err)}`);
    return { ok: false };
  }
}

function showPath(p) {
  return PII.maskPath(String(p));
}

function treeOf(sha, cwd) {
  const t = git('rev-parse', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{tree}`], { cwd }).trim();
  if (!R.KEY_RE.test(t)) throw new Error(`no tree for ${S(sha)}`);
  return t;
}

// [{sha, parents}] oldest first.
function listCommits(base, tip, cwd) {
  const out = git('rev-list', ['rev-list', '--reverse', '--topo-order', '--parents', '--end-of-options', `${base}..${tip}`, '--'], { cwd });
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, ...parents] = l.trim().split(/\s+/);
    if (!R.KEY_RE.test(sha) || !parents.every((p) => R.KEY_RE.test(p))) throw new Error('git rev-list printed a line that is no commit');
    return { sha, parents };
  });
}

function messageOf(sha, cwd) {
  const out = git('log', ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--no-show-signature', '--format=%s%x00%B', '--end-of-options', sha, '--'], { cwd });
  const at = out.indexOf('\0');
  return at < 0 ? { subject: out.trim(), body: out } : { subject: out.slice(0, at).trim(), body: out.slice(at + 1) };
}

// ---- files inside a receipt directory ------------------------------------------

// The absolute path of `rel` inside `dir`, or null when it is not a plain
// relative path that stays inside.
function inside(dir, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const p = path.resolve(dir, rel);
  return p.startsWith(dir + path.sep) ? p : null;
}

// The text of a regular file inside `dir`, or null.
function readInside(dir, rel) {
  const p = inside(dir, rel);
  if (!p) return null;
  try {
    if (!fs.lstatSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonInside(dir, rel) {
  const text = readInside(dir, rel);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- the receipt ---------------------------------------------------------------

// {key, dir, rec, via} or {missing: true, why}; a git or read error throws.
// A revert receipt under the commit key whose tip is set and names another
// commit belongs to that commit (a commit key is a patch id, and two reverts
// of the same lines share one), so the lookup goes on to the tree as if the
// key held nothing.
function findReceipt(sha, cwd) {
  let key = null;
  let keyWhy = null;
  try {
    key = R.commitKey(sha, { cwd });
  } catch (err) {
    keyWhy = err && err.message ? err.message : String(err);
  }
  let twin = null;
  if (key) {
    const dir = R.receiptDir(key, { cwd });
    const rec = R.readReceipt(dir);
    if (rec && rec.kind === 'revert' && rec.tip !== undefined && rec.tip !== null && rec.tip !== sha) twin = String(rec.tip);
    else if (rec) return { key, dir, rec, via: 'commit key' };
  }
  const tree = treeOf(sha, cwd);
  const dir = R.receiptDir(tree, { cwd });
  const rec = R.readReceipt(dir);
  if (rec) return { key: tree, dir, rec, via: 'tree' };
  if (twin !== null) {
    return { missing: true, why: `no review receipt of its own (its commit key ${S(key)} holds the revert receipt of ${S(twin)}, another commit with the same patch, and its tree ${S(tree)} holds none); it needs its own receipt` };
  }
  const where = key ? `its commit key ${S(key)}` : `no commit key (${keyWhy})`;
  return { missing: true, why: `no review receipt (looked under ${where} and its tree ${S(tree)})` };
}

// ---- revert: the tree proof (decision 9) ----------------------------------------

// The proof for commit c on its parent, given its message body (revertProof
// below says what it returns).
function proveRevert(c, parent, body, cwd, top, afterMessage) {
  const p = [];
  const at = `${S(c)}: `;
  const m = REVERTS.exec(body);
  if (!m) return { ok: false, reverted: null, problems: [`${at}a revert receipt, but the message names no reverted commit (This reverts commit <sha>)`] };
  const rv = attempt(() => R.resolveCommit(m[1], { cwd }), p, at);
  if (!rv.ok) return { ok: false, reverted: null, problems: p };
  const reverted = rv.value;
  const done = () => ({ ok: p.length === 0, reverted, problems: p });
  // A revert of a revert re-lands a change: it is reviewed like one.
  const prior = attempt(() => messageOf(reverted, cwd), p, at);
  if (!prior.ok) return done();
  if (REVERTS.test(prior.value.body)) {
    p.push(`${at}reverts ${S(reverted)}, itself a revert: the commit re-lands a reverted change and needs a lane or quick-fix receipt`);
    return done();
  }
  if (afterMessage) p.push(...afterMessage(reverted));
  let origin = null;
  try {
    origin = R.resolveCommit('refs/remotes/origin/main', { cwd });
  } catch {
    p.push(`${at}no origin/main to prove ${S(reverted)} shipped; fetch first`);
  }
  if (origin) {
    const anc = attempt(() => R.isAncestor(reverted, origin, { cwd }), p, at);
    if (anc.ok && !anc.value) p.push(`${at}reverts ${S(reverted)}, which is not on origin/main (a revert receipt is for a shipped commit)`);
  }
  const rp = attempt(() => R.resolveCommit(`${reverted}^`, { cwd }), p, at);
  if (!rp.ok) return done();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'range-check-index-'));
  try {
    const env = { ...R.gitEnv(), GIT_INDEX_FILE: path.join(tmp, 'index') };
    const proof = attempt(() => {
      git('read-tree', ['read-tree', '--end-of-options', parent], { cwd: top, env });
      const diff = git('diff', ['-c', 'core.quotePath=true', 'diff', ...REVERT_DIFF, '--end-of-options', rp.value, reverted, '--'], { cwd: top });
      if (diff.length === 0) throw new Error(`${S(reverted)} changes nothing; there is nothing to revert`);
      git('apply', ['-c', 'apply.whitespace=nowarn', 'apply', '--cached', '--reverse', '-'], { cwd: top, env, input: diff });
      return git('write-tree', ['write-tree'], { cwd: top, env }).trim();
    }, p, `${at}the revert proof did not run: `);
    if (proof.ok) {
      const want = attempt(() => treeOf(c, cwd), p, at);
      if (want.ok && proof.value !== want.value) p.push(`${at}its tree is not ${S(reverted)} reverted on its parent; the commit carries more than the revert`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return done();
}

// The tree proof of decision 9 for one commit, the one proof ship (before it
// writes a revert receipt) and checkRange (for every revert receipt it meets)
// share, so the two never disagree on what a clean revert is: {ok, reverted,
// problems}. reverted is the full sha the message names, null when it names
// none or that does not resolve; problems are the lines for the message, a
// revert of a revert, the origin/main ancestry and the tree; ok is true
// exactly when problems is empty. afterMessage is revertProblems' own: called
// with the reverted sha once the message names a commit that is no revert
// itself, its lines stand there, ahead of the ancestry.
function revertProof(sha, { cwd = process.cwd(), afterMessage = null } = {}) {
  const p = [];
  const c = attempt(() => R.resolveCommit(sha, { cwd }), p, `${S(String(sha))}: `);
  if (!c.ok) return { ok: false, reverted: null, problems: p };
  const at = `${S(c.value)}: `;
  const parent = attempt(() => R.resolveCommit(`${c.value}^`, { cwd }), p, at);
  const msg = attempt(() => messageOf(c.value, cwd), p, at);
  const top = attempt(() => git('rev-parse', ['rev-parse', '--show-toplevel'], { cwd }).trim(), p, at);
  if (!parent.ok || !msg.ok || !top.ok) return { ok: false, reverted: null, problems: p };
  return proveRevert(c.value, parent.value, msg.value.body, cwd, top.value, afterMessage);
}

// A revert receipt's problems: the receipt's reverted field, when present,
// must name the commit the message names; revertProof does the rest.
function revertProblems(c, rec, cwd) {
  const afterMessage = (reverted) => {
    if (rec.reverted === undefined || rec.reverted === null) return [];
    const p = [];
    const named = attempt(() => R.resolveCommit(String(rec.reverted), { cwd }), p, `${S(c)}: `);
    if (named.ok && named.value !== reverted) p.push(`${S(c)}: the receipt names ${S(named.value)} as reverted; the message names ${S(reverted)}`);
    return p;
  };
  return revertProof(c, { cwd, afterMessage }).problems;
}

// ---- the tables -----------------------------------------------------------------

function triageState(rec, report, id) {
  const t = rec.triage && typeof rec.triage === 'object' ? rec.triage[`${report}#${id}`] : null;
  return t && typeof t === 'object' ? t.status : null;
}

function allowedNotReached(rec, lens, file) {
  const cov = rec.coverage;
  return Boolean(cov && cov.allowed_not_reached === true && Array.isArray(cov.not_reached)
    && cov.not_reached.some((x) => x && x.lens === lens && x.file === file));
}

function tableProblems(c, rec, dir, files, floors, tier) {
  const p = [];
  const at = `${S(c)}: `;
  if (!Array.isArray(rec.reports)) return [`${at}the receipt lists no reports`];
  const order = (e, i) => (Number.isInteger(e.seq) ? e.seq : i + 1);
  const entries = rec.reports.map((e, i) => ({ e, n: order(e || {}, i) })).sort((a, b) => a.n - b.n).map((x) => x.e);
  const byLens = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.file !== 'string') {
      p.push(`${at}a reports entry names no file`);
      continue;
    }
    const lens = e.lens;
    if (lens !== 'verify' && !R.LENSES.includes(lens)) {
      p.push(`${at}the report ${showPath(e.file)} names no known lens`);
      continue;
    }
    const text = readInside(dir, e.file);
    if (text === null) {
      p.push(`${at}the report ${showPath(e.file)} is missing from the receipt directory`);
      continue;
    }
    const parsed = R.parseVerdictTable(text, lens === 'verify' ? { findingsOnly: true } : { lens });
    // A malformed report yields no rows (receiptVerdicts.js); it is judged
    // below, per lens, against the reports stored after it.
    if (!byLens.has(lens)) byLens.set(lens, []);
    byLens.get(lens).push({ name: e.file, ...parsed });
  }
  const lenses = R.LENSES.filter((l) => floors.includes(l) || byLens.has(l));
  for (const lens of lenses) {
    const reports = byLens.get(lens);
    // A malformed report stands only when a later report of its lens, stored
    // after it, parses well formed (a re-emission); otherwise its rows were
    // never read and it is named.
    (reports || []).forEach((r, i) => {
      if (r.malformed && !reports.slice(i + 1).some((x) => !x.malformed)) p.push(`${at}the ${lens} report ${showPath(r.name)} is malformed and no later well-formed ${lens} report follows it`);
    });
    if (!reports) {
      p.push(`${at}no ${lens} report; the tier floor needs one`);
      continue;
    }
    const merged = R.mergeVerdicts(reports);
    const cov = R.coverage(files, merged);
    for (const f of cov.not_reached) {
      const m = merged[f];
      if (!m) p.push(`${at}${lens} has no verdict for ${showPath(f)}`);
      else if (!allowedNotReached(rec, lens, f)) p.push(`${at}${lens} reads ${showPath(f)} as not reached`);
    }
    for (const f of cov.files_with_verdicts) {
      const m = merged[f];
      if (m.verdict === 'escalate') {
        p.push(`${at}${lens} escalates ${showPath(f)}`);
      } else if (m.verdict === 'finding') {
        const ids = [...new Set(String(m.note).match(NOTE_ID) || [])];
        const open = ids.filter((id) => !CLEARED.includes(triageState(rec, m.report, id)));
        if (ids.length === 0) p.push(`${at}${lens}'s finding row for ${showPath(f)} names no finding id`);
        else if (open.length) p.push(`${at}${lens}'s finding row for ${showPath(f)} names ${open.join(', ')}, neither fixed nor rejected in the triage`);
      } else if (m.verdict !== 'pass') {
        p.push(`${at}${lens} gives ${showPath(f)} no pass`);
      }
    }
  }
  const verify = byLens.get('verify') || [];
  if (tier === 'A' && verify.length === 0) p.push(`${at}tier A and no verify report`);
  // A verify report is read whole (no table): it must be well formed and hold
  // a finding or the No findings record, as finalize requires.
  for (const r of verify) {
    if (r.malformed) p.push(`${at}the verify report ${showPath(r.name)} is malformed or holds neither a finding nor the No findings record`);
  }
  // Every finding every report raised, whether or not a row names it, must be
  // fixed or rejected in the triage (a row's note may name a subset, and a
  // finding can sit under a file whose row says pass). The finding's file is
  // the report's words: named only when it is a file in the diff.
  for (const [lens, reports] of byLens) {
    for (const r of reports) {
      for (const f of r.findings) {
        if (CLEARED.includes(triageState(rec, r.name, f.id))) continue;
        const where = files.includes(f.file) ? showPath(f.file) : 'a file outside the diff';
        p.push(`${at}${lens}'s ${f.id} in ${showPath(r.name)} (on ${where}) is neither fixed nor rejected in the triage`);
      }
    }
  }
  return p;
}

// ---- the tests --------------------------------------------------------------------

// The problems of one runner entry (smoke or suites), read from its files.
function runProblems(at, dir, entry, type) {
  const p = [];
  const summary = readJsonInside(dir, entry.log);
  if (!summary) return [`${at}the ${type} entry's summary.json is missing or unreadable`];
  if (type === 'smoke') {
    if (summary.skipped !== false) p.push(`${at}the smoke summary says skipped`);
    if (summary.did_not_run !== undefined) p.push(`${at}the smoke summary says it did not run`);
  }
  if (summary.total_fail !== 0) p.push(`${at}the ${type} summary does not say total_fail 0`);
  if (!Array.isArray(summary.suites)) return [...p, `${at}the ${type} summary lists no suites`];
  if (type === 'smoke' && summary.suites.length === 0) p.push(`${at}the smoke ran no suite`);
  const runDir = path.dirname(entry.log);
  for (const s of summary.suites) {
    const log = s && typeof s.log === 'string' && path.basename(s.log) === s.log ? path.join(runDir, s.log) : null;
    const text = log ? readInside(dir, log) : null;
    const name = s && typeof s.file === 'string' ? showPath(s.file) : '(a suite)';
    if (text === null) {
      p.push(`${at}the ${type} log for ${name} is missing`);
      continue;
    }
    const t = parseTap(text);
    if (!t.found) p.push(`${at}the ${type} log for ${name} has no TAP summary`);
    else if (t.fail !== 0) p.push(`${at}the ${type} log for ${name} says fail ${t.fail}`);
    else if (t.cancelled > 0) p.push(`${at}the ${type} log ${showPath(s.log)} for ${name} says cancelled ${t.cancelled}`);
  }
  return p;
}

function testProblems(c, rec, dir, files, tier) {
  const p = [];
  const at = `${S(c)}: `;
  const tests = Array.isArray(rec.tests) ? rec.tests.filter((x) => x && typeof x === 'object') : [];
  if (!Array.isArray(rec.tests)) p.push(`${at}the receipt lists no tests`);
  const of = (type) => tests.filter((x) => x.type === type);
  if (tier === 'A') {
    if (of('smoke').length === 0) p.push(`${at}tier A and no smoke entry`);
    for (const e of of('smoke')) p.push(...runProblems(at, dir, e, 'smoke'));
  }
  if (SUITE_TIERS.includes(tier)) {
    if (of('suites').length === 0) p.push(`${at}tier ${tier} and no suites entry`);
    for (const e of of('suites')) p.push(...runProblems(at, dir, e, 'suites'));
  }
  if (files.some((f) => f.startsWith('client/'))) {
    const builds = of('build');
    const b = builds[builds.length - 1];
    if (!b) {
      p.push(`${at}a client/ file and no build entry`);
    } else {
      const text = readInside(dir, b.log);
      if (b.exit !== 0) p.push(`${at}the latest build entry does not say exit 0`);
      else if (text === null) p.push(`${at}the latest build log is missing`);
      else if (BUILD_FAILED.test(text) || !BUILD_COMPILED.test(text)) p.push(`${at}the latest build log is no green build`);
    }
  }
  return p;
}

// ---- one commit ---------------------------------------------------------------------

// The PII hits of the pinned diff between two commits, each as {file, line,
// shape} and the problem text (never the text of the line).
function piiScan(from, to, top) {
  const diff = git('diff', ['-c', 'core.quotePath=false', 'diff', ...PII_DIFF, '--end-of-options', from, to, '--'], { cwd: top });
  return PII.findInDiff(diff).map((h) => {
    const file = h.path === null || h.path === undefined ? null : showPath(h.path);
    const line = Number.isInteger(h.line) ? h.line : null;
    let text;
    if (file === null) text = 'pii: a diff header names a path this check cannot read; nothing about that file is judged';
    else if (line !== null) text = `pii: ${file} line ${line} adds a ${h.shape}-shaped run`;
    else text = `pii: the path ${file} itself carries a ${h.shape}-shaped run`;
    return { hit: { file, line, shape: h.shape }, text };
  });
}

// The shapes in a commit message (subject and body), allowlisted mode, each
// once. Three machine lines are left out, each only in its exact form: the
// sha on git revert's own line (a commit id, read as the revert proof), the
// attribution trailer's no-reply address, and the session trailer's id.
const NOREPLY = ['noreply', 'anthropic.com'].join('@').replace(/\./g, '\\.');
const TRAILERS = Object.freeze([
  /^(This reverts commit )[0-9a-f]{40}(?:[0-9a-f]{24})?\b/gm,
  new RegExp(`^(Co-Authored-By: [^<>\\n]*<)${NOREPLY}>[ \\t]*$`, 'gim'),
  /^(Claude-Session: )[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[ \t]*$/gm,
]);
function messageShapes(body) {
  const text = TRAILERS.reduce((t, re) => t.replace(re, '$1<machine>'), String(body || ''));
  return [...new Set(PII.findPii(text).map((h) => h.shape))];
}

function judge(entry, cwd, top) {
  const { sha, parents } = entry;
  const at = `${S(sha)}: `;
  const out = { sha, subject: '', docs_only: false, kind: null, receipt_key: null, problems: [] };
  const p = out.problems;
  const msg = attempt(() => messageOf(sha, cwd), p, at);
  out.subject = msg.ok ? PII.mask(msg.value.subject) : '';
  if (msg.ok) for (const shape of messageShapes(msg.value.body)) p.push(`${at}pii: the commit message carries a ${shape}-shaped run`);
  if (parents.length > 1) {
    p.push(`${at}a merge commit; main holds squashes only`);
    return out;
  }
  if (parents.length === 0) {
    p.push(`${at}a commit with no parent; nothing to compare it against`);
    return out;
  }
  const parent = parents[0];
  // Each commit's own diff too, docs-only ones included (they ran no
  // pre-step): a line added and removed again inside the range is still
  // caught here.
  const scan = attempt(() => piiScan(parent, sha, top), p, `${at}pii: `);
  if (scan.ok) for (const x of scan.value) p.push(`${at}${x.text}`);
  const t = attempt(() => GP.touches(parent, sha, { cwd }), p, at);
  if (!t.ok) return out;
  if (t.value.docs_only) {
    out.docs_only = true;
    return out;
  }
  const found = attempt(() => findReceipt(sha, cwd), p, at);
  if (!found.ok) return out;
  if (found.value.missing) {
    p.push(`${at}${found.value.why}`);
    return out;
  }
  const { key, dir, rec, via } = found.value;
  out.receipt_key = key;
  out.kind = typeof rec.kind === 'string' ? rec.kind : null;
  if (rec.key !== key) p.push(`${at}the receipt under ${S(key)} records another key`);
  if (rec.state !== 'final') p.push(`${at}the receipt ${S(key)} is not final`);
  const fits = via === 'tree' ? UNDER_TREE : UNDER_KEY;
  if (!fits.includes(rec.kind)) {
    p.push(`${at}a receipt of kind ${out.kind === null ? '(none)' : out.kind} under its ${via}, which takes ${fits.join(' or ')}`);
    return out;
  }
  if (rec.kind === 'revert') {
    p.push(...revertProblems(sha, rec, cwd));
    return out;
  }
  if (rec.kind === 'comment-only') {
    if (readInside(dir, rec.proof) === null) p.push(`${at}a comment-only receipt with no proof file in its directory`);
    return out;
  }
  const files = attempt(() => R.filesBetween(parent, sha, { cwd }), p, at);
  const tiers = attempt(() => R.withGitEnv(() => SM.tierFromGit({ base: parent, tip: sha }, { cwd })), p, at);
  if (!files.ok || !tiers.ok) return out;
  const computed = tiers.value.tier;
  if (!SM.TIER_ORDER.includes(rec.tier)) {
    p.push(`${at}the receipt's tier is not one of ${SM.TIER_ORDER.join(', ')}`);
    return out;
  }
  if (SM.TIER_ORDER.indexOf(computed) < SM.TIER_ORDER.indexOf(rec.tier)) p.push(`${at}the diff computes to tier ${computed}; the receipt is tier ${rec.tier}`);
  const tier = SM.TIER_ORDER.indexOf(computed) < SM.TIER_ORDER.indexOf(rec.tier) ? computed : rec.tier;
  p.push(...tableProblems(sha, rec, dir, files.value, tiers.value.floors || [], tier));
  p.push(...testProblems(sha, rec, dir, files.value, tier));
  return out;
}

// ---- the range -----------------------------------------------------------------------

function checkRange({ base, tip, cwd = process.cwd() } = {}) {
  const result = { ok: false, docs_only: false, commits: [], pii: [], problems: [] };
  const range = [];
  const b = attempt(() => R.resolveCommit(base, { cwd }), range, 'base: ');
  const t = attempt(() => R.resolveCommit(tip, { cwd }), range, 'tip: ');
  const top = attempt(() => git('rev-parse', ['rev-parse', '--show-toplevel'], { cwd }).trim(), range, '');
  if (!b.ok || !t.ok || !top.ok) {
    result.problems = range;
    return result;
  }
  const anc = attempt(() => R.isAncestor(b.value, t.value, { cwd }), range, '');
  if (anc.ok && !anc.value) range.push(`${S(b.value)} is not an ancestor of ${S(t.value)}; the range is not a push onto it`);
  const all = attempt(() => GP.touches(b.value, t.value, { cwd }), range, '');
  if (all.ok) result.docs_only = all.value.docs_only;
  const list = attempt(() => listCommits(b.value, t.value, cwd), range, '');
  if (list.ok) result.commits = list.value.map((c) => judge(c, cwd, top.value));
  const scan = attempt(() => piiScan(b.value, t.value, top.value), range, 'pii: ');
  if (scan.ok) {
    for (const x of scan.value) {
      result.pii.push(x.hit);
      range.push(x.text);
    }
  }
  result.problems = [...result.commits.flatMap((c) => c.problems), ...range];
  result.range_problems = range;
  result.ok = result.problems.length === 0;
  return result;
}

module.exports = { checkRange, revertProof };

// ---- CLI ---------------------------------------------------------------------------

function line(c) {
  const what = c.docs_only ? 'docs-only' : c.receipt_key ? `${c.kind || '(no kind)'} receipt ${S(c.receipt_key)}` : 'no receipt';
  return `${S(c.sha)} ${what}${c.problems.length ? ', refused' : ''}: ${c.subject}`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const m = args.length === 1 ? /^([^.\s][^\s]*?)\.\.([^.\s][^\s]*)$/.exec(args[0]) : null;
  if (!m || m[2].includes('..') || args[0].includes('...')) {
    process.stderr.write('usage: node scripts/lib/rangeCheck.js <base>..<tip>\n');
    process.exit(2);
  }
  const r = checkRange({ base: m[1], tip: m[2], cwd: process.cwd() });
  const out = [];
  for (const c of r.commits) {
    out.push(line(c));
    for (const x of c.problems) out.push(`  - ${x}`);
  }
  for (const x of r.range_problems) out.push(`- ${x}`);
  const counted = r.commits.length;
  const docs = r.commits.filter((c) => c.docs_only).length;
  out.push(r.ok
    ? `range-check: ${counted} commit(s), ${docs} docs-only, ${counted - docs} with a receipt; ok`
    : `range-check: ${r.problems.length} problem(s) over ${counted} commit(s); refused`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(r.ok ? 0 : 1);
}
