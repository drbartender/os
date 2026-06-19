#!/usr/bin/env node
'use strict';

// Sensitive-path matcher. Reads scripts/sensitive-paths.txt (the single source of
// truth) and reports which of a given set of paths are sensitive. Consumed by the
// review-scaling, conflict-escalation, and auto-pull logic (workflow-redesign).

const fs = require('fs');
const path = require('path');

const DEFAULT_LIST = path.join(__dirname, 'sensitive-paths.txt');

// Turn a gitignore-style pattern into an anchored regex. Every regex special is
// escaped except '*', which becomes "match within a path segment" ([^/]*), so a
// pattern never accidentally crosses a directory boundary.
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const globbed = escaped.replace(/\*/g, '[^/]*');
  return new RegExp('^' + globbed + '$');
}

function loadPatterns(listFile = DEFAULT_LIST) {
  return fs
    .readFileSync(listFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((pattern) => ({ pattern, regex: patternToRegex(pattern) }));
}

// Strip a leading "./" and normalize separators so callers can pass paths as git
// emits them, or with a leading "./", interchangeably.
function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// Return the subset of `paths` that match a sensitive pattern.
function matchSensitive(paths, listFile = DEFAULT_LIST) {
  const patterns = loadPatterns(listFile);
  const list = Array.isArray(paths) ? paths : [paths];
  return list.filter((p) => {
    const np = normalize(p);
    return patterns.some(({ regex }) => regex.test(np));
  });
}

// True if ANY of `paths` is sensitive.
function isSensitive(paths, listFile = DEFAULT_LIST) {
  return matchSensitive(paths, listFile).length > 0;
}

module.exports = { isSensitive, matchSensitive, loadPatterns, patternToRegex };

// CLI: `node sensitive-match.js <path>...` or pipe paths on stdin (one per line).
// Prints the matched sensitive paths; exits 0 if any matched, 1 if none (grep-style).
if (require.main === module) {
  const emit = (paths) => {
    const matched = matchSensitive(paths);
    matched.forEach((p) => process.stdout.write(p + '\n'));
    process.exit(matched.length > 0 ? 0 : 1);
  };
  const args = process.argv.slice(2);
  if (args.length > 0) {
    emit(args);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => emit(buf.split('\n').map((l) => l.trim()).filter(Boolean)));
  }
}
