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
  ['Words failed', P((p) => { p.draft.content = { words_status: 'failed' }; }), {}, 'Words failed', "Couldn't write the menu text.", 'No images were used.', ['Retry'], ['Retry']],
  ['Plan changed', P((p) => { p.diff.added = [{ key: 'custom:mule', name: 'Cucumber Mule' }]; }), {}, 'Plan changed', 'Cucumber Mule was added to the plan.',
    'Update the draft to include it.', ['Update draft', 'Dismiss'], ['Update draft', 'Dismiss']],
  ['Notes edited', P((p) => { p.diff.brief_edited = ['notes']; }), {}, 'Notes edited', 'Client edited their menu notes.', 'Review before approving.', [], ['Review', 'View']],
  ['Saving', P(), { save: { state: 'saving', savedAt: null, conflict: false } }, 'Draft', 'Ready to review.', 'Saving...', [], ['View']],
  ['Save failed', P(), { save: { state: 'failed', savedAt: null, conflict: false } }, 'Not saved', "Last change didn't save.", 'Edits are kept until you retry.', ['Retry'], ['Retry', 'View']],
  ['Approved', P(approved), {}, 'Approved', 'Print file ready for staff.', `Approved ${OCT_9} by Dallas`, [], ['View']],
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

describe('the in-place actions draw with GPT Image', () => {
  test('Generate, Retry, Update draft and Dismiss', async () => {
    let menu = fakeMenu(P(noDraft));
    const { unmount } = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(menu.generate).toHaveBeenCalledWith({ imageModel: 'openai' }));
    unmount();
    menu = fakeMenu(P((p) => { p.draft.content = { words_status: 'failed' }; }));
    const retry = mount(menu);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
      [P((p) => { p.draft.content = { words_status: 'failed' }; }), {}, 'Retry', 'Retrying...', 'generate'],
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

