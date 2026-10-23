#!/usr/bin/env node
'use strict';

// The post-ship watch (instruction rewrite step 3, lane post-ship-watch; spec
// 2026-10-19 sections 3.11 and 4.4, plan 2026-10-22 decision 5 and the
// post-ship-watch.js contract, which binds; this header says what this file
// does and never restates the ship flow).
//
//   node scripts/post-ship-watch.js <sha> [--health-url <u>] [--sentry-base <u>]
//     [--vercel-cmd <c>] [--window-ms <n>] [--deploy-wait-ms <n>]
//     [--poll-ms <n>] [--read-timeout-ms <n>] [--now <iso>]
//   node scripts/post-ship-watch.js --probe health [--health-url <u>]
//   node scripts/post-ship-watch.js --probe vercel --sha <sha> [--vercel-cmd <c>]
//   node scripts/post-ship-watch.js --probe sentry --deploy-at <iso>
//     [--window-ms <n>] [--sentry-base <u>]
//
// The watch reads the ship manifest for <sha> through shipLog under its cwd's
// common dir and writes only through shipLog.watchLine (its own log),
// shipLog.setManifest (the manifest's watch field, counts only) and
// markers.setWatch (the watch marker, by_issue keyed by Sentry issue id). Its
// first act is a start line, before any read; after it one line per health
// read, per Vercel read and per Sentry page, so the log's last write stays
// well inside shipLog's died bound while the watch runs. Every read runs under
// a timeout of at most two minutes and a read cut at its timeout is a failed
// read.
//
// The results, one result line each:
//   no deploy expected                    docs_only; nothing read.
//   deploy not observed                   the Render release (or the Vercel
//                                         READY state) never reached the sha
//                                         inside its bound, counted from this
//                                         watch's own start; no marker.
//   superseded by <sha7>                  the release is a strict descendant
//                                         of the sha on origin/main; no marker.
//   deploy instant unknown                the deploy cannot be placed inside
//                                         one window; marker with count null.
//   sentry unreadable (<status>)          no token, a non-200, a timeout;
//                                         marker with count null.
//   <N> events since deploy across <M> issues, <K> new
//                                         marker with the count and by_issue.
//   no new Sentry events in ten minutes   no marker. Never "clean": a wrong
//                                         figure throws nothing.
//   watch failed (<what>)                 an error in this script; marker
//                                         with count null, so it still blocks.
//
// The texts carry sha7 and counts only: a full sha masks as a token, a
// ten-digit id as a phone, and an event title can carry a person's name, so
// no issue id, title or event text is ever logged or printed. The Sentry
// token is read from ~/.sentryclirc ([auth] token=), sent only as the
// Authorization header, and followed only to the Sentry base's own origin.
// The probes print what the watch would read and write nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib/shipLog');
const M = require('./lib/markers');
const R = require('./lib/receipt');

const MINUTE = 60_000;
const DEFAULTS = Object.freeze({
  healthUrl: 'https://os-g7oa.onrender.com/api/health',
  sentryBase: 'https://sentry.io',
  vercelCmd: 'vercel ls os --scope drbartenders-projects --format json',
  windowMs: 10 * MINUTE,
  pollMs: 20_000,
  renderWaitMs: 20 * MINUTE,
  vercelWaitMs: 15 * MINUTE,
  readTimeoutMs: 2 * MINUTE,
});
const READ_TIMEOUT_CAP_MS = 2 * MINUTE;
const SENTRY_ORG = 'dr-bartender';
const SENTRY_PROJECTS = Object.freeze(['drbartender-server', 'drbartender-client']);
// A Sentry read that pages past this many pages per project is unreadable
// (the safe direction: the marker is set with count null).
const PAGE_CAP = 100;
const QUIET_TEXT = 'no new Sentry events in ten minutes';
const HEX = /^[0-9a-f]{7,64}$/;

const short = (s) => R.short(s);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const iso = (ms) => new Date(ms).toISOString();

// ---- arguments -----------------------------------------------------------------

function usage(text) {
  const err = new Error(text);
  err.code = 'WATCH_USAGE';
  return err;
}

const VALUE_FLAGS = new Set(['--health-url', '--sentry-base', '--vercel-cmd', '--window-ms', '--deploy-wait-ms', '--poll-ms', '--read-timeout-ms', '--now', '--probe', '--sha', '--deploy-at']);
const MS_FLAGS = { '--window-ms': 'windowMs', '--deploy-wait-ms': 'deployWaitMs', '--poll-ms': 'pollMs', '--read-timeout-ms': 'readTimeoutMs' };

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw usage(`post-ship-watch: unknown flag ${M.clean(a)}`);
    const v = argv[i + 1];
    if (v === undefined) throw usage(`post-ship-watch: ${a} needs a value`);
    i++;
    if (MS_FLAGS[a]) {
      if (!/^[0-9]+$/.test(v) || Number(v) <= 0) throw usage(`post-ship-watch: ${a} must be a positive whole number of milliseconds`);
      out[MS_FLAGS[a]] = Number(v);
    } else if (a === '--now' || a === '--deploy-at') {
      if (!M.isZonedTime(v)) throw usage(`post-ship-watch: ${a} must be an ISO time with a zone`);
      out[a === '--now' ? 'now' : 'deployAt'] = Date.parse(v);
    } else {
      out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
  }
  return out;
}

function settings(args) {
  return {
    healthUrl: args.healthUrl || DEFAULTS.healthUrl,
    sentryBase: (args.sentryBase || DEFAULTS.sentryBase).replace(/\/+$/, ''),
    vercelCmd: args.vercelCmd || DEFAULTS.vercelCmd,
    windowMs: args.windowMs || DEFAULTS.windowMs,
    pollMs: args.pollMs || DEFAULTS.pollMs,
    renderWaitMs: args.deployWaitMs || DEFAULTS.renderWaitMs,
    vercelWaitMs: args.deployWaitMs || DEFAULTS.vercelWaitMs,
    readTimeoutMs: Math.min(args.readTimeoutMs || DEFAULTS.readTimeoutMs, READ_TIMEOUT_CAP_MS),
  };
}

// The watch's clock: the real one, or one that starts at --now and runs.
function makeClock(nowMs) {
  if (nowMs === undefined) return () => Date.now();
  const t0 = Date.now();
  return () => nowMs + (Date.now() - t0);
}

const failure = (err) => (err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'error');

// ---- the health read -----------------------------------------------------------

// One read: {ok, release, failure, sentAt, recvAt, text}. sentAt is the last
// instant the server can have been on an earlier release when it answered
// one; recvAt the first instant by which a release it names was live.
async function readHealth(url, timeoutMs, clock) {
  const sentAt = clock();
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const recvAt = clock();
    if (res.status !== 200) return { ok: false, failure: String(res.status), sentAt, recvAt };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, failure: 'not json', sentAt, recvAt };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, failure: 'not an object', sentAt, recvAt };
    return { ok: true, release: typeof body.release === 'string' ? body.release : null, sentAt, recvAt, text };
  } catch (err) {
    return { ok: false, failure: failure(err), sentAt, recvAt: clock() };
  }
}

function ancestorOrNull(a, b, cwd) {
  try {
    return R.isAncestor(a, b, { cwd });
  } catch {
    return null;
  }
}

// Where a release sits against the sha, failing closed: 'sha' (the literal
// sha), 'earlier' (it resolves and is a strict ancestor of the sha),
// {superseded} (it resolves, the sha is its strict ancestor, and it is on
// origin/main), else 'unknown' (keep polling; it is no evidence either way).
function placeRelease(release, full, cwd) {
  if (release === full) return 'sha';
  if (!HEX.test(release)) return 'unknown';
  let rel;
  try {
    rel = M.resolveStrict(release, cwd);
  } catch {
    return 'unknown';
  }
  if (rel === full) return 'unknown';
  if (ancestorOrNull(rel, full, cwd) === true) return 'earlier';
  if (ancestorOrNull(full, rel, cwd) !== true) return 'unknown';
  let main;
  try {
    main = M.resolveStrict('refs/remotes/origin/main', cwd);
  } catch {
    return 'unknown';
  }
  return ancestorOrNull(rel, main, cwd) === true ? { superseded: rel } : 'unknown';
}

const releaseText = (release) => (release === null ? 'no release field' : HEX.test(release) ? `release ${short(release)}` : 'release unreadable');

// ---- the Vercel read -----------------------------------------------------------

// Runs the command under the timeout, its process group killed when it hangs.
function runCommand(cmd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      resolve({ ok: false, failure: 'did not start' });
      return;
    }
    let out = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL'); // no group to kill; the shell itself
      }
      finish({ ok: false, failure: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => finish({ ok: false, failure: 'did not start' }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, out } : { ok: false, failure: `exit ${code}` }));
  });
}

function deploymentsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.deployments)) return parsed.deployments;
  return null;
}

const stateOf = (d) => String(d.state || d.readyState || 'unknown').toUpperCase();
const commitOf = (d) => (d && d.meta && typeof d.meta.githubCommitSha === 'string' ? d.meta.githubCommitSha : null);
const createdOf = (d) => Number(d.created || d.createdAt || 0) || 0;

// One read: {ok, failure, production: [deployments], forSha: deployment|null}.
async function readVercel(cmd, full, timeoutMs) {
  const r = await runCommand(cmd, timeoutMs);
  if (!r.ok) return r;
  let list;
  try {
    list = deploymentsOf(JSON.parse(r.out.trim()));
  } catch {
    return { ok: false, failure: 'not json' };
  }
  if (!list) return { ok: false, failure: 'no deployment list' };
  const production = list.filter((d) => d && d.target === 'production').sort((a, b) => createdOf(b) - createdOf(a));
  const forSha = production.filter((d) => commitOf(d) === full);
  const ready = forSha.find((d) => stateOf(d) === 'READY');
  return { ok: true, production, forSha: ready || forSha[0] || null };
}

// ---- the Sentry read -----------------------------------------------------------

// The token under [auth] in an ini file, or null.
function sentryToken(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.sentryclirc'), 'utf8');
  } catch {
    return null;
  }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const lineText = raw.trim();
    if (lineText === '' || lineText.startsWith('#') || lineText.startsWith(';')) continue;
    const head = /^\[([^\]]*)\]$/.exec(lineText);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(lineText);
    if (section === 'auth' && kv && kv[1].trim().toLowerCase() === 'token') {
      const v = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
      return v === '' ? null : v;
    }
  }
  return null;
}

// The Link header's next page, only when it has results and stays on the
// base's origin (the token is never sent anywhere else). undefined when there
// is no next page; null for a next link off the origin.
function nextLink(header, base) {
  if (!header) return undefined;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>(.*)$/.exec(part.trim());
    if (!m || !/rel="next"/.test(m[2])) continue;
    if (!/results="true"/.test(m[2])) return undefined;
    let next;
    try {
      next = new URL(m[1], base);
    } catch {
      return null;
    }
    return next.origin === new URL(base).origin ? next.href : null;
  }
  return undefined;
}

// Reads both projects over [preStart, hinge) and [hinge, afterEnd], newest
// first, a page at a time while the newest event on the page is after
// preStart. {ok: true, issues: Map(id -> {pre, post}), perProject} or
// {ok: false, status}.
async function readSentry({ base, token, preStart, hinge, afterEnd, timeoutMs, onPage }) {
  if (!token) return { ok: false, status: 'no token' };
  const issues = new Map();
  const perProject = {};
  for (const project of SENTRY_PROJECTS) {
    const counts = { pages: 0, pre: 0, post: 0 };
    perProject[project] = counts;
    let url = `${base}/api/0/projects/${SENTRY_ORG}/${project}/events/`;
    while (url) {
      if (counts.pages >= PAGE_CAP) return { ok: false, status: 'page cap' };
      counts.pages++;
      let res;
      let events;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        if (res.status !== 200) return { ok: false, status: String(res.status) };
        events = JSON.parse(text);
      } catch (err) {
        return { ok: false, status: err instanceof SyntaxError ? 'not json' : failure(err) };
      }
      if (!Array.isArray(events)) return { ok: false, status: 'not a list' };
      let newest = -Infinity;
      let inWindows = 0;
      for (const e of events) {
        const t = e && typeof e.dateCreated === 'string' ? Date.parse(e.dateCreated) : NaN;
        if (!Number.isFinite(t)) continue;
        if (t > newest) newest = t;
        const id = e.groupID === undefined || e.groupID === null ? '' : String(e.groupID);
        if (id === '') continue;
        const side = t >= preStart && t < hinge ? 'pre' : t >= hinge && t <= afterEnd ? 'post' : null;
        if (!side) continue;
        if (!issues.has(id)) issues.set(id, { pre: 0, post: 0 });
        issues.get(id)[side]++;
        counts[side]++;
        inWindows++;
      }
      if (onPage) onPage(project, counts.pages, events.length, inWindows);
      if (!(newest > preStart)) break;
      const next = nextLink(res.headers.get('link'), base);
      if (next === null) return { ok: false, status: 'next page off the Sentry origin' };
      url = next;
    }
  }
  return { ok: true, issues, perProject };
}

// An issue quiet in the pre-window counts in full; one with events in both
// counts only when the post count exceeds the pre count. Status is never read.
function judge(issues) {
  let count = 0;
  let newIssues = 0;
  const byIssue = {};
  for (const [id, { pre, post }] of issues) {
    if (post === 0) continue;
    if (pre === 0) newIssues++;
    else if (post <= pre) continue;
    count += post;
    byIssue[id] = post;
  }
  return { count, issues: Object.keys(byIssue).length, new_issues: newIssues, by_issue: byIssue };
}

// ---- the watch -----------------------------------------------------------------

async function watch(sha, s, clock, { cwd, home }) {
  const full = L.shipPaths(sha, { cwd }).sha;
  const s7 = short(full);
  const log = (text) => L.watchLine(full, 'watch', text, { cwd });
  // The first act, before any read: the evidence shipLog.claimWatch reads.
  // This watch's bounds count from this instant, whatever lines the log
  // already holds.
  L.watchLine(full, 'start', `post-ship watch of ${s7} started, pid ${process.pid}`, { cwd });
  const startAt = clock();

  const finish = ({ text, count = null, issues = null, new_issues = null, deploy_at = null, marker = null }) => {
    let markerNote = '';
    if (marker) {
      try {
        const w = M.setWatch({ sha: full, deploy_at, count, by_issue: marker.by_issue || null, cwd });
        if (!w.written) markerNote = ` (watch marker not written: ${w.reason})`;
      } catch (err) {
        markerNote = ` (watch marker not written: ${M.clean(err.code || 'error')})`;
      }
    }
    const written = L.watchLine(full, 'result', text, { cwd });
    if (written) {
      try {
        L.setManifest(full, { watch: { result: text, count, issues, new_issues, deploy_at, finished_at: iso(clock()) } }, { cwd });
      } catch (err) {
        markerNote += ` (manifest not updated: ${M.clean(err.code || 'error')})`;
      }
    } else {
      markerNote += ' (a result already stood in the watch log)';
    }
    process.stdout.write(`post-ship-watch: ${s7} ${text}${markerNote}\n`);
    return text;
  };

  const m = L.readManifest(full, { cwd });
  if (!m) {
    process.exitCode = 1;
    L.watchLine(full, 'result', `no ship manifest for ${s7}`, { cwd });
    process.stdout.write(`post-ship-watch: no ship manifest for ${s7}\n`);
    return null;
  }
  if (m.docs_only === true) return finish({ text: 'no deploy expected' });

  // The Render half: poll until the release is the sha.
  let lastEarlier = null;
  let firstAtSha = null;
  for (let n = 1; ; n++) {
    const r = await readHealth(s.healthUrl, s.readTimeoutMs, clock);
    if (!r.ok) {
      log(`health read ${n} failed (${r.failure})`);
    } else {
      const place = r.release === null ? 'unknown' : placeRelease(r.release, full, cwd);
      if (place === 'sha') {
        log(`health read ${n}: release ${s7}, the sha is live`);
        firstAtSha = r.recvAt;
        break;
      }
      if (place && place.superseded) {
        log(`health read ${n}: release ${short(place.superseded)}, a descendant on origin/main`);
        return finish({ text: `superseded by ${short(place.superseded)}` });
      }
      if (place === 'earlier') lastEarlier = r.sentAt;
      log(`health read ${n}: ${releaseText(r.release)}${place === 'earlier' ? ', earlier' : ''}`);
    }
    if (clock() - startAt >= s.renderWaitMs) return finish({ text: 'deploy not observed' });
    await sleep(s.pollMs);
  }

  // The hinge: the last instant the sha was known not yet deployed.
  const stamp = M.isZonedTime(m.push_started_at) ? Date.parse(m.push_started_at) : null;
  const hinge = lastEarlier !== null ? lastEarlier : stamp;
  if (hinge === null || firstAtSha < hinge || firstAtSha - hinge > s.windowMs) {
    log(`deploy of ${s7} cannot be placed inside one window`);
    return finish({ text: 'deploy instant unknown', marker: {} });
  }
  const afterEnd = firstAtSha + s.windowMs;
  const preStart = hinge - (afterEnd - hinge);
  const deployAt = iso(hinge);

  // The Vercel half, only when the range touches client/.
  if (m.touches_client === true) {
    for (let n = 1; ; n++) {
      const v = await readVercel(s.vercelCmd, full, s.readTimeoutMs);
      if (!v.ok) {
        log(`vercel read ${n} failed (${v.failure})`);
      } else if (v.forSha && stateOf(v.forSha) === 'READY') {
        log(`vercel read ${n}: production READY for ${s7}`);
        break;
      } else {
        log(`vercel read ${n}: ${v.forSha ? stateOf(v.forSha) : 'no production deployment'} for ${s7}`);
      }
      if (clock() - startAt >= s.vercelWaitMs) return finish({ text: 'deploy not observed' });
      await sleep(s.pollMs);
    }
  }

  const waitFor = afterEnd - clock();
  if (waitFor > 0) {
    log(`window open until ${iso(afterEnd)}`);
    await sleep(waitFor);
  }

  const read = await readSentry({
    base: s.sentryBase,
    token: sentryToken(home),
    preStart,
    hinge,
    afterEnd,
    timeoutMs: s.readTimeoutMs,
    onPage: (project, page, listed, inWindows) => log(`sentry ${project} page ${page}: ${listed} events listed, ${inWindows} in the windows`),
  });
  if (!read.ok) return finish({ text: `sentry unreadable (${read.status})`, deploy_at: deployAt, marker: {} });
  const j = judge(read.issues);
  if (j.count === 0) return finish({ text: QUIET_TEXT, count: 0, issues: 0, new_issues: 0, deploy_at: deployAt });
  return finish({
    text: `${j.count} events since deploy across ${j.issues} issues, ${j.new_issues} new`,
    count: j.count,
    issues: j.issues,
    new_issues: j.new_issues,
    deploy_at: deployAt,
    marker: { by_issue: j.by_issue },
  });
}

// An error in the watch itself: it still blocks, through a marker with count
// null, when the sha resolves.
function watchFailed(sha, err, { cwd }) {
  const what = M.clean(err && err.code ? err.code : 'error');
  const notes = [];
  let full = null;
  try {
    full = L.shipPaths(sha, { cwd }).sha;
  } catch (e) {
    notes.push(`the sha did not resolve (${M.clean(e.code || 'error')}), nothing marked`);
  }
  if (full) {
    try {
      M.setWatch({ sha: full, deploy_at: null, count: null, by_issue: null, cwd });
    } catch (e) {
      notes.push(`watch marker not written (${M.clean(e.code || 'error')})`);
    }
    try {
      if (L.watchLine(full, 'result', `watch failed (${what})`, { cwd })) {
        L.setManifest(full, { watch: { result: `watch failed (${what})`, count: null, issues: null, new_issues: null, deploy_at: null, finished_at: new Date().toISOString() } }, { cwd });
      }
    } catch (e) {
      notes.push(`watch log or manifest not written (${M.clean(e.code || 'error')})`);
    }
  }
  process.stderr.write(`post-ship-watch: ${full ? short(full) : 'the sha'} watch failed (${what})${notes.length ? `; ${notes.join('; ')}` : ''}\n`);
  process.exitCode = 1;
}

// ---- the probes ----------------------------------------------------------------

async function probe(kind, args, s, clock, { home }) {
  const say = (text) => process.stdout.write(`${M.clean(text)}\n`);
  if (kind === 'health') {
    const r = await readHealth(s.healthUrl, s.readTimeoutMs, clock);
    if (!r.ok) return say(`health: read failed (${r.failure})`);
    say(`health: body ${r.text.trim().slice(0, 500)}`);
    return say(`health: release: ${r.release === null ? 'absent' : HEX.test(r.release) ? short(r.release) : 'unreadable'}`);
  }
  if (kind === 'vercel') {
    if (!args.sha) throw usage('post-ship-watch: --probe vercel needs --sha <sha>');
    const v = await readVercel(s.vercelCmd, args.sha, s.readTimeoutMs);
    if (!v.ok) return say(`vercel: read failed (${v.failure})`);
    const newest = v.production[0];
    say(`vercel: ${v.production.length} production deployments listed`);
    if (newest) say(`vercel: newest production ${commitOf(newest) ? short(commitOf(newest)) : 'no commit'} ${stateOf(newest)}`);
    return say(`vercel: for ${short(args.sha)}: ${v.forSha ? stateOf(v.forSha) : 'none'}`);
  }
  if (kind === 'sentry') {
    if (args.deployAt === undefined) throw usage('post-ship-watch: --probe sentry needs --deploy-at <iso>');
    const hinge = args.deployAt;
    const read = await readSentry({
      base: s.sentryBase,
      token: sentryToken(home),
      preStart: hinge - s.windowMs,
      hinge,
      afterEnd: hinge + s.windowMs,
      timeoutMs: s.readTimeoutMs,
    });
    if (!read.ok) return say(`sentry: unreadable (${read.status})`);
    for (const project of SENTRY_PROJECTS) {
      const c = read.perProject[project];
      say(`sentry ${project}: ${c.pages} pages, ${c.pre} events in the pre-window, ${c.post} in the after-window`);
    }
    const j = judge(read.issues);
    return say(`sentry: ${j.count} events since deploy across ${j.issues} issues, ${j.new_issues} new`);
  }
  throw usage('post-ship-watch: --probe is one of health, vercel, sentry');
}

async function main(argv, { cwd = process.cwd(), home = process.env.HOME || os.homedir() } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const s = settings(args);
  const clock = makeClock(args.now);
  if (args.probe !== undefined) {
    try {
      await probe(args.probe, args, s, clock, { home });
    } catch (err) {
      process.stderr.write(`${err.code === 'WATCH_USAGE' ? err.message : `post-ship-watch: probe failed (${M.clean(err.code || 'error')})`}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.positional.length !== 1) {
    process.stderr.write('post-ship-watch: usage: node scripts/post-ship-watch.js <sha> [flags], or --probe health|vercel|sentry\n');
    process.exitCode = 1;
    return;
  }
  const sha = args.positional[0];
  try {
    await watch(sha, s, clock, { cwd, home });
  } catch (err) {
    if (err && (err.code === 'SHIP_NO_COMMIT' || err.code === 'SHIP_RESOLVE_FAILED')) {
      process.stderr.write(`post-ship-watch: ${M.clean(err.message)}\n`);
      process.exitCode = 1;
      return;
    }
    watchFailed(sha, err, { cwd });
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, sentryToken, nextLink, judge, placeRelease, DEFAULTS, SENTRY_PROJECTS };
