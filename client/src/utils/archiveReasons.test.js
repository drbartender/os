import fs from 'fs';
import path from 'path';
import { ARCHIVE_REASONS, archiveReasonLabel } from './archiveReasons';

const repo = path.join(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const quoted = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

test("the four values are the server's ARCHIVE_REASONS exactly, in order", () => {
  const m = read('server/routes/proposals/actions.js').match(/const ARCHIVE_REASONS = \[([^\]]*)\]/);
  expect(m).not.toBeNull();
  expect(ARCHIVE_REASONS.map((r) => r.value)).toEqual(quoted(m[1]));
});

test("the desktop's words, in the desktop modal's order", () => {
  expect(ARCHIVE_REASONS.map((r) => r.label)).toEqual(['No hire', 'Client cancelled', 'We cancelled', 'Other']);
});

test('every reason the schema allows has a label, in the desktop words', () => {
  // Both definitions of the CHECK (schema.sql writes it twice and keeps them equal).
  const checks = [...read('server/db/schema.sql').matchAll(/archive_reason IN \(([^)]*)\)/g)].map((m) => quoted(m[1]));
  expect(checks.length).toBeGreaterThan(0);
  for (const values of checks) {
    for (const v of values) expect(archiveReasonLabel(v)).not.toBe('');
  }
  expect(['no_hire', 'client_cancelled', 'we_cancelled', 'event_completed', 'option_not_chosen', 'event_passed', 'other'].map(archiveReasonLabel))
    .toEqual(['No hire', 'Client cancelled', 'We cancelled', 'Event completed', 'Option not chosen', 'Event passed', 'Other']);
});

test('an unknown or missing reason has no label', () => {
  for (const v of ['nonsense', null, undefined, '', 'toString', '__proto__']) expect(archiveReasonLabel(v)).toBe('');
});
