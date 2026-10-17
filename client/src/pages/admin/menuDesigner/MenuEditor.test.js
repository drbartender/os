import React from 'react';
import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom';
import MenuEditor from './MenuEditor';
import useMenuEditorOpen from './useMenuEditorOpen';
import api from '../../../utils/api';
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
import { FULL_SIZE } from './useMenuDraft';

// The editor shell, its open state and the sidebar override (spec 2026-10-01
// sections 4.2, 10.1, 11.1; plan Task D1; Review Focus 7). MenuCanvas has its
// own suites and is a stand-in here; the hook is a stand-in for the page's
// useMenuDraft. CRA resets jest.fn implementations before each test, so every
// stub is built inside its test.

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../../../utils/downloadMenuPrint', () => ({ downloadMenuPrint: jest.fn() }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));
jest.mock('html2canvas', () => ({ __esModule: true, default: jest.fn() }));
const mockPrefs = { prefs: { sidebar: 'full', skin: 'dark' }, setPref: jest.fn(), sidebarOverride: null, setSidebarOverride: jest.fn() };
jest.mock('../../../context/UserPrefsContext', () => ({ useUserPrefs: () => mockPrefs }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockFit = { tooLong: [] };
jest.mock('./MenuCanvas', () => {
  const R = require('react');
  const Fake = R.forwardRef(function FakeCanvas({ onFit, editable, layers, selectedDrink, onSelectDrink, onPatch, onReroll, canReroll }, ref) {
    R.useEffect(() => { if (onFit) onFit({ artHeight: 130, typeStep: false, tooLong: mockFit.tooLong }); });
    return (
      <div ref={ref} className="mc-fake" data-editable={String(!!editable)} data-selected={selectedDrink || ''} data-can-reroll={String(!!canReroll)}>
        {Object.entries(layers || {}).map(([k, url]) => <img key={k} alt="" data-mc-layer={k} src={url} />)}
        <button type="button" onClick={() => onSelectDrink('cocktail:1')}>canvas art cocktail:1</button>
        <button type="button" onClick={() => onPatch({ content: { title: 'Cheers' } })}>canvas title edit</button>
        <button type="button" onClick={() => onReroll('cocktail:1')}>canvas pill re-roll</button>
        {editable && (
          <div data-mc-k="title" contentEditable="true" suppressContentEditableWarning tabIndex={0}
            onBlur={(e) => onPatch({ content: { title: e.currentTarget.textContent } })}>Bar Menu</div>
        )}
      </div>
    );
  });
  return { __esModule: true, default: Fake };
});

const NO_LONG = [];
const DESC_LONG = ['drinks.cocktail:2.description'];
const drink = (key, name, over = {}) => ({ key, display_name: name, description: 'Tart.', group: 'sig', hidden: false, has_art: true, ...over });
const piece = (key, status = 'done', over = {}) => ({
  piece_key: key, status, has_image: status === 'done', image_rev: status === 'done' ? `rev-${key}` : null, error: null, provider: 'openai', ...over,
});
function base() {
  return {
    draft: { id: 1, version: 3, art_version: 4, read_only: false, inputs: { planner_image_role: 'logo', drb_mark: true },
      content: { words_status: 'done', title: 'Bar Menu', font_pairing: 'modern-clean',
        drinks: [drink('cocktail:1', 'Paloma'), drink('cocktail:2', 'Old Fashioned')], also_at_bar: [] } },
    pieces: [piece('background'), piece('cocktail:1'), piece('cocktail:2')],
    brief: { theme: '', naming: '', notes: '', has_planner_image: false, planner_image_rev: null },
    diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false },
    print: { state: 'none', approved_at: null, approved_by_name: null, print_key: null, approved_file_in_use: false },
    cap: { used: 0, limit: 60, remaining: 60, resets_at: null },
    configured: { openai: true, gemini: false },
    plan: { id: 7, menu_style: 'custom', drink_count: 2 },
  };
}
const P = (mut) => { const p = base(); if (mut) mut(p); return p; };
const resolved = () => jest.fn(() => Promise.resolve());
function fakeMenu(payload, over = {}) {
  const stopFull = jest.fn();
  return {
    proposalId: '42', payload, draft: payload ? payload.draft : null, loading: false, error: null, reconnecting: false,
    refetch: resolved(), layers: { 240: {}, [FULL_SIZE]: { background: 'blob:bg' } }, plannerImages: {}, plannerImageRevs: {},
    wantSize: jest.fn(() => stopFull), stopFull, refreshPlannerImage: jest.fn(), activityKeys: [],
    edit: jest.fn(), flush: resolved(), retrySave: resolved(), save: { state: 'idle', savedAt: null, conflict: false },
    clearConflict: jest.fn(), brief: { planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true },
    setBrief: jest.fn(), referenceFile: null, setReferenceFile: jest.fn(), imageModel: 'openai', setImageModel: jest.fn(),
    generate: resolved(), sync: resolved(), dismissPlanChange: resolved(), reroll: resolved(), ...over,
  };
}
const PROPOSAL = { id: 42, client_name: 'Roscoe', menu_print_key: null };
const LABEL = 'Roscoe · Wedding';

// The page as EventDetailPage wires it: the open-state hook, and a card whose
// buttons open the editor.
let nav = null;
function Page({ menu, loadProposal }) {
  const { id } = useParams();
  const ed = useMenuEditorOpen(id);
  nav = useNavigate();
  if (ed.open) return <MenuEditor editor={ed} menu={menu} proposal={{ ...PROPOSAL, id: Number(id) }} eventLabel={LABEL} loadProposal={loadProposal} />;
  return (
    <div className="card md-card">
      <button type="button" onClick={() => ed.openEditor({})}>View</button>
      <button type="button" onClick={() => ed.openEditor({ tab: 'drinks', select: 'cocktail:2' })}>Fix</button>
    </div>
  );
}
function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}
const pageTree = (menu, loadProposal = resolved(), at = '/events/42') => (
  <MemoryRouter initialEntries={[at]}>
    <Routes><Route path="/events/:id" element={<><Page menu={menu} loadProposal={loadProposal} /><Where /></>} /></Routes>
  </MemoryRouter>
);
const where = () => screen.getByTestId('where').textContent;
const openWith = (name) => { const b = screen.getByRole('button', { name }); b.focus(); fireEvent.click(b); };
const editorOpen = () => !!document.querySelector('.md-editor');
const inBanners = () => within(document.querySelector('.md-ed-banners'));

// The editor alone, for the top bar, banners and dialogs.
const mountEditor = (menu, props = {}) => {
  const editor = { view: {}, close: jest.fn(), ...props.editor };
  const utils = render(<MenuEditor editor={editor} menu={menu} proposal={PROPOSAL} eventLabel={LABEL} loadProposal={resolved()} {...props} />);
  return { ...utils, editor };
};
const approveBtn = () => screen.getByRole('button', { name: /^(Approve|Approve again|Use as print file|Approving\.\.\.|Approved)$/ });
const saveText = (c) => c.querySelector('.md-ed-save').textContent;
const banners = (c) => [...c.querySelectorAll('.md-banner')].map((b) => ({
  id: b.getAttribute('data-banner'), tone: [...b.classList].find((k) => k.startsWith('md-banner-')),
  title: b.querySelector('.md-banner-title').textContent, text: b.querySelector('.md-banner-text').textContent,
  buttons: [...b.querySelectorAll('button')].map((x) => x.textContent),
}));

beforeAll(() => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve(), load: () => Promise.resolve([{ status: 'loaded' }]), addEventListener() {}, removeEventListener() {} },
  });
});
afterAll(() => { delete document.fonts; });
beforeEach(() => {
  mockFit.tooLong = NO_LONG;
  window.innerWidth = 1440;
  window.innerHeight = 900;
  api.patch.mockResolvedValue({ data: {} });
});
afterEach(() => { document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove()); });

describe('the open state', () => {
  test('opening sets ?menu=1, focus moves to the back button, Escape flushes then closes and focus returns to the opener', async () => {
    const menu = fakeMenu(P());
    render(pageTree(menu));
    openWith('Fix');
    expect(where()).toBe('/events/42?menu=1');
    expect(editorOpen()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: LABEL }));
    // The view asked for: Fix opens the Drinks tab.
    expect(screen.getByRole('tab', { name: 'Drinks' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/events/42'));
    expect(menu.flush).toHaveBeenCalled();
    expect(editorOpen()).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fix' }));
  });

  test('the back button awaits flush() before it closes', async () => {
    let finish;
    const menu = fakeMenu(P(), { flush: jest.fn(() => new Promise((r) => { finish = r; })) });
    render(pageTree(menu));
    openWith('View');
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    await act(async () => {});
    expect(menu.flush).toHaveBeenCalledTimes(1);
    expect(editorOpen()).toBe(true);
    await act(async () => { finish(); });
    await waitFor(() => expect(where()).toBe('/events/42'));
    expect(editorOpen()).toBe(false);
  });

  test('a failed flush asks: Stay keeps the editor, Close anyway closes and keeps the edits in the hook', async () => {
    const menu = fakeMenu(P(), { flush: jest.fn(() => Promise.reject(new Error('nope'))) });
    render(pageTree(menu));
    openWith('View');
    fireEvent.keyDown(document, { key: 'Escape' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Close with an unsaved change?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(where()).toBe('/events/42?menu=1');
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close anyway' }));
    await waitFor(() => expect(where()).toBe('/events/42'));
    expect(editorOpen()).toBe(false);
    // The edits stay with the page's hook (nothing dropped them); the unmount
    // tries the save once more, best effort.
    expect(menu.edit).not.toHaveBeenCalled();
    expect(menu.flush).toHaveBeenCalledTimes(3);
  });

  test('Escape with the dialog open closes only the dialog', async () => {
    const menu = fakeMenu(P(), { flush: jest.fn(() => Promise.reject(new Error('nope'))) });
    render(pageTree(menu));
    openWith('View');
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(editorOpen()).toBe(true);
    expect(menu.flush).toHaveBeenCalledTimes(1);
  });

  test('browser Back closes at once and flushes afterwards, on unmount', async () => {
    let finish;
    const menu = fakeMenu(P(), { flush: jest.fn(() => new Promise((r) => { finish = r; })) });
    render(pageTree(menu));
    openWith('View');
    expect(menu.flush).not.toHaveBeenCalled();
    act(() => nav(-1));
    expect(where()).toBe('/events/42');
    expect(editorOpen()).toBe(false);
    expect(menu.flush).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  test('a different event id drops the editor, and the old view is not carried over', async () => {
    const menu = fakeMenu(P());
    render(pageTree(menu));
    openWith('Fix');
    act(() => nav('/events/43'));
    expect(editorOpen()).toBe(false);
    act(() => nav('/events/43?menu=1'));
    expect(editorOpen()).toBe(true);
    expect(screen.getByRole('tab', { name: 'Design' })).toHaveAttribute('aria-selected', 'true');
  });

  test('an editor reached by link closes in place (nothing pushed behind it)', async () => {
    const menu = fakeMenu(P());
    render(pageTree(menu, resolved(), '/events/42?menu=1&drawer=shift&drawerId=3'));
    expect(editorOpen()).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/events/42?drawer=shift&drawerId=3'));
  });
});

describe('the sidebar override (Review Focus 7)', () => {
  test('set on open, cleared on close; setPref is never called', async () => {
    const menu = fakeMenu(P());
    render(pageTree(menu));
    openWith('View');
    expect(mockPrefs.setSidebarOverride).toHaveBeenLastCalledWith('rail');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(editorOpen()).toBe(false));
    expect(mockPrefs.setSidebarOverride).toHaveBeenLastCalledWith(null);
    expect(mockPrefs.setPref).not.toHaveBeenCalled();
  });

  test('cleared on unmount too (browser Back), never through setPref', () => {
    const { unmount } = mountEditor(fakeMenu(P()));
    expect(mockPrefs.setSidebarOverride).toHaveBeenCalledWith('rail');
    unmount();
    expect(mockPrefs.setSidebarOverride).toHaveBeenLastCalledWith(null);
    expect(mockPrefs.setPref).not.toHaveBeenCalled();
  });

  test('on open: GPT Image is selected, full-size layers are asked for (released on unmount), all six pairings load', () => {
    const menu = fakeMenu(P());
    const { unmount } = mountEditor(menu);
    expect(menu.setImageModel).toHaveBeenCalledWith('openai');
    expect(menu.wantSize).toHaveBeenCalledWith(FULL_SIZE);
    expect(document.head.querySelector('link[data-menu-fonts]').getAttribute('href')).toMatch(/Pinyon\+Script.*Pacifico/);
    unmount();
    expect(menu.stopFull).toHaveBeenCalled();
  });
});

describe('the top bar', () => {
  test('the label, the chip and the save text', () => {
    const { container, rerender } = mountEditor(fakeMenu(P()));
    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bar menu' })).toBeInTheDocument();
    expect(container.querySelector('.md-ed-top .chip').textContent).toBe('Draft');
    expect(saveText(container)).toBe('Saved');
    const at = (menu) => rerender(<MenuEditor editor={{ view: {}, close() {} }} menu={menu} proposal={PROPOSAL} eventLabel={LABEL} />);
    at(fakeMenu(P(), { save: { state: 'saving', savedAt: null, conflict: false } }));
    expect(saveText(container)).toBe('Saving...');
    at(fakeMenu(P((p) => { p.pieces[1].status = 'working'; })));
    expect(saveText(container)).toBe('Drafting...');
    expect(container.querySelector('.md-ed-top .chip').textContent).toBe('Drafting');
    at(fakeMenu(P((p) => { p.draft = null; p.pieces = []; p.diff = null; })));
    expect(saveText(container)).toBe('');
    expect(container.querySelector('.md-ed-top .chip').textContent).toBe('Not started');
  });

  test('a failed save reads Not saved in danger with Retry', async () => {
    const menu = fakeMenu(P(), { save: { state: 'failed', savedAt: null, conflict: false } });
    const { container } = mountEditor(menu);
    expect(saveText(container)).toBe('Not saved');
    expect(container.querySelector('.md-ed-save')).toHaveClass('is-failed');
    fireEvent.click(within(container.querySelector('.md-ed-top')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(menu.retrySave).toHaveBeenCalledTimes(1));
  });

  test.each([
    ['a draft', (p) => p, 'Approve', false, ''],
    ['no draft', (p) => { p.draft = null; p.pieces = []; p.diff = null; }, 'Approve', true, ''],
    ['drafting', (p) => { p.pieces[2].status = 'pending'; }, 'Approve', true, ''],
    ['a failed drawing', (p) => { p.pieces[2].status = 'failed'; }, 'Approve', true, 'Fix the failed drawing first'],
    ['approved', (p) => { p.print.state = 'approved'; p.print.print_key = 'k'; }, 'Approved', true, ''],
    ['edited since approval', (p) => { p.print.state = 'edited_since_approval'; p.print.print_key = 'k'; }, 'Approve again', false, ''],
    ['print file removed', (p) => { p.print.state = 'removed'; }, 'Approve again', false, ''],
    ['a manual upload', (p) => { p.print.state = 'replaced'; p.print.print_key = 'm'; }, 'Use as print file', false, ''],
  ])("Approve with %s: its label, disabled state and reason", (_n, mut, label, disabled, why) => {
    mountEditor(fakeMenu(P(mut)));
    const b = approveBtn();
    expect(b).toHaveTextContent(label);
    if (disabled) expect(b).toBeDisabled(); else expect(b).toBeEnabled();
    if (why) expect(b).toHaveAttribute('title', why); else expect(b).not.toHaveAttribute('title');
  });

  test('text too long (from the canvas fit) disables Approve with its reason and raises the banner', () => {
    mockFit.tooLong = DESC_LONG;
    const { container } = mountEditor(fakeMenu(P()));
    expect(approveBtn()).toBeDisabled();
    expect(approveBtn()).toHaveAttribute('title', 'Shorten the long description first');
    expect(banners(container)).toContainEqual(expect.objectContaining({
      id: 'too-long', tone: 'md-banner-danger', title: 'Text too long to fit.', text: 'Old Fashioned description runs past the page. Shorten it to approve.',
    }));
  });

  test('a pending save is not a reason to disable Approve', () => {
    mountEditor(fakeMenu(P(), { save: { state: 'saving', savedAt: null, conflict: false } }));
    expect(approveBtn()).toBeEnabled();
  });
});

describe('table B banners', () => {
  const at = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const APPROVED_AT = '2026-10-09T17:00:00Z';
  test.each([
    ['generating, the background next', (p) => { p.pieces[0].status = 'working'; p.pieces[1].status = 'pending'; p.pieces[2].status = 'pending'; },
      {}, { id: 'generating', tone: 'md-banner-info', title: 'Words are in.', text: 'Painting the background next.', buttons: [] }],
    ['generating a drink', (p) => { p.pieces[2].status = 'working'; },
      {}, { id: 'generating', tone: 'md-banner-info', title: 'Painting Old Fashioned...', text: '1 of 2 drinks done. Text is editable now.', buttons: [] }],
    ['one drawing failed', (p) => { p.pieces[2].status = 'failed'; p.pieces[2].error = 'Gemini refused it.'; },
      {}, { id: 'drawing-failed', tone: 'md-banner-danger', title: 'One drawing failed.', text: "Old Fashioned didn't draw: Gemini refused it. Re-roll it or hide it.", buttons: ['Re-roll'] }],
    ['two drawings failed', (p) => { p.pieces[1].status = 'failed'; p.pieces[2].status = 'failed'; },
      {}, { id: 'drawing-failed', tone: 'md-banner-danger', title: '2 drawings failed.', text: 'Re-roll or hide the flagged drinks.', buttons: [] }],
    ['the image limit', (p) => { p.cap = { used: 60, limit: 60, remaining: 0, resets_at: null }; },
      {}, { id: 'image-limit', tone: 'md-banner-warn', title: 'Daily image limit reached.', text: '60 of 60 images used in the last 24 hours. Re-rolls resume soon. Text, type and color still work.', buttons: [] }],
    ['not set up, with a draft', (p) => { p.configured.openai = false; },
      {}, { id: 'drawing-off', tone: 'md-banner-neutral', title: 'Drawing is off.', text: "The AI key isn't on the server. Text, type, color and Approve still work.", buttons: [] }],
    ['plan changed', (p) => { p.diff.added = [{ key: 'cocktail:9', name: 'Cucumber Mule' }]; },
      {}, { id: 'plan-changed', tone: 'md-banner-info', title: 'Plan changed since this draft.', text: 'Cucumber Mule was added. Updating paints only the new drinks.', buttons: ['Dismiss', 'Update draft'] }],
    ['notes edited', (p) => { p.diff.brief_edited = ['notes']; },
      {}, { id: 'notes-edited', tone: 'md-banner-info', title: 'Client edited their menu notes.', text: "Design notes changed. The draft hasn't been updated.", buttons: ['Mark reviewed'] }],
    ['the client image changed', (p) => { p.diff.image_changed = true; },
      {}, { id: 'notes-edited', tone: 'md-banner-info', title: 'The client image changed since this draft.', text: "The draft hasn't been updated.", buttons: ['Mark reviewed'] }],
    ['save failed', (p) => p, { save: { state: 'failed', savedAt: null, conflict: false } },
      { id: 'save-failed', tone: 'md-banner-danger', title: "Last change didn't save.", text: 'Your edits are kept in this tab.', buttons: ['Retry'] }],
    ['save conflict', (p) => p, { save: { state: 'idle', savedAt: null, conflict: true } },
      { id: 'save-conflict', tone: 'md-banner-warn', title: 'This draft changed elsewhere.', text: 'It was reloaded.', buttons: [] }],
    ['approved', (p) => { p.print = { state: 'approved', approved_at: APPROVED_AT, approved_by_name: 'Dallas', print_key: 'k', approved_file_in_use: true }; },
      {}, { id: 'approved', tone: 'md-banner-ok', title: `Approved ${at(APPROVED_AT)}.`, text: 'This is the print file staff download. Edits make a new draft until you approve again.', buttons: ['Download'] }],
    ['edited since approval', (p) => { p.print = { state: 'edited_since_approval', approved_at: APPROVED_AT, print_key: 'k', approved_file_in_use: true }; },
      {}, { id: 'edited', tone: 'md-banner-warn', title: 'Edited since approval.', text: `Staff still get the ${at(APPROVED_AT)} version until you approve again.`, buttons: [] }],
    ['replaced by upload', (p) => { p.print = { state: 'replaced', print_key: 'm', approved_file_in_use: false }; },
      {}, { id: 'replaced', tone: 'md-banner-neutral', title: 'Print file is a manual upload.', text: 'Approving replaces it with this draft.', buttons: [] }],
    ['print file removed', (p) => { p.print = { state: 'removed', print_key: null }; },
      {}, { id: 'removed', tone: 'md-banner-warn', title: 'Print file was removed.', text: 'Staff have nothing to print. Approve to restore it.', buttons: [] }],
    ['no menu needed', (p) => { p.print = { state: 'not_required', print_key: null }; },
      {}, { id: 'no-menu', tone: 'md-banner-neutral', title: 'Marked no menu needed.', text: 'Approving still posts this menu and clears the mark.', buttons: ['Undo'] }],
    ['no plan, with a draft', (p) => { p.draft.read_only = true; p.diff = null; p.plan = null; },
      {}, { id: 'no-plan', tone: 'md-banner-neutral', title: 'No drink plan on this event.', text: 'The draft is read-only.', buttons: [] }],
  ])('%s', (_n, mut, over, want) => {
    const { container } = mountEditor(fakeMenu(P(mut), over));
    expect(banners(container)).toContainEqual(want);
  });

  test("couldn't load: the danger banner with Retry, which refetches", async () => {
    const menu = fakeMenu(null, { error: { message: 'Network error. Check your connection.' } });
    const { container } = mountEditor(menu);
    expect(banners(container)).toEqual([{ id: 'load-error', tone: 'md-banner-danger', title: "Couldn't load the menu.", text: 'Network error. Check your connection.', buttons: ['Retry'] }]);
    fireEvent.click(within(container.querySelector('.md-banner')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
  });

  test('two that apply stack in order (plan changed after approval)', () => {
    const { container } = mountEditor(fakeMenu(P((p) => {
      p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }];
      p.print = { state: 'approved', approved_at: '2026-10-09T17:00:00Z', print_key: 'k', approved_file_in_use: true };
    })));
    const stack = container.querySelector('.md-ed-banners');
    expect([...stack.children].map((b) => b.getAttribute('data-banner'))).toEqual(['plan-changed', 'approved']);
    expect(container.querySelector('.md-ed-top .chip').textContent).toBe('Plan changed');
  });

  test("each button runs its action: Re-roll, Dismiss, Update draft, Mark reviewed, Download, Undo", async () => {
    const loadProposal = resolved();
    const failed = fakeMenu(P((p) => { p.pieces[2].status = 'failed'; }));
    const one = mountEditor(failed, { loadProposal });
    fireEvent.click(inBanners().getByRole('button', { name: 'Re-roll' }));
    await waitFor(() => expect(failed.reroll).toHaveBeenCalledWith('cocktail:2'));
    one.unmount();

    const plan = fakeMenu(P((p) => { p.diff.added = [{ key: 'cocktail:9', name: 'Cucumber Mule' }]; }));
    const two = mountEditor(plan);
    fireEvent.click(inBanners().getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(plan.dismissPlanChange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(inBanners().getByRole('button', { name: 'Update draft' })).toBeEnabled());
    fireEvent.click(inBanners().getByRole('button', { name: 'Update draft' }));
    await waitFor(() => expect(plan.sync).toHaveBeenCalledTimes(1));
    two.unmount();

    const notes = fakeMenu(P((p) => { p.diff.brief_edited = ['theme']; }));
    const three = mountEditor(notes);
    fireEvent.click(inBanners().getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(notes.dismissPlanChange).toHaveBeenCalledTimes(1));
    three.unmount();

    const approved = fakeMenu(P((p) => { p.print = { state: 'approved', approved_at: '2026-10-09T17:00:00Z', print_key: 'k', approved_file_in_use: true }; }));
    const four = mountEditor(approved);
    fireEvent.click(inBanners().getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadMenuPrint).toHaveBeenCalledWith('/proposals/42/menu-print'));
    four.unmount();

    const noMenu = fakeMenu(P((p) => { p.print = { state: 'not_required', print_key: null }; }));
    mountEditor(noMenu, { loadProposal });
    fireEvent.click(inBanners().getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(noMenu.refetch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-print', { not_required: false });
    expect(loadProposal).toHaveBeenCalledTimes(1);
  });

  test('a failed action says why in a toast, and the button says it is busy while it runs', async () => {
    let fail;
    const menu = fakeMenu(P((p) => { p.diff.added = [{ key: 'cocktail:9', name: 'Cucumber Mule' }]; }), {
      sync: jest.fn(() => new Promise((resolve, reject) => { fail = reject; })),
    });
    mountEditor(menu);
    fireEvent.click(inBanners().getByRole('button', { name: 'Update draft' }));
    expect(await within(document.querySelector('.md-ed-banners')).findByRole('button', { name: 'Updating...' })).toBeDisabled();
    expect(inBanners().getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await act(async () => { fail({ message: 'Daily menu art limit reached.', status: 429 }); });
    expect(mockToast.error).toHaveBeenCalledWith('Daily menu art limit reached.');
    expect(inBanners().getByRole('button', { name: 'Update draft' })).toBeEnabled();
  });

  test("the tones sit on StatusChip's fixed hues in index.css (table D, item 8)", () => {
    const css = fs.readFileSync(path.join(__dirname, '../../../index.css'), 'utf8');
    const rule = (sel) => (css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
    expect(rule('.md-banner-ok')).toMatch(/hsl\(145 55% 45% \/ 0\.10\).*hsl\(145 55% 45% \/ 0\.32\)/);
    expect(rule('.md-banner-warn')).toMatch(/hsl\(38 92% 50% \/ 0\.10\).*hsl\(38 92% 50% \/ 0\.34\)/);
    expect(rule('.md-banner-danger')).toMatch(/hsl\(358 72% 55% \/ 0\.10\).*hsl\(358 72% 55% \/ 0\.36\)/);
    expect(rule('.md-banner-info')).toMatch(/hsl\(208 72% 55% \/ 0\.10\).*hsl\(208 72% 55% \/ 0\.34\)/);
    expect(css).not.toMatch(/\.md-banner[^{]*\{[^}]*var\(--(ok|warn|danger|info)-h\)/);
  });
});

describe('the confirm dialog', () => {
  test('Start over: its texts, Escape and Cancel close it, focus returns, the action generates', async () => {
    const menu = fakeMenu(P());
    mountEditor(menu);
    const start = screen.getByRole('button', { name: 'Start over' });
    start.focus();
    fireEvent.click(start);
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Start over?')).toBeInTheDocument();
    expect(within(dialog).getByText('This discards the draft, its drawings and your text edits, then drafts again from the plan. Uses about 3 images.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start over' })).toHaveClass('btn-danger');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(start);
    fireEvent.click(start);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(start);
    expect(menu.generate).not.toHaveBeenCalled();
    fireEvent.click(start);
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledTimes(1));
  });

  test('Tab stays inside the dialog', () => {
    mountEditor(fakeMenu(P()));
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    const dialog = screen.getByRole('dialog');
    const [cancel, action] = within(dialog).getAllByRole('button');
    action.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(action);
  });
});

describe('table E: the empty editor', () => {
  const none = (p) => { p.draft = null; p.pieces = []; p.diff = null; };
  test.each([
    ['never generated', none, 'No draft yet', 'Generate'],
    ['words failed', (p) => { p.draft.content = { words_status: 'failed' }; p.pieces = []; }, "Couldn't write the menu text", 'Retry'],
    ['no menu needed', (p) => { none(p); p.print.state = 'not_required'; }, 'No menu for this event', 'Undo'],
    ['not set up', (p) => { none(p); p.configured.openai = false; }, "Menu art isn't set up", null],
    ['no plan', (p) => { none(p); p.plan = null; }, 'No drink plan on this event', null],
    ['no drinks', (p) => { none(p); p.plan.drink_count = 0; }, 'No drinks on the plan', 'Open drink plan'],
  ])('%s', (_n, mut, title, button) => {
    const { container } = mountEditor(fakeMenu(P(mut)));
    const card = container.querySelector('.md-ed-empty');
    expect(within(card).getByText(title)).toBeInTheDocument();
    if (button) expect(within(card).getByRole('button', { name: button })).toBeInTheDocument();
    else expect(within(card).queryByRole('button')).toBeNull();
    expect(container.querySelector('.mc-fake')).toBeNull();
    // Brief is the default tab without a draft.
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Generate and Retry post Generate; Open drink plan closes the editor', async () => {
    const never = fakeMenu(P((p) => { p.draft = null; p.pieces = []; p.diff = null; }));
    const a = mountEditor(never);
    fireEvent.click(within(document.querySelector('.md-ed-empty')).getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(never.generate).toHaveBeenCalledTimes(1));
    a.unmount();
    const words = fakeMenu(P((p) => { p.draft.content = { words_status: 'failed' }; p.pieces = []; }));
    const b = mountEditor(words);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(words.generate).toHaveBeenCalledTimes(1));
    b.unmount();
    const empty = fakeMenu(P((p) => { p.draft = null; p.pieces = []; p.diff = null; p.plan.drink_count = 0; }));
    const { editor } = mountEditor(empty);
    fireEvent.click(screen.getByRole('button', { name: 'Open drink plan' }));
    await waitFor(() => expect(editor.close).toHaveBeenCalledTimes(1));
  });

  test('loading is a skeleton, with no empty card', () => {
    const { container } = mountEditor(fakeMenu(null, { loading: true }));
    expect(container.querySelector('.md-ed-skel')).not.toBeNull();
    expect(container.querySelector('.md-ed-empty')).toBeNull();
  });
});

describe('the preview', () => {
  test('the meta row, the canvas editable once the words land, Design the default tab with a draft', () => {
    const { container } = mountEditor(fakeMenu(P()));
    expect(container.querySelector('.md-ed-meta').textContent).toBe('8 × 10 in · Gallery · 2 drinksClick text to edit · dotted = AI-written');
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByRole('tab', { name: 'Design' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    expect(screen.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a read-only draft (no plan) is not editable', () => {
    const { container } = mountEditor(fakeMenu(P((p) => { p.draft.read_only = true; p.diff = null; p.plan = null; })));
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-editable', 'false');
  });
});

describe('the mounted panel (Task D2) and the canvas wiring', () => {
  test('each tab shows its own component; Brief is never inert', () => {
    const { container } = mountEditor(fakeMenu(P()));
    expect(within(container.querySelector('.md-ed-panel-body')).getByText('Font pairing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Drinks' }));
    expect(within(container.querySelector('.md-ed-panel-body')).getByText('2 of 8 illustrated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    expect(within(container.querySelector('.md-ed-panel-body')).getByText('Client brief')).toBeInTheDocument();
  });

  test('clicking a drink on the canvas selects it and switches to Drinks; its row opens', () => {
    const { container } = mountEditor(fakeMenu(P()));
    fireEvent.click(screen.getByRole('button', { name: 'canvas art cocktail:1' }));
    expect(screen.getByRole('tab', { name: 'Drinks' })).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-selected', 'cocktail:1');
    expect(container.querySelector('[aria-expanded="true"]')).toHaveTextContent('Paloma');
  });

  test('a Fix view opens Drinks with that drink selected', () => {
    const { container } = mountEditor(fakeMenu(P()), { editor: { view: { tab: 'drinks', select: 'cocktail:2' }, close: jest.fn() } });
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-selected', 'cocktail:2');
    expect(container.querySelector('[aria-expanded="true"]')).toHaveTextContent('Old Fashioned');
  });

  test('a canvas edit goes to the hook as a PATCH; a pill re-roll draws under the toggle', async () => {
    const menu = fakeMenu(P());
    const { container } = mountEditor(menu);
    fireEvent.click(screen.getByRole('button', { name: 'canvas title edit' }));
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-can-reroll', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'canvas pill re-roll' }));
    await waitFor(() => expect(menu.reroll).toHaveBeenCalledWith('cocktail:1', { note: undefined }));
  });

  test('no re-roll pill at the cap or without the key', () => {
    const { container, unmount } = mountEditor(fakeMenu(P((p) => { p.cap.remaining = 0; })));
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-can-reroll', 'false');
    unmount();
    const b = mountEditor(fakeMenu(P((p) => { p.configured.openai = false; })));
    expect(b.container.querySelector('.mc-fake')).toHaveAttribute('data-can-reroll', 'false');
  });

  test('a Design tab choice patches the draft content', () => {
    const menu = fakeMenu(P());
    const { container } = mountEditor(menu);
    fireEvent.click(container.querySelectorAll('.md-pair')[1]);
    expect(menu.edit).toHaveBeenCalledWith({ content: { font_pairing: 'rustic', ink_color: null, accent_color: null } });
  });

  test('before any draft, a Brief choice lands in the hook\'s brief, not a PATCH', () => {
    const menu = fakeMenu(P((p) => { p.draft = null; p.pieces = []; p.diff = null; p.brief.has_planner_image = true; }));
    mountEditor(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(menu.setBrief).toHaveBeenCalledWith(expect.objectContaining({ planner_image_role: 'ignore' }));
    expect(menu.edit).not.toHaveBeenCalled();
  });

  test('the footer: GPT Image selected, Gemini once configured, and Generate posts with no confirm before a draft', async () => {
    const menu = fakeMenu(P((p) => { p.draft = null; p.pieces = []; p.diff = null; p.configured.gemini = true; }));
    const { container } = mountEditor(menu);
    const foot = within(container.querySelector('.md-ed-panel'));
    expect(foot.getByRole('button', { name: 'GPT Image' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(foot.getByRole('button', { name: 'Gemini' }));
    expect(menu.setImageModel).toHaveBeenLastCalledWith('gemini');
    fireEvent.click(foot.getByRole('button', { name: 'Generate' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(menu.generate).toHaveBeenCalledTimes(1));
  });
});

describe('text being edited commits before any flush (spec 10.1)', () => {
  const typeTitle = (container, value) => {
    const el = container.querySelector('[data-mc-k="title"]');
    el.focus();
    el.textContent = value;
    return el;
  };
  const before = (a, b) => expect(a.mock.invocationCallOrder[0]).toBeLessThan(b.mock.invocationCallOrder[0]);

  test('browser Back (unmount) commits the edit in progress through the text patch, then flushes', () => {
    const menu = fakeMenu(P());
    const { container } = render(pageTree(menu));
    openWith('View');
    typeTitle(container, 'Cheers');
    act(() => nav(-1));
    expect(editorOpen()).toBe(false);
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    before(menu.edit, menu.flush);
  });

  test('an unchanged or refused text commits nothing on unmount', () => {
    const menu = fakeMenu(P());
    const { container } = render(pageTree(menu));
    openWith('View');
    typeTitle(container, 'Bar Menu');
    act(() => nav(-1));
    expect(menu.edit).not.toHaveBeenCalled();
    act(() => nav('/events/42?menu=1'));
    typeTitle(container, '   ');
    act(() => nav(-1));
    expect(menu.edit).not.toHaveBeenCalled();
  });

  test('Escape blurs first, so the edit reaches the hook before the flush', async () => {
    const menu = fakeMenu(P());
    const { container } = render(pageTree(menu));
    openWith('View');
    typeTitle(container, 'Cheers');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(editorOpen()).toBe(false));
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    before(menu.edit, menu.flush);
  });

  test('the back button blurs first too', async () => {
    const menu = fakeMenu(P());
    const { container } = mountEditor(menu);
    typeTitle(container, 'Cheers');
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    await waitFor(() => expect(menu.flush).toHaveBeenCalled());
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    before(menu.edit, menu.flush);
  });
});

describe('a read-only draft (no plan on the event)', () => {
  const readOnly = (p) => { p.draft.read_only = true; p.diff = null; p.plan = null; p.pieces[2].status = 'failed'; };

  test('no re-roll from the canvas pill or the banner, and the canvas offers none', async () => {
    const menu = fakeMenu(P(readOnly));
    const { container } = mountEditor(menu);
    expect(container.querySelector('.mc-fake')).toHaveAttribute('data-can-reroll', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'canvas pill re-roll' }));
    const reroll = container.querySelector('.md-banner[data-banner="drawing-failed"] button');
    if (reroll) fireEvent.click(reroll);
    await act(async () => {});
    expect(menu.reroll).not.toHaveBeenCalled();
  });
});

describe('while Approve runs', () => {
  test('the panel is inert, the banners wait, and Escape and the back button hold until it settles', async () => {
    // The save fails once released, so Approve settles without an export here.
    let finish;
    const menu = fakeMenu(P((p) => { p.diff.added = [{ key: 'cocktail:9', name: 'Cucumber Mule' }]; }), {
      flush: jest.fn(() => new Promise((_resolve, reject) => { finish = () => reject(new Error('save failed')); })),
    });
    const { container, editor } = mountEditor(menu);
    const panel = container.querySelector('.md-ed-panel');
    expect(panel).not.toHaveAttribute('inert');
    fireEvent.click(approveBtn());
    expect(panel).toHaveAttribute('inert');
    expect(inBanners().getByRole('button', { name: 'Update draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: LABEL })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});
    expect(menu.flush).toHaveBeenCalledTimes(1);
    expect(editor.close).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(panel).not.toHaveAttribute('inert'));
    expect(screen.getByRole('button', { name: LABEL })).toBeEnabled();
  });
});
