'use strict';

// Tests for scripts/post-ship-watch.js (instruction rewrite step 3, lane
// post-ship-watch). Every case runs in a throwaway repo under the temp dir
// with a ship manifest opened through shipLog, a local HTTP server standing in
// for the health endpoint and Sentry, a shell script on PATH standing in for
// vercel, and a fake HOME whose .sentryclirc holds a fixture token built at
// runtime. Nothing here reads the real home or touches the network beyond
// 127.0.0.1.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const L = require('./lib/shipLog');
const M = require('./lib/markers');
const W = require('./post-ship-watch');

const SCRIPT = path.resolve(__dirname, 'post-ship-watch.js');
const WINDOW = 2000;
const POLL = 100;
const WAIT = 2500;
const MIN = 60_000;
const QUIET = 'no new Sentry events in ten minutes';
// The fixture token, built at runtime from parts so no literal in this file
// is token-shaped.
const TOKEN = ['fixture', 'tok', 'Zq'.repeat(12)].join('-');
const TITLE = 'Fixture Person could not pay';

const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(Date.now() - ms);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, file) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), `${message}\n`);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A repo with base, the watched sha (one) and its child (two) on origin/main.
function makeRepo(t) {
  const repo = tempDir(t, 'post-ship-watch-test-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const base = commit(repo, 'seed', 'docs/seed.md');
  const one = commit(repo, 'server work', 'server/a.js');
  const two = commit(repo, 'more work', 'server/b.js');
  git(repo, 'update-ref', 'refs/remotes/origin/main', two);
  return { repo, base, one, two, common: path.join(repo, '.git') };
}

function openManifest(r, { docs_only = false, touches_client = false, stamps = {} } = {}) {
  L.open(r.one, { cwd: r.repo, base: r.base, commits: [{ sha: r.one, subject: 'server work' }], docs_only, touches_server: true, touches_client });
  if (Object.keys(stamps).length) L.setManifest(r.one, stamps, { cwd: r.repo });
}

function fakeHome(t, { token = TOKEN } = {}) {
  const home = tempDir(t, 'post-ship-watch-home-');
  if (token !== null) fs.writeFileSync(path.join(home, '.sentryclirc'), `[defaults]\norg = dr-bartender\n\n[auth]\ntoken = ${token}\n`);
  return home;
}

// A vercel stand-in on PATH: it records its arguments and prints a fixture.
function fakeVercel(t, deployments) {
  const bin = tempDir(t, 'post-ship-watch-bin-');
  const out = path.join(bin, 'out.json');
  const ran = path.join(bin, 'ran.log');
  fs.writeFileSync(out, JSON.stringify({ deployments }));
  fs.writeFileSync(path.join(bin, 'vercel'), `#!/bin/sh\necho "$@" >> '${ran}'\ncat '${out}'\n`, { mode: 0o755 });
  return { bin, ran, runs: () => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').split('\n').filter(Boolean) : []) };
}

const health = (...specs) => (n) => specs[Math.min(n, specs.length) - 1];
const at = (release) => ({ body: { status: 'ok', release } });

// Events for the Sentry stand-in: {project, groupID, at}; served newest first,
// only those already in the past, one page unless a test pages them.
const ev = (groupID, when, project = 'drbartender-server') => ({ project, groupID, at: when });

async function fakeServer(t, { healthSpec, events = () => [], sentry = null }) {
  const state = { healthReads: [], sentryReqs: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/health') {
      const n = state.healthReads.length + 1;
      const spec = healthSpec(n, state);
      state.healthReads.push({ n, at: Date.now() });
      if (spec === 'hang') return;
      res.writeHead(spec.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(spec.body || {}));
      return;
    }
    const m = /^\/api\/0\/projects\/dr-bartender\/([^/]+)\/events\/$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    state.sentryReqs.push({ project: m[1], cursor: u.searchParams.get('cursor'), search: u.search, auth: req.headers.authorization });
    if (sentry) {
      sentry(m[1], u, req, res, state);
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"detail":"no"}');
      return;
    }
    const now = Date.now();
    const list = events(state)
      .filter((e) => e.project === m[1] && e.at <= now)
      .sort((a, b) => b.at - a.at)
      .map((e, i) => ({ eventID: `e${i}`, groupID: e.groupID, dateCreated: iso(e.at), title: TITLE }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(list));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

function runScript(cwd, args, { home, bin = null } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home };
    if (bin) env.PATH = `${bin}:${process.env.PATH}`;
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runWatch(r, srv, { home, bin = null, extra = [], window = WINDOW, wait = WAIT } = {}) {
  return runScript(r.repo, [
    r.one,
    '--health-url', `${srv.url}/api/health`,
    '--sentry-base', srv.url,
    '--window-ms', String(window),
    '--poll-ms', String(POLL),
    '--deploy-wait-ms', String(wait),
    '--read-timeout-ms', '400',
    ...extra,
  ], { home, bin });
}

const watchLogPath = (r) => L.shipPaths(r.one, { cwd: r.repo }).watchLog;
const watchLines = (r) => fs.readFileSync(watchLogPath(r), 'utf8').split('\n').filter(Boolean);
const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (\S+)(?: (.*))?$/;
const stageOf = (l) => LINE_RE.exec(l)[1];
const textOf = (l) => LINE_RE.exec(l)[2] || '';
const resultOf = (r) => {
  const rs = watchLines(r).filter((l) => stageOf(l) === 'result');
  assert.equal(rs.length, 1, 'exactly one result line');
  return textOf(rs[0]);
};
const marker = (r) => {
  const m = M.watch({ cwd: r.repo });
  return m && m.sha === r.one ? m : null;
};
const manifest = (r) => L.readManifest(r.one, { cwd: r.repo });

describe('post-ship-watch', { concurrency: 6 }, () => {
  it('docs-only ends no deploy expected without a request', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { docs_only: true });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'no deploy expected');
    assert.equal(stageOf(watchLines(r)[0]), 'start');
    assert.equal(srv.state.healthReads.length, 0);
    assert.equal(srv.state.sentryReqs.length, 0);
    assert.equal(marker(r), null);
    assert.equal(manifest(r).watch.result, 'no deploy expected');
  });

  it('health that never carries release ends deploy not observed at the bound, no marker', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const srv = await fakeServer(t, { healthSpec: health({ body: { status: 'ok' } }) });
    const started = Date.now();
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'deploy not observed');
    assert.ok(Date.now() - started >= WAIT, 'ran to the bound');
    assert.equal(marker(r), null);
    assert.equal(srv.state.sentryReqs.length, 0);
    const reads = watchLines(r).filter((l) => /^health read \d+/.test(textOf(l)));
    assert.equal(reads.length, srv.state.healthReads.length, 'one line per health read');
    assert.ok(reads.every((l) => /no release field/.test(l)));
    assert.equal(manifest(r).watch.result, 'deploy not observed');
    assert.equal(manifest(r).watch.count, null);
  });

  it('a release that is a child of the sha on origin/main ends superseded', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.two)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), `superseded by ${r.two.slice(0, 7)}`);
    assert.equal(marker(r), null);
    assert.equal(srv.state.sentryReqs.length, 0);
  });

  it('a release that does not resolve is neither the sha nor superseded: keep polling', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const stranger = 'b'.repeat(40);
    const srv = await fakeServer(t, { healthSpec: health(at(stranger), at(stranger), at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), QUIET);
    assert.equal(srv.state.healthReads.length, 3);
  });

  it('at the sha with touches_client false skips vercel and reads Sentry', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(200) } });
    const v = fakeVercel(t, []);
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t), bin: v.bin });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), QUIET);
    assert.deepEqual(v.runs(), [], 'the vercel stand-in never ran');
    assert.equal(marker(r), null);
    assert.ok(srv.state.sentryReqs.length >= 2, 'both projects read');
    assert.deepEqual(manifest(r).watch.count, 0);
  });

  it('a READY production deployment for the sha passes, one line per vercel read and per Sentry page', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { touches_client: true, stamps: { push_started_at: ago(200) } });
    const v = fakeVercel(t, [
      { target: 'preview', state: 'READY', meta: { githubCommitSha: r.one }, created: 3 },
      { target: 'production', state: 'READY', meta: { githubCommitSha: r.one }, created: 2 },
    ]);
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t), bin: v.bin });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), QUIET);
    assert.deepEqual(v.runs(), ['ls os --scope drbartenders-projects --format json']);
    const lines = watchLines(r);
    assert.equal(stageOf(lines[0]), 'start');
    assert.equal(lines.filter((l) => /^health read /.test(textOf(l))).length, srv.state.healthReads.length);
    assert.equal(lines.filter((l) => /^vercel read /.test(textOf(l))).length, v.runs().length);
    assert.equal(lines.filter((l) => /^sentry \S+ page /.test(textOf(l))).length, srv.state.sentryReqs.length);
  });

  it('a never-READY vercel deployment ends deploy not observed', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { touches_client: true, stamps: { push_started_at: ago(200) } });
    const v = fakeVercel(t, [{ target: 'production', state: 'BUILDING', meta: { githubCommitSha: r.one } }]);
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t), bin: v.bin });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'deploy not observed');
    assert.ok(v.runs().length >= 2);
    assert.equal(watchLines(r).filter((l) => /^vercel read \d+: BUILDING/.test(textOf(l))).length, v.runs().length);
    assert.equal(marker(r), null);
    assert.equal(srv.state.sentryReqs.length, 0);
  });

  it('three events after the deploy on an issue quiet before count three and set the marker with by_issue', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      events: () => [ev('101', stamp + 50), ev('101', stamp + 60), ev('101', stamp + 70, 'drbartender-client')],
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), '3 events since deploy across 1 issues, 1 new');
    const mk = marker(r);
    assert.equal(mk.count, 3);
    assert.deepEqual({ ...mk.by_issue }, { 101: 3 });
    assert.equal(mk.deploy_at, iso(stamp), 'the hinge is push_started_at');
    const w = manifest(r).watch;
    assert.deepEqual([w.count, w.issues, w.new_issues], [3, 1, 1]);
    const text = fs.readFileSync(L.shipPaths(r.one, { cwd: r.repo }).manifest, 'utf8');
    assert.ok(!/by_issue|101/.test(text), 'the manifest carries counts only');
    const all = watchLines(r).join('\n') + out.stdout;
    assert.ok(!all.includes(TITLE) && !/\b101\b/.test(all), 'no title and no issue id logged or printed');
  });

  it('four events in the pre-window and three after on the same issue count zero', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      events: () => [
        ...[10, 20, 30, 40].map((d) => ev('102', stamp - d * 10)),
        ...[10, 20, 30].map((d) => ev('102', stamp + d)),
      ],
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), QUIET);
    assert.equal(marker(r), null);
  });

  it('a new issue with one event counts beside a chronic one that did not rise', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      events: () => [ev('102', stamp - 100), ev('102', stamp - 50), ev('102', stamp + 20), ev('105', stamp + 30)],
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), '1 events since deploy across 1 issues, 1 new');
    assert.deepEqual({ ...marker(r).by_issue }, { 105: 1 });
  });

  it('a resolved issue that regresses counts: the read never filters on status', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    // Issue 103 had events long ago (it was resolved), none in the pre-window.
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      events: () => [ev('103', stamp - 30 * MIN), ev('103', stamp + 20), ev('103', stamp + 40)],
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), '2 events since deploy across 1 issues, 1 new');
    assert.ok(srv.state.sentryReqs.every((q) => q.search === ''), 'no query, no status filter');
  });

  it('pages newest first through the Link cursor while the newest event is after the window start', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const pages = (srvUrl) => ({
      null: { events: [ev('101', stamp + 30), ev('101', stamp + 20)], next: '0:100:0' },
      '0:100:0': { events: [ev('101', stamp + 10), ev('104', stamp - 20 * MIN)], next: '0:200:0' },
      '0:200:0': { events: [ev('104', stamp - 30 * MIN)], next: '0:300:0' },
      '0:300:0': { events: [ev('101', stamp + 10)], next: null },
      srvUrl,
    });
    let book = null;
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      sentry: (project, u, req, res) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        const page = project === 'drbartender-server' ? book[String(u.searchParams.get('cursor'))] : { events: [], next: null };
        const headers = { 'content-type': 'application/json' };
        const self = `${book.srvUrl}${u.pathname}`;
        headers.link = page.next
          ? `<${self}?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <${self}?cursor=${page.next}>; rel="next"; results="true"; cursor="${page.next}"`
          : `<${self}?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <${self}?cursor=0:900:0>; rel="next"; results="false"; cursor="0:900:0"`;
        res.writeHead(200, headers);
        res.end(JSON.stringify(page.events.map((e, i) => ({ eventID: `p${i}`, groupID: e.groupID, dateCreated: iso(e.at), title: TITLE }))));
      },
    });
    book = pages(srv.url);
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), '3 events since deploy across 1 issues, 1 new');
    const server = srv.state.sentryReqs.filter((q) => q.project === 'drbartender-server').map((q) => q.cursor);
    assert.deepEqual(server, [null, '0:100:0', '0:200:0'], 'the page whose newest event is before the window start ends the read');
    assert.equal(watchLines(r).filter((l) => /^sentry \S+ page /.test(textOf(l))).length, srv.state.sentryReqs.length);
  });

  it('a next link off the Sentry origin is never followed: unreadable, count null', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.one)),
      sentry: (project, u, req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', link: '<http://elsewhere.invalid/x?cursor=1>; rel="next"; results="true"; cursor="1"' });
        res.end(JSON.stringify([{ eventID: 'a', groupID: '101', dateCreated: iso(stamp + 10) }]));
      },
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'sentry unreadable (next page off the Sentry origin)');
    assert.equal(marker(r).count, null);
  });

  it('a 401 from Sentry ends sentry unreadable (401) with the marker at count null', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(200) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)), sentry: (p, u, req, res) => { res.writeHead(401); res.end(); } });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'sentry unreadable (401)');
    const mk = marker(r);
    assert.equal(mk.count, null);
    assert.equal(srv.state.sentryReqs[0].auth, `Bearer ${TOKEN}`, 'the token rides the header');
    assert.equal(manifest(r).watch.count, null);
  });

  it('a missing .sentryclirc under the fake home is sentry unreadable with count null and no request', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(200) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t, { token: null }) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'sentry unreadable (no token)');
    assert.equal(marker(r).count, null);
    assert.equal(srv.state.sentryReqs.length, 0);
  });

  it('the token never appears in the watch log, the manifest, the marker or stdout', async (t) => {
    for (const mode of ['events', '401']) {
      const r = makeRepo(t);
      const stamp = Date.now() - 200;
      openManifest(r, { stamps: { push_started_at: iso(stamp) } });
      const srv = await fakeServer(t, {
        healthSpec: health(at(r.one)),
        events: () => [ev('101', stamp + 20)],
        sentry: mode === '401' ? (p, u, req, res) => { res.writeHead(401); res.end(); } : null,
      });
      const out = await runWatch(r, srv, { home: fakeHome(t) });
      assert.equal(out.code, 0, out.stderr);
      const p = L.shipPaths(r.one, { cwd: r.repo });
      for (const text of [fs.readFileSync(p.watchLog, 'utf8'), fs.readFileSync(p.manifest, 'utf8'), fs.readFileSync(M.markerPaths({ cwd: r.repo }).watch, 'utf8'), out.stdout, out.stderr]) {
        assert.ok(!text.includes(TOKEN) && !text.includes('Zq'.repeat(12)), `no token (${mode})`);
      }
    }
  });

  it('health at the sha on the first poll with push_started_at more than a window back ends deploy instant unknown', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(2 * WINDOW) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'deploy instant unknown');
    assert.equal(marker(r).count, null);
    assert.equal(srv.state.sentryReqs.length, 0);
    assert.equal(manifest(r).watch.result, 'deploy instant unknown');
  });

  it('push_started_at a fifth of a window old hinges both windows on it: an event between the stamp and the first read counts', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - WINDOW / 5;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)), events: () => [ev('101', stamp + 30), ev('106', stamp - 30)] });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(srv.state.healthReads[0].at > stamp + 30, 'the event precedes the first read');
    assert.equal(resultOf(r), '1 events since deploy across 1 issues, 1 new');
    assert.deepEqual({ ...marker(r).by_issue }, { 101: 1 }, 'the event before the stamp is in the pre-window');
    assert.equal(marker(r).deploy_at, iso(stamp));
  });

  it('a failed first read followed by one at the sha more than a window after the stamp ends deploy instant unknown', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(WINDOW / 2) } });
    const srv = await fakeServer(t, { healthSpec: health('hang', at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t), extra: ['--read-timeout-ms', String(WINDOW)] });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(textOf(watchLines(r)[1]), 'health read 1 failed (timeout)');
    assert.equal(resultOf(r), 'deploy instant unknown');
    assert.equal(marker(r).count, null);
  });

  it('a health read that hangs is cut at its timeout and counts as a failed read', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const srv = await fakeServer(t, { healthSpec: health('hang', at(r.one)) });
    const started = Date.now();
    const out = await runWatch(r, srv, { home: fakeHome(t), extra: ['--read-timeout-ms', '300'] });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(textOf(watchLines(r)[1]), 'health read 1 failed (timeout)');
    assert.equal(srv.state.healthReads.length, 2);
    assert.equal(resultOf(r), QUIET);
    assert.ok(Date.now() - started < WAIT + WINDOW + 2000);
  });

  it('both stamps twenty-five minutes back with health at the sha on the first read: the read happens, deploy instant unknown', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(25 * MIN), pushed_at: ago(25 * MIN) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(srv.state.healthReads.length, 1, 'the bound counts from the start line, so the read happens');
    assert.equal(resultOf(r), 'deploy instant unknown');
    assert.equal(marker(r).count, null);
  });

  it('the same stamps with an earlier release first hinge on the last earlier-release read and read Sentry', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 25 * MIN;
    openManifest(r, { stamps: { push_started_at: iso(stamp), pushed_at: iso(stamp) } });
    const srv = await fakeServer(t, {
      healthSpec: health(at(r.base), at(r.base), at(r.one)),
      // One event right after the second earlier read (counts), one a minute
      // after the stamp (would count only if the windows hinged on the stamp).
      events: (state) => (state.healthReads.length >= 2 ? [ev('101', state.healthReads[1].at + 5), ev('107', stamp + MIN)] : []),
    });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), '1 events since deploy across 1 issues, 1 new');
    assert.ok(srv.state.sentryReqs.length >= 2);
    const deployAt = Date.parse(marker(r).deploy_at);
    assert.ok(deployAt > srv.state.healthReads[0].at && deployAt <= srv.state.healthReads[1].at, 'the hinge is the second read, the last earlier one');
    assert.equal(watchLines(r).filter((l) => /, earlier$/.test(textOf(l))).length, 2);
  });

  it('a first read at the sha nine tenths of a window after the stamp counts an event past one window from the stamp', async (t) => {
    const r = makeRepo(t);
    const window = 4000;
    const stamp = Date.now() - 0.75 * window;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)), events: () => [ev('101', stamp + 1.1 * window)] });
    const out = await runWatch(r, srv, { home: fakeHome(t), window });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(srv.state.healthReads[0].at - stamp < window, 'placed inside one window');
    assert.equal(resultOf(r), '1 events since deploy across 1 issues, 1 new', 'the after-window runs to one window past the first read');
  });

  it('a second watch on a log that already holds a start line counts its bounds from its own start', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const old = new Date(Date.now() - 50 * MIN).toISOString();
    fs.writeFileSync(watchLogPath(r), `${old} start post-ship watch started\n${old} watch health read 1 failed (error)\n`);
    const srv = await fakeServer(t, { healthSpec: health(at(r.base), at(r.base), at(r.base), at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), QUIET, 'not deploy not observed: the old start line is not this watch\'s');
    const lines = watchLines(r);
    assert.equal(lines[0].slice(0, old.length), old, 'appended to the old log');
    assert.equal(lines.filter((l) => stageOf(l) === 'start').length, 2);
    assert.equal(srv.state.healthReads.length, 4);
  });

  it('a result line refused by watchLine still sets the watch marker for what was found', async (t) => {
    const r = makeRepo(t);
    const stamp = Date.now() - 200;
    openManifest(r, { stamps: { push_started_at: iso(stamp) } });
    fs.writeFileSync(watchLogPath(r), `${iso(Date.now() - 1000)} result ${QUIET}\n`);
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)), events: () => [ev('101', stamp + 20), ev('101', stamp + 30)] });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(marker(r).count, 2);
    assert.equal(manifest(r).watch, null, 'the first watch owns the result');
    assert.match(out.stdout, /a result already stood/);
  });

  it('an error in the watch itself still blocks: watch failed, the marker at count null', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    fs.writeFileSync(L.shipPaths(r.one, { cwd: r.repo }).manifest, 'not json');
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 1);
    assert.equal(stageOf(watchLines(r)[0]), 'start');
    assert.match(resultOf(r), /^watch failed \(/);
    assert.equal(marker(r).count, null);
    assert.match(out.stderr, /watch failed/);
    assert.equal(srv.state.healthReads.length, 0);
  });

  it('--now moves the watch clock: a fresh stamp read twenty-five minutes later cannot be placed', async (t) => {
    const r = makeRepo(t);
    openManifest(r, { stamps: { push_started_at: ago(100) } });
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t), extra: ['--now', iso(Date.now() + 25 * MIN)] });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(resultOf(r), 'deploy instant unknown');
    assert.equal(srv.state.healthReads.length, 1);
  });

  it('a missing manifest is a refusal naming the sha7', async (t) => {
    const r = makeRepo(t);
    const srv = await fakeServer(t, { healthSpec: health(at(r.one)) });
    const out = await runWatch(r, srv, { home: fakeHome(t) });
    assert.equal(out.code, 1);
    assert.match(out.stdout, new RegExp(`no ship manifest for ${r.one.slice(0, 7)}`));
    assert.equal(srv.state.healthReads.length, 0);
    assert.equal(stageOf(watchLines(r)[0]), 'start', 'the start line still comes first');
  });

  it('the probes print their reads and write nothing', async (t) => {
    const r = makeRepo(t);
    const home = fakeHome(t);
    const deployAt = Date.now() - 1000;
    const srv = await fakeServer(t, {
      healthSpec: health({ body: { status: 'ok', db: 'ok' } }),
      events: () => [ev('101', deployAt - 200), ev('101', deployAt + 100), ev('101', deployAt + 200), ev('108', deployAt + 300, 'drbartender-client')],
    });
    const v = fakeVercel(t, [
      { target: 'production', state: 'READY', meta: { githubCommitSha: r.two }, created: 9 },
      { target: 'production', state: 'READY', meta: { githubCommitSha: r.one }, created: 5 },
    ]);
    const h = await runScript(r.repo, ['--probe', 'health', '--health-url', `${srv.url}/api/health`], { home });
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stdout, /health: body \{"status":"ok","db":"ok"\}/);
    assert.match(h.stdout, /release: absent/);
    const vp = await runScript(r.repo, ['--probe', 'vercel', '--sha', r.one], { home, bin: v.bin });
    assert.equal(vp.code, 0, vp.stderr);
    assert.match(vp.stdout, new RegExp(`newest production ${r.two.slice(0, 7)} READY`));
    assert.match(vp.stdout, new RegExp(`for ${r.one.slice(0, 7)}: READY`));
    assert.ok(!vp.stdout.includes(r.one), 'sha7 only');
    const sp = await runScript(r.repo, ['--probe', 'sentry', '--deploy-at', iso(deployAt), '--window-ms', '60000', '--sentry-base', srv.url], { home });
    assert.equal(sp.code, 0, sp.stderr);
    assert.match(sp.stdout, /sentry drbartender-server: 1 pages, 1 events in the pre-window, 2 in the after-window/);
    assert.match(sp.stdout, /sentry drbartender-client: 1 pages, 0 events in the pre-window, 1 in the after-window/);
    assert.match(sp.stdout, /sentry: 3 events since deploy across 2 issues, 1 new/);
    assert.ok(!sp.stdout.includes(TITLE) && !sp.stdout.includes(TOKEN));
    for (const dir of ['drb-ship', 'drb-markers']) assert.ok(!fs.existsSync(path.join(r.common, dir)), `${dir} not written`);
  });
});

describe('post-ship-watch helpers', () => {
  it('reads the token from the [auth] section only', (t) => {
    const home = tempDir(t, 'post-ship-watch-home-');
    fs.writeFileSync(path.join(home, '.sentryclirc'), '[defaults]\ntoken = wrong\n[auth]\n# a comment\ntoken="right-one"\n');
    assert.equal(W.sentryToken(home), 'right-one');
    fs.writeFileSync(path.join(home, '.sentryclirc'), '[defaults]\ntoken = wrong\n');
    assert.equal(W.sentryToken(home), null);
  });

  it('judges an issue quiet before in full and a chronic one only when it rises', () => {
    const j = W.judge(new Map([['1', { pre: 0, post: 2 }], ['2', { pre: 3, post: 3 }], ['3', { pre: 1, post: 4 }], ['4', { pre: 5, post: 0 }]]));
    assert.deepEqual({ count: j.count, issues: j.issues, new_issues: j.new_issues }, { count: 6, issues: 2, new_issues: 1 });
    assert.deepEqual(j.by_issue, { 1: 2, 3: 4 });
  });

  it('rejects an unknown flag and a zoneless --now', () => {
    assert.throws(() => W.parseArgs(['abc', '--manifest', 'x']), /unknown flag/);
    assert.throws(() => W.parseArgs(['abc', '--now', '2026-10-23T10:00:00']), /zone/);
  });

  it('both files are ASCII with no em dash', () => {
    for (const f of [path.join(__dirname, 'post-ship-watch.js'), __filename]) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(/^[\x00-\x7f]*$/.test(text), `${path.basename(f)} is ASCII`);
    }
  });
});
