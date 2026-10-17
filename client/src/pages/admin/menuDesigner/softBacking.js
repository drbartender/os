// The Soft text backing as an image layer (spec 2026-10-01 sections 11.2,
// Text backing, and 11.3). The snapshot drew it as a CSS radial gradient,
//   radial-gradient(ellipse 60% 56% at 50% 50%,
//     rgba(g,.8), rgba(g,.58) 58%, rgba(g,0) 86%)
// and this paints the same feather on an offscreen 800 x 1000 canvas, so the
// export places a picture of it instead of depending on html2canvas's
// gradient support.
//
// drawSoftBacking(groundRgb) -> a PNG data URL, or null where there is no 2D
//   canvas (jsdom). groundRgb is the background piece's 'r,g,b'; a missing or
//   malformed one reads as the light ground. Results are cached per color.

import { groundRgb, rgba } from './menuColors';

export const CANVAS_W = 800;
export const CANVAS_H = 1000;

// The ellipse's radii: 60% of the width and 56% of the height.
export const RADIUS_X = CANVAS_W * 0.6;
export const RADIUS_Y = CANVAS_H * 0.56;

export const STOPS = Object.freeze([[0, 0.8], [0.58, 0.58], [0.86, 0], [1, 0]]);

const MAX_CACHED = 16;
const cache = new Map();

function context2d(canvas) {
  try {
    return canvas.getContext('2d');
  } catch (err) {
    return null;
  }
}

export function drawSoftBacking(value) {
  const rgb = groundRgb(value);
  if (cache.has(rgb)) return cache.get(rgb);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = context2d(canvas);
  if (!ctx) return null;
  // A circle of radius RADIUS_Y, squeezed horizontally into the ellipse.
  const sx = RADIUS_X / RADIUS_Y;
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
  ctx.scale(sx, 1);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, RADIUS_Y);
  STOPS.forEach(([at, alpha]) => g.addColorStop(at, rgba(rgb, alpha)));
  ctx.fillStyle = g;
  ctx.fillRect(-CANVAS_W / 2 / sx, -CANVAS_H / 2, CANVAS_W / sx, CANVAS_H);
  let url = null;
  try {
    url = canvas.toDataURL('image/png');
  } catch (err) {
    url = null;
  }
  if (!url) return null;
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(rgb, url);
  return url;
}

// The logo badge's soft shadow (11.2: "on #fbf8f2 with a 20 px radius, 10/14
// padding and a soft shadow"; the snapshot's 0 3px 14px rgba(0,0,0,.28)).
// html2canvas 1.4.1 paints a blurred outer box-shadow over the element's own
// background, which would print the badge grey, so the shadow is an image
// too, placed under an opaque badge face.
//
// drawBadgeShadow(width, height) -> a PNG data URL of the shadow of a width x
//   height badge, padded by BADGE.pad on every side (place it at -pad, -pad
//   behind the face), or null where there is no 2D canvas.
export const BADGE = Object.freeze({ radius: 20, blur: 14, offsetY: 3, alpha: 0.28, pad: 20 });

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawBadgeShadow(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0 && h > 0) || typeof document === 'undefined') return null;
  const key = `badge:${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = w + 2 * BADGE.pad;
  canvas.height = h + 2 * BADGE.pad;
  const ctx = context2d(canvas);
  if (!ctx) return null;
  // The shape is drawn off the canvas and only its shadow is offset back on.
  const off = canvas.width + 100;
  ctx.shadowColor = `rgba(0,0,0,${BADGE.alpha})`;
  ctx.shadowBlur = BADGE.blur;
  ctx.shadowOffsetX = off;
  ctx.shadowOffsetY = BADGE.offsetY;
  ctx.fillStyle = '#000';
  roundRectPath(ctx, BADGE.pad - off, BADGE.pad, w, h, BADGE.radius);
  ctx.fill();
  let url = null;
  try {
    url = canvas.toDataURL('image/png');
  } catch (err) {
    url = null;
  }
  if (!url) return null;
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(key, url);
  return url;
}

export function _clearSoftBackingCacheForTest() {
  cache.clear();
}
