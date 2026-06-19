'use strict';

// worktree-rm: tear down a project worktree created by worktree-new.
//
//   node scripts/worktree-rm.js <name> [--force]
//   npm run worktree:rm -- <name> [--force]
//
// Order matters. The symlinks are removed first, so the teardown can never
// follow a link into the shared node_modules and delete it. Only entries that
// lstat reports as links are removed; a real directory in a link's place
// stops the script. Then the worktree is removed, then the branch.
//
// The branch is deleted with `git branch -d`, which refuses an unmerged branch,
// so unmerged work cannot be lost by accident. --force switches to -D to
// discard a throwaway branch on purpose.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function die(msg) {
  console.error(`worktree-rm: ${msg}`);
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
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const name = argv.find((a) => !a.startsWith('-'));

if (!name) die('usage: npm run worktree:rm -- <name> [--force]');
if (name === 'main') die('refusing to operate on "main"');

// --- locate the main worktree and the target ------------------------------
let mainRoot;
try {
  mainRoot = path.dirname(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
} catch {
  die('not inside a git repository');
}

const target = path.join(path.dirname(mainRoot), 'worktrees', name);

const listed = git(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
const registered = listed
  .split('\n')
  .some((l) => l.startsWith('worktree ') && samePath(l.slice(9), target));
if (!registered) die(`no registered worktree at ${target}`);

// --- refuse if the worktree has uncommitted work ---------------------------
if (git(['status', '--porcelain'], { cwd: target })) {
  die(`"${name}" has uncommitted changes, commit or discard them in the worktree first`);
}

// --- remove the symlinks BEFORE removing the worktree ----------------------
// The isSymbolicLink guard below is cross-platform and load-bearing: it stops
// the script if a shared dir was materialized as a real directory, so teardown
// never deletes the shared node_modules.
function unlinkSharedLink(relPath) {
  const dest = path.join(target, relPath);
  let st;
  try { st = fs.lstatSync(dest); } catch { return; }
  if (!st.isSymbolicLink()) {
    die(`${relPath} is a real directory, not a symlink, stopping so the shared copy is not deleted`);
  }
  try {
    fs.unlinkSync(dest);
  } catch {
    try {
      // rmdir fallback was for Windows junctions; on Linux a symlink always
      // unlinks above, so this branch is a no-op now. Kept as a harmless guard.
      fs.rmdirSync(dest);
    } catch (e) {
      die(`could not remove the link ${relPath}: ${e.message}`);
    }
  }
  console.log(`  unlinked ${relPath}`);
}

unlinkSharedLink('node_modules');
unlinkSharedLink(path.join('client', 'node_modules'));
unlinkSharedLink(path.join('.husky', '_'));

// --- remove the worktree, then the branch ----------------------------------
try {
  git(['worktree', 'remove', target], { cwd: mainRoot });
} catch (e) {
  die(`git worktree remove failed: ${(e.stderr || e.message || '').toString().trim()}`);
}
console.log(`Removed worktree "${name}".`);

try {
  git(['branch', force ? '-D' : '-d', name], { cwd: mainRoot });
} catch (e) {
  console.error(`worktree-rm: worktree removed, but branch "${name}" was kept.`);
  console.error(`  ${(e.stderr || e.message || '').toString().trim()}`);
  console.error('  Merge the branch, or re-run with --force to discard it.');
  process.exit(1);
}
console.log(`Deleted branch "${name}". Done.`);
