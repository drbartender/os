#!/usr/bin/env node
'use strict';

/*
 * gen-docs.js: writes and checks the generated sections of README.md and
 * ARCHITECTURE.md from the code (instruction rewrite spec 2026-10-19 section
 * 5.1; plan 2026-10-27 step 4, lane gen-docs, decisions 4, 13 and 14). Six
 * sections, each between `<!-- gen:<name> -->` and `<!-- /gen:<name> -->`:
 * tree, scripts and env in README.md (the folder tree from file headers,
 * package.json's scripts, .env.example); routes, schema and agents in
 * ARCHITECTURE.md (the route mounts, server/db/schema.sql, the .claude agents,
 * commands and skills). Prose outside the markers is never touched, and the
 * generator never creates a marker. `npm run docs` maps here.
 *
 *   node scripts/gen-docs.js [--staged | --ref <sha>] [--check]
 *                            [--readme <path>] [--arch <path>]
 *   node scripts/gen-docs.js --generated-only --base <sha> --tip <sha>
 *
 * Sources (scripts/lib/genDocs/source.js), always read through git:
 *   (default)   the index's file list, the working tree's content; a
 *               `git add`ed new file counts, an untracked one does not (one
 *               stderr line names untracked source files when writing)
 *   --staged    the index for both
 *   --ref <sha> that commit alone (with --check only: there is nothing to write)
 *
 * Writing (no --check): renders the six sections, writes the two docs in the
 * working tree, prints `docs: updated <file> gen:<name>` per changed section or
 * `docs: nothing to change`, exit 0. A missing or doubled marker stops it
 * before anything is written (exit 1). With --staged the docs' prose comes
 * from the index and the rendered bytes of both are staged after the write
 * (hash-object and update-index, never a re-read of the disk; retried every
 * 100 ms for up to two seconds while another git holds index.lock); it
 * refuses (exit 1, writing nothing) when either differs between the index and
 * the working tree, so a hand edit is neither swept in nor clobbered, except
 * a file that is exactly what the run renders (a run that wrote it and could
 * not stage it), which is staged as it is. Every
 * doc is read before the render and again before the write (the index blob
 * and the file with --staged, the file otherwise); a doc that moved in between,
 * the render included, refuses the run (exit 1, one line naming it, nothing
 * written). Each doc is written through a temp file in its directory and a
 * rename.
 *
 * --check: writes nothing; renders from the chosen source, compares with the
 * docs in the same source, checks the header rule (--staged: the source files
 * the index adds or modifies; otherwise every source file), and prints one
 * line per problem, every class in one run, in this order: `marker: <file>
 * gen:<name> missing|doubled|out of order`, `stale: <file> gen:<name>`,
 * `unparsed: <file>:<line> <reason>`, `no header: <path>`; then one `run:`
 * line naming what to do for each kind present, in order (place the markers,
 * add the header, rewrite each unparsed route registration by file and line,
 * and, for a stale section only, regenerate with the run's own mode: `npm
 * run docs`, or `npm run docs -- --staged`, which stages both docs itself; a
 * marker problem or an unparsed route alone never names the regeneration);
 * exit 1. Silent exit 0 when clean. Under a pathspec commit (GIT_INDEX_FILE
 * set to a temporary index, not <git dir>/index or its lock) the regeneration
 * remedy also says to name README.md and ARCHITECTURE.md in the commit's
 * pathspec, and one line counts the source files the real index has staged
 * that this commit does not carry.
 *
 * --readme <path>, --arch <path>: read and write these copies instead of the
 * repo's two docs (no `git add` for them); every other input is unchanged. A
 * path that cannot be read refuses the run in either mode with one line,
 * `refused: cannot read <path>` (never reported as missing markers).
 *
 * --generated-only --base <a> --tip <b>: exit 0 when README.md and
 * ARCHITECTURE.md differ between the two commits only inside the generated
 * sections (their texts are equal with every section's body emptied), else
 * exit 1 naming the file. The merge path reads it.
 *
 * Exit 0 clean or written, 1 a problem, a refusal or an error (one line), 2
 * argv misuse.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const source = require('./lib/genDocs/source');
const { readHeader, isSource, extOf } = require('./lib/genDocs/headers');
const markers = require('./lib/genDocs/markers');
const tree = require('./lib/genDocs/tree');
const scriptsTable = require('./lib/genDocs/scriptsTable');
const env = require('./lib/genDocs/env');
const routes = require('./lib/genDocs/routes');
const schema = require('./lib/genDocs/schema');
const agents = require('./lib/genDocs/agents');

const DOCS = Object.keys(markers.DOC_SECTIONS);
const USAGE = 'usage: gen-docs.js [--staged | --ref <sha>] [--check] [--readme <path>] [--arch <path>]\n'
  + '       gen-docs.js --generated-only --base <sha> --tip <sha>';
const RUN_HEADER = 'add a header comment (see docs/dev.md)';
const RUN_MARKERS = 'place the markers by hand (see docs/dev.md)';

class Misuse extends Error {}

function parseArgs(argv) {
  const o = { staged: false, ref: null, check: false, readme: null, arch: null, generatedOnly: false, base: null, tip: null };
  const takes = { '--ref': 'ref', '--readme': 'readme', '--arch': 'arch', '--base': 'base', '--tip': 'tip' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--staged') o.staged = true;
    else if (a === '--check') o.check = true;
    else if (a === '--generated-only') o.generatedOnly = true;
    else if (takes[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Misuse(`${a} needs a value`);
      o[takes[a]] = v;
      i += 1;
    } else throw new Misuse(`unknown argument: ${a}`);
  }
  if (o.generatedOnly) {
    if (!o.base || !o.tip) throw new Misuse('--generated-only needs --base and --tip');
    if (o.staged || o.ref || o.check || o.readme || o.arch) throw new Misuse('--generated-only takes only --base and --tip');
  } else if (o.base || o.tip) throw new Misuse('--base and --tip go with --generated-only');
  if (o.staged && o.ref) throw new Misuse('--staged and --ref are exclusive');
  if (o.ref && !o.check) throw new Misuse('--ref is read-only: use it with --check');
  return o;
}

const SCHEMA = 'server/db/schema.sql';
const INPUTS = ['package.json', '.env.example', SCHEMA, ...DOCS];

// Everything a render reads, in one batch: the files the tree describes (the
// roots, the top level, client/'s own files), the agent files and the inputs.
const READS = /^(?:(?:server|client\/src|scripts)\/.*|client\/[^/]+|[^/]+)\.(?:js|jsx|mjs|cjs|sh|sql|css)$/;

function renderAll(src) {
  src.prefetch([...src.list().filter((p) => READS.test(p) || p.startsWith('.claude/')), ...INPUTS]);
  const walked = routes.walk(src);
  return {
    sections: {
      tree: tree.render(src),
      scripts: scriptsTable.render(src.read('package.json')),
      env: env.render(env.parse(src.read('.env.example') || '')),
      routes: routes.render(walked),
      schema: schema.render(schema.parse(src.read(SCHEMA) || ''), SCHEMA),
      agents: agents.render(src),
    },
    unparsed: walked.problems,
  };
}

function override(o, doc) {
  return doc === 'README.md' ? o.readme : o.arch;
}

// Where a doc lives on disk: its override path, or the repo's file.
function target(o, src, io, doc) {
  const p = override(o, doc);
  return p ? path.resolve(io.cwd, p) : path.join(src.top, doc);
}

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// The doc's prose as the run's source holds it: an override is read from disk;
// otherwise the source (the index blob with --staged, the working tree by
// default, the commit with --ref).
function readDoc(o, src, io, doc) {
  return override(o, doc) ? readFile(target(o, src, io, doc)) : src.read(doc);
}

// The index's blob for one path, read now (not from the run's cache).
function indexNow(top, doc) {
  const rec = execFileSync('git', ['ls-files', '-s', '-z', '--', doc], { cwd: top, stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\0')[0];
  if (!rec) return null;
  const id = rec.slice(0, rec.indexOf('\t')).split(' ')[1];
  return execFileSync('git', ['cat-file', 'blob', id], { cwd: top, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
}

// Writes through a temp file in the same directory and a rename, so a reader
// never sees half a file; the file's mode is kept.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.gen-docs-${process.pid}.tmp`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null;
  try {
    fs.writeFileSync(tmp, text, mode === null ? undefined : { mode });
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const LOCK_WAIT_MS = 2000;
const LOCK_STEP_MS = 100;

// Stages the run's own bytes for each doc (never whatever is on disk when the
// index frees): the rendered text written as a blob with `git hash-object -w
// --path`, then `git update-index --add --cacheinfo`. While another git holds
// index.lock, the update tries again every 100 ms for up to two seconds, then
// gives up with one line.
function stage(top, entries) {
  const docs = entries.map((e) => e.path);
  const infos = entries.flatMap((e) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin', `--path=${e.path}`], { cwd: top, input: e.text, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    const rec = execFileSync('git', ['ls-files', '-s', '-z', '--', e.path], { cwd: top, stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\0')[0];
    const mode = rec ? rec.split(' ')[0] : '100644';
    return ['--cacheinfo', `${mode},${blob},${e.path}`];
  });
  const started = Date.now();
  for (;;) {
    const r = spawnSync('git', ['update-index', '--add', ...infos], { cwd: top, encoding: 'utf8' });
    if (r.status === 0) return;
    const why = String(r.stderr || r.error || '').trim().split('\n')[0];
    const locked = /index\.lock/.test(String(r.stderr));
    if (!locked) throw new Error(`could not stage ${docs.join(' and ')}: ${why}`);
    if (Date.now() - started >= LOCK_WAIT_MS) throw new Error(`could not stage ${docs.join(' and ')} (index.lock held for ${LOCK_WAIT_MS / 1000} s): ${why}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_STEP_MS);
  }
}

function headerProblems(src) {
  const files = src.mode === 'staged' ? src.changedSource() : src.list().filter(isSource);
  src.prefetch(files);
  return files.filter((f) => {
    const text = src.read(f);
    return text != null && !readHeader(text, extOf(f)).present;
  });
}

// The regeneration command for the run's own mode: `npm run docs`, or with
// --staged `npm run docs -- --staged` (which stages both docs itself), and
// any doc override the run was given.
function docsCommand(o) {
  const quote = (p) => (/\s/.test(p) ? JSON.stringify(p) : p);
  const flags = [];
  if (o.staged) flags.push('--staged');
  if (o.readme) flags.push('--readme', quote(o.readme));
  if (o.arch) flags.push('--arch', quote(o.arch));
  return flags.length ? `npm run docs -- ${flags.join(' ')}` : 'npm run docs';
}

// A pathspec commit (`git commit -- <paths>`) runs its hook against a
// temporary index: GIT_INDEX_FILE set and resolving to neither <git dir>/index
// nor its index.lock (commit -a and -i use that one, which becomes the real
// index). There, `--staged` stages into the real index, which this commit
// does not read, so the remedy must name the docs in the pathspec. foreign
// counts the source files the real index has staged (differing from HEAD)
// that the temporary index does not hold. Null outside such a commit.
function pathspecCommit(top) {
  const env = process.env.GIT_INDEX_FILE;
  if (!env) return null;
  const run = (args, extraEnv) => execFileSync('git', args, { cwd: top, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
  const canon = (p) => {
    const dir = path.dirname(p);
    return path.join(fs.existsSync(dir) ? fs.realpathSync(dir) : dir, path.basename(p));
  };
  const real = path.join(gitDir, 'index');
  const used = canon(path.resolve(top, env));
  if (used === canon(real) || used === canon(`${real}.lock`)) return null;
  const entries = (text, stageField) => new Map(text.split('\0').filter(Boolean).flatMap((rec) => {
    const tab = rec.indexOf('\t');
    const f = rec.slice(0, tab).split(' ');
    return stageField && f[2] !== '0' ? [] : [[rec.slice(tab + 1), `${f[0]} ${stageField ? f[1] : f[2]}`]];
  }));
  const temp = entries(run(['ls-files', '-s', '-z']), true);
  const staged = entries(run(['ls-files', '-s', '-z'], { GIT_INDEX_FILE: real }), true);
  let head = new Map();
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: top }).status === 0) head = entries(run(['ls-tree', '-r', '-z', 'HEAD']), false);
  const paths = new Set([...staged.keys(), ...head.keys()]);
  const foreign = [...paths].filter((p) => isSource(p) && staged.get(p) !== head.get(p) && staged.get(p) !== temp.get(p)).length;
  return { foreign };
}

function check(o, src, io) {
  const out = { marker: [], stale: [], unparsed: [], header: [] };
  const rendered = renderAll(src);
  for (const doc of DOCS) {
    const name = override(o, doc) || doc;
    const text = readDoc(o, src, io, doc);
    for (const section of markers.DOC_SECTIONS[doc]) {
      const loc = text == null ? { problem: 'missing' } : markers.locate(text, section);
      if (loc.problem) out.marker.push(`marker: ${name} gen:${section} ${loc.problem}`);
      else if (markers.readSection(text, section) !== markers.expectedBody(rendered.sections[section])) out.stale.push(`stale: ${name} gen:${section}`);
    }
  }
  for (const u of rendered.unparsed) out.unparsed.push(`unparsed: ${u.file}:${u.line} ${u.reason}`);
  for (const f of headerProblems(src)) out.header.push(`no header: ${f}`);
  const lines = [...out.marker, ...out.stale, ...out.unparsed, ...out.header];
  if (lines.length === 0) return 0;
  // One remedy per kind of problem, in the order to do them: the markers, the
  // headers, the route registrations the walker cannot read, then the
  // regeneration (named only for a stale section; it cannot place a marker).
  const remedies = [];
  if (out.marker.length) remedies.push(RUN_MARKERS);
  if (out.header.length) remedies.push(RUN_HEADER);
  if (rendered.unparsed.length) {
    remedies.push(`rewrite the route registration at ${rendered.unparsed.map((u) => `${u.file}:${u.line}`).join(', ')} so the walker can read it`);
  }
  const pathspec = src.mode === 'staged' ? pathspecCommit(src.top) : null;
  if (out.stale.length) remedies.push(pathspec ? `${docsCommand(o)}, then name README.md and ARCHITECTURE.md in the commit's pathspec` : docsCommand(o));
  const foreign = pathspec && pathspec.foreign
    ? [`${pathspec.foreign} source file(s) staged by another window are not in this commit; commit or unstage them first`] : [];
  io.stdout.write(`${[...lines, ...foreign, `run: ${remedies.join(', then ')}`].join('\n')}\n`);
  return 1;
}

function write(o, src, io) {
  const repoDocs = DOCS.filter((d) => !override(o, d));
  if (o.staged && repoDocs.length) {
    const conflicted = src.unmerged();
    if (conflicted.length) {
      io.stderr.write(`refused: the index has unmerged paths (${conflicted.join(', ')})\n`);
      return 1;
    }
  }
  // Every doc is read before the render (its prose from the run's source and
  // the file on disk), so an edit that lands while the render runs is caught
  // by the check before the write.
  const snapshots = DOCS.map((doc) => {
    const file = target(o, src, io, doc);
    return { prose: readDoc(o, src, io, doc), disk: readFile(file) };
  });
  const rendered = renderAll(src);
  const plan = [];
  const problems = [];
  for (const [k, doc] of DOCS.entries()) {
    const name = override(o, doc) || doc;
    const file = target(o, src, io, doc);
    const snapshot = snapshots[k];
    const { prose } = snapshot;
    let text = prose;
    const changed = [];
    for (const section of markers.DOC_SECTIONS[doc]) {
      if (text == null) { problems.push(`marker: ${name} gen:${section} missing`); continue; }
      const r = markers.replaceSection(text, section, rendered.sections[section], name);
      if (r.problem) { problems.push(`marker: ${r.problem}`); continue; }
      if (r.changed) changed.push(section);
      text = r.text;
    }
    plan.push({ doc, name, file, text, changed, snapshot });
  }
  if (problems.length) {
    io.stdout.write(`${problems.join('\n')}\nrun: place the markers by hand, then run again\n`);
    return 1;
  }
  // --staged: a doc on disk that differs from the index is a hand edit and
  // refuses the run, unless it is exactly what this run renders (a run that
  // wrote it and could not stage it); that one is staged as it is.
  if (o.staged) {
    const dirty = plan.filter((p) => !override(o, p.doc) && p.snapshot.disk !== p.snapshot.prose && p.snapshot.disk !== p.text);
    if (dirty.length) {
      io.stderr.write(`refused: unstaged change in ${dirty.map((p) => p.name).join(' and ')}; stage it or set it aside, then run again\n`);
      return 1;
    }
  }
  if (typeof io.beforeWrite === 'function') io.beforeWrite();
  // Nothing is written unless every doc is still what the run rendered from:
  // with --staged the index blob and the file as they were before the render;
  // otherwise the file must still be the prose the render used.
  for (const p of plan) {
    const staged = o.staged && !override(o, p.doc);
    const moved = staged
      ? readFile(p.file) !== p.snapshot.disk || indexNow(src.top, p.doc) !== p.snapshot.prose
      : readFile(p.file) !== p.snapshot.prose;
    if (moved) {
      io.stderr.write(`refused: ${p.name} changed while the docs were rendered; run again\n`);
      return 1;
    }
  }
  for (const p of plan) {
    if (p.text !== p.snapshot.disk) writeAtomic(p.file, p.text);
  }
  if (o.staged && repoDocs.length) stage(src.top, plan.filter((p) => !override(o, p.doc)).map((p) => ({ path: p.doc, text: p.text })));
  const report = plan.flatMap((p) => p.changed.map((x) => `docs: updated ${p.name} gen:${x}`));
  io.stdout.write(`${report.length ? report.join('\n') : 'docs: nothing to change'}\n`);
  for (const u of rendered.unparsed) io.stderr.write(`unparsed: ${u.file}:${u.line} ${u.reason}\n`);
  const untracked = src.untrackedSource();
  if (untracked.length) {
    const shown = untracked.slice(0, 10).join(', ') + (untracked.length > 10 ? `, and ${untracked.length - 10} more` : '');
    io.stderr.write(`untracked: ${untracked.length} source file(s) not in the index are not in the docs (git add to include): ${shown}\n`);
  }
  return 0;
}

function generatedOnly(o, io) {
  const base = source.open({ mode: 'ref', ref: o.base, cwd: io.cwd });
  const later = source.open({ mode: 'ref', ref: o.tip, cwd: io.cwd });
  const bad = [];
  for (const doc of DOCS) {
    const a = base.read(doc);
    const b = later.read(doc);
    if (a === b) continue;
    if (a == null || b == null) { bad.push(doc); continue; }
    let x = a;
    let y = b;
    for (const section of markers.DOC_SECTIONS[doc]) {
      x = x == null ? null : markers.blankSection(x, section);
      y = y == null ? null : markers.blankSection(y, section);
    }
    if (x == null || y == null || x !== y) bad.push(doc);
  }
  if (!bad.length) return 0;
  io.stdout.write(`${bad.map((d) => `generated-only: ${d} differs outside the generated sections`).join('\n')}\n`);
  return 1;
}

// io: {cwd, stdout, stderr, beforeWrite}; the defaults are the process's own.
// beforeWrite is a test seam: it runs after the render and before the re-read
// that guards the write.
function main(argv, ioIn = {}) {
  const io = { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, beforeWrite: null, ...ioIn };
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof Misuse)) throw err;
    io.stderr.write(`gen-docs: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  for (const p of [o.readme, o.arch]) {
    if (p && readFile(path.resolve(io.cwd, p)) === null) {
      io.stderr.write(`refused: cannot read ${p}\n`);
      return 1;
    }
  }
  try {
    if (o.generatedOnly) return generatedOnly(o, io);
    const mode = o.staged ? 'staged' : o.ref ? 'ref' : 'worktree';
    const src = source.open({ mode, ref: o.ref, cwd: io.cwd });
    return o.check ? check(o, src, io) : write(o, src, io);
  } catch (err) {
    io.stderr.write(`gen-docs: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, renderAll };
