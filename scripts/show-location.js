#!/usr/bin/env node
// Tells you which window you're sitting in.
// Auto-runs at Claude Code session start (via .claude/settings.json),
// and on demand via `npm run where`.

const { execSync } = require('child_process');
const path = require('path');

function safe(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const toplevel = safe('git rev-parse --show-toplevel');
if (!toplevel) process.exit(0);

const branch = safe('git branch --show-current') || '(detached HEAD)';
const folder = path.basename(toplevel);
const parent = path.basename(path.dirname(toplevel));
const isWorktree = parent.toLowerCase() === 'worktrees';

const supportsColor = process.stdout.isTTY || process.env.FORCE_COLOR;
const c = (code, s) => supportsColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

const tint = isWorktree ? yellow : green;
const bar = tint('='.repeat(60));

const headline = isWorktree
  ? `You are in: ${bold(folder)}  ${dim('(worktree)')}`
  : `You are in: ${bold(folder)}  ${dim('(integration window)')}`;

const purpose = isWorktree
  ? dim('Project work happens here. To merge to main, switch to the os window.')
  : dim('Merging and pushing happen here. Project work happens in a worktree.');

const lines = [
  '',
  bar,
  ' ' + headline,
  ' ' + `Branch:     ${bold(branch)}`,
  ' ' + purpose,
  bar,
  '',
];

console.log(lines.join('\n'));
