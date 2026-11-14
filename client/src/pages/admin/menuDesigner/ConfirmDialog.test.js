import { editorConfirm } from './ConfirmDialog';

// The editor's confirms (spec 2026-10-01 section 11.1). Start over counts the
// images the next Generate uses: none for a plain house card, one for a house
// card with touches, about n for a custom draft.
test('Start over counts its images: none, one, or about n', () => {
  const lead = 'This discards the draft, its drawings and your text edits, then drafts again from the plan.';
  const text = (need) => editorConfirm('start-over', { need }).text;
  expect(text(0)).toBe(`${lead} Uses no images.`);
  expect(text(1)).toBe(`${lead} Uses about 1 image.`);
  expect(text(9)).toBe(`${lead} Uses about 9 images.`);
  expect(editorConfirm('start-over', { need: 3 })).toEqual({
    title: 'Start over?', actionLabel: 'Start over', actionClass: 'btn btn-danger', text: `${lead} Uses about 3 images.`,
  });
});

// A plain house card has no drawings to discard (no background), so its
// Start over leaves them out; a touched house card and a custom draft keep the
// sentence with their own count.
test('Start over on a draft with no drawings leaves the drawings out', () => {
  expect(editorConfirm('start-over', { need: 0, drawings: false }).text)
    .toBe('This discards the draft and your text edits, then drafts again from the plan. Uses no images.');
  expect(editorConfirm('start-over', { need: 1, drawings: true }).text)
    .toBe('This discards the draft, its drawings and your text edits, then drafts again from the plan. Uses about 1 image.');
});

// Approve and send has its own confirm (exportMenu approveConfirm; spec
// 2026-10-19 section 10.5), so the v1 replace-the-print-file confirm is gone:
// the editor's ids are start-over and close (lane menu-approve-send).
test('there is no replace confirm any more; an id it does not know reads as close', () => {
  const close = editorConfirm('close');
  expect(close).toEqual({ title: 'Close with an unsaved change?', actionLabel: 'Close anyway', actionClass: 'btn btn-primary', cancelLabel: 'Stay',
    text: "Your last change didn't save. Close anyway keeps it on the event page, where you can retry it." });
  expect(editorConfirm('replace', { print: { approved_file_in_use: true, approved_at: '2026-10-09T17:00:00Z' } })).toEqual(close);
});
