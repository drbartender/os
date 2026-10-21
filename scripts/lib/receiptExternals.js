'use strict';

// Recording the second opinion's reviewers into a review's working directory
// (instruction rewrite step 2, lane receipt-lib; scripts/review-receipt.js
// `externals`). Each argument is one reviewer's state: codex=run,
// codex=run:<output file>, codex=not_run:<reason>, or second-opinion.md's
// fixed line as it prints it, codex: run (<note>) or codex: not run
// (<reason>); the two fixed lines may come as one argument, a line each. An
// entry carries the position snapshot it was recorded at, when there is one:
// recorded, never gated (spec 3.10). A message names reviewers and states
// only, never a note, a reason or a line of an output file.

const fs = require('fs');
const path = require('path');
const P = require('./receiptPosition');
const { readFile } = require('./receiptTests');
const { writeNotRun } = require('./receiptPublish');
const { REVIEWERS } = require('./receiptFinalize');

// A usage error: the CLI prints the usage and exits 2.
function usage(why) {
  throw Object.assign(new Error(why), { code: 'USAGE' });
}

function externalUpdate(p) {
  const line = /^(codex|gemini):\s*(run|not run)\s*(?:\(([\s\S]*)\))?\s*$/.exec(p);
  if (line) {
    if (line[2] === 'not run' && !(line[3] || '').trim()) usage('a not run line needs its reason in parentheses');
    return line[2] === 'run' ? { who: line[1], state: 'run', note: line[3] } : { who: line[1], state: 'not_run', arg: line[3] };
  }
  const m = /^(codex|gemini)=(run|not_run)(?::([\s\S]*))?$/.exec(p);
  if (!m) usage('externals takes codex=run, codex=run:<output file>, codex=not_run:<reason>, or the line codex: run (<note>) or codex: not run (<reason>), and the same for gemini');
  if (m[2] === 'not_run' && !(m[3] || '').trim()) usage('not_run needs a reason');
  return { who: m[1], state: m[2], arg: m[3] };
}

// The arguments after <name> -> {who: update}; a usage error for anything else.
function externalUpdates(args) {
  const pairs = args.flatMap((a) => (/^(codex|gemini):/.test(a) ? a.split('\n').map((l) => l.trim()).filter(Boolean) : [a]));
  const updates = {};
  for (const p of pairs) {
    const u = externalUpdate(p);
    if (updates[u.who]) usage(`${u.who} given twice`);
    updates[u.who] = u;
  }
  return updates;
}

// Records the updates into the state (the caller saves it); returns the one
// line the CLI prints.
function recordExternals(dir, state, updates) {
  let snap = null;
  try {
    snap = P.read(dir);
  } catch {
    snap = null;
  }
  const at = snap ? { tip: snap.tip, ...(snap.tree ? { tree: snap.tree } : {}), main: snap.main, position: snap.seq } : {};
  for (const who of REVIEWERS) {
    const u = updates[who];
    if (!u) continue;
    if (u.state === 'run') {
      const e = { state: 'run' };
      if (u.note !== undefined && u.note.trim()) e.note = u.note;
      if (u.arg) {
        const text = readFile(u.arg, `${who} output`);
        fs.mkdirSync(path.join(dir, 'externals'), { recursive: true });
        const out = `${who}${path.extname(u.arg) || '.md'}`;
        fs.writeFileSync(path.join(dir, 'externals', out), text);
        e.output = `externals/${out}`;
      }
      state.externals[who] = { ...e, ...at };
    } else {
      state.externals[who] = { state: 'not_run', reason: u.arg, ...at };
    }
  }
  writeNotRun(dir, state.externals);
  return `externals: ${REVIEWERS.map((w) => `${w} ${state.externals[w] ? state.externals[w].state.replace('_', ' ') : 'not recorded'}`).join(', ')}`;
}

module.exports = { externalUpdates, recordExternals };
