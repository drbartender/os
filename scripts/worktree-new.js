'use strict';

// worktree-new: create a project worktree for the parallel-development workflow.
//
//   node scripts/worktree-new.js <name>
//   npm run worktree:new -- <name>
//
// Creates ../worktrees/<name>/ on a new branch <name> taken from main, then
// symlinks in the three things a worktree needs to edit, lint, and commit:
//
//   <worktree>/node_modules        -> <main>/node_modules
//   <worktree>/client/node_modules -> <main>/client/node_modules
//   <worktree>/.husky/_            -> <main>/.husky/_
//
// All three are needed even by a worktree that only edits and commits: the
// pre-commit hook runs eslint, the root eslint.config.mjs imports a plugin out
// of client/node_modules, and .husky/_ is husky's hook runner (without it the
// commit silently skips the hook). Symlinks are instant and cost no disk.
//
// Re-running on an existing worktree just creates any missing links.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// --- arguments --------------------------------------------------------------
const name = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!name) die('usage: npm run worktree:new -- <name>');
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
  die(`invalid name "${name}" (use letters, digits, dot, dash, underscore)`);
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
function link(relPath, source) {
  const dest = path.join(target, relPath);
  if (!fs.existsSync(source)) {
    console.warn(`  skipped ${relPath}: ${source} is missing`);
    return;
  }
  let st = null;
  try { st = fs.lstatSync(dest); } catch { /* not there yet */ }
  if (st) {
    if (st.isSymbolicLink()) {
      console.log(`  ${relPath} already linked`);
    } else {
      console.warn(`  ${relPath} exists as a real path, left as-is`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Plain symlink: correct on Linux. The old Windows-only 'junction' type
  // arg has been dropped (it was a no-op on Linux anyway).
  fs.symlinkSync(source, dest);
  console.log(`  linked ${relPath}`);
}

link('node_modules', path.join(mainRoot, 'node_modules'));
link(path.join('client', 'node_modules'), path.join(mainRoot, 'client', 'node_modules'));
link(path.join('.husky', '_'), path.join(mainRoot, '.husky', '_'));

// --- done -------------------------------------------------------------------
console.log('');
console.log('Ready. Open a Claude window in:');
console.log(`  ${target}`);
