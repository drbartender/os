// The printed menu's six font pairings (spec 2026-10-01 section 11.2, table P;
// section 10.3). The ids are fixed and shared with the server
// (server/utils/menuFontPairings.js, FONT_PAIRING_IDS): the server knows only
// the ids, and the faces, sizes and default colors live here.
//
// The 2026-10-01 snapshot (menu-designer.html, PAIRINGS) keyed them by design
// name. Its keys map to the fixed ids like this:
//   script -> elegant-script, rustic -> rustic, modern -> modern-clean,
//   disco -> retro, spooky -> spooky, tropical -> tropical.
//
// Each face is { family, stack, size (canvas px), weight, transform, tracking }.
// light and dark are the default { ink, accent } for light art and dark art.
//
// fontsHref(pairingIds) -> one Google Fonts css2 URL for those pairings ('' for
//   none). Loaded through a plain <link rel="stylesheet">, never the
//   media="print" swap AdminLayout uses (it lets document.fonts.ready resolve
//   before the faces are declared, and the export would print in fallbacks).
// ensureFontsLink(pairingIds) -> the one <link data-menu-fonts> for that URL,
//   added to <head> once; it gains data-loaded="true" when its load fires.
// pairingFaces(id) -> the distinct [{ family, weight }] one pairing uses.
// useFontsRevision(pairingIds) -> ensures those pairings' link and returns a
//   number that goes up when the link loads and whenever the document's fonts
//   finish loading, so the canvas refits once real faces replace fallbacks.

import { useEffect, useState } from 'react';

export const PAIRING_IDS = Object.freeze([
  'elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical',
]);

export const DEFAULT_PAIRING_ID = 'elegant-script';

const face = (family, fallback, size, weight, transform = 'none', tracking = '0') => ({
  family, stack: `'${family}', ${fallback}`, size, weight, transform, tracking,
});

export const PAIRINGS = Object.freeze({
  'elegant-script': {
    id: 'elegant-script', designKey: 'script', name: 'Garden Script', theme: 'Elegant script',
    title: face('Pinyon Script', "'Snell Roundhand', cursive", 88, 400),
    heading: face('Cormorant Garamond', 'Georgia, serif', 25, 700),
    body: face('Cormorant Garamond', 'Georgia, serif', 17.5, 500),
    light: { ink: '#2c2238', accent: '#8a6a2f' },
    dark: { ink: '#f5eedf', accent: '#dcbc6e' },
  },
  rustic: {
    id: 'rustic', designKey: 'rustic', name: 'Barn & Ledger', theme: 'Rustic',
    title: face('Rye', 'Georgia, serif', 60, 400, 'none', '.02em'),
    heading: face('Alegreya SC', 'Georgia, serif', 22, 700, 'none', '.02em'),
    body: face('Alegreya', 'Georgia, serif', 16, 400),
    light: { ink: '#33251a', accent: '#8e3b1c' },
    dark: { ink: '#f2e7d3', accent: '#e5a45a' },
  },
  'modern-clean': {
    id: 'modern-clean', designKey: 'modern', name: 'Gallery', theme: 'Clean modern',
    title: face('Josefin Sans', "'Helvetica Neue', sans-serif", 54, 300, 'uppercase', '.32em'),
    // Table P sets no case on the names (the snapshot's data carried an
    // uppercase here that its CSS never read).
    heading: face('Josefin Sans', "'Helvetica Neue', sans-serif", 18, 600, 'none', '.1em'),
    body: face('Karla', "'Helvetica Neue', sans-serif", 15, 400),
    light: { ink: '#1d232b', accent: '#3d5c8c' },
    dark: { ink: '#eef2f6', accent: '#a7c4f2' },
  },
  retro: {
    id: 'retro', designKey: 'disco', name: 'Mirror Ball', theme: 'Retro / disco',
    title: face('Shrikhand', 'Georgia, serif', 68, 400),
    heading: face('Righteous', "'Trebuchet MS', sans-serif", 21, 400, 'none', '.01em'),
    body: face('Work Sans', "'Helvetica Neue', sans-serif", 15, 400),
    light: { ink: '#2a1838', accent: '#c8336f' },
    dark: { ink: '#fcf0f7', accent: '#ffb0d0' },
  },
  spooky: {
    id: 'spooky', designKey: 'spooky', name: 'Hollow', theme: 'Spooky',
    title: face('Creepster', 'Impact, fantasy', 84, 400, 'none', '.03em'),
    heading: face('IM Fell English SC', 'Georgia, serif', 23, 400, 'none', '.02em'),
    body: face('IM Fell English', 'Georgia, serif', 16, 400),
    light: { ink: '#1f1a15', accent: '#8d2f10' },
    dark: { ink: '#f0e7d7', accent: '#f2902e' },
  },
  tropical: {
    id: 'tropical', designKey: 'tropical', name: 'Tiki Hour', theme: 'Tropical',
    title: face('Pacifico', "'Brush Script MT', cursive", 64, 400),
    heading: face('Fredoka', "'Trebuchet MS', sans-serif", 22, 600),
    body: face('Nunito Sans', "'Helvetica Neue', sans-serif", 15, 400),
    light: { ink: '#173a38', accent: '#cf4f37' },
    dark: { ink: '#f2fbf6', accent: '#ffb27a' },
  },
});

export function isPairingId(id) {
  return typeof id === 'string' && PAIRING_IDS.includes(id);
}

// An unknown or missing id reads as the default pairing.
export function pairingFor(id) {
  return PAIRINGS[isPairingId(id) ? id : DEFAULT_PAIRING_ID];
}

export function pairingFaces(id) {
  const p = pairingFor(id);
  const seen = new Set();
  const out = [];
  for (const f of [p.title, p.heading, p.body]) {
    const k = `${f.family}|${f.weight}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ family: f.family, weight: f.weight });
    }
  }
  return out;
}

export const FONTS_BASE = 'https://fonts.googleapis.com/css2';

// Families in first-seen order, each with its weights ascending (the css2 API
// refuses unsorted weights). A family used only at 400 needs no axis.
export function fontsHref(pairingIds) {
  const ids = (Array.isArray(pairingIds) ? pairingIds : [pairingIds]).filter(isPairingId);
  const families = new Map();
  for (const id of ids) {
    for (const f of pairingFaces(id)) {
      if (!families.has(f.family)) families.set(f.family, new Set());
      families.get(f.family).add(f.weight);
    }
  }
  if (families.size === 0) return '';
  const parts = [...families].map(([family, weights]) => {
    const name = family.replace(/ /g, '+');
    const list = [...weights].sort((a, b) => a - b);
    return list.length === 1 && list[0] === 400 ? `family=${name}` : `family=${name}:wght@${list.join(';')}`;
  });
  return `${FONTS_BASE}?${parts.join('&')}&display=swap`;
}

export function ensureFontsLink(pairingIds, doc = typeof document !== 'undefined' ? document : null) {
  const href = fontsHref(pairingIds);
  if (!href || !doc || !doc.head) return null;
  const found = Array.from(doc.head.querySelectorAll('link[data-menu-fonts]'))
    .find((l) => l.getAttribute('href') === href);
  if (found) return found;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-menu-fonts', '');
  link.addEventListener('load', () => link.setAttribute('data-loaded', 'true'));
  doc.head.appendChild(link);
  return link;
}

export function useFontsRevision(pairingIds) {
  const ids = (Array.isArray(pairingIds) ? pairingIds : [pairingIds]).filter(isPairingId).join(',');
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    const bump = () => { if (live) setRev((n) => n + 1); };
    // The stylesheet arriving declares the faces; each loading cycle then
    // settles in fonts.ready. Either can land after a fit, so both refit.
    const link = ids ? ensureFontsLink(ids.split(',')) : null;
    if (link && link.getAttribute('data-loaded') !== 'true') link.addEventListener('load', bump);
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    const settle = () => { if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(bump, () => {}); };
    settle();
    const listen = fonts && typeof fonts.addEventListener === 'function';
    if (listen) {
      fonts.addEventListener('loading', settle);
      fonts.addEventListener('loadingdone', bump);
    }
    return () => {
      live = false;
      if (link) link.removeEventListener('load', bump);
      if (listen && typeof fonts.removeEventListener === 'function') {
        fonts.removeEventListener('loading', settle);
        fonts.removeEventListener('loadingdone', bump);
      }
    };
  }, [ids]);
  return rev;
}
