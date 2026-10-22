'use strict';

// worktree-new: create a project worktree for the parallel-development workflow.
//
//   node scripts/worktree-new.js <name>
//   npm run worktree:new -- <name>
//
// Creates ../worktrees/<name>/ on a new branch <name> taken from main, then
// symlinks in the things a worktree needs to edit, lint, commit, and RUN (the
// list is LINKS in scripts/lib/worktreeLinks.js, which the gate's throwaway
// worktree reads too, so the two cannot drift):
//
//   <worktree>/node_modules        -> <main>/node_modules
//   <worktree>/client/node_modules -> <main>/client/node_modules
//   <worktree>/.husky/_            -> <main>/.husky/_
//   <worktree>/.env                -> <main>/.env
//   <worktree>/client/.env         -> <main>/client/.env
//
// and then links the lane window's memory to the main memory:
//
//   ~/.claude/projects/<worktree key>/memory -> ~/.claude/projects/-home-drbartender/memory
//
// All of them are needed even by a worktree that only edits and commits: the
// pre-commit hook runs eslint, the root eslint.config.mjs imports a plugin out
// of client/node_modules, .env carries DATABASE_URL (without it every server test
// dies with ECONNREFUSED 127.0.0.1:5432, because dotenv finds nothing and pg falls
// back to a local socket — hit while building the upload-honesty lane 2026-07-26),
// and .husky/_ is husky's hook runner (without it the
// commit silently skips the hook). Symlinks are instant and cost no disk.
//
// client/.env carries REACT_APP_API_URL. It is gitignored, so a worktree is
// born without it, and CRA then bakes an EMPTY api base into the bundle: every
// call goes relative to the dev server instead of :5000 and comes back 500,
// which reads as a code bug rather than a missing file. Cost a real detour on
// the tip-sign download lane, 2026-08-11.
//
// The memory link: Claude Code keeps a project's memory under a folder keyed by
// the launch folder's path, so a window opened in the lane would otherwise read
// and write an empty memory of its own (spec 2026-10-19, 6.5). This step took
// the link over from the drb wrapper, which keeps its copy as a fallback for a
// worktree made earlier; worktree-rm removes it. The rule (a link is left, a
// real directory is archived into the main memory's _archive/ and replaced,
// anything else refuses) is in worktreeLinks.js. DRB_MAIN_MEMORY overrides the
// main memory path (the tests point it into a fake home).
//
// Re-running on an existing worktree just creates any missing links.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LINKS, linkInto, linkMemory } = require('./lib/worktreeLinks');

function die(msg) {
  console.error(`worktree-new: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

// Compared as written: Linux paths are case-sensitive, so lowercasing (a
// Windows-era rule) would take "Lane-x" for an existing "lane-x".
function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// --- arguments --------------------------------------------------------------
const name = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!name) die('usage: npm run worktree:new -- <name>');
// Letters, digits and dashes only, and at most MAX_NAME characters. The lane
// memory link is keyed by the worktree path through memoryRoot, which maps
// every non-alphanumeric character to a dash (Claude Code's own rule), so
// "x.y" and "x-y" would share one memory key; the drb wrapper (outside git)
// maps only slashes. On this set of names both rules agree, and the cap keeps
// the key well under the 200 characters Claude Code uses as is.
const MAX_NAME = 100;
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name) || name.length > MAX_NAME) {
  die(`invalid name "${name}" (use letters, digits and dashes, starting with a letter or digit, at most ${MAX_NAME} characters)`);
}
if (name === 'main') die('"main" is reserved, pick a project name');

// --- locate the main worktree ----------------------------------------------
let mainRoot;
try {
  mainRoot = path.dirname(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
} catch {
  die('not inside a git repository');
}

const target = path.join(path.dirname(mainRoot), 'worktrees', name);

// --- create the worktree (or reuse an existing one) ------------------------
const listed = git(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
const exists = listed
  .split('\n')
  .some((l) => l.startsWith('worktree ') && samePath(l.slice(9), target));

if (exists) {
  console.log(`Worktree "${name}" already exists, refreshing junctions.`);
} else {
  if (fs.existsSync(target)) {
    die(`${target} already exists but is not a registered worktree, remove it first`);
  }
  try {
    git(['worktree', 'add', '-b', name, target, 'main'], { cwd: mainRoot });
  } catch (e) {
    die(`git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  console.log(`Created worktree "${name}" on a new branch from main.`);
}

// --- symlinks ---------------------------------------------------------------
const made = linkInto(target, mainRoot, { env: true });
// What a lane loses when a link's source is absent comes from its LINKS entry.
const notMade = [
  ...made.skipped.map((rel) => `${rel}: ${LINKS.find((l) => l.rel === rel).consequence}`),
  ...made.real.map((rel) => `${rel}: a real path stands in its place, left as-is`),
];
if (notMade.length) {
  console.error(`worktree-new: ${notMade.length} link(s) not made, see the header: ${notMade.join('; ')}`);
}

// --- the lane memory link -------------------------------------------------
const mainMemory = process.env.DRB_MAIN_MEMORY
  ? path.resolve(process.env.DRB_MAIN_MEMORY)
  : path.join(os.homedir(), '.claude', 'projects', '-home-drbartender', 'memory');
if (process.env.DRB_MAIN_MEMORY) {
  console.error(`worktree-new: DRB_MAIN_MEMORY is set, linking the lane memory to ${mainMemory}`);
}
try {
  linkMemory(target, mainMemory);
} catch (e) {
  die(`the worktree is made, but its memory link is not: ${e.message}`);
}

// --- done -------------------------------------------------------------------
console.log('');
console.log('Ready. Open a Claude window in:');
console.log(`  ${target}`);
