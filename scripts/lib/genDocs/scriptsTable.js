'use strict';

// The npm scripts table for README.md's gen:scripts section (instruction
// rewrite step 4, lane gen-docs; plan 2026-10-27 decision 5 and the contract
// "The scripts table").
//
//   render(packageJsonText) -> `| Script | Command |`, one row per key of
//                              package.json's scripts in file order, each as a
//                              code span, pipes escaped
//
// package.json has no description field, so the table carries the command
// only; the caveats a command does not say live in README's hand "script
// notes" below the markers. Text that is not JSON throws, naming package.json.

const { code } = require('./markers');

function render(packageJsonText) {
  const rows = ['| Script | Command |', '|---|---|'];
  if (packageJsonText == null || String(packageJsonText).trim() === '') return rows.join('\n');
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch (err) {
    throw new Error(`package.json does not parse: ${err.message}`);
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  for (const [name, command] of Object.entries(scripts)) {
    rows.push(`| ${code(name)} | ${code(String(command))} |`);
  }
  return rows.join('\n');
}

module.exports = { render };
