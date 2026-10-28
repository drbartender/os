'use strict';

// git's view of the tree the docs generator reads (instruction rewrite step 4,
// lane gen-docs; plan 2026-10-27 decision 13 and the contract "The sources").
// The generator never reads the bare working tree for its file list, so a
// pathspec commit's temporary index, a lane's own index and a commit all read
// right: every call is git itself, which honors GIT_INDEX_FILE.
//
//   open({mode, ref, cwd}) -> source
//     mode 'worktree' (default)  the index's file list, the working tree's
//                                content: a `git add`ed new file counts, an
//                                untracked scratch file does not
//     mode 'staged'              the index for both (the pre-commit check)
//     mode 'ref'                 one commit for both (`ref` names it)
//   source.list()              tracked paths in byte order (git ls-files -s;
//                              git ls-tree -r for a ref)
//   source.has(path)           the path is in that list
//   source.read(path)          its content as text, or null (a missing file,
//                              a gitlink, an unmerged path in staged mode)
//   source.prefetch(paths)     reads many at once: one `git cat-file --batch`
//                              over the blob ids in staged and ref modes, so a
//                              full generation stays fast
//   source.untrackedSource()   worktree mode: untracked, non-ignored source
//                              files under the roots (the stderr line), else []
//   source.changedSource()     staged mode: the source files the index adds or
//                              modifies against HEAD (the empty tree before a
//                              first commit), the header rule's scope
//   source.unmerged()          paths with conflict stages in the index
//   source.top, source.mode, source.commit (ref mode: the resolved sha)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isSource, ROOTS } = require('./headers');

const MODES = Object.freeze(['worktree', 'staged', 'ref']);
const MAX_BUFFER = 1024 * 1024 * 1024;

function git(cwd, args, input) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      maxBuffer: MAX_BUFFER,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A quiet git (rev-parse -q) says nothing on stderr: the error's own
    // message, which names the command and its arguments, stands in.
    const stderr = err.stderr ? err.stderr.toString().trim().split('\n')[0] : '';
    throw new Error(`git ${args[0]} failed: ${stderr || String(err.message).trim().split('\n')[0]}`);
  }
}

function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function records(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

// `git cat-file --batch` over unique ids: Map id -> text (null when missing).
function catBatch(top, ids) {
  const out = new Map();
  if (ids.length === 0) return out;
  const buf = git(top, ['cat-file', '--batch'], `${ids.join('\n')}\n`);
  let pos = 0;
  for (const id of ids) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header.length < 3 || header[1] === 'missing') { out.set(id, null); continue; }
    const size = Number(header[2]);
    out.set(id, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

function open({ mode = 'worktree', ref = null, cwd = process.cwd() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown source mode: ${mode}`);
  if (mode === 'ref' && (!ref || String(ref).startsWith('-'))) throw new Error('a ref source needs a commit');
  const top = git(cwd, ['rev-parse', '--show-toplevel']).toString().trim();
  const blobs = new Map();
  const conflicted = new Set();
  let commit = null;

  if (mode === 'ref') {
    try {
      commit = git(top, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).toString().trim();
    } catch (err) {
      throw new Error(`cannot resolve the ref ${ref} to a commit (${err.message})`);
    }
    for (const rec of records(git(top, ['ls-tree', '-r', '-z', '--full-tree', commit]))) {
      const tab = rec.indexOf('\t');
      const [, type, id] = rec.slice(0, tab).split(' ');
      blobs.set(rec.slice(tab + 1), type === 'blob' ? id : null);
    }
  } else {
    for (const rec of records(git(top, ['ls-files', '-s', '-z']))) {
      const tab = rec.indexOf('\t');
      const [fileMode, id, stage] = rec.slice(0, tab).split(' ');
      const p = rec.slice(tab + 1);
      if (stage !== '0') {
        conflicted.add(p);
        if (!blobs.has(p)) blobs.set(p, null);
        continue;
      }
      blobs.set(p, fileMode === '160000' ? null : id);
    }
  }

  const sorted = [...blobs.keys()].sort(byteOrder);
  const cache = new Map();

  function readWorktree(p) {
    try {
      return fs.readFileSync(path.join(top, p), 'utf8');
    } catch {
      return null;
    }
  }

  function prefetch(paths) {
    const want = (paths || []).filter((p) => !cache.has(p));
    if (mode === 'worktree') {
      for (const p of want) cache.set(p, readWorktree(p));
      return;
    }
    const ids = [...new Set(want.map((p) => blobs.get(p)).filter(Boolean))];
    const texts = catBatch(top, ids);
    for (const p of want) {
      const id = blobs.get(p);
      cache.set(p, id ? (texts.get(id) ?? null) : null);
    }
  }

  function read(p) {
    if (!cache.has(p)) prefetch([p]);
    return cache.get(p);
  }

  function untrackedSource() {
    if (mode !== 'worktree') return [];
    const roots = ROOTS.map((r) => r.replace(/\/$/, ''));
    const out = records(git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...roots]));
    return out.filter(isSource).sort(byteOrder);
  }

  function changedSource() {
    if (mode !== 'staged') return sorted.filter(isSource);
    let against;
    try {
      against = git(top, ['rev-parse', '--verify', '-q', 'HEAD']).toString().trim();
    } catch {
      against = git(top, ['hash-object', '-t', 'tree', '--stdin'], '').toString().trim();
    }
    const out = records(git(top, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AM', '-z', against, '--']));
    return out.filter(isSource).sort(byteOrder);
  }

  return {
    mode,
    top,
    commit,
    list: () => sorted.slice(),
    has: (p) => blobs.has(p),
    read,
    prefetch,
    untrackedSource,
    changedSource,
    unmerged: () => [...conflicted].sort(byteOrder),
  };
}

module.exports = { open, MODES, byteOrder };
