// Exports EXPORT_SCALE, PRINT_W, PRINT_H, JPEG_QUALITY, MenuExportError, defaultLayerName,
// exportMenu, ExportCanvas and 2 more. Header generated from the file's exports by migrate-headers
// on 2026-10-27; replace with what it does.

import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../utils/api';
import MenuCanvas from './MenuCanvas';
import { ensureFontsLink, pairingFaces, pairingFor } from './fontPairings';
import { FULL_SIZE } from './useMenuLayers';

// The print export and Approve (spec 2026-10-01 sections 8, Approve 1; 10.3,
// Loading; 11.3; Review Focus 4; plan Task D3).
//
// exportMenu({ node, pairingId, nameOf?, timeoutMs?, onBeforeRender? }) -> a JPEG Blob, 2400 x
//   3000. node is the hidden, unscaled 800 x 1000 MenuCanvas (ExportCanvas
//   below, never the scaled preview). In order, each wait timing out at 10 s:
//   the pairing's font link (injected when missing), document.fonts.load for
//   each face of the pairing, document.fonts.ready; then every layer the print
//   needs (no data-mc-pending placeholder left, every img[data-mc-layer]
//   loaded, the two mark images included). Then html2canvas at scale 3 and
//   toBlob('image/jpeg', 0.92). A failure rejects with a MenuExportError that
//   names the font or the layer (nameOf(layerKey) -> its name). onBeforeRender
//   (node) runs just before html2canvas reads the node, so a caller can note
//   what is drawn (or throw to stop the render).
// ExportCanvas: that hidden instance, from an approve snapshot plus the live
//   full-size layers, so a layer still loading lands in it.
// useApproveMenu({ menu, loadProposal, beforeSave }) -> { run({ expectedPrintKey }),
//   approving, error, clearError, exportProps }: flush the autosave, render the export
//   from the draft as saved, export it, POST it with version, art_version,
//   expected_print_key and (logo role) expected_planner_image_rev, then
//   refetch the proposal and the draft. A 409 refetches both; its reason is
//   keyed on the code, never the message. An export failure goes to client
//   Sentry with { area: 'menu-designer', step: 'export' }.

export const EXPORT_SCALE = 3;
export const PRINT_W = 2400;
export const PRINT_H = 3000;
export const JPEG_QUALITY = 0.92;
const WAIT_MS = 10000;
const POLL_MS = 100;

export class MenuExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MenuExportError';
  }
}

const fail = (message) => new MenuExportError(message);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const frame = () => new Promise((resolve) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 16);
});

async function waitFonts(pairingId, ms) {
  const pairing = pairingFor(pairingId);
  const faces = pairingFaces(pairing.id);
  const families = [...new Set(faces.map((f) => f.family))].join(', ');
  const link = ensureFontsLink([pairing.id]);
  if (link && link.getAttribute('data-loaded') !== 'true' && !link.sheet) {
    const loaded = new Promise((resolve, reject) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => reject(fail(`The ${families} fonts didn't load.`)), { once: true });
    });
    await withTimeout(loaded, ms, `The ${families} fonts didn't load.`);
  }
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts || typeof fonts.load !== 'function') throw fail("This browser can't load the menu fonts.");
  await Promise.all(faces.map(async (f) => {
    const message = `The ${f.family} font didn't load.`;
    // A load that throws or rejects (a DOMException) still names the font.
    const loading = new Promise((resolve, reject) => {
      try {
        Promise.resolve(fonts.load(`${f.weight} 32px "${f.family}"`)).then(resolve, () => reject(fail(message)));
      } catch (err) {
        reject(fail(message));
      }
    });
    const got = await withTimeout(loading, ms, message);
    // An empty answer means no face matched: the print would use a fallback.
    if (!Array.isArray(got) || got.length === 0 || got.some((face) => face && face.status && face.status !== 'loaded')) throw fail(message);
  }));
  if (fonts.ready) await withTimeout(Promise.resolve(fonts.ready), ms, `The ${families} fonts didn't finish loading.`);
}

function waitImage(img, ms, name) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  const message = `${name} didn't load.`;
  return withTimeout(new Promise((resolve, reject) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', () => reject(fail(message)), { once: true });
  }), ms, message);
}

async function waitLayers(node, ms, nameOf) {
  const started = Date.now();
  let pending = node.querySelector('[data-mc-pending]');
  while (pending) {
    if (Date.now() - started >= ms) throw fail(`${nameOf(pending.getAttribute('data-mc-pending'))} didn't load.`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    pending = node.querySelector('[data-mc-pending]');
  }
  const imgs = [...node.querySelectorAll('img[data-mc-layer]')];
  await Promise.all(imgs.map((img) => waitImage(img, ms, nameOf(img.getAttribute('data-mc-layer')))));
}

const LAYER_NAME = {
  background: 'The background', logo: 'The client logo', avatar: 'The Dr. Bartender avatar',
  wordmark: 'The Dr. Bartender wordmark', backing: 'The text backing', 'badge-shadow': "The logo badge's shadow",
};
export const defaultLayerName = (key) => LAYER_NAME[key] || `The art for ${key}`;

export async function exportMenu({ node, pairingId, nameOf = defaultLayerName, timeoutMs = WAIT_MS, onBeforeRender } = {}) {
  if (!node) throw fail('The menu is not ready to export.');
  await waitFonts(pairingId, timeoutMs);
  await waitLayers(node, timeoutMs, nameOf);
  // Two frames, so a refit after the fonts landed has painted (renderToFile.js).
  await frame();
  await frame();
  const html2canvas = (await import('html2canvas')).default;
  if (onBeforeRender) onBeforeRender(node);
  const canvas = await html2canvas(node, {
    scale: EXPORT_SCALE, useCORS: true, logging: false, backgroundColor: '#ffffff', width: 800, height: 1000,
  });
  if (!canvas || canvas.width !== PRINT_W || canvas.height !== PRINT_H) {
    throw fail(`The export came out at ${canvas ? canvas.width : 0} x ${canvas ? canvas.height : 0}, not 2400 x 3000.`);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(fail("The menu couldn't be saved as a JPEG."))), 'image/jpeg', JPEG_QUALITY);
  });
}

// The hidden, unscaled instance html2canvas renders (11.3): no editor
// affordances, no slot states, the wordmark pre-tinted, drinks square.
export const ExportCanvas = forwardRef(function ExportCanvas({ snap, layers, plannerUrl }, ref) {
  if (!snap || !snap.content) return null;
  return (
    <div className="md-export" aria-hidden="true">
      <MenuCanvas ref={ref} content={snap.content} inputs={snap.inputs} pieces={snap.pieces} layers={layers}
        plannerImage={snap.hasPlanner ? { url: plannerUrl || null } : null} editable={false} />
    </div>
  );
});

const CODE_REASON = {
  MENU_DRAFT_CHANGED: 'The draft changed. Approve again.',
  MENU_PRINT_CHANGED: 'The print file changed since you confirmed. Check it and approve again.',
  MENU_WORDS_PENDING: 'The menu words are still being written. Try again once they land.',
  MENU_WORDS_NOT_WRITTEN: 'The menu words were not written. Start over to write them.',
};

export function approveReason(err, step) {
  if (step === 'save') return "Your last change didn't save. Retry it, then approve.";
  if (step === 'export') return err instanceof MenuExportError ? err.message : "The menu couldn't be rendered for print. Try again.";
  if (err && CODE_REASON[err.code]) return CODE_REASON[err.code];
  const first = err && err.fieldErrors ? Object.values(err.fieldErrors).find(Boolean) : null;
  if (first) return String(first);
  // The api.js shape (a numeric status) carries a sentence written for people;
  // anything else (a TypeError, a DOMException) is never shown as is.
  return err && Number.isInteger(err.status) && err.message ? err.message : 'Something went wrong. Please try again.';
}

function snapshotOf(m) {
  const p = m.payload || {};
  const d = m.draft || {};
  const inputs = d.inputs || {};
  const brief = p.brief || {};
  return {
    proposalId: m.proposalId, content: d.content, inputs, pieces: p.pieces,
    version: d.version, artVersion: d.art_version,
    logoRole: (inputs.planner_image_role || 'logo') === 'logo', hasPlanner: !!brief.has_planner_image,
  };
}

export function useApproveMenu({ menu, loadProposal, beforeSave }) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const [snap, setSnap] = useState(null);
  const live = useRef(menu);
  live.current = menu;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const nodeRef = useRef(null);
  const inFlight = useRef(false);
  const waiters = useRef([]);
  // After every commit: resolve the waits whose condition now holds.
  useEffect(() => { waiters.current = waiters.current.filter((w) => !w()); });
  const committed = (pred) => new Promise((resolve) => {
    waiters.current.push(() => (pred() ? (resolve(), true) : false));
  });

  // expectedPrintKey: the print key at the moment Dallas clicked (or confirmed
  // over), never one a later poll brought in.
  const run = useCallback(async ({ expectedPrintKey = '' } = {}) => {
    // One approval at a time, whatever calls it twice.
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setApproving(true);
    let step = 'save';
    try {
      if (beforeSave) beforeSave();
      await live.current.flush();
      step = 'export';
      // A render after the save landed, so the snapshot is the draft as saved.
      const prep = { prep: true };
      setSnap(prep);
      await committed(() => snapRef.current === prep);
      const s = snapshotOf(live.current);
      if (!s.content) throw fail('There is no draft to approve.');
      setSnap(s);
      await committed(() => snapRef.current === s && !!nodeRef.current);
      const node = nodeRef.current;
      const names = new Map((Array.isArray(s.content.drinks) ? s.content.drinks : []).map((d) => [d && d.key, d && d.display_name]));
      // The rev of the logo actually drawn, read the moment html2canvas reads the
      // node: the image in it must be the hook's current one, whose rev it posts.
      let rev = '';
      const noteLogo = (n) => {
        const logo = n.querySelector('img[data-mc-layer="logo"]');
        if (!s.logoRole || !logo) return;
        const m = live.current;
        if (logo.getAttribute('src') !== m.plannerImages[FULL_SIZE]) throw fail('The client image changed. Approve again.');
        rev = m.plannerImageRevs[FULL_SIZE] || '';
      };
      const blob = await exportMenu({
        node, pairingId: s.content.font_pairing, onBeforeRender: noteLogo,
        nameOf: (k) => (names.get(k) ? `The art for ${names.get(k)}` : defaultLayerName(k)),
      });
      step = 'post';
      const form = new FormData();
      form.append('file', blob, 'bar-menu.jpg');
      form.append('version', String(s.version));
      form.append('art_version', String(s.artVersion));
      form.append('expected_print_key', expectedPrintKey || '');
      if (s.logoRole) form.append('expected_planner_image_rev', rev);
      await api.post(`/proposals/${s.proposalId}/menu-draft/approve`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      step = 'done';
      // It is approved: a refetch that fails now is not a failed approval.
      await Promise.all([loadProposal ? loadProposal() : null, live.current.refetch()]).catch(() => {});
    } catch (err) {
      if (step === 'export') Sentry.captureException(err, { tags: { area: 'menu-designer', step: 'export' } });
      setError(approveReason(err, step));
      if (step === 'post' && err && err.status === 409) {
        await Promise.all([loadProposal ? loadProposal() : null, live.current.refetch()]).catch(() => {});
      }
    } finally {
      inFlight.current = false;
      setSnap(null);
      setApproving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProposal, beforeSave]);

  const clearError = useCallback(() => setError(null), []);
  const exportProps = {
    ref: nodeRef, snap: snap && !snap.prep ? snap : null,
    layers: (menu.layers && menu.layers[FULL_SIZE]) || {}, plannerUrl: menu.plannerImages ? menu.plannerImages[FULL_SIZE] : null,
  };
  return { run, approving, error, clearError, exportProps };
}
