import React, { useImperativeHandle, forwardRef } from 'react';
import '@testing-library/jest-dom';
import { render, act } from '@testing-library/react';
import html2canvas from 'html2canvas';
import { exportMenu, approveReason, useApproveMenu, MenuExportError, EXPORT_SCALE, JPEG_QUALITY } from './exportMenu';
import { ensureFontsLink, fontsHref } from './fontPairings';

// The print export (spec 2026-10-01 sections 8, 10.3, 11.3; Review Focus 4;
// plan Task D3). jsdom has no canvas, no document.fonts and never fires image
// loads, so html2canvas is mocked, document.fonts is stubbed and every image
// load or error is fired by hand (spec 14). The node is built by hand with the
// attributes MenuCanvas puts on its layers (data-mc-layer, data-mc-pending).

jest.mock('html2canvas', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('./MenuCanvas', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../utils/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));

const PINYON = "The Pinyon Script, Cormorant Garamond fonts didn't load.";
const loaded = () => Promise.resolve([{ status: 'loaded' }]);
function stubFonts(load = loaded, ready = Promise.resolve()) {
  const fonts = { load: jest.fn(load), ready, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  return fonts;
}
const markLoaded = (id) => ensureFontsLink([id]).setAttribute('data-loaded', 'true');
function nodeWith(html) {
  const node = document.createElement('div');
  node.innerHTML = html;
  document.body.appendChild(node);
  return node;
}
const okCanvas = (w = 2400, h = 3000) => ({ width: w, height: h, toBlob: jest.fn((cb, type) => cb(new Blob(['jpg'], { type }))) });
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); }; // eslint-disable-line no-await-in-loop
const fire = (el, type) => el.dispatchEvent(new Event(type));

beforeEach(() => {
  html2canvas.mockImplementation(() => Promise.resolve(okCanvas()));
});
afterEach(() => {
  jest.useRealTimers();
  document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
  document.body.innerHTML = '';
  delete document.fonts;
});

describe('fonts (each wait 10 s, Review Focus 4)', () => {
  test("injects the pairing's link when it is missing, and a link that never loads fails at 10 s naming the fonts", async () => {
    jest.useFakeTimers();
    stubFonts();
    const p = exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' });
    const link = document.head.querySelector('link[data-menu-fonts]');
    expect(link.getAttribute('href')).toBe(fontsHref(['elegant-script']));
    const settled = jest.fn();
    p.then(settled, settled);
    jest.advanceTimersByTime(9999);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(p).rejects.toThrow(PINYON);
    expect(html2canvas).not.toHaveBeenCalled();
  });

  test('a link that loads in time lets the export go on', async () => {
    stubFonts();
    const p = exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' });
    fire(document.head.querySelector('link[data-menu-fonts]'), 'load');
    await expect(p).resolves.toBeInstanceOf(Blob);
  });

  test('a face that never loads fails at 10 s naming the font, and nothing is rendered', async () => {
    jest.useFakeTimers();
    markLoaded('elegant-script');
    stubFonts((spec) => (spec.includes('Pinyon Script') ? new Promise(() => {}) : loaded()));
    const p = exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' });
    await flush();
    jest.advanceTimersByTime(10000);
    await expect(p).rejects.toThrow("The Pinyon Script font didn't load.");
    expect(html2canvas).not.toHaveBeenCalled();
  });

  test('every face and weight of the pairing is asked for', async () => {
    markLoaded('modern-clean');
    const fonts = stubFonts();
    await exportMenu({ node: nodeWith(''), pairingId: 'modern-clean' });
    expect(fonts.load.mock.calls.map((c) => c[0])).toEqual(['300 32px "Josefin Sans"', '600 32px "Josefin Sans"', '400 32px "Karla"']);
  });

  test('a fonts.load that rejects (a DOMException) still fails naming the font', async () => {
    markLoaded('modern-clean');
    stubFonts((spec) => (spec.includes('Karla') ? Promise.reject(new DOMException('A network error occurred.', 'NetworkError')) : loaded()));
    const p = exportMenu({ node: nodeWith(''), pairingId: 'modern-clean' });
    await expect(p).rejects.toThrow("The Karla font didn't load.");
    await expect(p).rejects.toBeInstanceOf(MenuExportError);
  });

  test('a fonts.load that throws at once still fails naming the font', async () => {
    markLoaded('modern-clean');
    stubFonts((spec) => { if (spec.includes('Karla')) throw new SyntaxError('bad font'); return loaded(); });
    await expect(exportMenu({ node: nodeWith(''), pairingId: 'modern-clean' })).rejects.toThrow("The Karla font didn't load.");
  });

  test('an empty answer (no face matched) fails naming the font, since the print would fall back', async () => {
    markLoaded('rustic');
    stubFonts((spec) => (spec.includes('"Rye"') ? Promise.resolve([]) : loaded()));
    await expect(exportMenu({ node: nodeWith(''), pairingId: 'rustic' })).rejects.toThrow("The Rye font didn't load.");
  });

  test('fonts.ready that never settles fails at the timeout', async () => {
    markLoaded('rustic');
    stubFonts(loaded, new Promise(() => {}));
    await expect(exportMenu({ node: nodeWith(''), pairingId: 'rustic', timeoutMs: 30 }))
      .rejects.toThrow("The Rye, Alegreya SC, Alegreya fonts didn't finish loading.");
  });
});

describe('layers (each wait 10 s)', () => {
  beforeEach(() => {
    markLoaded('elegant-script');
    stubFonts();
  });

  test('a placeholder still pending fails naming that layer, the mark images included', async () => {
    const node = nodeWith('<div data-mc-pending="wordmark"></div>');
    await expect(exportMenu({ node, pairingId: 'elegant-script', timeoutMs: 120 }))
      .rejects.toThrow("The Dr. Bartender wordmark didn't load.");
    expect(html2canvas).not.toHaveBeenCalled();
  });

  test('a pending drink is named through nameOf', async () => {
    const node = nodeWith('<div data-mc-pending="cocktail:2"></div>');
    const nameOf = (k) => (k === 'cocktail:2' ? 'The art for Old Fashioned' : k);
    await expect(exportMenu({ node, pairingId: 'elegant-script', nameOf, timeoutMs: 120 }))
      .rejects.toThrow("The art for Old Fashioned didn't load.");
  });

  test('the 10 s default for a pending layer', async () => {
    jest.useFakeTimers();
    const node = nodeWith('<div data-mc-pending="background"></div>');
    const p = exportMenu({ node, pairingId: 'elegant-script' });
    const settled = jest.fn();
    p.then(settled, settled);
    await flush(60); // the font waits settle and the layer wait starts its clock
    for (let i = 0; i < 99; i += 1) { jest.advanceTimersByTime(100); await flush(); } // eslint-disable-line no-await-in-loop
    expect(settled).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i += 1) { jest.advanceTimersByTime(100); await flush(); } // eslint-disable-line no-await-in-loop
    await expect(p).rejects.toThrow("The background didn't load.");
  });

  test('a placeholder that fills in time is waited for, then its image', async () => {
    const node = nodeWith('<div data-mc-pending="logo"></div>');
    const p = exportMenu({ node, pairingId: 'elegant-script', timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 150));
    node.innerHTML = '<img data-mc-layer="logo" alt="">';
    await new Promise((r) => setTimeout(r, 150));
    expect(html2canvas).not.toHaveBeenCalled();
    fire(node.querySelector('img'), 'load');
    await expect(p).resolves.toBeInstanceOf(Blob);
  });

  test('an image that never loads fails naming it', async () => {
    const node = nodeWith('<img data-mc-layer="avatar" alt="">');
    await expect(exportMenu({ node, pairingId: 'elegant-script', timeoutMs: 60 }))
      .rejects.toThrow("The Dr. Bartender avatar didn't load.");
  });

  test('an image that errors fails at once naming it', async () => {
    const node = nodeWith('<img data-mc-layer="cocktail:1" alt="">');
    const p = exportMenu({ node, pairingId: 'elegant-script', nameOf: () => 'The art for Paloma' });
    await flush(20);
    fire(node.querySelector('img'), 'error');
    await expect(p).rejects.toThrow("The art for Paloma didn't load.");
    await expect(p).rejects.toBeInstanceOf(MenuExportError);
  });
});

describe('the render', () => {
  beforeEach(() => {
    markLoaded('elegant-script');
    stubFonts();
  });

  test('waits for every layer (both mark images too), then html2canvas at scale 3 and a JPEG at 0.92', async () => {
    const node = nodeWith(['background', 'cocktail:1', 'logo', 'avatar', 'wordmark']
      .map((k) => `<img data-mc-layer="${k}" alt="">`).join(''));
    const p = exportMenu({ node, pairingId: 'elegant-script' });
    const imgs = [...node.querySelectorAll('img')];
    await flush(20);
    imgs.slice(0, 4).forEach((img) => fire(img, 'load'));
    await flush(20);
    expect(html2canvas).not.toHaveBeenCalled();
    fire(imgs[4], 'load');
    const blob = await p;
    expect(blob.type).toBe('image/jpeg');
    expect(EXPORT_SCALE).toBe(3);
    expect(html2canvas).toHaveBeenCalledTimes(1);
    expect(html2canvas).toHaveBeenCalledWith(node, expect.objectContaining({ scale: 3, useCORS: true, width: 800, height: 1000 }));
    const canvas = await html2canvas.mock.results[0].value;
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', JPEG_QUALITY);
    expect(JPEG_QUALITY).toBe(0.92);
  });

  test('an image already loaded is not waited for', async () => {
    const node = nodeWith('<img data-mc-layer="avatar" alt="">');
    const img = node.querySelector('img');
    Object.defineProperty(img, 'complete', { get: () => true });
    Object.defineProperty(img, 'naturalWidth', { get: () => 120 });
    await expect(exportMenu({ node, pairingId: 'elegant-script', timeoutMs: 60 })).resolves.toBeInstanceOf(Blob);
  });

  test('a canvas at the wrong size fails (the server takes only 2400 x 3000)', async () => {
    html2canvas.mockImplementation(() => Promise.resolve(okCanvas(2304, 2880)));
    await expect(exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' }))
      .rejects.toThrow('The export came out at 2304 x 2880, not 2400 x 3000.');
  });

  test('a failed JPEG encode fails, and no node fails at once', async () => {
    html2canvas.mockImplementation(() => Promise.resolve({ width: 2400, height: 3000, toBlob: (cb) => cb(null) }));
    await expect(exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' })).rejects.toThrow("The menu couldn't be saved as a JPEG.");
    await expect(exportMenu({ node: null, pairingId: 'elegant-script' })).rejects.toThrow('The menu is not ready to export.');
  });
});

describe('approveReason: keyed on the code, never the message', () => {
  test.each([
    ['MENU_DRAFT_CHANGED', 'The draft changed. Approve again.'],
    ['MENU_PRINT_CHANGED', 'The print file changed since you confirmed. Check it and approve again.'],
    ['MENU_WORDS_PENDING', 'The menu words are still being written. Try again once they land.'],
    ['MENU_WORDS_NOT_WRITTEN', 'The menu words were not written. Start over to write them.'],
  ])('%s', (code, text) => {
    expect(approveReason({ status: 409, code, message: 'whatever the server said' }, 'post')).toBe(text);
  });

  test('a field error, another error, a failed save and a failed export', () => {
    expect(approveReason({ status: 400, fieldErrors: { file: 'The menu must be 2400 x 3000.' }, message: 'x' }, 'post')).toBe('The menu must be 2400 x 3000.');
    expect(approveReason({ status: 500, message: 'Something went wrong. Please try again.' }, 'post')).toBe('Something went wrong. Please try again.');
    expect(approveReason(new Error('x'), 'save')).toBe("Your last change didn't save. Retry it, then approve.");
    expect(approveReason(new MenuExportError("The Rye font didn't load."), 'export')).toBe("The Rye font didn't load.");
    expect(approveReason(new Error('canvas tainted'), 'export')).toBe("The menu couldn't be rendered for print. Try again.");
  });

  test("a browser error at the POST (no status) is never shown as is", () => {
    expect(approveReason(new TypeError('Failed to fetch'), 'post')).toBe('Something went wrong. Please try again.');
    expect(approveReason({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' }, 'post'))
      .toBe('Network error. Check your connection.');
  });
});

describe('useApproveMenu', () => {
  const Harness = forwardRef(function Harness({ menu }, ref) {
    const approve = useApproveMenu({ menu, loadProposal: null });
    useImperativeHandle(ref, () => approve);
    return null;
  });

  test('a second run while one is under way is ignored (one flush, one approval)', async () => {
    const menu = { flush: jest.fn(() => new Promise(() => {})), payload: null, draft: null, layers: {}, plannerImages: {}, plannerImageRevs: {} };
    const ref = React.createRef();
    render(<Harness ref={ref} menu={menu} />);
    act(() => {
      ref.current.run({ expectedPrintKey: '' });
      ref.current.run({ expectedPrintKey: '' });
    });
    await act(async () => {});
    expect(menu.flush).toHaveBeenCalledTimes(1);
    expect(ref.current.approving).toBe(true);
  });
});
