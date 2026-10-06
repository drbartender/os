import React from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NoteSheet from './NoteSheet';
import api from '../../utils/api';
import { READ_TIMEOUT_MS } from '../../utils/editSheetView';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn() } }));

const NETWORK = { status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
function serve({ notes = ['Gate code 4412'], patch } = {}) {
  let reads = 0;
  api.get.mockImplementation(() => {
    const note = notes[Math.min(reads, notes.length - 1)];
    reads += 1;
    return note && note.reject ? Promise.reject(note.reject) : Promise.resolve({ data: { id: 13, admin_notes: note } });
  });
  api.patch.mockImplementation(patch || ((url, body) => Promise.resolve({ data: { id: 13, admin_notes: body.admin_notes } })));
}
function mount(props = {}) {
  const handles = { onDraft: jest.fn(), onSaved: jest.fn(), onClose: jest.fn() };
  const utils = render(<NoteSheet proposalId={13} {...handles} {...props} />);
  return { ...handles, ...utils };
}
const box = () => screen.findByRole('textbox', { name: 'Note' });
const LOST = 'No connection. It may not have saved; reopen the event to check.';
// What jsdom lacks: a record of what was scrolled into view.
const scrolled = [];
beforeAll(() => { Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); }; });
afterAll(() => { delete Element.prototype.scrollIntoView; });
beforeEach(() => { scrolled.length = 0; });
// Every read is a plain fresh read: the read timeout and nothing else, so no
// header (the stored-copy X-Offline-Ok above all) can ride. The PATCH carries
// no config at all: a write that times out on the phone can still land.
function expectPlainReads() {
  expect(api.get.mock.calls.length).toBeGreaterThan(0);
  for (const call of api.get.mock.calls) {
    expect(call).toHaveLength(2);
    expect(call[1]).toStrictEqual({ timeout: READ_TIMEOUT_MS });
  }
  for (const call of api.patch.mock.calls) expect(call).toHaveLength(2);
}

test('reads the note fresh and shows it in a 16px textarea, Save disabled until it changes', async () => {
  serve();
  mount();
  expect(await box()).toHaveValue('Gate code 4412');
  expect(api.get.mock.calls.map(([u]) => u)).toEqual(['/proposals/13']);
  expectPlainReads();
  expect(screen.getByText('internal · never shown to staff or clients')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('Save re-reads, writes the note, and closes', async () => {
  serve();
  const { onSaved, onClose, onDraft } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Gate code 4413' });
  expect(onSaved).toHaveBeenCalledWith('Gate code 4413');
  expect(onDraft).toHaveBeenCalledWith(null);
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('a note that changed meanwhile: yours is kept, theirs is shown, and you choose', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  const { onSaved } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(screen.getByText('Call Marcus at the gate')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Gate code 4413'));
});

test('Discard mine takes their note and saves nothing', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard mine' }));
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Call Marcus at the gate');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('Back or the scrim keeps an unsaved draft; Cancel clears it', async () => {
  serve();
  const first = mount();
  fireEvent.change(await box(), { target: { value: 'Half written' } });
  first.unmount();
  expect(first.onDraft).toHaveBeenLastCalledWith({ text: 'Half written', base: 'Gate code 4412' });
  const second = mount();
  fireEvent.change(await box(), { target: { value: 'Something else' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(second.onDraft).toHaveBeenLastCalledWith(null);
  expect(second.onClose).toHaveBeenCalled();
  second.unmount();
  expect(second.onDraft).toHaveBeenLastCalledWith(null);
});

test('a kept draft reopens in place of the stored note', async () => {
  serve();
  mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  expect(await box()).toHaveValue('Half written');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('a read that fails says so, with Retry', async () => {
  serve({ notes: [{ reject: NETWORK }] });
  mount();
  expect(await screen.findByText("Couldn't load the note. Editing needs a connection.")).toBeInTheDocument();
  serve();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await box()).toHaveValue('Gate code 4412');
});

// S-M4: the PATCH went out and no answer came back, so it may have landed.
test('a save whose answer never came says it may not have saved, and keeps the text', async () => {
  serve({ patch: () => Promise.reject(NETWORK) });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(LOST)).toBeInTheDocument();
  expect(screen.queryByText("No connection, didn't save.")).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
});

test('a re-read that fails before the write is a definite "didn\'t save", and nothing is written', async () => {
  serve({ notes: ['Gate code 4412', { reject: NETWORK }] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText("No connection, didn't save.")).toBeInTheDocument();
  expect(screen.queryByText(LOST)).toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
});

test('a booking with no note opens empty, and its first note saves and leaves no draft behind', async () => {
  serve({ notes: [null] });
  const { onDraft, onClose, unmount } = mount();
  expect(await box()).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Gate code 4412' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Gate code 4412' });
  unmount();
  expect(onDraft).toHaveBeenLastCalledWith(null);
});

test('two taps in one tick still write the note once, and every read is a plain fresh read', async () => {
  serve();
  const { onSaved } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  const save = screen.getByRole('button', { name: 'Save' });
  // One act: React cannot re-render, so it cannot disable Save, between the taps.
  act(() => { save.click(); save.click(); });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledTimes(2);
  // The read at open and the re-read before the write.
  expectPlainReads();
});

test('the scrim and Escape close the sheet, but not while it saves: Save reads Saving and the note is locked', async () => {
  let release;
  serve({ patch: () => new Promise((resolve) => { release = resolve; }) });
  const { onClose } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Note' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
  await act(async () => { release({ data: { id: 13, admin_notes: 'Gate code 4413' } }); });
  expect(onClose).toHaveBeenCalledTimes(3);
});

test('while the changed-meanwhile choice shows, Save stays disabled: a second tap on it reads and writes nothing', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('This note changed since you opened it.');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.patch).not.toHaveBeenCalled();
});

test('a note emptied meanwhile still offers the choice', async () => {
  serve({ notes: ['Gate code 4412', ''] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('The note is now empty.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save mine' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Discard mine' })).toBeEnabled();
});

test('a sheet closed before the note loads leaves the kept draft alone; one closed unchanged keeps none', async () => {
  serve();
  const early = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  early.unmount();
  expect(early.onDraft).not.toHaveBeenCalled();
  const unchanged = mount();
  await box();
  unchanged.unmount();
  expect(unchanged.onDraft).toHaveBeenLastCalledWith(null);
});

test('the note is typed at 16px, so iOS does not zoom into the field', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-note-text \{[^}]*font-size: 16px;/);
});

test('a kept draft whose note has not moved reopens with no choice, and Save writes it', async () => {
  serve();
  const { onSaved, onDraft } = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  expect(await box()).toHaveValue('Half written');
  expect(screen.queryByText('This note changed since you opened it.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Half written'));
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Half written' });
  expect(onDraft).toHaveBeenLastCalledWith(null);
});

test('a kept draft reopened after the note moved offers the choice at once, and Save mine writes the draft', async () => {
  serve({ notes: ['Call Marcus at the gate'] });
  const { onSaved, onClose } = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(screen.getByText('Call Marcus at the gate')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Half written');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Half written' });
  expect(onSaved).toHaveBeenCalledWith('Half written');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('Save mine re-reads: a note that moved again refreshes the choice and sends nothing, then Save mine writes', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate', 'Gate is open, no code'] });
  const { onSaved } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Call Marcus at the gate')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  expect(await screen.findByText('Gate is open, no code')).toBeInTheDocument();
  expect(screen.getByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(screen.queryByText('Call Marcus at the gate')).not.toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Gate code 4413'));
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(api.patch).toHaveBeenCalledWith('/proposals/13/notes', { admin_notes: 'Gate code 4413' });
  expect(api.get).toHaveBeenCalledTimes(4);
});

test('Discard mine on a reopened draft takes their note, sends nothing, and keeps no draft', async () => {
  serve({ notes: ['Call Marcus at the gate'] });
  const { onDraft, unmount } = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Discard mine' }));
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Call Marcus at the gate');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(api.patch).not.toHaveBeenCalled();
  unmount();
  expect(onDraft).toHaveBeenLastCalledWith(null);
});

test('Back while the choice shows keeps the draft over its old base, so the choice shows again on reopen', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  const first = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('This note changed since you opened it.');
  first.unmount();
  expect(first.onDraft).toHaveBeenLastCalledWith({ text: 'Gate code 4413', base: 'Gate code 4412' });
  const second = mount({ draft: { text: 'Gate code 4413', base: 'Gate code 4412' } });
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
  second.unmount();
  expect(second.onDraft).toHaveBeenLastCalledWith({ text: 'Gate code 4413', base: 'Gate code 4412' });
  expect(api.patch).not.toHaveBeenCalled();
});

test('Cancel leaves a kept draft it never showed alone: while the note loads, and after a failed read', async () => {
  api.get.mockImplementation(() => new Promise(() => {}));
  const loading = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(loading.onClose).toHaveBeenCalled();
  loading.unmount();
  expect(loading.onDraft).not.toHaveBeenCalled();
  serve({ notes: [{ reject: NETWORK }] });
  const failed = mount({ draft: { text: 'Half written', base: 'Gate code 4412' } });
  await screen.findByText("Couldn't load the note. Editing needs a connection.");
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(failed.onClose).toHaveBeenCalled();
  failed.unmount();
  expect(failed.onDraft).not.toHaveBeenCalled();
});

// ---- Fleet fold (lane ma-e3, 2026-10-06) ----
// Item 6 (S-M2): a read with no admin_notes at all cannot be compared, so the
// sheet shows the choice and writes nothing (fails closed).
test('a re-read that carries no admin_notes at all shows the choice and writes nothing', async () => {
  api.get.mockImplementation(() => Promise.resolve({ data: { id: 13 } }));
  api.patch.mockImplementation((url, body) => Promise.resolve({ data: { id: 13, admin_notes: body.admin_notes } }));
  const { onSaved } = mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Gate code 4413');
  // Save mine reads again, and still cannot compare: nothing is sent.
  fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
  expect(await screen.findByText('This note changed since you opened it.')).toBeInTheDocument();
  expect(api.patch).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

// Item 11 (U-M11): a pasted link in the changed-meanwhile note wraps instead of running sideways.
test('the changed-meanwhile note wraps a long unbroken token', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf8');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-note-theirs \{[^}]*overflow-wrap: anywhere;/);
});

// Fold follow-up (concern 6, accepted): the changed-meanwhile choice is brought
// into view as it appears, and focus moves to its words. Neither choice button
// is the safe one, so neither takes focus.
test('the changed-meanwhile choice is brought into view and takes focus on its words, never on a button', async () => {
  serve({ notes: ['Gate code 4412', 'Call Marcus at the gate'] });
  mount();
  fireEvent.change(await box(), { target: { value: 'Gate code 4413' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const copy = await screen.findByText('This note changed since you opened it.');
  await waitFor(() => expect(document.activeElement).toBe(copy));
  expect(copy).toHaveAttribute('tabindex', '-1');
  // eslint-disable-next-line testing-library/no-node-access
  expect(scrolled).toContain(copy.closest('.m-note-conflict'));
  expect(screen.getByRole('button', { name: 'Save mine' })).not.toHaveFocus();
  expect(screen.getByRole('button', { name: 'Discard mine' })).not.toHaveFocus();
});
