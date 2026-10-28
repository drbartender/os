// Exports WORDMARK_SRC, tintWordmark, loadWordmark, useTintedWordmark, _resetWordmarkForTest.
// Header generated from the file's exports by migrate-headers on 2026-10-27; replace with what it
// does.

import { useEffect, useState } from 'react';

// The Dr. Bartender wordmark, tinted before it is placed (spec 2026-10-01
// sections 11.2, Mark, and 11.3). The v3 files color it with a CSS mask, which
// html2canvas does not draw, so the PNG is drawn to an offscreen canvas,
// filled with the mark color under source-in (the fill keeps only the
// wordmark's own pixels, at their own alpha) and placed as an image, in the
// preview and the export alike. The PNG is same origin
// (client/public/images), so the canvas is never tainted.
//
// tintWordmark(img, color) -> a PNG data URL, or null where there is no 2D
//   canvas or the image has no size yet.
// loadWordmark() -> a promise of the loaded wordmark <img>, shared by every
//   caller; a failed load is forgotten so the next call tries again.
// useTintedWordmark(color) -> the tinted data URL for that color, or null
//   until it is ready (MenuCanvas marks the wordmark pending meanwhile).

export const WORDMARK_SRC = `${process.env.PUBLIC_URL || ''}/images/menu-mark-wordmark.png`;

export function tintWordmark(img, color) {
  const w = (img && (img.naturalWidth || img.width)) || 0;
  const h = (img && (img.naturalHeight || img.height)) || 0;
  if (!w || !h || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch (err) {
    ctx = null;
  }
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  try {
    return canvas.toDataURL('image/png');
  } catch (err) {
    return null;
  }
}

let wordmarkPromise = null;

export function loadWordmark() {
  if (!wordmarkPromise) {
    wordmarkPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        wordmarkPromise = null;
        reject(new Error('The Dr. Bartender wordmark did not load.'));
      };
      img.src = WORDMARK_SRC;
    });
  }
  return wordmarkPromise;
}

const MAX_CACHED = 24;
const tinted = new Map();

export function useTintedWordmark(color) {
  const [state, setState] = useState({ color: null, url: null });
  const cached = color ? tinted.get(color) : null;

  useEffect(() => {
    if (!color || tinted.has(color)) return undefined;
    let live = true;
    loadWordmark()
      .then((img) => {
        const url = tintWordmark(img, color);
        if (url) {
          if (tinted.size >= MAX_CACHED) tinted.delete(tinted.keys().next().value);
          tinted.set(color, url);
        }
        if (live) setState({ color, url });
      })
      .catch(() => {
        if (live) setState({ color, url: null });
      });
    return () => { live = false; };
  }, [color]);

  if (cached) return cached;
  return state.color === color ? state.url : null;
}

export function _resetWordmarkForTest() {
  wordmarkPromise = null;
  tinted.clear();
}
