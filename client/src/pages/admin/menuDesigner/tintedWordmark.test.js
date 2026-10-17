import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { tintWordmark, loadWordmark, useTintedWordmark, _resetWordmarkForTest, WORDMARK_SRC } from './tintedWordmark';

function recorder() {
  const calls = [];
  return {
    calls,
    drawImage: (...a) => calls.push(['drawImage', ...a]),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    set globalCompositeOperation(v) { calls.push(['op', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
  };
}

let ctx;
let getContext;
let toDataURL;
const RealImage = global.Image;

beforeEach(() => {
  _resetWordmarkForTest();
  ctx = recorder();
  getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  toDataURL = jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,TINTED');
});

afterEach(() => {
  getContext.mockRestore();
  toDataURL.mockRestore();
  global.Image = RealImage;
});

test('draws the wordmark, then fills it with the color under source-in', () => {
  const img = { naturalWidth: 987, naturalHeight: 112 };
  expect(tintWordmark(img, '#d9b77e')).toBe('data:image/png;base64,TINTED');
  expect(ctx.calls).toEqual([
    ['drawImage', img, 0, 0, 987, 112],
    ['op', 'source-in'],
    ['fillStyle', '#d9b77e'],
    ['fillRect', 0, 0, 987, 112],
  ]);
});

test('an image with no size yet, or no 2D canvas, gives no tint', () => {
  expect(tintWordmark({ naturalWidth: 0, naturalHeight: 0 }, '#000000')).toBeNull();
  getContext.mockImplementation(() => null);
  expect(tintWordmark({ naturalWidth: 10, naturalHeight: 2 }, '#000000')).toBeNull();
});

// jsdom never fires image loads, so Image is a stand-in that loads (or fails)
// on the next tick.
function fakeImage({ fail = false } = {}) {
  const made = [];
  global.Image = class {
    constructor() { this.naturalWidth = 987; this.naturalHeight = 112; made.push(this); }
    set src(v) {
      this.srcValue = v;
      setTimeout(() => (fail ? this.onerror() : this.onload()), 0);
    }
  };
  return made;
}

test('loadWordmark loads the public PNG once and shares it', async () => {
  const made = fakeImage();
  const a = await loadWordmark();
  const b = await loadWordmark();
  expect(a).toBe(b);
  expect(made).toHaveLength(1);
  expect(made[0].srcValue).toBe(WORDMARK_SRC);
  expect(WORDMARK_SRC).toMatch(/\/images\/menu-mark-wordmark\.png$/);
});

test('a failed load is forgotten so the next call tries again', async () => {
  fakeImage({ fail: true });
  await expect(loadWordmark()).rejects.toThrow('did not load');
  const made = fakeImage();
  await loadWordmark();
  expect(made).toHaveLength(1);
});

function Probe({ color }) {
  const url = useTintedWordmark(color);
  return <span data-testid="url">{url || 'none'}</span>;
}

test('useTintedWordmark is null until the tint is ready, then the data URL', async () => {
  fakeImage();
  render(<Probe color="#2c2238" />);
  expect(screen.getByTestId('url')).toHaveTextContent('none');
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('data:image/png;base64,TINTED'));
  expect(ctx.calls).toContainEqual(['fillStyle', '#2c2238']);
});

test('a color change never shows the old color while the new one tints', async () => {
  fakeImage();
  toDataURL.mockImplementationOnce(() => 'data:A').mockImplementationOnce(() => 'data:B');
  const { rerender } = render(<Probe color="#111111" />);
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('data:A'));
  rerender(<Probe color="#222222" />);
  expect(screen.getByTestId('url')).toHaveTextContent('none');
  await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('data:B'));
  rerender(<Probe color="#111111" />);
  expect(screen.getByTestId('url')).toHaveTextContent('data:A');
});
