'use strict';

// Publishing a finalized receipt (instruction rewrite step 2, lane
// receipt-lib; scripts/review-receipt.js `finalize`). The receipt is built in
// a fresh directory beside its key (a copy of the working directory plus the
// failing log, the proof, externals/not-run.txt and the final receipt.json),
// renamed into place, then the working directory is removed. The working
// receipt.json is never marked final, so a failure before the rename removes
// the partial directory and leaves the review open for another finalize (exit
// 1, one line); a failure after it, in the index, exits 3.
//
// The copy is a plain recursive one: fs.cpSync aborts the process on an
// unreadable directory (a C++ exception no try/catch sees), which skipped the
// cleanup. A working directory holds files and directories only; anything else
// (a symlink) is refused, never followed.

const fs = require('fs');
const path = require('path');
const R = require('./receipt');
const { REVIEWERS } = require('./receiptFinalize');

function stamp(ms = false) {
  const iso = new Date().toISOString();
  return ms ? iso.replace(/[-:.]/g, '') : iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function copyTree(src, dest) {
  fs.mkdirSync(dest);
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, d.name);
    const to = path.join(dest, d.name);
    if (d.isDirectory()) copyTree(from, to);
    else if (d.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw Object.assign(new Error(`${from} is not a file or a directory`), { code: 'ENOTFILE', path: from });
  }
}

// externals/not-run.txt: one line per reviewer recorded as not run, with the
// reason; removed when both ran.
function writeNotRun(dir, externals) {
  const notRun = REVIEWERS.filter((w) => externals[w] && externals[w].state === 'not_run');
  const file = path.join(dir, 'externals', 'not-run.txt');
  if (notRun.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, notRun.map((w) => `${w}: ${externals[w].reason}\n`).join(''));
  } else {
    fs.rmSync(file, { force: true });
  }
}

// Publishes the receipt; returns the exit code (0, 1 or 3).
function publish(dir, receipt, { failing, proof, cwd }) {
  const { key, name, tip, reviewed_against: reviewed } = receipt;
  const root = R.reviewRoot({ cwd });
  const dest = R.receiptDir(key, { cwd });
  const tmp = path.join(root, `.publish-${key}-${process.pid}-${stamp(true)}`);
  let superseded = null;
  try {
    copyTree(dir, tmp);
    if (failing) {
      fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tests', 'failing-on-old-code.log'), failing.text);
    }
    if (proof) fs.writeFileSync(path.join(tmp, 'proof.txt'), proof.text);
    // externals/not-run.txt at every tier: one line per reviewer not run, with
    // the reason (below tier A, "not required at tier X").
    writeNotRun(tmp, receipt.externals);
    R.writeReceipt(tmp, receipt);
    if (fs.existsSync(dest)) {
      const sup = path.join(root, '_superseded');
      fs.mkdirSync(sup, { recursive: true });
      superseded = path.join(sup, `${key}.${stamp(true)}`);
      fs.renameSync(dest, superseded);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (superseded && !fs.existsSync(dest)) fs.renameSync(superseded, dest);
    const where = err.path ? ` on ${err.path}` : '';
    console.error(`finalize: could not build the receipt (${err.code || 'error'}${where}); nothing was published, and the review stays open`);
    return 1;
  }
  if (superseded) console.log(`finalize: the earlier receipt under this key moved to ${superseded}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`finalize: receipt ${key} is published, but the working directory ${dir} was not removed (${err.code || 'error'}); remove it`);
  }
  try {
    R.indexSet(name, { key, tip, reviewedAgainst: reviewed }, { cwd });
  } catch (err) {
    console.error(`finalize: receipt ${key} is at ${dest}, but the index was not updated (${err.message}); show finds it by key`);
    return 3;
  }
  console.log(`finalize: receipt ${key} (${receipt.kind}, tier ${receipt.tier})\n  dir: ${dest}`);
  return 0;
}

module.exports = { publish, writeNotRun, copyTree, stamp };
