'use strict';

// Suite for the agents, commands and skills tables
// (scripts/lib/genDocs/agents.js) over an in-memory fixture source.

const test = require('node:test');
const assert = require('node:assert/strict');
const { render, frontMatter } = require('./agents');

function fixture(files) {
  return { list: () => Object.keys(files), read: (p) => (p in files ? files[p] : null) };
}

const FILES = {
  '.claude/agents/seams.md': '---\nname: seams\ndescription: Seams lens. Reads | a shape.\nmodel: opus\n---\n\nBody.\n',
  '.claude/agents/alpha.md': '---\nname: alpha-lens\ndescription: "Quoted \u2014 text."\ntools: Read\nmodel: fable\n---\n',
  '.claude/agents/plain.md': '# No front matter here\n\n---\nname: not-this\n---\n',
  '.claude/agents/nested/deep.md': '---\nname: deep\n---\n',
  '.claude/commands/review-plan.md': '---\ndescription: Design-stage review of a plan.\n---\n\nYou are coordinating.\n',
  '.claude/commands/bare.md': 'No front matter.\n',
  '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: >\n  The per-lane review\n  that writes a receipt.\n---\n',
  '.claude/skills/other/SKILL.md': '---\ndescription: No name line.\n---\n',
  '.claude/skills/review/brief-template.md': '---\nname: not-a-skill\n---\n',
  '.claude/CLAUDE.md': '# rules\n',
};

test('the three tables, each in byte order of the file paths', () => {
  assert.equal(render(fixture(FILES)), [
    '| Agent | Model | Description |',
    '|---|---|---|',
    '| `alpha-lens` | fable | Quoted - text. |',
    '| `plain` |  |  |',
    '| `seams` | opus | Seams lens. Reads \\| a shape. |',
    '',
    '| Command | Description |',
    '|---|---|',
    '| `/bare` |  |',
    '| `/review-plan` | Design-stage review of a plan. |',
    '',
    '| Skill | Description |',
    '|---|---|',
    '| `other` | No name line. |',
    '| `review` | The per-lane review that writes a receipt. |',
  ].join('\n'));
});

test('front matter is the block between a first-line --- and the next', () => {
  assert.deepEqual(frontMatter('---\nname: a\nmodel: opus\n---\nname: b\n'), { name: 'a', model: 'opus' });
  assert.equal(frontMatter('text\n---\nname: a\n---\n'), null);
  assert.equal(frontMatter('---\nname: a\n'), null);
  assert.deepEqual(frontMatter("---\r\nname: 'q'\r\n---\r\n"), { name: 'q' });
});

test('no agent files renders the three headers alone', () => {
  const out = render(fixture({ 'README.md': '' }));
  assert.equal(out.split('\n').filter((l) => l.startsWith('| ')).length, 3);
});
