import { drawSoftBacking, drawBadgeShadow, _clearSoftBackingCacheForTest, RADIUS_X, RADIUS_Y, BADGE } from './softBacking';

// jsdom has no 2D canvas, so the context is a recorder.
function fakeContext() {
  const calls = [];
  const gradient = { stops: [], addColorStop(at, color) { this.stops.push([at, color]); } };
  const ctx = {
    calls,
    gradient,
    translate: (...a) => calls.push(['translate', ...a]),
    scale: (...a) => calls.push(['scale', ...a]),
    createRadialGradient: (...a) => { calls.push(['createRadialGradient', ...a]); return gradient; },
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    arcTo: (...a) => calls.push(['arcTo', ...a]),
    closePath: () => calls.push(['closePath']),
    fill: () => calls.push(['fill']),
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set shadowColor(v) { calls.push(['shadowColor', v]); },
    set shadowBlur(v) { calls.push(['shadowBlur', v]); },
    set shadowOffsetX(v) { calls.push(['shadowOffsetX', v]); },
    set shadowOffsetY(v) { calls.push(['shadowOffsetY', v]); },
  };
  return ctx;
}

let ctx;
let getContext;
let toDataURL;

beforeEach(() => {
  _clearSoftBackingCacheForTest();
  ctx = fakeContext();
  getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  toDataURL = jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,SOFT');
});

afterEach(() => {
  getContext.mockRestore();
  toDataURL.mockRestore();
});

test('paints the 60% x 56% feather at .8, .58 at 58% and 0 at 86%', () => {
  expect(drawSoftBacking('15,24,48')).toBe('data:image/png;base64,SOFT');
  expect(RADIUS_X).toBe(480);
  expect(RADIUS_Y).toBe(560);
  expect(ctx.calls).toContainEqual(['translate', 400, 500]);
  expect(ctx.calls).toContainEqual(['scale', 480 / 560, 1]);
  expect(ctx.calls).toContainEqual(['createRadialGradient', 0, 0, 0, 0, 0, 560]);
  expect(ctx.gradient.stops).toEqual([
    [0, 'rgba(15,24,48,0.8)'],
    [0.58, 'rgba(15,24,48,0.58)'],
    [0.86, 'rgba(15,24,48,0)'],
    [1, 'rgba(15,24,48,0)'],
  ]);
  expect(ctx.calls).toContainEqual(['fillStyle', ctx.gradient]);
  // The fill covers the whole 800 x 1000 canvas in the squeezed space.
  const fill = ctx.calls.find((c) => c[0] === 'fillRect');
  expect(fill[1] * (480 / 560)).toBeCloseTo(-400);
  expect(fill[3] * (480 / 560)).toBeCloseTo(800);
  expect(fill.slice(2)).toEqual([-500, expect.any(Number), 1000]);
});

test('a missing or malformed ground reads as the light ground', () => {
  drawSoftBacking(null);
  expect(ctx.gradient.stops[0]).toEqual([0, 'rgba(252,248,250,0.8)']);
});

test('caches per color', () => {
  drawSoftBacking('1,2,3');
  drawSoftBacking('1,2,3');
  expect(getContext).toHaveBeenCalledTimes(1);
  drawSoftBacking('4,5,6');
  expect(getContext).toHaveBeenCalledTimes(2);
});

test('no 2D canvas means no backing image', () => {
  getContext.mockImplementation(() => null);
  expect(drawSoftBacking('7,8,9')).toBeNull();
});

describe('drawBadgeShadow', () => {
  test("the snapshot's 0 3px 14px rgba(0,0,0,.28), cast from a 20 px rounded rect drawn off the canvas", () => {
    expect(drawBadgeShadow(124, 116)).toBe('data:image/png;base64,SOFT');
    expect(BADGE).toMatchObject({ radius: 20, blur: 14, offsetY: 3, alpha: 0.28, pad: 20 });
    expect(ctx.calls).toContainEqual(['shadowColor', 'rgba(0,0,0,0.28)']);
    expect(ctx.calls).toContainEqual(['shadowBlur', 14]);
    expect(ctx.calls).toContainEqual(['shadowOffsetY', 3]);
    const offX = ctx.calls.find((c) => c[0] === 'shadowOffsetX')[1];
    // The shape starts off the canvas; its shadow lands at (pad, pad + 3).
    const start = ctx.calls.find((c) => c[0] === 'moveTo');
    expect(start[1] + offX).toBe(20 + 20);
    expect(start[2]).toBe(20);
    expect(ctx.calls.filter((c) => c[0] === 'arcTo').map((c) => c[5])).toEqual([20, 20, 20, 20]);
    expect(ctx.calls).toContainEqual(['fill']);
  });

  test('no size, or no 2D canvas, means no shadow; results are cached by size', () => {
    expect(drawBadgeShadow(0, 10)).toBeNull();
    drawBadgeShadow(50, 40);
    drawBadgeShadow(50.2, 39.8);
    expect(getContext).toHaveBeenCalledTimes(1);
    getContext.mockImplementation(() => null);
    expect(drawBadgeShadow(60, 40)).toBeNull();
  });
});
