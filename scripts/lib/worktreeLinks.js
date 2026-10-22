'use strict';

// worktreeLinks: the one list of symlinks a worktree of this repo is born
// with, and the link that gives a lane window the main memory. Instruction
// rewrite step 3, lane worktree-links (spec 2026-10-19, sections 4.3 and 6.5;
// plan 2026-10-22, decision 15).
//
// Who reads LINKS: scripts/worktree-new.js, which makes a lane's links;
// scripts/worktree-rm.js, which removes them; and, from the gate-sha lane on,
// the gate's throwaway worktree at a sha (spec 4.3). One list for the lane and
// the gate means a gate never runs without a link the lane had, or with one the
// lane never saw. The review skill's --commit worktree and its old-code
// worktree still link node_modules and .env by hand (moving them here is a
// step 5 item). Why each link exists is in worktree-new.js's header.
//
// The gate never links .env or client/.env: it calls linkInto with env: false
// and writes its own .env from push-gate.js gateEnvFile(), so the box's live
// .env never reaches the one environment that is meant to hold no live key.
//
//   linkInto(target, mainRoot, {env, log, warn})  make the links: the shared
//                                                 entries always, the env pair
//                                                 only with env: true
//   unlinkFrom(target, {log, warn})               remove the entries that are
//                                                 links (worktree-rm's first
//                                                 step)
//   memoryRoot(worktreePath, {home})              Claude Code's memory folder
//                                                 for a launch folder
//   linkMemory(worktreePath, mainMemory, {home, log, warn})
//                                                 point that folder at the
//                                                 main memory
//   unlinkMemory(worktreePath, {home, log, warn}) remove that link, leave
//                                                 anything else
//
// linkInto keeps worktree-new's old rules: a missing source is skipped with a
// warning line and the rest are still made; a real path where a link belongs is
// left alone and reported; a link already there is reported and left. Normal
// lines go through `log` (console.log by default) and warning lines (a skip, a
// real path, a re-pointed or kept memory entry) through `warn` (console.warn,
// so stderr as before). The return value names what happened to each entry,
// so a caller can judge it without parsing lines.
//
// unlinkFrom checks every entry before it removes any: a shared entry that is a
// real path (a materialized node_modules, say) throws and nothing is removed,
// so teardown can never delete the shared copy through it. A real .env or
// client/.env is the worktree's own file and is left for git worktree remove.
//
// The memory rule is the one the drb wrapper (~/.local/bin/drb) applied at
// launch, moved here so a lane has the link from birth; the wrapper keeps its
// copy as a fallback for a worktree made before step 3. Claude Code keys a
// launch folder's project directory by its absolute path with every character
// that is not a letter or a digit turned into '-' (read from the CLI build,
// 2026-10-22). The wrapper turns only '/' into '-', which is the same key for
// every path made of letters, digits, '-' and '/', and the wrong one for a lane
// name with '.' or '_', so worktree-new takes letters, digits and dashes only,
// at most 100 characters. A key over 200 characters is cut and suffixed with a
// hash this module does not reproduce, so memoryRoot refuses one rather than
// link a folder Claude Code never reads.
//
// linkMemory: a link already there is left when it points at the main memory
// (both sides resolved to absolute paths) and re-pointed, with a warning line,
// when it points anywhere else. A real directory has every
// entry moved to <mainMemory>/_archive/lane-<worktree name>-<entry> (never over
// an existing name: that entry is left, a warning line names it, and the call
// throws with the directory still in place, so nothing is lost); the emptied
// directory is then replaced by the link. Anything else at the path refuses,
// and so does a main memory that is not a directory (a dangling memory link
// would break memory writes in that window, where no link leaves them working).
// unlinkMemory removes the link when it is one, then the project directory
// above it when that is left empty; a real directory is left and reported. A
// path whose key memoryRoot refuses is reported absent with the reason, since
// no link can have been made for it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each entry carries what a worktree loses when that link is not made, so a
// caller's report reads it from here rather than from a table of its own.
const LINKS = Object.freeze([
  Object.freeze({ rel: 'node_modules', shared: true, consequence: 'eslint and the suites cannot load their modules' }),
  Object.freeze({ rel: 'client/node_modules', shared: true, consequence: 'eslint and the suites cannot load their modules' }),
  Object.freeze({ rel: '.husky/_', shared: true, consequence: 'commits in this lane silently skip the pre-commit hook' }),
  Object.freeze({ rel: '.env', shared: false, consequence: 'a lane without .env fails every server test with ECONNREFUSED' }),
  Object.freeze({
    rel: 'client/.env',
    shared: false,
    consequence: 'CRA bakes an empty API base into the bundle and every client call comes back 500 from the dev server',
  }),
]);

// The longest project key Claude Code uses as is.
const MAX_KEY = 200;

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Follows a link, so a link to a directory counts and a dangling one does not.
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function linkInto(target, mainRoot, { env = false, log = console.log, warn = console.warn } = {}) {
  const result = { linked: [], present: [], skipped: [], real: [] };
  for (const { rel, shared } of LINKS) {
    if (!shared && !env) continue;
    const source = path.join(mainRoot, rel);
    const dest = path.join(target, rel);
    if (!fs.existsSync(source)) {
      warn(`  skipped ${rel}: ${source} is missing`);
      result.skipped.push(rel);
      continue;
    }
    const st = lstatOrNull(dest);
    if (st) {
      if (st.isSymbolicLink()) {
        log(`  ${rel} already linked`);
        result.present.push(rel);
      } else {
        warn(`  ${rel} exists as a real path, left as-is`);
        result.real.push(rel);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(source, dest);
    log(`  linked ${rel}`);
    result.linked.push(rel);
  }
  return result;
}

function unlinkFrom(target, { log = console.log, warn = console.warn } = {}) {
  const links = [];
  const left = [];
  for (const { rel, shared } of LINKS) {
    const st = lstatOrNull(path.join(target, rel));
    if (!st) continue;
    if (st.isSymbolicLink()) {
      links.push(rel);
    } else if (shared) {
      const err = new Error(`${rel} is a real path, not a symlink, stopping so the shared copy is not deleted`);
      err.code = 'REAL_SHARED_PATH';
      err.rel = rel;
      throw err;
    } else {
      left.push(rel);
    }
  }
  for (const rel of links) {
    try {
      fs.unlinkSync(path.join(target, rel));
    } catch (e) {
      throw new Error(`could not remove the link ${rel}: ${e.message}`);
    }
    log(`  unlinked ${rel}`);
  }
  for (const rel of left) warn(`  ${rel} is a real path, not a link, left in place`);
  return { unlinked: links, left };
}

function memoryRoot(worktreePath, { home = os.homedir() } = {}) {
  const key = path.resolve(worktreePath).replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length > MAX_KEY) {
    throw new Error(`the project key for ${worktreePath} is over ${MAX_KEY} characters; Claude Code shortens it with a hash this script does not reproduce, so no memory link is made`);
  }
  return path.join(home, '.claude', 'projects', key, 'memory');
}

function linkMemory(worktreePath, mainMemoryIn, { home = os.homedir(), log = console.log, warn = console.warn } = {}) {
  const mainMemory = path.resolve(mainMemoryIn);
  const mem = memoryRoot(worktreePath, { home });
  // Checked first, so a link whose target is gone is never reported present.
  if (!isDirectory(mainMemory)) {
    throw new Error(`the main memory ${mainMemory} is not a directory; no memory link made`);
  }
  const st = lstatOrNull(mem);
  let from = null;
  if (st && st.isSymbolicLink()) {
    from = path.resolve(path.dirname(mem), fs.readlinkSync(mem));
    if (from === mainMemory) {
      log('  memory already linked');
      return { state: 'present', path: mem, archived: [] };
    }
  }
  if (from !== null) {
    fs.unlinkSync(mem);
    fs.symlinkSync(mainMemory, mem);
    warn(`  re-pointed memory from ${from} to ${mainMemory}`);
    return { state: 're-pointed', path: mem, archived: [], from };
  }
  if (st && st.isDirectory()) {
    const name = path.basename(path.resolve(worktreePath));
    const archive = path.join(mainMemory, '_archive');
    fs.mkdirSync(archive, { recursive: true });
    const archived = [];
    const kept = [];
    for (const entry of fs.readdirSync(mem)) {
      const dest = path.join(archive, `lane-${name}-${entry}`);
      if (lstatOrNull(dest)) {
        warn(`  memory: ${dest} already exists, ${entry} left in ${mem}`);
        kept.push(entry);
        continue;
      }
      fs.renameSync(path.join(mem, entry), dest);
      archived.push(entry);
    }
    if (kept.length) {
      throw new Error(`${mem} still holds ${kept.join(', ')} because the archive names are taken; move them by hand and run again`);
    }
    fs.rmdirSync(mem);
    fs.symlinkSync(mainMemory, mem);
    log(`  archived the lane's own memory files to ${archive}/lane-${name}-* and linked memory to ${mainMemory}`);
    return { state: 'archived', path: mem, archived };
  }
  if (st) {
    throw new Error(`${mem} exists and is neither a directory nor a link; refusing to touch it`);
  }
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(mainMemory, mem);
  log(`  linked memory to ${mainMemory}`);
  return { state: 'linked', path: mem, archived: [] };
}

function unlinkMemory(worktreePath, { home = os.homedir(), log = console.log, warn = console.warn } = {}) {
  let mem;
  try {
    mem = memoryRoot(worktreePath, { home });
  } catch (err) {
    // linkMemory refuses the same key, so no link can exist to remove.
    return { state: 'absent', path: null, reason: err.message };
  }
  const st = lstatOrNull(mem);
  if (!st) return { state: 'absent', path: mem };
  if (!st.isSymbolicLink()) {
    warn(`  memory at ${mem} is not a link, left as-is`);
    return { state: 'left', path: mem };
  }
  fs.unlinkSync(mem);
  try {
    fs.rmdirSync(path.dirname(mem));
  } catch (err) {
    // Not empty (session files keep the folder) or already gone: either way
    // the folder stays as it is. Anything else is a real failure.
    if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT' && err.code !== 'EEXIST') throw err;
  }
  log('  unlinked memory');
  return { state: 'unlinked', path: mem };
}

module.exports = { LINKS, linkInto, unlinkFrom, memoryRoot, linkMemory, unlinkMemory };
