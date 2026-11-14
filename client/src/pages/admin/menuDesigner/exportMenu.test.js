import React, { useImperativeHandle, forwardRef } from 'react';
import '@testing-library/jest-dom';
import { render, act } from '@testing-library/react';
import html2canvas from 'html2canvas';
import {
  exportMenu, approveReason, useApproveMenu, MenuExportError, EXPORT_SCALE, JPEG_QUALITY, renderPrintCanvas, encodePrint,
  encodeProof, approveConfirm, hasClientEmail, reviewConfirm, eventDayPassed, useMenuReview, seenProof, REVIEW_BUSY,
} from './exportMenu';
import api from '../../../utils/api';
import { chicagoDay } from '../../../utils/chicagoDay';
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
const okCanvas = (w = 2400, h = 3000) => {
  const c = { width: w, height: h, blobs: [] };
  c.toBlob = jest.fn((cb, type) => { const b = new Blob(['jpg'], { type }); c.blobs.push(b); cb(b); });
  return c;
};
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
    // Approve and send's own (spec 2026-10-19 sections 10.2 and 10.4).
    ['MENU_EVENT_PASSED', "This event has passed, so there's nothing to send."],
    ['MENU_PROOF_ARCHIVED', 'This event is archived, so there is no one to send it to.'],
    ['MENU_MARKED_NONE', 'This event is marked as needing no printed menu. Clear the mark first.'],
    ['LEGAL_HOLD', "This event is on hold and can't be changed."],
    ['MENU_UPLOAD_LIVE', 'Your uploaded file is what staff print. Remove it first to send this menu.'],
    ['MENU_PROOF_CHANGED', "The client's review changed. Refresh to see it."],
  ])('%s', (code, text) => {
    expect(approveReason({ status: 409, code, message: 'whatever the server said' }, 'post')).toBe(text);
  });

  test('the send cap, a 429', () => {
    expect(approveReason({ status: 429, code: 'MENU_PROOF_SEND_CAP', message: 'x' }, 'post')).toBe("You've sent this menu 5 times today. Try again tomorrow.");
  });

  test('a bad proof file names its field error', () => {
    expect(approveReason({ status: 400, code: 'VALIDATION_ERROR', fieldErrors: { proof: 'The proof must be exactly 1200 x 1556 pixels.' } }, 'post'))
      .toBe('The proof must be exactly 1200 x 1556 pixels.');
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

// v2 spec 9.3 and v1 11.3: a house draft prints in the house faces, so the
// export waits on them (never on the default pairing its null font_pairing reads as).
describe('the house card fonts', () => {
  const HOUSE = "The Pirata One, IM Fell English SC, IM Fell English fonts didn't load.";

  test("a house draft's export waits on the house link and each of its three faces", async () => {
    const { faceSetFor } = require('./fontPairings');
    const pairingId = faceSetFor({ look: 'house', font_pairing: null });
    markLoaded('house');
    const fonts = stubFonts();
    await exportMenu({ node: nodeWith(''), pairingId });
    expect(fonts.load.mock.calls.map((c) => c[0])).toEqual(['400 32px "Pirata One"', '400 32px "IM Fell English SC"', '400 32px "IM Fell English"']);
    expect(document.head.querySelector('link[data-menu-fonts]').getAttribute('href')).toBe(fontsHref(['house']));
  });

  test('a house link that never loads fails at 10 s naming the house faces', async () => {
    jest.useFakeTimers();
    stubFonts();
    const p = exportMenu({ node: nodeWith(''), pairingId: 'house' });
    jest.advanceTimersByTime(10000);
    await expect(p).rejects.toThrow(HOUSE);
    expect(html2canvas).not.toHaveBeenCalled();
  });

  test('a house face that never loads is named', async () => {
    jest.useFakeTimers();
    markLoaded('house');
    stubFonts((spec) => (spec.includes('Pirata One') ? new Promise(() => {}) : loaded()));
    const p = exportMenu({ node: nodeWith(''), pairingId: 'house' });
    await flush();
    jest.advanceTimersByTime(10000);
    await expect(p).rejects.toThrow("The Pirata One font didn't load.");
  });
});

// ── One render, two files (spec 2026-10-19 section 10.1; lane menu-approve-send) ──

// jsdom has no 2D canvas: the proof's canvas is a recording stand-in.
function stubProofCanvas({ letterSpacing = true, noContext = false } = {}) {
  const log = [];
  const made = [];
  const ctx = {
    fillStyle: '', font: '', textAlign: 'start', textBaseline: 'alphabetic',
    drawImage: (...a) => log.push(['drawImage', ...a]),
    fillRect: (...a) => log.push(['fillRect', ctx.fillStyle, ...a]),
    fillText: (t, x, y) => log.push(['fillText', t, x, y, ctx.font, ctx.fillStyle, ctx.textAlign, ctx.textBaseline, ctx.letterSpacing]),
    measureText: () => ({ width: 10 }),
  };
  if (letterSpacing) ctx.letterSpacing = '0px';
  const spies = [
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() { made.push(this); return noContext ? null : ctx; }),
    jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(cb, type, q) {
      log.push(['toBlob', this.width, this.height, type, q]);
      cb(new Blob(['proof'], { type }));
    }),
  ];
  return { log, made, restore: () => spies.forEach((sp) => sp.mockRestore()) };
}

describe('one render, two files', () => {
  let stub;
  beforeEach(() => {
    markLoaded('elegant-script');
    stubFonts();
  });
  afterEach(() => { if (stub) stub.restore(); stub = null; });

  test('renderPrintCanvas is the 2400 x 3000 render; the print file is its own JPEG at 0.92, as exportMenu makes it', async () => {
    const canvas = await renderPrintCanvas({ node: nodeWith(''), pairingId: 'elegant-script' });
    expect(canvas).toBe(await html2canvas.mock.results[0].value);
    expect([canvas.width, canvas.height]).toEqual([2400, 3000]);
    const blob = await encodePrint(canvas);
    expect(canvas.toBlob).toHaveBeenCalledTimes(1);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect(blob).toBe(canvas.blobs[0]);
    // exportMenu is the same two steps: one html2canvas, one encode of that canvas, nothing redrawn.
    const viaExport = await exportMenu({ node: nodeWith(''), pairingId: 'elegant-script' });
    const second = await html2canvas.mock.results[1].value;
    expect(viaExport).toBe(second.blobs[0]);
    expect(second.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
  });

  test('the proof: the render at 1200 x 1500 over the 56 px band, 1200 x 1556, JPEG at 0.85; the print file is not touched', async () => {
    stub = stubProofCanvas();
    const src = okCanvas();
    const blob = await encodeProof(src, { version: 3, artVersion: 4 });
    expect(blob.type).toBe('image/jpeg');
    expect(stub.made).toHaveLength(1);
    expect([stub.made[0].width, stub.made[0].height]).toEqual([1200, 1556]);
    expect(stub.log).toEqual([
      ['drawImage', src, 0, 0, 1200, 1500],
      ['fillRect', '#fbf8f3', 0, 1500, 1200, 56],
      ['fillRect', '#d8d2c6', 0, 1500, 1200, 1],
      ['fillText', 'PROOF · not for print · v3.4', 600.8, 1528, '600 20px Inter, system-ui, sans-serif', '#6b665e', 'center', 'middle', '1.6px'],
      ['toBlob', 1200, 1556, 'image/jpeg', 0.85],
    ]);
    expect(src.toBlob).not.toHaveBeenCalled();
  });

  test('without the canvas letterSpacing the band is drawn letter by letter, centred with the same 1.6 px tracking', async () => {
    stub = stubProofCanvas({ letterSpacing: false });
    await encodeProof(okCanvas(), { version: 12, artVersion: 0 });
    const text = 'PROOF · not for print · v12.0';
    const n = Array.from(text).length;
    const letters = stub.log.filter((l) => l[0] === 'fillText');
    expect(letters.map((l) => l[1]).join('')).toBe(text);
    const first = 600 - (10 * n + 1.6 * (n - 1)) / 2;
    expect(letters[0][2]).toBeCloseTo(first, 6);
    expect(letters[1][2]).toBeCloseTo(first + 11.6, 6);
    expect(letters.every((l) => l[3] === 1528 && l[6] === 'left' && l[4] === '600 20px Inter, system-ui, sans-serif')).toBe(true);
  });

  test('a browser that gives no 2D context fails naming the proof', async () => {
    stub = stubProofCanvas({ noContext: true });
    await expect(encodeProof(okCanvas(), { version: 1, artVersion: 0 })).rejects.toThrow("The proof couldn't be drawn.");
  });
});

describe("Approve and send's confirm (spec 2026-10-19 section 10.5)", () => {
  const NO_EMAIL_TEXT = 'Creates a proof of the menu as it is now, with a link the client can use to say it looks great or ask for changes. '
    + "Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see. "
    + 'No email is on file for this client, so no email goes out. Copy the link from the card and send it yourself.';
  const TEXT = 'Emails the client a proof of the menu as it is now, with a link to say it looks great or ask for changes. '
    + "Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see.";
  test('with an email on file, and with none', () => {
    expect(approveConfirm()).toEqual({ title: 'Approve and send to the client?', text: TEXT, actionLabel: 'Approve and send', actionClass: 'btn btn-primary' });
    expect(approveConfirm({ noEmail: true })).toEqual({
      title: 'Approve and send to the client?', actionLabel: 'Approve and create link', actionClass: 'btn btn-primary',
      // With no email the body never says one goes out (it creates the proof and its link).
      text: NO_EMAIL_TEXT,
    });
  });

  test("an email on file is the server's mailable rule: set, and not an .invalid placeholder", () => {
    expect(hasClientEmail({ client_email: 'avery@example.com' })).toBe(true);
    for (const email of [null, undefined, '', '   ', 'placeholder-12@clients.invalid', 'X@Y.INVALID ']) {
      expect(hasClientEmail({ client_email: email })).toBe(false);
    }
    expect(hasClientEmail(null)).toBe(false);
  });
});

describe('the review confirms and the event day', () => {
  const AFTER = 'This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.';
  test('Release for printing, Put it back for staff and Close request, each before and after the event day', () => {
    expect(reviewConfirm('release')).toEqual({ title: 'Release for printing?', actionLabel: 'Release for printing', actionClass: 'btn btn-primary',
      text: 'Staff will be able to download and print this menu now, without waiting for the client.' });
    expect(reviewConfirm('release', { afterEvent: true }).text).toBe(AFTER);
    expect(reviewConfirm('put-back')).toEqual({ title: 'Put this menu back for staff?', actionLabel: 'Put it back for staff', actionClass: 'btn btn-primary',
      text: 'Staff will be able to download and print it again.' });
    expect(reviewConfirm('put-back', { afterEvent: true }).text).toBe(AFTER);
    expect(reviewConfirm('close')).toEqual({ title: 'Close this request?', actionLabel: 'Close request', actionClass: 'btn btn-primary',
      text: "The menu stays as it is for staff. The client's link will say the menu is no longer open for review." });
    expect(REVIEW_BUSY).toEqual({ release: 'Releasing...', 'put-back': 'Putting it back...', close: 'Closing...' });
  });

  test('the event day is before today in Chicago, read as text; no date never passed', () => {
    expect(eventDayPassed('2026-11-13', '2026-11-14')).toBe(true);
    expect(eventDayPassed('2026-11-13T00:00:00.000Z', '2026-11-14')).toBe(true);
    expect(eventDayPassed('2026-11-14', '2026-11-14')).toBe(false);
    expect(eventDayPassed('2026-11-15T00:00:00.000Z', '2026-11-14')).toBe(false);
    for (const none of [null, undefined, '', 'soon']) expect(eventDayPassed(none, '2026-11-14')).toBe(false);
  });
});

describe('seenProof: what the page shows of the latest proof', () => {
  test('its id and answer, each empty for none', () => {
    expect(seenProof({ id: 77, state: 'changes', answer: 'changes' })).toEqual({ seen_proof_id: 77, seen_proof_answer: 'changes' });
    expect(seenProof({ id: 77, state: 'open', answer: null })).toEqual({ seen_proof_id: 77, seen_proof_answer: '' });
    expect(seenProof({ id: 78, state: 'withdrawn', answer: 'changes' })).toEqual({ seen_proof_id: 78, seen_proof_answer: 'changes' });
    for (const none of [null, undefined, {}]) expect(seenProof(none)).toEqual({ seen_proof_id: '', seen_proof_answer: '' });
  });
});

describe('useMenuReview', () => {
  const PRINT = { state: 'held', held: true, approved_version: 4, approved_art_version: 2 };
  const PROOF = { id: 77, state: 'changes', answer: 'changes' };
  const SEEN = { seen_proof_id: 77, seen_proof_answer: 'changes' };
  const ymd = (days) => chicagoDay(new Date(Date.now() + days * 86400000));
  const Harness = forwardRef(function Harness({ menu, proposal, loadProposal }, ref) {
    const review = useMenuReview({ menu, proposal, loadProposal });
    useImperativeHandle(ref, () => review);
    return null;
  });
  const setup = ({ eventDate = ymd(10), print = PRINT, proof = PROOF } = {}) => {
    const menu = { payload: { print, proof }, refetch: jest.fn(() => Promise.resolve()) };
    const loadProposal = jest.fn(() => Promise.resolve());
    const ref = React.createRef();
    render(<Harness ref={ref} menu={menu} proposal={{ id: 42, event_date: eventDate }} loadProposal={loadProposal} />);
    return { ref, menu, loadProposal };
  };
  const press = async (ref, kind) => {
    act(() => ref.current.ask(kind));
    await act(async () => { await ref.current.go(); });
  };

  test('Release for printing confirms over the approved pair and the proof it showed, posts them, and refetches the proposal and the draft', async () => {
    let finish;
    api.post.mockImplementation(() => new Promise((r) => { finish = r; }));
    const { ref, menu, loadProposal } = setup();
    act(() => ref.current.ask('release'));
    expect(ref.current.confirm).toEqual({ kind: 'release', afterEvent: false, body: { version: 4, art_version: 2, ...SEEN } });
    let going;
    act(() => { going = ref.current.go(); });
    expect(ref.current.confirm).toBeNull();
    expect(ref.current.busy).toBe('release');
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release', { version: 4, art_version: 2, ...SEEN });
    await act(async () => { finish({ data: {} }); await going; });
    expect(menu.refetch).toHaveBeenCalledTimes(1);
    expect(loadProposal).toHaveBeenCalledTimes(1);
    expect(ref.current.busy).toBeNull();
    expect(ref.current.error).toBeNull();
  });

  test('after the event day the confirm names the duty and the post carries after_event true; Put it back posts the same route', async () => {
    api.post.mockResolvedValue({ data: {} });
    const { ref } = setup({ eventDate: `${ymd(-3)}T00:00:00.000Z`, print: { state: 'removed', restorable: true, approved_version: 4, approved_art_version: 2 },
      proof: null });
    act(() => ref.current.ask('put-back'));
    expect(ref.current.confirm).toMatchObject({ kind: 'put-back', afterEvent: true });
    await act(async () => { await ref.current.go(); });
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/release',
      { version: 4, art_version: 2, seen_proof_id: '', seen_proof_answer: '', after_event: true });
  });

  test.each([
    ['added', 'Released. The $5 print duty was added.'],
    ['pending', 'Released. The print duty will be added when the event is completed.'],
    ['not_added', "Released. This event's pay period is closed, so no print duty was added."],
    ['check_payroll', "Released. No print duty was added. Check this event's duty lines in payroll."],
  ])('after the event day the landed release says what happened to the duty (%s), until the next action', async (duty, line) => {
    api.post.mockResolvedValue({ data: { duty } });
    const { ref } = setup({ eventDate: `${ymd(-3)}T00:00:00.000Z` });
    await press(ref, 'release');
    expect(ref.current.notice).toBe(line);
    act(() => ref.current.ask('release'));
    expect(ref.current.notice).toBe('');
    await act(async () => { await ref.current.go(); });
    expect(ref.current.notice).toBe(line);
    act(() => ref.current.clearNotice());
    expect(ref.current.notice).toBe('');
  });

  test('a release before the event day, or a duty the page does not know, says nothing of the duty', async () => {
    api.post.mockResolvedValue({ data: { duty: 'added' } });
    const { ref } = setup();
    await press(ref, 'release');
    expect(ref.current.notice).toBe('');
    api.post.mockResolvedValue({ data: { duty: 'constructor' } });
    const after = setup({ eventDate: `${ymd(-3)}T00:00:00.000Z` });
    await press(after.ref, 'release');
    expect(after.ref.current.notice).toBe('');
  });

  test('a 409 MENU_EVENT_PASSED (the day turned while the page was open) reopens the confirm in its after-event form', async () => {
    api.post.mockRejectedValueOnce({ status: 409, code: 'MENU_EVENT_PASSED', message: 'x' });
    const { ref } = setup();
    await press(ref, 'release');
    expect(ref.current.confirm).toMatchObject({ kind: 'release', afterEvent: true });
    expect(ref.current.error).toBeNull();
    api.post.mockResolvedValueOnce({ data: {} });
    await act(async () => { await ref.current.go(); });
    expect(api.post).toHaveBeenLastCalledWith('/proposals/42/menu-draft/release', { version: 4, art_version: 2, ...SEEN, after_event: true });
  });

  test.each([
    [{ status: 409, code: 'MENU_NOT_HELD' }, null],
    // The client answered since the page loaded: refetched, so the owner sees the answer, then can act knowingly.
    [{ status: 409, code: 'MENU_PROOF_CHANGED' }, "The client's review changed. Refresh to see it."],
    [{ status: 409, code: 'LEGAL_HOLD' }, "This event is on hold and can't be changed."],
    [{ status: 409, code: 'MENU_MARKED_NONE' }, 'This event is marked as needing no printed menu. Clear the mark first.'],
    [{ status: 409, code: 'MENU_PRINT_CHANGED' }, 'A different print file is live now. Refresh to see it.'],
    [{ status: 409, code: 'MENU_DRAFT_CHANGED' }, "That didn't go through. Try again."],
    [{ status: 500, code: 'INTERNAL_ERROR' }, "That didn't go through. Try again."],
    [new TypeError('Failed to fetch'), "That didn't go through. Try again."],
  ])('release refused with %p: its line, and a refusal refetches', async (rejection, line) => {
    api.post.mockRejectedValue({ message: 'server words', ...rejection });
    const { ref, menu } = setup();
    await press(ref, 'release');
    expect(ref.current.error).toEqual(line === null ? null : { kind: 'release', text: line });
    expect(menu.refetch).toHaveBeenCalledTimes(rejection.status === 409 ? 1 : 0);
  });

  test('Close request posts the proof the page showed; MENU_PROOF_CHANGED only refetches, anything else says so', async () => {
    api.post.mockResolvedValueOnce({ data: {} });
    const { ref, menu } = setup({ print: { state: 'approved', held: false } });
    act(() => ref.current.ask('close'));
    expect(ref.current.confirm).toEqual({ kind: 'close', body: { proof_id: 77 } });
    await act(async () => { await ref.current.go(); });
    expect(api.post).toHaveBeenCalledWith('/proposals/42/menu-draft/proof/close', { proof_id: 77 });
    expect(menu.refetch).toHaveBeenCalledTimes(1);
    api.post.mockRejectedValueOnce({ status: 409, code: 'MENU_PROOF_CHANGED', message: 'x' });
    await press(ref, 'close');
    expect(ref.current.error).toBeNull();
    expect(menu.refetch).toHaveBeenCalledTimes(2);
    api.post.mockRejectedValueOnce({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
    await press(ref, 'close');
    expect(ref.current.error).toEqual({ kind: 'close', text: "That didn't go through. Try again." });
  });

  test('one write at a time, and Cancel posts nothing', async () => {
    api.post.mockImplementation(() => new Promise(() => {}));
    const { ref } = setup();
    act(() => ref.current.ask('release'));
    act(() => ref.current.cancel());
    expect(ref.current.confirm).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    act(() => ref.current.ask('release'));
    act(() => { ref.current.go(); });
    act(() => ref.current.ask('release'));
    act(() => { ref.current.go(); });
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
