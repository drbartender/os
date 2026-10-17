import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import html2canvas from 'html2canvas';
import MenuEditor from './MenuEditor';
import api from '../../../utils/api';
import { ensureFontsLink } from './fontPairings';
import { FULL_SIZE } from './useMenuDraft';

// Approve through the editor (spec 2026-10-01 sections 8, Approve 1, Confirm
// before replacing, the rendered-logo check; 11.1; 12; plan Task D3): flush,
// then export from the hidden canvas, then the POST with version, art_version,
// expected_print_key and the logo's rev; the replace confirm; the "Couldn't
// approve." banner keyed on the code; client Sentry on an export failure.
// MenuCanvas is a stand-in whose layer images read as already loaded (the
// waits themselves are exportMenu.test.js); html2canvas is mocked.

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../../../utils/downloadMenuPrint', () => ({ downloadMenuPrint: jest.fn() }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));
jest.mock('html2canvas', () => ({ __esModule: true, default: jest.fn() }));
const mockPrefs = { prefs: { sidebar: 'full' }, setPref: jest.fn(), sidebarOverride: null, setSidebarOverride: jest.fn() };
jest.mock('../../../context/UserPrefsContext', () => ({ useUserPrefs: () => mockPrefs }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockCanvas = { freezeLogo: false };
jest.mock('./MenuCanvas', () => {
  const R = require('react');
  const ready = (el) => {
    if (!el) return;
    Object.defineProperty(el, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(el, 'naturalWidth', { configurable: true, get: () => 100 });
  };
  const Fake = R.forwardRef(function FakeCanvas({ editable, layers, plannerImage, inputs, onPatch }, ref) {
    const logo = plannerImage && ((inputs && inputs.planner_image_role) || 'logo') === 'logo';
    // freezeLogo: an instance that has not caught up with a newer logo yet.
    const first = R.useRef(plannerImage && plannerImage.url);
    const logoUrl = mockCanvas.freezeLogo ? first.current : plannerImage && plannerImage.url;
    return (
      <div ref={ref} className="mc-fake" data-editable={String(!!editable)}>
        {editable && (
          <div data-mc-k="title" contentEditable="true" suppressContentEditableWarning tabIndex={0}
            onBlur={(e) => onPatch({ content: { title: e.currentTarget.textContent } })}>Bar Menu</div>
        )}
        {Object.entries(layers || {}).map(([k, url]) => <img key={k} ref={ready} alt="" data-mc-layer={k} src={url} />)}
        {logo && (logoUrl ? <img ref={ready} alt="" data-mc-layer="logo" src={logoUrl} /> : <div data-mc-pending="logo" />)}
        <img ref={ready} alt="" data-mc-layer="avatar" src="/images/menu-mark-avatar.png" />
        <img ref={ready} alt="" data-mc-layer="wordmark" src="data:image/png;base64,TINT" />
      </div>
    );
  });
  return { __esModule: true, default: Fake };
});

const APPROVED_AT = '2026-10-09T17:00:00Z';
const DAY = new Date(APPROVED_AT).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const drink = (key, name) => ({ key, display_name: name, description: 'Tart.', group: 'sig', hidden: false, has_art: true });
const piece = (key) => ({ piece_key: key, status: 'done', has_image: true, image_rev: `rev-${key}`, error: null, provider: 'openai' });
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
const FULL_LAYERS = { background: 'blob:bg', 'cocktail:1': 'blob:c1', 'cocktail:2': 'blob:c2' };
function fakeMenu(payload, over = {}) {
  return {
    proposalId: '42', payload, draft: payload ? payload.draft : null, loading: false, error: null, reconnecting: false,
    refetch: resolved(), layers: { 240: {}, [FULL_SIZE]: FULL_LAYERS }, plannerImages: {}, plannerImageRevs: {},
    wantSize: jest.fn(() => () => {}), refreshPlannerImage: jest.fn(), activityKeys: [],
    edit: jest.fn(), flush: resolved(), retrySave: resolved(), save: { state: 'idle', savedAt: null, conflict: false },
    clearConflict: jest.fn(), brief: { planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true },
    setBrief: jest.fn(), referenceFile: null, setReferenceFile: jest.fn(), imageModel: 'openai', setImageModel: jest.fn(),
    generate: resolved(), sync: resolved(), dismissPlanChange: resolved(), reroll: resolved(), ...over,
  };
}
const PROPOSAL = { id: 42, client_name: 'Roscoe' };
const tree = (menu, loadProposal) => (
  <MenuEditor editor={{ view: {}, close: jest.fn() }} menu={menu} proposal={PROPOSAL} eventLabel="Roscoe · Wedding" loadProposal={loadProposal} />
);
const approveBtn = () => screen.getByRole('button', { name: /^(Approve|Approve again|Use as print file|Approving\.\.\.|Approved)$/ });
const posted = () => api.post.mock.calls[0][1];
const bannerText = (id) => {
  const b = document.querySelector(`.md-banner[data-banner="${id}"]`);
  return b ? `${b.querySelector('.md-banner-title').textContent} ${b.querySelector('.md-banner-text').textContent}` : null;
};
const okCanvas = () => ({ width: 2400, height: 3000, toBlob: (cb, type) => cb(new Blob(['jpg'], { type })) });

let order;
beforeAll(() => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve(), load: () => Promise.resolve([{ status: 'loaded' }]), addEventListener() {}, removeEventListener() {} },
  });
});
afterAll(() => { delete document.fonts; });
beforeEach(() => {
  order = [];
  mockCanvas.freezeLogo = false;
  window.innerWidth = 1440;
  window.innerHeight = 900;
  // The pairing's stylesheet has landed (the preview has been using it).
  ensureFontsLink(['modern-clean']).setAttribute('data-loaded', 'true');
  html2canvas.mockImplementation((node) => { order.push(['export', node]); return Promise.resolve(okCanvas()); });
  api.post.mockImplementation((url) => { order.push(['post', url]); return Promise.resolve({ data: { version: 3, art_version: 4, print: {} } }); });
});
afterEach(() => { document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove()); });

test('flush, then the export from the hidden canvas, then the POST, then both refetch', async () => {
  const loadProposal = resolved();
  let finishFlush;
  const menu = fakeMenu(P(), {
    save: { state: 'saving', savedAt: null, conflict: false },
    flush: jest.fn(() => { order.push(['flush']); return new Promise((r) => { finishFlush = r; }); }),
  });
  const { container } = render(tree(menu, loadProposal));
  // A pending save is flushed first, not a reason to disable.
  expect(approveBtn()).toBeEnabled();
  fireEvent.click(approveBtn());
  expect(approveBtn()).toHaveTextContent('Approving...');
  expect(approveBtn()).toBeDisabled();
  expect(container.querySelector('.md-ed-top .chip').textContent).toBe('Approving');
  expect(container.querySelector('.md-ed-save').textContent).toBe('Approving...');
  // The preview is not editable while it approves.
  expect(container.querySelector('.md-ed-canvas, .mc-fake')).toHaveAttribute('data-editable', 'false');
  await act(async () => {});
  expect(order.map((o) => o[0])).toEqual(['flush']);
  await act(async () => { finishFlush(); });
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(order.map((o) => o[0])).toEqual(['flush', 'export', 'post']);
  // Rendered from the hidden, unscaled instance, never the preview.
  expect(order[1][1].closest('.md-export')).not.toBeNull();
  expect(html2canvas).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scale: 3 }));
  expect(api.post.mock.calls[0][0]).toBe('/proposals/42/menu-draft/approve');
  const form = posted();
  expect(form.get('version')).toBe('3');
  expect(form.get('art_version')).toBe('4');
  expect(form.get('expected_print_key')).toBe('');
  // The logo role with no planner image: rendered with no logo.
  expect(form.get('expected_planner_image_rev')).toBe('');
  expect(form.get('file').type).toBe('image/jpeg');
  await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
  expect(loadProposal).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve'));
  expect(container.querySelector('.md-export')).toBeNull();
});

test('the versions posted are the draft as saved (read after the flush lands)', async () => {
  let finishFlush;
  const before = fakeMenu(P(), { flush: jest.fn(() => new Promise((r) => { finishFlush = r; })) });
  const { rerender } = render(tree(before, resolved()));
  fireEvent.click(approveBtn());
  // The hook's PATCH lands and the page re-renders with version 4 before flush resolves.
  const after = fakeMenu(P((p) => { p.draft.version = 4; }), { flush: before.flush });
  rerender(tree(after, resolved()));
  await act(async () => { finishFlush(); });
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(posted().get('version')).toBe('4');
});

test('the logo actually drawn is posted back as expected_planner_image_rev; another role posts none', async () => {
  const withLogo = (role) => fakeMenu(P((p) => {
    p.brief.has_planner_image = true;
    p.brief.planner_image_rev = 'ffffffffffffffff';
    p.draft.inputs.planner_image_role = role;
  }), { plannerImages: { [FULL_SIZE]: 'blob:logo-full' }, plannerImageRevs: { [FULL_SIZE]: '0123456789abcdef' } });
  const a = render(tree(withLogo('logo'), resolved()));
  fireEvent.click(approveBtn());
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(posted().get('expected_planner_image_rev')).toBe('0123456789abcdef');
  expect(order[0][1].querySelector('img[data-mc-layer="logo"]').getAttribute('src')).toBe('blob:logo-full');
  await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve'));
  a.unmount();
  api.post.mockClear();
  render(tree(withLogo('reference'), resolved()));
  fireEvent.click(approveBtn());
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(posted().has('expected_planner_image_rev')).toBe(false);
});

describe('the replace confirm, whenever a print file exists', () => {
  test('over an earlier approval: its text, Cancel posts nothing, Replace and approve posts that key', async () => {
    const menu = fakeMenu(P((p) => {
      p.print = { state: 'edited_since_approval', approved_at: APPROVED_AT, print_key: 'menu-print/42/a.jpg', approved_file_in_use: true };
    }));
    render(tree(menu, resolved()));
    fireEvent.click(approveBtn());
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Replace the print file?')).toBeInTheDocument();
    expect(within(dialog).getByText(`Staff will download this version instead of the one approved ${DAY}.`)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(menu.flush).not.toHaveBeenCalled();
    fireEvent.click(approveBtn());
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace and approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(posted().get('expected_print_key')).toBe('menu-print/42/a.jpg');
  });

  test('over a manual upload: its text', () => {
    render(tree(fakeMenu(P((p) => { p.print = { state: 'replaced', print_key: 'menu-print/42/m.pdf', approved_file_in_use: false }; })), resolved()));
    expect(approveBtn()).toHaveTextContent('Use as print file');
    fireEvent.click(approveBtn());
    expect(screen.getByText('Staff currently download a manual upload. Approving makes this draft the print file instead.')).toBeInTheDocument();
  });

  test('with no print file there is no confirm', async () => {
    render(tree(fakeMenu(P()), resolved()));
    fireEvent.click(approveBtn());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });

  test('the key posted is the one confirmed over, not one a later poll brought in', async () => {
    const mut = (key) => (p) => { p.print = { state: 'replaced', print_key: key, approved_file_in_use: false }; };
    const { rerender } = render(tree(fakeMenu(P(mut('menu-print/42/one.pdf'))), resolved()));
    fireEvent.click(approveBtn());
    rerender(tree(fakeMenu(P(mut('menu-print/42/two.pdf'))), resolved()));
    fireEvent.click(screen.getByRole('button', { name: 'Replace and approve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(posted().get('expected_print_key')).toBe('menu-print/42/one.pdf');
  });
});

describe("a refusal: the Couldn't approve. banner, keyed on the code", () => {
  test.each([
    ['MENU_PRINT_CHANGED', 'The print file changed since you confirmed. Check it and approve again.'],
    ['MENU_DRAFT_CHANGED', 'The draft changed. Approve again.'],
    ['MENU_WORDS_PENDING', 'The menu words are still being written. Try again once they land.'],
    ['MENU_WORDS_NOT_WRITTEN', 'The menu words were not written. Start over to write them.'],
  ])('409 %s shows its reason and refetches both', async (code, text) => {
    api.post.mockImplementation(() => Promise.reject({ status: 409, code, message: 'Server words the client never keys on.' }));
    const loadProposal = resolved();
    const menu = fakeMenu(P());
    render(tree(menu, loadProposal));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).toBe(`Couldn't approve. ${text}`));
    expect(menu.refetch).toHaveBeenCalledTimes(1);
    expect(loadProposal).toHaveBeenCalledTimes(1);
    expect(approveBtn()).toHaveTextContent('Approve');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the next Approve clears the old reason', async () => {
    api.post.mockImplementationOnce(() => Promise.reject({ status: 409, code: 'MENU_DRAFT_CHANGED' }));
    render(tree(fakeMenu(P()), resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).not.toBeNull());
    fireEvent.click(approveBtn());
    expect(bannerText('approve-rejected')).toBeNull();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });
});

describe('failures before the POST', () => {
  test('an export failure goes to client Sentry with area and step, says so, and posts nothing', async () => {
    const boom = new Error('canvas exploded');
    html2canvas.mockImplementation(() => Promise.reject(boom));
    render(tree(fakeMenu(P()), resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. The menu couldn't be rendered for print. Try again."));
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { area: 'menu-designer', step: 'export' } });
    expect(api.post).not.toHaveBeenCalled();
  });

  test('a font that will not load fails Approve naming it (and reports to Sentry)', async () => {
    const fonts = document.fonts;
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ...fonts, load: (spec) => Promise.resolve(spec.includes('Karla') ? [] : [{ status: 'loaded' }]) } });
    render(tree(fakeMenu(P()), resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. The Karla font didn't load."));
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { area: 'menu-designer', step: 'export' } });
    expect(api.post).not.toHaveBeenCalled();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });

  test('a failed flush stops before the export', async () => {
    const menu = fakeMenu(P(), { flush: jest.fn(() => Promise.reject(new Error('save failed'))) });
    render(tree(menu, resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. Your last change didn't save. Retry it, then approve."));
    expect(html2canvas).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('the review fixes', () => {
  const withLogo = (over = {}) => fakeMenu(P((p) => {
    p.brief.has_planner_image = true;
    p.brief.planner_image_rev = '0123456789abcdef';
  }), { plannerImages: { [FULL_SIZE]: 'blob:logo-a' }, plannerImageRevs: { [FULL_SIZE]: 'aaaaaaaaaaaaaaaa' }, ...over });
  const newerLogo = (menu) => ({ ...menu, plannerImages: { [FULL_SIZE]: 'blob:logo-b' }, plannerImageRevs: { [FULL_SIZE]: 'bbbbbbbbbbbbbbbb' } });

  test('the hidden export canvas is never editable, though the preview is', async () => {
    const { container } = render(tree(fakeMenu(P()), resolved()));
    expect(container.querySelector('.md-ed-preview .mc-fake')).toHaveAttribute('data-editable', 'true');
    fireEvent.click(approveBtn());
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(order.find((o) => o[0] === 'export')[1].getAttribute('data-editable')).toBe('false');
  });

  test('the rev posted is the logo the export drew, even when a newer one lands during the render', async () => {
    let paint;
    html2canvas.mockImplementation((node) => { order.push(['export', node]); return new Promise((r) => { paint = () => r(okCanvas()); }); });
    const menu = withLogo();
    const { rerender } = render(tree(menu, resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(html2canvas).toHaveBeenCalledTimes(1));
    rerender(tree(newerLogo(menu), resolved()));
    await act(async () => { paint(); });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(posted().get('expected_planner_image_rev')).toBe('aaaaaaaaaaaaaaaa');
  });

  test('an export that has not caught up with a newer logo fails, naming the change, and posts nothing', async () => {
    mockCanvas.freezeLogo = true;
    let ready;
    const fonts = document.fonts;
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ...fonts, ready: new Promise((r) => { ready = r; }) } });
    const menu = withLogo();
    const { rerender } = render(tree(menu, resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(document.querySelector('.md-export img[data-mc-layer="logo"]')).not.toBeNull());
    rerender(tree(newerLogo(menu), resolved()));
    await act(async () => { ready(); });
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. The client image changed. Approve again."));
    expect(html2canvas).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });

  test('text being edited is blurred and committed before the flush', async () => {
    const menu = fakeMenu(P());
    const { container } = render(tree(menu, resolved()));
    const el = container.querySelector('.md-ed-preview [data-mc-k="title"]');
    el.focus();
    el.textContent = 'Cheers';
    fireEvent.click(approveBtn());
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    expect(menu.edit.mock.invocationCallOrder[0]).toBeLessThan(menu.flush.mock.invocationCallOrder[0]);
  });

  test('a POST that landed is not reported as a failure when a refetch after it fails', async () => {
    const menu = fakeMenu(P(), { refetch: jest.fn(() => Promise.reject(new Error('socket hang up'))) });
    render(tree(menu, resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(menu.refetch).toHaveBeenCalled());
    await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve'));
    expect(bannerText('approve-rejected')).toBeNull();
  });

  test("an error that is not the server's reads as a plain sentence, never the browser's text", async () => {
    api.post.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    render(tree(fakeMenu(P()), resolved()));
    fireEvent.click(approveBtn());
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. Something went wrong. Please try again."));
  });
});
