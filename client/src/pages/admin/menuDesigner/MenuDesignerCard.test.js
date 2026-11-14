import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('../../../utils/downloadMenuPrint', () => ({ downloadMenuPrint: jest.fn() }));
// jsdom has no 2D canvas (spec 14): the two canvas-drawn layers are mocked.
jest.mock('./tintedWordmark', () => ({ useTintedWordmark: () => 'data:image/png;base64,TINT' }));
jest.mock('./softBacking', () => ({
  drawSoftBacking: () => 'data:image/png;base64,SOFT',
  drawBadgeShadow: () => 'data:image/png;base64,SHADOW',
  BADGE: { pad: 20 },
}));
// eslint-disable-next-line import/first
import api from '../../../utils/api';
// eslint-disable-next-line import/first
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
// eslint-disable-next-line import/first
import MenuDesignerCard from './MenuDesignerCard';
// eslint-disable-next-line import/first
import { shortDate } from './menuCardState';

// The card by table C (spec 2026-10-01 section 11.1), with a stand-in for the
// page's useMenuDraft. No onOpenEditor is passed on the page in this lane, so
// the editor actions and the thumbnail's click are tested both ways.
const APPROVED_AT = '2026-10-09T17:00:00Z';
const drink = (key, name, over = {}) => ({ key, display_name: name, description: '', group: 'sig', hidden: false, has_art: true, ...over });
const piece = (key, status = 'done') => ({ piece_key: key, status, has_image: status === 'done', image_rev: status === 'done' ? `rev-${key}` : null, error: null });
function base() {
  return {
    draft: { id: 1, version: 3, art_version: 4, read_only: false, inputs: { planner_image_role: 'logo', drb_mark: true },
      content: { words_status: 'done', title: 'Bar Menu', font_pairing: 'modern-clean',
        drinks: [drink('cocktail:1', 'Paloma'), drink('cocktail:2', 'Old Fashioned')], also_at_bar: [] } },
    pieces: [piece('background'), piece('cocktail:1'), piece('cocktail:2')],
    brief: { theme: '', naming: '', notes: '', has_planner_image: false },
    diff: { added: [], dropped: [], brief_edited: [], image_changed: false, dismissed: false },
    print: { state: 'none', approved_at: null, approved_by_name: null, print_key: null, approved_file_in_use: false },
    cap: { used: 0, limit: 60, remaining: 60, resets_at: null },
    configured: { openai: true, gemini: false },
    plan: { id: 7, menu_style: 'custom', drink_count: 2 },
  };
}
const P = (mut) => { const p = base(); if (mut) mut(p); return p; };
const noDraft = (p) => { p.draft = null; p.pieces = []; p.diff = null; };

const resolved = () => jest.fn(() => Promise.resolve());
function fakeMenu(payload, over = {}) {
  return {
    payload, draft: payload ? payload.draft : null, loading: false, error: null, reconnecting: false,
    refetch: resolved(), layers: { 240: { background: 'blob:bg', 'cocktail:1': 'blob:c1', 'cocktail:2': 'blob:c2' } },
    plannerImages: {}, refreshPlannerImage: jest.fn(), activityKeys: [],
    save: { state: 'idle', savedAt: null, conflict: false }, retrySave: resolved(),
    brief: { planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true },
    generate: resolved(), sync: resolved(), dismissPlanChange: resolved(), ...over,
  };
}
const PROPOSAL = { id: 42, menu_print_key: null, menu_not_required: false };
const PLAN = { id: 7, selections: { companyLogo: '/api/drink-plans/t/7f1c/logo' } };
const mount = (menu, props = {}) => render(
  <MenuDesignerCard proposal={PROPOSAL} drinkPlan={PLAN} setDrinkPlan={jest.fn()} loadProposal={resolved()} menu={menu} {...props} />,
);
const top = (container) => ({
  chip: container.querySelector('.card-head .chip'),
  msg: container.querySelector('.md-card-msg'),
  sub: container.querySelector('.md-card-sub'),
  buttons: [...container.querySelectorAll('.md-card-actions button')].map((b) => b.textContent),
});

beforeAll(() => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    // ready never settles here, so the canvas's font refit never fires mid-test.
    value: { ready: new Promise(() => {}), load: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} },
  });
});
afterAll(() => { delete document.fonts; });
beforeEach(() => {
  window.innerWidth = 1280;
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
});
afterEach(() => { document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove()); });

// [row, payload, menu overrides, chip, message, sub, buttons without the editor, buttons with it]
const OCT_9 = shortDate(APPROVED_AT);
const approved = (p) => { p.print = { state: 'approved', approved_at: APPROVED_AT, approved_by_name: 'Dallas', print_key: 'k', approved_file_in_use: true }; };
const ROWS = [
  ["Couldn't load", null, { error: { message: 'Network error. Check your connection.' } }, 'Error', "Couldn't load the menu draft.", 'Network error. Check your connection.', ['Retry'], ['Retry']],
  ['Not set up', P((p) => { noDraft(p); p.configured.openai = false; }), {}, 'Not set up', "Menu art isn't set up.", "The AI key isn't on the server yet.", [], []],
  ['No plan', P((p) => { noDraft(p); p.plan = null; }), {}, 'No plan', 'No drink plan yet.', 'Menus are built from the drink plan.', [], []],
  ['No drinks', P((p) => { noDraft(p); p.plan.drink_count = 0; }), {}, 'No drinks', 'Nothing to put on a menu yet.', 'Drafts are built from the drink plan.', [], []],
  ['Never generated', P(noDraft), {}, 'Not started', 'Draft a custom 8×10 menu.', "From the drink plan and the client's menu notes.", ['Generate'], ['Generate', 'Open editor']],
  ['Generating', P((p) => { p.draft.content.words_status = 'working'; p.pieces = p.pieces.map((x) => piece(x.piece_key, 'pending')); }), {},
    'Drafting', 'Writing the words...', 'About 2 min. Keep working.', [], ['Watch']],
  ['Draft ready', P(), {}, 'Draft', 'Ready to review.', 'Saved', [], ['View']],
  ['Drawing failed', P((p) => { p.pieces[2] = piece('cocktail:2', 'failed'); }), {}, '1 drawing failed', "Old Fashioned didn't draw.", 'Re-roll it in the editor.', [], ['Fix', 'View']],
  ['Words failed', P((p) => { p.draft.content = { words_status: 'failed' }; }), {}, 'Words failed', "Couldn't write the menu text.", 'No images were used.', ['Generate again'], ['Generate again']],
  ['Plan changed', P((p) => { p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }]; }), {}, 'Plan changed', 'Cucumber Mule was added to the plan.',
    'Update the draft to include it.', ['Update draft', 'Dismiss'], ['Update draft', 'Dismiss']],
  ['Notes edited', P((p) => { p.diff.brief_edited = ['notes']; }), {}, 'Notes edited', 'Client edited their menu notes.', 'Review before approving.', [], ['Review', 'View']],
  ['Saving', P(), { save: { state: 'saving', savedAt: null, conflict: false } }, 'Draft', 'Ready to review.', 'Saving...', [], ['View']],
  ['Save failed', P(), { save: { state: 'failed', savedAt: null, conflict: false } }, 'Not saved', "Last change didn't save.", 'Edits are kept until you retry.', ['Retry'], ['Retry', 'View']],
  // Released (spec 2026-10-19 table C): View, and a ghost Download that needs no editor.
  ['Approved', P(approved), {}, 'Approved', 'Approved for print. Staff can download it.', `You released it ${OCT_9}.`, ['Download'], ['View', 'Download']],
  ['Edited since approval', P((p) => { approved(p); p.print.state = 'edited_since_approval'; }), {}, 'Edited since approval',
    `Staff still get the ${OCT_9} version.`, 'Approve again to update it.', [], ['Review & approve', 'View']],
  ['Replaced by upload', P((p) => { p.print = { state: 'replaced', print_key: 'up' }; }), {}, 'Not in use', 'Print file is a manual upload.', "This draft isn't what staff print.", [], ['View']],
  ['Print file removed', P((p) => { p.print = { state: 'removed' }; }), {}, 'No print file', 'Print file was removed.', 'Staff have nothing to print.', [], ['Review & approve', 'View']],
  ['No menu needed', P((p) => { noDraft(p); p.print.state = 'not_required'; }), {}, 'No menu needed', 'Marked no menu needed.', null, ['Undo'], ['Undo']],
];

describe('table C on the card', () => {
  test.each(ROWS)('%s', (row, payload, over, chip, msg, sub, plain, withEditor) => {
    const menu = fakeMenu(payload, over);
    const { container, unmount } = mount(menu);
    const t = top(container);
    expect(t.chip).toHaveTextContent(chip);
    expect(t.msg).toHaveTextContent(msg);
    if (sub === null) expect(t.sub).toBeNull(); else expect(t.sub).toHaveTextContent(sub);
    expect(t.buttons).toEqual(plain);
    unmount();
    const editor = mount(fakeMenu(payload, over), { onOpenEditor: jest.fn() });
    expect(top(editor.container).buttons).toEqual(withEditor);
  });

  test('Loading: no chip, a skeleton of the top half, and the fold already there', () => {
    const { container } = mount(fakeMenu(null, { loading: true }));
    expect(container.querySelector('.card-head .chip')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.getByText('Print file')).toBeInTheDocument();
    expect(screen.getByText('Client image')).toBeInTheDocument();
  });

  test('Generating shows its progress bar; the primary keeps its own style', () => {
    const { container } = mount(fakeMenu(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); })), { onOpenEditor: jest.fn() });
    expect(container.querySelector('.md-card-msg')).toHaveTextContent('Painting 3 of 3');
    expect(container.querySelector('.md-card-prog > div').style.width).toBe('75%');
    expect(screen.getByRole('button', { name: 'Watch' })).toHaveClass('btn', 'btn-ghost', 'btn-sm');
    const approvedCard = mount(fakeMenu(P(approved)), { onOpenEditor: jest.fn() });
    expect(within(approvedCard.container).getByRole('button', { name: 'View' })).toHaveClass('btn-secondary');
  });
});

describe('the editor actions', () => {
  test('open the editor with their tab when onOpenEditor is passed', () => {
    const onOpenEditor = jest.fn();
    mount(fakeMenu(P((p) => { p.pieces[2] = piece('cocktail:2', 'failed'); })), { onOpenEditor });
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(onOpenEditor).toHaveBeenLastCalledWith({ tab: 'drinks', select: 'cocktail:2' });
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(onOpenEditor).toHaveBeenLastCalledWith({});
  });

  test('the thumbnail: the menu at 0.12 from the ?w=240 layers, opening nothing without onOpenEditor', () => {
    const { container } = mount(fakeMenu(P()));
    const frame = container.querySelector('.md-thumb .mc-frame');
    expect(frame.style.width).toBe('96px');
    expect(frame.style.height).toBe('120px');
    expect(container.querySelector('.md-thumb img[data-mc-layer="background"]')).toHaveAttribute('src', 'blob:bg');
    expect(screen.queryByRole('button', { name: 'Open the bar menu editor' })).toBeNull();
    expect(container.querySelector('.md-thumb button')).toBeNull();
  });

  test('the thumbnail opens the editor once onOpenEditor is passed; with no draft it is the dashed 8 × 10 box', () => {
    const onOpenEditor = jest.fn();
    mount(fakeMenu(P()), { onOpenEditor });
    fireEvent.click(screen.getByRole('button', { name: 'Open the bar menu editor' }));
    expect(onOpenEditor).toHaveBeenCalledWith({});
    const empty = mount(fakeMenu(P(noDraft)), { onOpenEditor });
    expect(within(empty.container).getByText('8 × 10')).toHaveClass('md-thumb-empty');
  });

  test('below 900 px the editor actions give way to the note; in-place actions stay', () => {
    window.innerWidth = 800;
    const onOpenEditor = jest.fn();
    const { container } = mount(fakeMenu(P((p) => { p.diff.added = [{ key: 'x', name: 'X' }]; })), { onOpenEditor });
    expect(screen.getByText('Edit the menu on a wider screen.')).toBeInTheDocument();
    expect(top(container).buttons).toEqual(['Update draft', 'Dismiss']);
    expect(container.querySelector('.md-thumb button')).toBeNull();
    act(() => { window.innerWidth = 1280; window.dispatchEvent(new Event('resize')); });
    expect(screen.queryByText('Edit the menu on a wider screen.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the bar menu editor' })).toBeInTheDocument();
  });
});

describe('the in-place actions draw with the default image model', () => {
  test('Generate, Retry, Update draft and Dismiss', async () => {
    let menu = fakeMenu(P(noDraft));
    const { unmount } = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledWith({ imageModel: 'openai' }));
    unmount();
    menu = fakeMenu(P((p) => { p.draft.content = { words_status: 'failed' }; }));
    const retry = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledWith({ imageModel: 'openai' }));
    retry.unmount();
    menu = fakeMenu(P((p) => { p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; }));
    mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    await waitFor(() => expect(menu.sync).toHaveBeenCalledWith({ imageModel: 'openai' }));
    // One action at a time: the row is held until Update draft settles.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(menu.dismissPlanChange).toHaveBeenCalled());
  });

  // Spec 2026-10-19 section 16 (lane menu-words-claude): the card draws with
  // the read model's default image model, and Not set up reads the words key.
  test('with no OpenAI key, the words key and Gemini set: no Not set up, and every action draws with the default, Gemini', async () => {
    const claudeOnGemini = (p) => { p.configured = { openai: false, gemini: true, words: true, default_image_model: 'gemini' }; };
    let menu = fakeMenu(P((p) => { noDraft(p); claudeOnGemini(p); }));
    const { container, unmount } = mount(menu);
    expect(top(container).chip).toHaveTextContent('Not started');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledWith({ imageModel: 'gemini' }));
    unmount();
    menu = fakeMenu(P((p) => { claudeOnGemini(p); p.draft.content = { words_status: 'failed' }; }));
    const retry = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledWith({ imageModel: 'gemini' }));
    retry.unmount();
    menu = fakeMenu(P((p) => { claudeOnGemini(p); p.diff.dropped = [{ key: 'cocktail:2', name: 'Old Fashioned' }]; }));
    mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    await waitFor(() => expect(menu.sync).toHaveBeenCalledWith({ imageModel: 'gemini' }));
  });

  test('Not set up follows the words key, not the OpenAI key', () => {
    const { container } = mount(fakeMenu(P((p) => { noDraft(p); p.configured = { openai: true, gemini: true, words: false, default_image_model: 'gemini' }; })));
    expect(top(container).chip).toHaveTextContent('Not set up');
    expect(top(container).buttons).toEqual([]);
  });

  test('a running action holds the row under its own label, and its refusal shows as one alert line', async () => {
    let fail;
    const menu = fakeMenu(P(noDraft), { generate: jest.fn(() => new Promise((_, reject) => { fail = reject; })) });
    mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled();
    await act(async () => { fail({ status: 429, code: 'MENU_ART_CAP_REACHED', message: 'Daily menu art limit reached.' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('Daily menu art limit reached.');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  test('Generate is held when the images it needs exceed what is left, saying why in its title', () => {
    mount(fakeMenu(P((p) => { noDraft(p); p.cap.remaining = 1; })));
    const g = screen.getByRole('button', { name: 'Generate' });
    expect(g).toBeDisabled();
    expect(g).toHaveAttribute('title', 'Needs 3 images; 1 left in the last 24 hours.');
  });

  test("Undo clears no menu needed and reloads the proposal and the draft; Retry reloads or re-saves", async () => {
    const loadProposal = resolved();
    let menu = fakeMenu(P((p) => { noDraft(p); p.print.state = 'not_required'; }));
    const { unmount } = mount(menu, { loadProposal, proposal: { ...PROPOSAL, menu_not_required: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(menu.refetch).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-print', { not_required: false });
    expect(loadProposal).toHaveBeenCalled();
    unmount();
    menu = fakeMenu(null, { error: { message: 'Network error.' } });
    const again = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(menu.refetch).toHaveBeenCalled());
    again.unmount();
    menu = fakeMenu(P(), { save: { state: 'failed', savedAt: null, conflict: false } });
    mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(menu.retrySave).toHaveBeenCalled());
  });

  test('a quiet reconnecting note while the poll backs off', () => {
    mount(fakeMenu(P(), { reconnecting: true }));
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
  });
});

describe('the fold', () => {
  test('keeps working when the draft GET fails', async () => {
    const loadProposal = resolved();
    const menu = fakeMenu(null, { error: { message: 'Network error.' } });
    mount(menu, { loadProposal });
    expect(screen.getByText("Couldn't load the menu draft.")).toBeInTheDocument();
    expect(screen.getByText('None yet')).toBeInTheDocument();
    expect(screen.getByText('Logo on top')).toBeInTheDocument();
    const file = new File(['x'], 'menu.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('menu-print-input'), { target: { files: [file] } });
    await waitFor(() => expect(loadProposal).toHaveBeenCalled());
    expect(api.post.mock.calls[0][0]).toBe('/proposals/42/menu-print');
    expect(menu.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getAllByTitle('More actions')[0]);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'No menu needed for this event' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/proposals/42/menu-print', { not_required: true }));
    await waitFor(() => expect(screen.getByText('None yet')).toBeInTheDocument());
  });

  test("reads the role from the draft and refetches the draft and its image after a client-image change", async () => {
    api.delete.mockResolvedValue({ data: { selections: {} } });
    const setDrinkPlan = jest.fn();
    const menu = fakeMenu(P((p) => { p.draft.inputs.planner_image_role = 'reference'; p.brief.has_planner_image = true; }),
      { plannerImages: { 240: 'blob:planner' } });
    const { container } = mount(menu, { setDrinkPlan });
    expect(screen.getByText('Style reference')).toBeInTheDocument();
    expect(container.querySelector('.md-fold-img img')).toHaveAttribute('src', 'blob:planner');
    fireEvent.click(screen.getAllByTitle('More actions')[1]);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(menu.refreshPlannerImage).toHaveBeenCalled());
    expect(menu.refetch).toHaveBeenCalled();
    expect(setDrinkPlan).toHaveBeenCalled();
  });
});

describe('the review fixes', () => {
  const never = () => new Promise(() => {});

  test('each in-place action has its own busy label', () => {
    const cases = [
      [P((p) => { p.diff.added = [{ key: 'x', name: 'X' }]; }), {}, 'Update draft', 'Updating...', 'sync'],
      [P((p) => { p.diff.added = [{ key: 'x', name: 'X' }]; }), {}, 'Dismiss', 'Dismissing...', 'dismissPlanChange'],
      [P((p) => { p.draft.content = { words_status: 'failed' }; }), {}, 'Generate again', 'Generating...', 'generate'],
      [P(), { save: { state: 'failed', savedAt: null, conflict: false } }, 'Retry', 'Retrying...', 'retrySave'],
    ];
    for (const [payload, over, label, busy, fn] of cases) {
      const { unmount } = mount(fakeMenu(payload, { ...over, [fn]: jest.fn(never) }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('button', { name: busy })).toBeDisabled();
      unmount();
    }
    api.patch.mockReturnValue(never());
    mount(fakeMenu(P((p) => { noDraft(p); p.print.state = 'not_required'; })));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Undoing...' })).toBeDisabled();
  });

  test("the error line reads field errors, and Undo's falls back to the old card's words", async () => {
    let menu = fakeMenu(P(noDraft), { generate: jest.fn(() => Promise.reject({ status: 400, message: 'Invalid.', fieldErrors: { reference: 'The reference must be one JPG, PNG or WebP image.' } })) });
    const { unmount } = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The reference must be one JPG, PNG or WebP image.');
    unmount();
    api.patch.mockRejectedValue({ status: 500 });
    menu = fakeMenu(P((p) => { noDraft(p); p.print.state = 'not_required'; }));
    mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update the menu status.');
  });

  test('the error line clears once the card moves to another state', async () => {
    const menu = fakeMenu(P(noDraft), { generate: jest.fn(() => Promise.reject({ status: 429, message: 'Daily menu art limit reached.' })) });
    const { rerender } = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Daily menu art limit reached.');
    const next = fakeMenu(P());
    rerender(<MenuDesignerCard proposal={PROPOSAL} drinkPlan={PLAN} setDrinkPlan={jest.fn()} loadProposal={resolved()} menu={next} />);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('the thumbnail shows the drawing states, as the design does', () => {
    const { container } = mount(fakeMenu(P((p) => { p.pieces[1] = piece('cocktail:1', 'working'); p.pieces[2] = piece('cocktail:2', 'failed'); })));
    const states = [...container.querySelectorAll('.md-thumb .mc-slot-st')].map((el) => el.textContent);
    expect(states).toEqual(['Painting...', "Couldn't draw this one"]);
  });

  test('the thumbnail logo falls back to a safe companyLogo when the image blob is not there', () => {
    const { container } = mount(fakeMenu(P((p) => { p.brief.has_planner_image = true; }), { plannerImages: {} }));
    expect(container.querySelector('.md-thumb img[data-mc-layer="logo"]')).toHaveAttribute('src', PLAN.selections.companyLogo);
  });

  test('a11y: the progress bar, the reconnecting status and a visible reason for a held Generate', () => {
    const { container, unmount } = mount(fakeMenu(P((p) => { p.pieces[2] = piece('cocktail:2', 'working'); }), { reconnecting: true }));
    const bar = screen.getByRole('progressbar', { name: 'Drafting progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    expect(container.querySelector('[role="status"]')).toHaveTextContent('Reconnecting...');
    unmount();
    mount(fakeMenu(P((p) => { noDraft(p); p.cap.remaining = 1; })));
    expect(screen.getByText('Needs 3 images; 1 left in the last 24 hours.')).toHaveClass('md-card-note');
  });
});

test('an unsafe companyLogo is never the thumbnail fallback', () => {
  const plan = { id: 7, selections: { companyLogo: 'javascript:alert(1)' } };
  const { container } = render(
    <MenuDesignerCard proposal={PROPOSAL} drinkPlan={plan} setDrinkPlan={jest.fn()} loadProposal={resolved()}
      menu={fakeMenu(P((p) => { p.brief.has_planner_image = true; }), { plannerImages: {} })} />,
  );
  expect(container.querySelector('.md-thumb img[data-mc-layer="logo"]')).toBeNull();
  expect(container.querySelector('.md-thumb [data-mc-pending="logo"]')).toBeInTheDocument();
  expect(container.innerHTML).not.toContain('javascript:');
});


// v2 spec 9.1 and 9.2 (lane menu-house-card): before a draft the card reads the
// look its own Generate will post, from the page hook's held brief and
// reference file (the look and the admin brief typed in the editor before a
// draft exists), as the editor does, so its words, image count and gate match
// the run it starts.
describe('before a draft, the card reads the held brief its Generate posts', () => {
  const held = { planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true };
  const ready = (mut) => P((p) => { noDraft(p); p.plan.house_plain = true; if (mut) mut(p); });

  test('a custom look chosen in the editor: the custom run, its image count holding Generate at the cap', () => {
    const menu = fakeMenu(ready((p) => { p.cap.remaining = 2; }), { brief: { ...held, look: 'custom' } });
    const { container } = mount(menu);
    expect(top(container).msg).toHaveTextContent('Draft a custom 8×10 menu.');
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.getByText('Needs 3 images; 2 left in the last 24 hours.')).toHaveClass('md-card-note');
  });

  test('a house look chosen in the editor over a client brief: the plain house card, which needs no key', () => {
    const menu = fakeMenu(ready((p) => { p.brief.theme = 'Navy and gold'; p.configured = { openai: false, gemini: false, words: false }; }),
      { brief: { ...held, look: 'house' } });
    const { container } = mount(menu);
    expect(top(container).chip).toHaveTextContent('Not started');
    expect(top(container).msg).toHaveTextContent('Draft the house card.');
    const gen = screen.getByRole('button', { name: 'Generate' });
    expect(gen).toBeEnabled();
    fireEvent.click(gen);
    expect(menu.generate).toHaveBeenCalledTimes(1);
  });

  test('art direction typed, or a reference file held, in the editor reads as the custom design', () => {
    const { container, unmount } = mount(fakeMenu(ready(), { brief: { ...held, art_direction: 'Moody speakeasy' } }));
    expect(top(container).msg).toHaveTextContent('Draft a custom 8×10 menu.');
    unmount();
    const file = mount(fakeMenu(ready(), { brief: held, referenceFile: { name: 'ref.png' } }));
    expect(top(file.container).msg).toHaveTextContent('Draft a custom 8×10 menu.');
  });
});

// ── The client review on the card (spec 2026-10-19 sections 10.3, 10.5 and 14; lane menu-approve-send) ──

describe('the client review on the card', () => {
  const SENT = '2026-11-10T17:00:00Z';
  const URL_ = 'https://drbartender.com/menu-proof/11111111-2222-4333-8444-555555555555';
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const proof = (over = {}) => ({ id: 77, state: 'open', url: URL_, sent_at: SENT, email_status: 'sent', expired: false, stale: false,
    answer: null, answer_note: null, answered_at: null, withdrawn_at: null, history: [], ...over });
  const held = (over = {}) => (p) => {
    p.print = { state: 'held', held: true, live: 'none', approved_at: SENT, approved_version: 3, approved_art_version: 4, print_key: null, approved_file_in_use: false };
    p.proof = proof(over);
  };
  const dialog = () => screen.getByRole('dialog');
  const proposalOn = (eventDate) => ({ ...PROPOSAL, event_date: eventDate });
  const writeText = jest.fn();
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  test('Waiting on the client: Release for printing confirms, reads Releasing... while it posts the pair, then refetches', async () => {
    let finish;
    api.post.mockImplementation(() => new Promise((r) => { finish = r; }));
    const menu = fakeMenu(P(held()));
    const loadProposal = resolved();
    const { container } = mount(menu, { proposal: proposalOn(day(10)), loadProposal });
    expect(top(container).buttons).toEqual(['Release for printing', 'Copy link']);
    expect(screen.getByRole('button', { name: 'Release for printing' })).toHaveClass('btn', 'btn-secondary', 'btn-sm');
    fireEvent.click(screen.getByRole('button', { name: 'Release for printing' }));
    expect(within(dialog()).getByText('Release for printing?')).toBeInTheDocument();
    expect(within(dialog()).getByText('Staff will be able to download and print this menu now, without waiting for the client.')).toBeInTheDocument();
    expect(dialog().closest('.md-cf-page')).not.toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    // The approved pair and the proof the card showed (MENU_PROOF_CHANGED when the client answered since).
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release', { version: 3, art_version: 4, seen_proof_id: 77, seen_proof_answer: '' });
    expect(screen.getByRole('button', { name: 'Releasing...' })).toBeDisabled();
    expect(within(container.querySelector('.md-fold')).getByText('Releasing...')).toBeInTheDocument();
    await act(async () => { finish({ data: {} }); });
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
    expect(loadProposal).toHaveBeenCalledTimes(1);
  });

  test('after the event day the confirm names the $5 duty and the post carries after_event true', async () => {
    mount(fakeMenu(P(held())), { proposal: proposalOn(`${day(-3)}T00:00:00.000Z`) });
    fireEvent.click(screen.getByRole('button', { name: 'Release for printing' }));
    expect(within(dialog()).getByText('This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.'))
      .toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release',
      { version: 3, art_version: 4, seen_proof_id: 77, seen_proof_answer: '', after_event: true }));
  });

  test('the landed after-event release says what happened to the duty in one status line, until the next action', async () => {
    api.post.mockResolvedValue({ data: { duty: 'not_added' } });
    const { container } = mount(fakeMenu(P(held())), { proposal: proposalOn(`${day(-3)}T00:00:00.000Z`) });
    fireEvent.click(screen.getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    const line = await screen.findByText("Released. This event's pay period is closed, so no print duty was added.");
    expect(line).toHaveAttribute('role', 'status');
    expect(line.closest('.md-card-text')).not.toBeNull();
    await act(async () => { fireEvent.click(within(container.querySelector('.md-card-actions')).getByRole('button', { name: 'Copy link' })); });
    expect(screen.queryByText("Released. This event's pay period is closed, so no print duty was added.")).toBeNull();
  });

  test.each([
    ['LEGAL_HOLD', "This event is on hold and can't be changed."],
    ['MENU_MARKED_NONE', 'This event is marked as needing no printed menu. Clear the mark first.'],
    ['MENU_PRINT_CHANGED', 'A different print file is live now. Refresh to see it.'],
    ['MENU_DRAFT_CHANGED', "That didn't go through. Try again."],
    ['MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
  ])('a 409 %s on release: its line in an alert, and the card refetches', async (code, line) => {
    api.post.mockRejectedValue({ status: 409, code, message: 'server words' });
    const menu = fakeMenu(P(held()));
    mount(menu, { proposal: proposalOn(day(10)) });
    fireEvent.click(screen.getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(menu.refetch).toHaveBeenCalledTimes(1);
  });

  test('a 409 MENU_NOT_HELD refetches and says nothing', async () => {
    api.post.mockRejectedValue({ status: 409, code: 'MENU_NOT_HELD', message: 'x' });
    const menu = fakeMenu(P(held()));
    mount(menu, { proposal: proposalOn(day(10)) });
    fireEvent.click(screen.getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test("the ghost Copy link copies the proof's link and reads Copied", async () => {
    mount(fakeMenu(P(held())), { proposal: proposalOn(day(10)) });
    await act(async () => { fireEvent.click(within(document.querySelector('.md-card-actions')).getByRole('button', { name: 'Copy link' })); });
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(within(document.querySelector('.md-card-actions')).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  test("Client asked for changes: Read notes opens the editor's Brief tab; a ghost Release for printing", () => {
    const onOpenEditor = jest.fn();
    const { container } = mount(fakeMenu(P(held({ state: 'changes', answer: 'changes', answer_note: 'More gin.', answered_at: SENT }))), { onOpenEditor });
    const t = top(container);
    expect(t.chip).toHaveTextContent('Changes requested');
    expect(t.sub).toHaveTextContent('More gin.');
    expect(t.buttons).toEqual(['Read notes', 'Release for printing']);
    expect(screen.getByRole('button', { name: 'Release for printing' })).toHaveClass('btn-ghost');
    fireEvent.click(screen.getByRole('button', { name: 'Read notes' }));
    expect(onOpenEditor).toHaveBeenCalledWith({ tab: 'brief' });
  });

  test('Released: the ghost Download reads the print file back', async () => {
    downloadMenuPrint.mockResolvedValue();
    mount(fakeMenu(P(approved)));
    fireEvent.click(within(document.querySelector('.md-card-actions')).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadMenuPrint).toHaveBeenCalledWith('/proposals/42/menu-print'));
  });

  test('Print file removed: Put it back for staff confirms and posts the release route', async () => {
    api.post.mockResolvedValue({ data: {} });
    mount(fakeMenu(P((p) => { p.print = { state: 'removed', restorable: true, approved_version: 3, approved_art_version: 4, print_key: null }; })),
      { proposal: proposalOn(day(10)) });
    fireEvent.click(screen.getByRole('button', { name: 'Put it back for staff' }));
    expect(within(dialog()).getByText('Put this menu back for staff?')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Put it back for staff' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release',
      { version: 3, art_version: 4, seen_proof_id: '', seen_proof_answer: '' }));
  });

  test('a change request on a released menu: Close request from the Client review row, its confirm and Closing...', async () => {
    let finish;
    api.post.mockImplementation(() => new Promise((r) => { finish = r; }));
    const menu = fakeMenu(P((p) => { approved(p); p.proof = proof({ state: 'changes', answer: 'changes', answer_note: 'x', answered_at: SENT }); }));
    const { container } = mount(menu);
    const row = screen.getByText('Client review').closest('.md-fold-row');
    fireEvent.click(within(row).getByTitle('More actions'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close request' }));
    expect(within(dialog()).getByText('Close this request?')).toBeInTheDocument();
    expect(within(dialog()).getByText("The menu stays as it is for staff. The client's link will say the menu is no longer open for review.")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close request' }));
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/proof/close', { proof_id: 77 });
    expect(within(container.querySelector('.md-fold')).getByText('Closing...')).toBeInTheDocument();
    await act(async () => { finish({ data: {} }); });
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
  });

  test("Close request that fails says That didn't go through. Try again.", async () => {
    api.post.mockRejectedValue({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
    mount(fakeMenu(P((p) => { approved(p); p.proof = proof({ state: 'changes', answer: 'changes', answered_at: SENT }); })));
    const row = screen.getByText('Client review').closest('.md-fold-row');
    fireEvent.click(within(row).getByTitle('More actions'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close request' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
  });

  test('the fold kebab Release for printing asks the same confirm', () => {
    mount(fakeMenu(P(held())), { proposal: proposalOn(day(10)) });
    const row = screen.getByText('Client review').closest('.md-fold-row');
    expect(within(row).getByText(`Sent ${shortDate(SENT)}`)).toBeInTheDocument();
    fireEvent.click(within(row).getByTitle('More actions'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Release for printing' }));
    expect(within(dialog()).getByText('Release for printing?')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  // The pressed trigger is disabled, then gone, by the time the action lands.
  test("after a review action settles, focus moves to the card's heading, never the page body", async () => {
    let finish;
    api.post.mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(fakeMenu(P(held())), { proposal: proposalOn(day(10)) });
    const trigger = screen.getByRole('button', { name: 'Release for printing' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await act(async () => { finish({ data: {} }); });
    const heading = screen.getByRole('heading', { name: 'Bar menu' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading).toHaveAttribute('tabindex', '-1');
  });
});
