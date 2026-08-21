import { splitBoldRuns } from './markdownBold';

// The exact SHAPE of contractor-agreement clause 6, not a copy of its text. CRA
// cannot import from outside client/src, so the real string cannot be reached
// from here; server/data/contractorAgreement.test.js pins the other half, that
// the frozen copy only ever contains runs this split understands.
const CLAUSE_SHAPE = '**Mutual.** Each party represents...\n\n**From Contractor.** Contractor represents...';

test('a plain string is one non-bold run', () => {
  expect(splitBoldRuns('Just words.')).toEqual([{ text: 'Just words.', bold: false }]);
});

test('two lead-ins in one body become bold runs, asterisks gone', () => {
  // The shape that shipped the bug: two **bold** lead-ins inside one clause body.
  const runs = splitBoldRuns(CLAUSE_SHAPE);
  const bold = runs.filter((r) => r.bold).map((r) => r.text);
  expect(bold).toEqual(['Mutual.', 'From Contractor.']);
  // Nothing may survive as a literal marker anywhere in the output.
  expect(runs.some((r) => r.text.includes('**'))).toBe(false);
  // And the visible text must be the original minus exactly the four markers.
  expect(runs.map((r) => r.text).join('')).toBe(CLAUSE_SHAPE.replace(/\*\*/g, ''));
});

test('order is preserved, so a lead-in stays attached to its own paragraph', () => {
  const runs = splitBoldRuns('**A.** one\n\n**B.** two');
  expect(runs).toEqual([
    { text: 'A.', bold: true },
    { text: ' one\n\n', bold: false },
    { text: 'B.', bold: true },
    { text: ' two', bold: false },
  ]);
});

test('newlines are untouched, because the screen relies on pre-wrap', () => {
  const runs = splitBoldRuns('a\n\n**b**\nc');
  expect(runs.map((r) => r.text).join('')).toBe('a\n\nb\nc');
});

test('an UNMATCHED marker stays literal, matching the server twin', () => {
  // agreementPdf.js requires both delimiters too. Neither surface may silently
  // swallow half a marker, or the two documents stop agreeing.
  expect(splitBoldRuns('**oops')).toEqual([{ text: '**oops', bold: false }]);
  expect(splitBoldRuns('oops**')).toEqual([{ text: 'oops**', bold: false }]);
});

test('bullets and em dashes are NOT normalized here', () => {
  // The PDF rewrites them because its font lacks the glyphs. A browser has them.
  const s = '• item — dash';
  expect(splitBoldRuns(s)).toEqual([{ text: s, bold: false }]);
});

test('empty and non-string inputs yield nothing to render', () => {
  expect(splitBoldRuns('')).toEqual([]);
  expect(splitBoldRuns(null)).toEqual([]);
  expect(splitBoldRuns(undefined)).toEqual([]);
});
