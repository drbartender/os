import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import html2canvas from 'html2canvas';
import MenuEditor from './MenuEditor';
import api from '../../../utils/api';
import { ensureFontsLink } from './fontPairings';
import { FULL_SIZE } from './useMenuDraft';

// Approve and send through the editor (spec 2026-10-01 sections 8, Approve 1,
// the rendered-logo check; 11.1; 12; plan Task D3; amended by spec 2026-10-19
// sections 10.1, 10.3 and 10.5, lane menu-approve-send): its confirm, with the
// no-email variant, then flush, then one export from the hidden canvas encoded
// as the print file and the proof, then the POST with both files, version,
// art_version, expected_print_key and the logo's rev; the "Couldn't approve."
// banner keyed on the code, MENU_PROOF_ALREADY_SENT read as success; client
// Sentry on an export failure; and Release for printing and Put it back for
// staff from the banners, with their confirms, running labels and errors.
// MenuCanvas is a stand-in whose layer images read as already loaded (the
// waits themselves are exportMenu.test.js); html2canvas is mocked, and so is
// the proof's 2D canvas, which jsdom does not have.

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
const PROPOSAL = { id: 42, client_name: 'Avery Example', client_email: 'avery@example.com', event_date: '2099-12-31T00:00:00.000Z' };
const tree = (menu, loadProposal, proposal = PROPOSAL) => (
  <MenuEditor editor={{ view: {}, close: jest.fn() }} menu={menu} proposal={proposal} eventLabel="Avery · Wedding" loadProposal={loadProposal} />
);
const approveBtn = () => screen.getByRole('button', { name: /^(Approve and send|Approving\.\.\.|Approved)$/ });
// The top bar's Approve and send, then the confirm's own button.
const approve = () => {
  fireEvent.click(approveBtn());
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Approve and (send|create link)$/ }));
};
const posted = () => api.post.mock.calls[0][1];
const bannerText = (id) => {
  const b = document.querySelector(`.md-banner[data-banner="${id}"]`);
  return b ? `${b.querySelector('.md-banner-title').textContent} ${b.querySelector('.md-banner-text').textContent}` : null;
};
const okCanvas = () => ({ width: 2400, height: 3000, toBlob: (cb, type, q) => cb(new Blob([`print ${q}`], { type })) });
// The proof's offscreen canvas: a context that draws nothing, and a JPEG it names.
let canvasSpies = [];
const stubProofCanvas = () => {
  const ctx = { drawImage() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }), letterSpacing: '0px' };
  canvasSpies = [
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx),
    jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(cb, type, q) { cb(new Blob([`proof ${this.width}x${this.height} ${q}`], { type })); }),
  ];
};

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
  stubProofCanvas();
});
afterEach(() => {
  document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
  canvasSpies.forEach((sp) => sp.mockRestore());
});
const text = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });

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
  approve();
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
  // No proof on the page: what it saw of the latest proof is empty.
  expect([form.get('seen_proof_id'), form.get('seen_proof_answer')]).toEqual(['', '']);
  // The logo role with no planner image: rendered with no logo.
  expect(form.get('expected_planner_image_rev')).toBe('');
  expect(form.get('file').type).toBe('image/jpeg');
  // One render, two files (spec 2026-10-19 section 10.1): the print file at 0.92, the 1200 x 1556 proof at 0.85.
  expect(html2canvas).toHaveBeenCalledTimes(1);
  expect(await text(form.get('file'))).toBe('print 0.92');
  expect(form.get('proof').type).toBe('image/jpeg');
  expect(await text(form.get('proof'))).toBe('proof 1200x1556 0.85');
  await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
  expect(loadProposal).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve and send'));
  expect(container.querySelector('.md-export')).toBeNull();
});

test('the versions posted are the draft as saved (read after the flush lands)', async () => {
  let finishFlush;
  const before = fakeMenu(P(), { flush: jest.fn(() => new Promise((r) => { finishFlush = r; })) });
  const { rerender } = render(tree(before, resolved()));
  approve();
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
  approve();
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(posted().get('expected_planner_image_rev')).toBe('0123456789abcdef');
  expect(order[0][1].querySelector('img[data-mc-layer="logo"]').getAttribute('src')).toBe('blob:logo-full');
  await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve and send'));
  a.unmount();
  api.post.mockClear();
  render(tree(withLogo('reference'), resolved()));
  approve();
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(posted().has('expected_planner_image_rev')).toBe(false);
});

describe("Approve and send's confirm, every time (spec 2026-10-19 section 10.5)", () => {
  // With no email the body says it creates the proof, never that it emails one.
  const NO_EMAIL_TEXT = 'Creates a proof of the menu as it is now, with a link the client can use to say it looks great or ask for changes. '
    + "Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see. "
    + 'No email is on file for this client, so no email goes out. Copy the link from the card and send it yourself.';
  const TEXT = 'Emails the client a proof of the menu as it is now, with a link to say it looks great or ask for changes. '
    + "Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see.";

  test('its title, text and button; Cancel posts nothing; Approve and send posts the print key it confirmed over', async () => {
    const menu = fakeMenu(P((p) => {
      p.print = { state: 'edited_since_approval', approved_at: APPROVED_AT, print_key: 'menu-print/42/a.jpg', approved_file_in_use: true };
    }));
    render(tree(menu, resolved()));
    expect(approveBtn()).toHaveTextContent('Approve and send');
    fireEvent.click(approveBtn());
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Approve and send to the client?')).toBeInTheDocument();
    expect(within(dialog).getByText(TEXT)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(menu.flush).not.toHaveBeenCalled();
    fireEvent.click(approveBtn());
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(posted().get('expected_print_key')).toBe('menu-print/42/a.jpg');
  });

  test.each([
    ['no email on file', { client_email: null }],
    ['an .invalid placeholder', { client_email: 'placeholder-9@clients.invalid' }],
  ])('with %s: the text says it creates the proof, never that it emails one, and the button reads Approve and create link', async (_n, over) => {
    render(tree(fakeMenu(P()), resolved(), { ...PROPOSAL, ...over }));
    fireEvent.click(approveBtn());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(NO_EMAIL_TEXT))
      .toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Approve and send' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and create link' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  });

  test('the key posted is the one confirmed over, not one a later poll brought in', async () => {
    // The menu's own released file is live (an upload beside it holds Approve off).
    const mut = (key) => (p) => { p.print = { state: 'edited_since_approval', approved_at: APPROVED_AT, print_key: key, approved_file_in_use: true }; };
    const { rerender } = render(tree(fakeMenu(P(mut('menu-print/42/one.jpg'))), resolved()));
    fireEvent.click(approveBtn());
    rerender(tree(fakeMenu(P(mut('menu-print/42/two.jpg'))), resolved()));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(posted().get('expected_print_key')).toBe('menu-print/42/one.jpg');
  });

  test('the proof posted as seen is the one on screen at the press, not one a later poll brought in', async () => {
    const withProof = (answer) => (p) => {
      p.print = { state: 'held', held: true, live: 'none', approved_version: 3, approved_art_version: 4, print_key: null, approved_file_in_use: false };
      p.proof = { id: 77, state: answer || 'open', answer, url: 'u', sent_at: APPROVED_AT, email_status: 'sent', expired: false, history: [] };
    };
    const { rerender } = render(tree(fakeMenu(P(withProof(null))), resolved()));
    fireEvent.click(approveBtn());
    rerender(tree(fakeMenu(P(withProof('changes'))), resolved()));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect([posted().get('seen_proof_id'), posted().get('seen_proof_answer')]).toEqual(['77', '']);
  });
});

describe("a refusal: the Couldn't approve. banner, keyed on the code", () => {
  test.each([
    ['MENU_PRINT_CHANGED', 'The print file changed since you confirmed. Check it and approve again.'],
    ['MENU_DRAFT_CHANGED', 'The draft changed. Approve again.'],
    ['MENU_WORDS_PENDING', 'The menu words are still being written. Try again once they land.'],
    ['MENU_WORDS_NOT_WRITTEN', 'The menu words were not written. Start over to write them.'],
    ['MENU_EVENT_PASSED', "This event has passed, so there's nothing to send."],
    ['MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
  ])('409 %s shows its reason and refetches both', async (code, text) => {
    api.post.mockImplementation(() => Promise.reject({ status: 409, code, message: 'Server words the client never keys on.' }));
    const loadProposal = resolved();
    const menu = fakeMenu(P());
    render(tree(menu, loadProposal));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).toBe(`Couldn't approve. ${text}`));
    expect(menu.refetch).toHaveBeenCalledTimes(1);
    expect(loadProposal).toHaveBeenCalledTimes(1);
    expect(approveBtn()).toHaveTextContent('Approve and send');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('409 MENU_PROOF_ALREADY_SENT (a double click, a retried post) is success: it refetches and says nothing', async () => {
    api.post.mockImplementation(() => Promise.reject({ status: 409, code: 'MENU_PROOF_ALREADY_SENT', message: 'This menu was just sent.' }));
    const loadProposal = resolved();
    const menu = fakeMenu(P());
    render(tree(menu, loadProposal));
    approve();
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
    expect(loadProposal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve and send'));
    expect(bannerText('approve-rejected')).toBeNull();
  });

  test('429 MENU_PROOF_SEND_CAP says so', async () => {
    api.post.mockImplementation(() => Promise.reject({ status: 429, code: 'MENU_PROOF_SEND_CAP', message: 'x' }));
    render(tree(fakeMenu(P()), resolved()));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. You've sent this menu 5 times today. Try again tomorrow."));
  });

  test('the next Approve clears the old reason', async () => {
    api.post.mockImplementationOnce(() => Promise.reject({ status: 409, code: 'MENU_DRAFT_CHANGED' }));
    render(tree(fakeMenu(P()), resolved()));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).not.toBeNull());
    fireEvent.click(approveBtn());
    expect(bannerText('approve-rejected')).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });
});

describe('failures before the POST', () => {
  test('an export failure goes to client Sentry with area and step, says so, and posts nothing', async () => {
    const boom = new Error('canvas exploded');
    html2canvas.mockImplementation(() => Promise.reject(boom));
    render(tree(fakeMenu(P()), resolved()));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. The menu couldn't be rendered for print. Try again."));
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { area: 'menu-designer', step: 'approve-export' } });
    expect(api.post).not.toHaveBeenCalled();
  });

  test('a font that will not load fails Approve naming it (and reports to Sentry)', async () => {
    const fonts = document.fonts;
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ...fonts, load: (spec) => Promise.resolve(spec.includes('Karla') ? [] : [{ status: 'loaded' }]) } });
    render(tree(fakeMenu(P()), resolved()));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. The Karla font didn't load."));
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { area: 'menu-designer', step: 'approve-export' } });
    expect(api.post).not.toHaveBeenCalled();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });

  test('a failed flush stops before the export', async () => {
    const menu = fakeMenu(P(), { flush: jest.fn(() => Promise.reject(new Error('save failed'))) });
    render(tree(menu, resolved()));
    approve();
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
    approve();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(order.find((o) => o[0] === 'export')[1].getAttribute('data-editable')).toBe('false');
  });

  test('the rev posted is the logo the export drew, even when a newer one lands during the render', async () => {
    let paint;
    html2canvas.mockImplementation((node) => { order.push(['export', node]); return new Promise((r) => { paint = () => r(okCanvas()); }); });
    const menu = withLogo();
    const { rerender } = render(tree(menu, resolved()));
    approve();
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
    approve();
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
    approve();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(menu.edit).toHaveBeenCalledWith({ content: { title: 'Cheers' } });
    expect(menu.edit.mock.invocationCallOrder[0]).toBeLessThan(menu.flush.mock.invocationCallOrder[0]);
  });

  test('a POST that landed is not reported as a failure when a refetch after it fails', async () => {
    const menu = fakeMenu(P(), { refetch: jest.fn(() => Promise.reject(new Error('socket hang up'))) });
    render(tree(menu, resolved()));
    approve();
    await waitFor(() => expect(menu.refetch).toHaveBeenCalled());
    await waitFor(() => expect(approveBtn()).toHaveTextContent('Approve and send'));
    expect(bannerText('approve-rejected')).toBeNull();
  });

  test("an error that is not the server's reads as a plain sentence, never the browser's text", async () => {
    api.post.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    render(tree(fakeMenu(P()), resolved()));
    approve();
    await waitFor(() => expect(bannerText('approve-rejected')).toBe("Couldn't approve. Something went wrong. Please try again."));
  });
});

// ── The review's other writes, from the banners (spec 2026-10-19 sections 10.3, 10.5 and 14) ──

describe('Release for printing and Put it back for staff in the editor', () => {
  const SENT = '2026-11-10T17:00:00Z';
  const URL_ = 'https://drbartender.com/menu-proof/11111111-2222-4333-8444-555555555555';
  const held = (over = {}) => (p) => {
    p.print = { state: 'held', held: true, live: 'none', approved_at: SENT, approved_version: 3, approved_art_version: 4, print_key: null, approved_file_in_use: false };
    p.proof = { id: 77, state: 'open', url: URL_, sent_at: SENT, email_status: 'sent', expired: false, stale: false,
      answer: null, answer_note: null, answered_at: null, withdrawn_at: null, history: [], ...over };
  };
  const inBanner = (id) => within(document.querySelector(`.md-banner[data-banner="${id}"]`));
  const dialog = () => screen.getByRole('dialog');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('Waiting on the client: the info banner; Release for printing confirms, reads Releasing... disabled while it posts, then refetches', async () => {
    let finish;
    api.post.mockImplementation(() => new Promise((r) => { finish = r; }));
    const menu = fakeMenu(P(held()));
    const loadProposal = resolved();
    render(tree(menu, loadProposal));
    expect(bannerText('client-waiting')).toBe(`Proof sent ${new Date(SENT).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. Waiting on the client's answer. Edits here don't change what they see.`);
    const release = inBanner('client-waiting').getByRole('button', { name: 'Release for printing' });
    expect(release).toHaveClass('btn', 'btn-secondary', 'btn-sm');
    fireEvent.click(release);
    expect(within(dialog()).getByText('Release for printing?')).toBeInTheDocument();
    expect(within(dialog()).getByText('Staff will be able to download and print this menu now, without waiting for the client.')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release', { version: 3, art_version: 4, seen_proof_id: 77, seen_proof_answer: '' });
    expect(inBanner('client-waiting').getByRole('button', { name: 'Releasing...' })).toBeDisabled();
    await act(async () => { finish({ data: {} }); });
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
    expect(loadProposal).toHaveBeenCalledTimes(1);
  });

  test('after the event day the confirm names the $5 duty and the post carries after_event true', async () => {
    api.post.mockResolvedValue({ data: {} });
    render(tree(fakeMenu(P(held())), resolved(), { ...PROPOSAL, event_date: daysAgo(3) }));
    fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Release for printing' }));
    expect(within(dialog()).getByText('This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.'))
      .toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release',
      { version: 3, art_version: 4, seen_proof_id: 77, seen_proof_answer: '', after_event: true }));
  });

  test('the landed after-event release says what happened to the duty in one status line under the banners, until the next action', async () => {
    api.post.mockResolvedValue({ data: { duty: 'added' } });
    render(tree(fakeMenu(P(held())), resolved(), { ...PROPOSAL, event_date: daysAgo(3) }));
    fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    const line = await screen.findByText('Released. The $5 print duty was added.');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.closest('.md-ed-banners')).not.toBeNull();
    fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Release for printing' }));
    expect(screen.queryByText('Released. The $5 print duty was added.')).toBeNull();
  });

  test.each([
    ['LEGAL_HOLD', "This event is on hold and can't be changed."],
    ['MENU_MARKED_NONE', 'This event is marked as needing no printed menu. Clear the mark first.'],
    ['MENU_PRINT_CHANGED', 'A different print file is live now. Refresh to see it.'],
    ['MENU_DRAFT_CHANGED', "That didn't go through. Try again."],
    ['MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
  ])('a 409 %s: its line inline, as an alert', async (code, line) => {
    api.post.mockRejectedValue({ status: 409, code, message: 'server words' });
    render(tree(fakeMenu(P(held())), resolved()));
    fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(line);
    expect(alert.closest('.md-ed-preview')).not.toBeNull();
  });

  test('a 409 MENU_NOT_HELD refetches silently', async () => {
    api.post.mockRejectedValue({ status: 409, code: 'MENU_NOT_HELD', message: 'x' });
    const menu = fakeMenu(P(held()));
    render(tree(menu, resolved()));
    fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Release for printing' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await waitFor(() => expect(menu.refetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Put it back for staff from the removed banner: its confirm, and the same route', async () => {
    api.post.mockResolvedValue({ data: {} });
    render(tree(fakeMenu(P((p) => { p.print = { state: 'removed', restorable: true, approved_version: 3, approved_art_version: 4, print_key: null }; })), resolved()));
    fireEvent.click(inBanner('removed').getByRole('button', { name: 'Put it back for staff' }));
    expect(within(dialog()).getByText('Put this menu back for staff?')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Put it back for staff' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release',
      { version: 3, art_version: 4, seen_proof_id: '', seen_proof_answer: '' }));
  });

  // The pressed banner button is disabled, then gone, by the time the action lands.
  test('after a review action settles (here a refusal), focus moves to the banner region, never the page body', async () => {
    api.post.mockRejectedValue({ status: 409, code: 'MENU_PRINT_CHANGED', message: 'x' });
    const { container } = render(tree(fakeMenu(P(held())), resolved()));
    const trigger = inBanner('client-waiting').getByRole('button', { name: 'Release for printing' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Release for printing' }));
    await screen.findByRole('alert');
    const region = container.querySelector('.md-ed-banners');
    await waitFor(() => expect(document.activeElement).toBe(region));
    expect(region).toHaveAttribute('tabindex', '-1');
  });

  test('the client asked for changes: the warn banner with the full note and no buttons; Approve and send stays in the top bar', () => {
    const note = 'Can the title say Happy 40th? And put the Paloma first, since it is the one everyone asked about at the party last year.';
    render(tree(fakeMenu(P(held({ state: 'changes', answer: 'changes', answer_note: note, answered_at: SENT }))), resolved()));
    expect(bannerText('client-changes')).toBe(`The client asked for changes. ${note}`);
    expect(document.querySelector('.md-banner[data-banner="client-changes"] button')).toBeNull();
    expect(document.querySelector('.md-banner[data-banner="client-changes"]')).toHaveClass('md-banner-warn');
    expect(approveBtn()).toHaveTextContent('Approve and send');
  });

  test("a proof with no email on file: the banner says so, and its Copy link copies the link", async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(tree(fakeMenu(P(held({ email_status: 'no_address' }))), resolved()));
    expect(bannerText('client-waiting')).toContain('No email on file. Copy the link and send it yourself.');
    await act(async () => { fireEvent.click(inBanner('client-waiting').getByRole('button', { name: 'Copy link' })); });
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(inBanner('client-waiting').getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  test('Approve and send stays enabled while the file is held, so a fresh link can go out; the replace confirm is gone', () => {
    render(tree(fakeMenu(P(held())), resolved()));
    expect(approveBtn()).toBeEnabled();
    fireEvent.click(approveBtn());
    expect(within(dialog()).queryByText('Replace the print file?')).toBeNull();
  });
});
