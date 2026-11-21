'use strict';

// Which sensitive-listed paths main changed since a lane's review are related
// to the lane, the ones that make mergeCheck's answer stale rather than
// ready-moved (a ready-moved squash still re-runs the receipt's suites on the
// merged tree, and the push gate runs the full gate). No CLI.
//
// relatedSensitive({ sensitivePaths, laneFiles, readMain, readTip }) returns
// { related, unrelated }, each in the order given. A path is related when:
//   - it is one of the lane's files;
//   - it is scripts/sensitive-paths.txt, which changes every lane's tier;
//   - it is server/db/schema.sql and a lane file is a code file (.js, .jsx,
//     .mjs, .cjs, .sql, .sh) outside client/: under server/, under scripts/
//     or at the repo root (a schema change can break any SQL, and root and
//     scripts/ imports and backfills run raw SQL behind pure tests);
//   - it is under scripts/ or .husky/ and a lane file under scripts/ or
//     .husky/ is not JS (a shell entry point or a hook execs node modules by
//     path, never by require), or it is a non-JS file under scripts/ or
//     .husky/ (a hook such as .husky/pre-push) and a lane file is under
//     scripts/ or .husky/;
//   - it is package.json or client/package.json and, at main or at the lane
//     tip, a value of its "scripts" names a lane file (for client/'s, by its
//     path under client/); a copy that does not parse, a "scripts" that is
//     not an object, or a file at neither ref counts as related;
//   - its directory and a lane file's are the same, or one is the direct
//     parent of the other (server/utils/comms/registry.js beside
//     server/utils/comms/actions/x.js), the repo root aside, since a root
//     file sits beside every top folder: a dynamic loader builds its
//     specifier with path.join, which no import scan sees;
//   - a lane file, as it stands at the lane tip, directly requires or imports
//     it; or it, as it stands on main, directly requires or imports a lane
//     file. Direct is one hop over a relative specifier ('./x', '../x', '.',
//     '..') of require(), require.resolve(), import(), import ... from,
//     export ... from or a bare import, resolved from the importing file's
//     directory as the path itself, then with .js, .jsx, .json, .mjs, .cjs,
//     then as a directory's index.js or index.jsx. A match on any candidate
//     counts (over-matching only makes the answer stale, the safe side).
// readMain(paths) and readTip(paths) return a Map of path to text for the ones
// that exist at that ref; they throw on a git failure, so the check refuses
// rather than reading a missing import as no relation.
//
// readAt(cwd, ref) is such a reader over git (ls-tree, then one cat-file
// --batch for every blob, parsed by parseBatch), for lane-status, which marks a lane stale only on a related landing;
// mergeCheck uses its own, whose git failures it names in its refusal.

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path').posix;

const LIST = 'scripts/sensitive-paths.txt';
const SCHEMA = 'server/db/schema.sql';
const CODE = /\.(?:[cm]?js|jsx)$/;
const SQL_CODE = /\.(?:[cm]?js|jsx|sql|sh)$/;
const SHELLED = /^(?:scripts|\.husky)\//;
const PKG = /^(?:client\/)?package\.json$/;
const MAX_BUFFER = 64 * 1024 * 1024;
const SPEC = /(?:\brequire(?:\.resolve)?\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*(['"`])(\.\.?(?:\/[^'"`\n]*)?)\1/g;
const EXTS = ['', '.js', '.jsx', '.json', '.mjs', '.cjs', '/index.js', '/index.jsx'];

// The repo paths a file's relative specifiers could name.
function targets(file, text) {
  const out = new Set();
  const dir = path.dirname(file);
  for (const m of String(text).matchAll(SPEC)) {
    const base = path.normalize(path.join(dir, m[2])).replace(/\/$/, '');
    if (base.startsWith('..')) continue;
    for (const e of EXTS) out.add(base === '.' ? e.replace(/^\//, '') : `${base}${e}`);
  }
  return out;
}

// A lane file that runs SQL: code outside client/, under server/, scripts/ or the root.
const runsSql = (f) => SQL_CODE.test(f) && (/^(?:server|scripts)\//.test(f) || !f.includes('/'));

// Same directory, or one the direct parent of the other; never the root.
function near(a, b) {
  const da = path.dirname(a);
  const db = path.dirname(b);
  if (da === '.' || db === '.') return false;
  return da === db || path.dirname(da) === db || path.dirname(db) === da;
}

// True when a package.json's text names a lane file in a "scripts" value, or
// cannot be read as one (the safe side).
function pkgNames(p, text, laneFiles) {
  let scripts;
  try { scripts = JSON.parse(text).scripts; } catch { return true; }
  if (scripts === undefined) return false;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return true;
  const vals = Object.values(scripts).map(String).join('\n');
  const prefix = p === 'package.json' ? '' : `${path.dirname(p)}/`;
  return laneFiles.some((f) => f.startsWith(prefix) && vals.includes(f.slice(prefix.length)));
}

function relatedSensitive({ sensitivePaths, laneFiles, readMain, readTip }) {
  const lane = new Set(laneFiles);
  const sql = laneFiles.some(runsSql);
  const shelled = laneFiles.some((f) => SHELLED.test(f) && !CODE.test(f));
  const underShell = laneFiles.some((f) => SHELLED.test(f));
  const direct = (p) => lane.has(p) || p === LIST || (p === SCHEMA && sql)
    || (shelled && SHELLED.test(p)) || (underShell && SHELLED.test(p) && !CODE.test(p))
    || laneFiles.some((f) => near(f, p));
  const rest = sensitivePaths.filter((p) => !direct(p));
  const reached = new Set();
  const pkgs = rest.filter((p) => PKG.test(p));
  if (pkgs.length) {
    const atMain = readMain(pkgs);
    const atTip = readTip(pkgs);
    for (const p of pkgs) {
      const texts = [atMain.get(p), atTip.get(p)].filter((x) => x !== undefined);
      if (!texts.length || texts.some((x) => pkgNames(p, x, laneFiles))) reached.add(p);
    }
  }
  if (rest.length) {
    const tipText = readTip(laneFiles.filter((f) => CODE.test(f)));
    for (const [f, text] of tipText) for (const x of targets(f, text)) reached.add(x);
    const mainText = readMain(rest.filter((p) => CODE.test(p)));
    for (const [p, text] of mainText) if ([...targets(p, text)].some((x) => lane.has(x))) reached.add(p);
  }
  const related = sensitivePaths.filter((p) => direct(p) || reached.has(p));
  return { related, unrelated: sensitivePaths.filter((p) => !related.includes(p)) };
}

// The texts of `oids`, in order, from git cat-file --batch's output (a header
// line "<oid> <type> <size>", the size's bytes, a newline, per object);
// a missing object, a non-blob or a short or garbled record throws.
function parseBatch(buf, oids) {
  const out = [];
  let pos = 0;
  for (const oid of oids) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) throw new Error(`git cat-file --batch: no record for ${oid}`);
    const [got, type, size] = buf.toString('utf8', pos, nl).split(' ');
    const n = Number(size);
    if (got !== oid || type !== 'blob' || !Number.isInteger(n) || n < 0 || buf[nl + 1 + n] !== 10) {
      throw new Error(`git cat-file --batch: ${buf.toString('utf8', pos, nl)} where blob ${oid} was asked`);
    }
    out.push(buf.toString('utf8', nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return out;
}

// The blob records of `git ls-tree -z` output, as [path, oid].
function blobRecords(lsTree) {
  const out = [];
  for (const rec of lsTree.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [, type, oid] = rec.slice(0, tab).split(' ');
    if (type === 'blob') out.push([rec.slice(tab + 1), oid]);
  }
  return out;
}

function readAt(cwd, ref) {
  return (paths) => {
    const out = new Map();
    if (!paths.length) return out;
    const ls = execFileSync('git', ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', ...paths], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
    const blobs = blobRecords(ls);
    if (!blobs.length) return out;
    const oids = blobs.map(([, oid]) => oid);
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: `${oids.join('\n')}\n`, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) throw new Error(`git cat-file --batch failed: ${r.error ? r.error.code : `exit ${r.status}`}`);
    parseBatch(r.stdout, oids).forEach((text, i) => out.set(blobs[i][0], text));
    return out;
  };
}

module.exports = { relatedSensitive, targets, readAt, parseBatch, blobRecords };
