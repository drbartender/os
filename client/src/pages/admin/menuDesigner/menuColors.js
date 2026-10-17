// The printed menu's colors (spec 2026-10-01 section 11.2, Colors, Mark and
// Text backing; table P). Pure. The menu uses no OS tokens: every color here
// comes from table P, the draft's ink_color / accent_color / mark_color, and
// the background piece's tone and ground_rgb.
//
// resolveColors({ pairing, tone, ink, accent, markColor }) -> { ink, accent, mark }
//   pairing: a pairing id (an unknown one reads as the default pairing).
//   tone: the background piece's tone; 'dark' picks the dark-art set, and
//     'light', null or anything else picks the light set. The caller passes
//     null while the background is not drawn yet (the light set applies).
//   ink, accent: the draft's overrides; a #rrggbb value wins, anything else
//     (null included) falls back to the set.
//   markColor: 'ink' (the default), 'accent' or 'gold' (#d9b77e).
// groundRgb(value) -> a safe 'r,g,b' for the text backing, from the
//   background piece's ground_rgb, or the light ground when it is missing.

import { pairingFor } from './fontPairings';

export const GOLD = '#d9b77e';
export const MARK_COLORS = Object.freeze(['ink', 'accent', 'gold']);

// The snapshot's light scrim ('252,248,250', the garden ground): the backing
// color when ground_rgb is null, which is also when the light ink set applies.
export const DEFAULT_GROUND_RGB = '252,248,250';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v) => typeof v === 'string' && HEX_RE.test(v);

export function resolveColors({ pairing, tone, ink, accent, markColor } = {}) {
  const p = pairingFor(pairing);
  const set = tone === 'dark' ? p.dark : p.light;
  const resolvedInk = isHex(ink) ? ink : set.ink;
  const resolvedAccent = isHex(accent) ? accent : set.accent;
  let mark = resolvedInk;
  if (markColor === 'accent') mark = resolvedAccent;
  else if (markColor === 'gold') mark = GOLD;
  return { ink: resolvedInk, accent: resolvedAccent, mark };
}

export function groundRgb(value) {
  if (typeof value !== 'string') return DEFAULT_GROUND_RGB;
  const parts = value.split(',').map((s) => s.trim());
  if (parts.length !== 3) return DEFAULT_GROUND_RGB;
  const nums = parts.map((s) => (/^\d{1,3}$/.test(s) ? Number(s) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) return DEFAULT_GROUND_RGB;
  return nums.join(',');
}

export const rgba = (rgb, alpha) => `rgba(${groundRgb(rgb)},${alpha})`;

// The opaque color of the ground at `alpha` laid over a #rrggbb color: the
// Panel backing's 7 px ring, which the snapshot drew as a ground-at-.86 inset
// shadow over an 8 px accent one (html2canvas 1.4.1 inverts those layers, so
// the ring is drawn as a plain border in the color the browser composited).
export function overlay(rgb, alpha, hex) {
  const g = groundRgb(rgb).split(',').map(Number);
  const h = isHex(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : g;
  return `rgb(${g.map((c, i) => Math.round(alpha * c + (1 - alpha) * h[i])).join(',')})`;
}
