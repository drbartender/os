// The menu's print export and the client review's writes: renderPrintCanvas, the print file and the client proof
// encoded from that one render, Approve and send (useApproveMenu) with its confirm and codes, and Release for
// printing, Put it back for staff and Close request (useMenuReview) with theirs.

import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../utils/api';
import { chicagoDay } from '../../../utils/chicagoDay';
import MenuCanvas from './MenuCanvas';
import { ensureFontsLink, faceSetFaces, faceSetFor, pairingFor, HOUSE_FACE_SET } from './fontPairings';
import { FULL_SIZE } from './useMenuLayers';

// The print export and Approve (spec 2026-10-01 sections 8, Approve 1; 10.3,
// Loading; 11.3; Review Focus 4; plan Task D3), amended by spec 2026-10-19
// sections 10.1, 10.3 and 10.5 (lane menu-approve-send).
//
// renderPrintCanvas({ node, pairingId, nameOf?, timeoutMs?, onBeforeRender? })
//   -> the 2400 x 3000 canvas. node is the hidden, unscaled 800 x 1000
//   MenuCanvas (ExportCanvas below, never the scaled preview). In order, each
//   wait timing out at 10 s: the pairing's font link (injected when missing),
//   document.fonts.load for each face of the pairing, document.fonts.ready;
//   then every layer the print needs (no data-mc-pending placeholder left,
//   every img[data-mc-layer] loaded, the two mark images included). Then
//   html2canvas at scale 3. A failure rejects with a MenuExportError that
//   names the font or the layer (nameOf(layerKey) -> its name). onBeforeRender
//   (node) runs just before html2canvas reads the node, so a caller can note
//   what is drawn (or throw to stop the render). pairingId may be the house
//   face set ('house', fontPairings.js HOUSE_FACE_SET): a house draft prints in
//   Pirata One and the IM Fell faces, so its export waits on those, never on
//   the default pairing its null font_pairing would read as (v2 spec 9.3);
//   useApproveMenu passes faceSetFor(content).
// encodePrint(canvas) -> the print file: that canvas's own toBlob('image/jpeg',
//   0.92), byte for byte the v1 path. exportMenu(opts) is the two in a row.
// drawProof(canvas, { version, artVersion }) -> the proof canvas, 1200 x 1556
//   (spec 10.1): the render scaled to 1200 x 1500, over a 56 px band filled
//   #fbf8f3 with a 1 px #d8d2c6 hairline at its top and the text "PROOF · not
//   for print · v<version>.<art_version>" in 600 20px Inter, system-ui,
//   sans-serif, 0.08em (1.6 px) tracking, #6b665e, centred (the canvas's
//   letterSpacing where the browser has it, else drawn letter by letter).
//   encodeProof(canvas, pair) is it at toBlob('image/jpeg', 0.85). The band's
//   colors are part of the image, not the page, so they are literals here.
// ExportCanvas: that hidden instance, from an approve snapshot plus the live
//   full-size layers, so a layer still loading lands in it.
// useApproveMenu({ menu, loadProposal, beforeSave }) -> { run({ expectedPrintKey, seen }),
//   approving, error, clearError, exportProps }: flush the autosave, render
//   the export from the draft as saved, encode the print file and the proof
//   from that one render, POST both (file, proof) with version, art_version,
//   expected_print_key, seen_proof_id and seen_proof_answer (seen: what the
//   page showed of the latest proof at the press, seenProof; a 409
//   MENU_PROOF_CHANGED says the client answered since) and (logo role)
//   expected_planner_image_rev, then
//   refetch the proposal and the draft. A 409 refetches both; its reason is
//   keyed on the code, never the message, and 409 MENU_PROOF_ALREADY_SENT (the
//   same pair sent under 10 minutes ago: a double click or a retried post) is
//   success, with no message. An export failure goes to client Sentry with {
//   area: 'menu-designer', step: 'approve-export' }; the error object only,
//   never a note or the draft. approveConfirm({ noEmail }) is the copy of its
//   confirm (spec 10.5; with no email it says it creates the proof and its
//   link, never that it emails one), and hasClientEmail(proposal) the server's mailable
//   rule (an address that is set and not an .invalid placeholder).
// useMenuReview({ proposal, menu, loadProposal }) -> { busy, error, notice, settled, confirm,
//   ask(kind), go(), cancel(), clearError, clearNotice }: the review's other writes (spec
//   10.3 and 10.5), each through its confirm (reviewConfirm(kind, confirm)).
//   kind 'release' (Release for printing) and 'put-back' (Put it back for
//   staff) post /menu-draft/release with the approved pair the page showed
//   (print.approved_version, approved_art_version) and the latest proof it
//   showed (seenProof: seen_proof_id, seen_proof_answer), and after_event: true when
//   the event day is before today in Chicago (eventDayPassed, from the
//   proposal's event_date as text), whose confirm names the $5 duty instead;
//   'close' (Close request) posts /menu-draft/proof/close with the proof the
//   page showed. One write at a time; busy is the kind under way (REVIEW_BUSY
//   its label). Success, and any 409, refetches the proposal and the draft. A
//   409 MENU_NOT_HELD (released already, or clicked twice) and, for Close
//   request, MENU_PROOF_CHANGED are refusals that only refetch; a 409
//   MENU_EVENT_PASSED (the day turned while the page sat open) reopens the
//   confirm in its after-event form; LEGAL_HOLD, MENU_MARKED_NONE,
//   MENU_PRINT_CHANGED and, for a release, MENU_PROOF_CHANGED (the client
//   answered since the page loaded) say their sentence; anything else "That didn't go
//   through. Try again." error is { kind, text }. notice is the one line a
//   landed after-event release or Put it back leaves (the 200's duty: what
//   happened to the $5 print duty, DUTY_LINE), cleared by the next ask or
//   clearNotice (the card and the editor call it on their other actions).
//   settled counts the writes that landed or were refused (not one whose
//   confirm reopened): the card focuses its heading and the editor its banner
//   region on each, since the pressed trigger is disabled, then gone.

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
  const setId = pairingId === HOUSE_FACE_SET ? HOUSE_FACE_SET : pairingFor(pairingId).id;
  const faces = faceSetFaces(setId);
  const families = [...new Set(faces.map((f) => f.family))].join(', ');
  const link = ensureFontsLink([setId]);
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

export async function renderPrintCanvas({ node, pairingId, nameOf = defaultLayerName, timeoutMs = WAIT_MS, onBeforeRender } = {}) {
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
  return canvas;
}

function toJpeg(canvas, quality, message) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(fail(message))), 'image/jpeg', quality);
  });
}

// The print file: the render's own JPEG, as v1 encoded it.
export const encodePrint = (canvas) => toJpeg(canvas, JPEG_QUALITY, "The menu couldn't be saved as a JPEG.");

export async function exportMenu(opts = {}) {
  return encodePrint(await renderPrintCanvas(opts));
}

// The client proof (spec 2026-10-19 section 10.1).
export const PROOF_W = 1200;
export const PROOF_H = 1556;
export const PROOF_ART_H = 1500;
export const PROOF_QUALITY = 0.85;
const BAND = Object.freeze({
  fill: '#fbf8f3', rule: '#d8d2c6', ink: '#6b665e', font: '600 20px Inter, system-ui, sans-serif', tracking: 1.6,
});
export const proofBandText = (version, artVersion) => `PROOF · not for print · v${version}.${artVersion}`;

// The band's line, centred with its tracking: the canvas's letterSpacing where
// the browser has it (half a step right, since it trails the last letter too),
// else one letter at a time.
function drawTracked(ctx, text, x, y, tracking) {
  if (typeof ctx.letterSpacing === 'string') {
    ctx.letterSpacing = `${tracking}px`;
    ctx.textAlign = 'center';
    ctx.fillText(text, x + tracking / 2, y);
    return;
  }
  const chars = Array.from(text);
  const widths = chars.map((c) => ctx.measureText(c).width);
  let at = x - (widths.reduce((a, w) => a + w, 0) + tracking * (chars.length - 1)) / 2;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, at, y);
    at += widths[i] + tracking;
  });
}

export function drawProof(canvas, { version, artVersion }) {
  const out = document.createElement('canvas');
  out.width = PROOF_W;
  out.height = PROOF_H;
  const ctx = out.getContext('2d');
  if (!ctx) throw fail("The proof couldn't be drawn.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, PROOF_W, PROOF_ART_H);
  ctx.fillStyle = BAND.fill;
  ctx.fillRect(0, PROOF_ART_H, PROOF_W, PROOF_H - PROOF_ART_H);
  ctx.fillStyle = BAND.rule;
  ctx.fillRect(0, PROOF_ART_H, PROOF_W, 1);
  ctx.fillStyle = BAND.ink;
  ctx.font = BAND.font;
  ctx.textBaseline = 'middle';
  drawTracked(ctx, proofBandText(version, artVersion), PROOF_W / 2, PROOF_ART_H + (PROOF_H - PROOF_ART_H) / 2, BAND.tracking);
  return out;
}

export async function encodeProof(canvas, pair) {
  return toJpeg(drawProof(canvas, pair), PROOF_QUALITY, "The proof couldn't be saved as a JPEG.");
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

const ON_HOLD = "This event is on hold and can't be changed.";
const MARKED = 'This event is marked as needing no printed menu. Clear the mark first.';
// The client answered since the page loaded (the page does not poll): 409 MENU_PROOF_CHANGED.
const REVIEW_CHANGED = "The client's review changed. Refresh to see it.";

// What the page shows of the draft's latest proof, as Release, Put it back and
// Approve post it back (seen_proof_id, seen_proof_answer; empty for none).
export function seenProof(proof) {
  const p = proof && typeof proof === 'object' ? proof : null;
  return {
    seen_proof_id: p && Number.isInteger(p.id) ? p.id : '',
    seen_proof_answer: p && (p.answer === 'approved' || p.answer === 'changes') ? p.answer : '',
  };
}
const CODE_REASON = {
  MENU_DRAFT_CHANGED: 'The draft changed. Approve again.',
  MENU_PRINT_CHANGED: 'The print file changed since you confirmed. Check it and approve again.',
  MENU_WORDS_PENDING: 'The menu words are still being written. Try again once they land.',
  MENU_WORDS_NOT_WRITTEN: 'The menu words were not written. Start over to write them.',
  MENU_EVENT_PASSED: "This event has passed, so there's nothing to send.",
  MENU_PROOF_SEND_CAP: "You've sent this menu 5 times today. Try again tomorrow.",
  MENU_PROOF_ARCHIVED: 'This event is archived, so there is no one to send it to.',
  MENU_MARKED_NONE: MARKED,
  LEGAL_HOLD: ON_HOLD,
  MENU_UPLOAD_LIVE: 'Your uploaded file is what staff print. Remove it first to send this menu.',
  MENU_PROOF_CHANGED: REVIEW_CHANGED,
};
// The same pair sent under 10 minutes ago (spec 10.2): the first post landed.
const ALREADY_SENT = 'MENU_PROOF_ALREADY_SENT';

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

// Approve and send's confirm (spec 10.5). With no email on file the body says
// it creates the proof, never that it emails one (the spec's two sentences
// contradicted each other when joined).
const LATER = "Staff can print it once the client says it looks great or you release it. Edits you make after this won't change what they see.";
const APPROVE_TEXT = `Emails the client a proof of the menu as it is now, with a link to say it looks great or ask for changes. ${LATER}`;
const NO_EMAIL_TEXT = `Creates a proof of the menu as it is now, with a link the client can use to say it looks great or ask for changes. ${LATER} `
  + 'No email is on file for this client, so no email goes out. Copy the link from the card and send it yourself.';
export function approveConfirm({ noEmail = false } = {}) {
  return {
    title: 'Approve and send to the client?', text: noEmail ? NO_EMAIL_TEXT : APPROVE_TEXT,
    actionLabel: noEmail ? 'Approve and create link' : 'Approve and send', actionClass: 'btn btn-primary',
  };
}

// The server's mailable rule (menuDraftApprove.js): set, and not an RFC 2606 .invalid placeholder.
export function hasClientEmail(proposal) {
  const email = proposal && typeof proposal.client_email === 'string' ? proposal.client_email.trim() : '';
  return email !== '' && !email.toLowerCase().endsWith('.invalid');
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
  // over), never one a later poll brought in; seen: what the page showed of the
  // latest proof then (seenProof), else what it shows at the run.
  const run = useCallback(async ({ expectedPrintKey = '', seen = null } = {}) => {
    const shown = seen || seenProof(live.current && live.current.payload ? live.current.payload.proof : null);
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
      // One render, two files (spec 10.1): the print file as v1, and the proof.
      const canvas = await renderPrintCanvas({
        node, pairingId: faceSetFor(s.content), onBeforeRender: noteLogo,
        nameOf: (k) => (names.get(k) ? `The art for ${names.get(k)}` : defaultLayerName(k)),
      });
      const blob = await encodePrint(canvas);
      const proof = await encodeProof(canvas, { version: s.version, artVersion: s.artVersion });
      step = 'post';
      const form = new FormData();
      form.append('file', blob, 'bar-menu.jpg');
      form.append('proof', proof, 'bar-menu-proof.jpg');
      form.append('version', String(s.version));
      form.append('art_version', String(s.artVersion));
      form.append('expected_print_key', expectedPrintKey || '');
      form.append('seen_proof_id', String(shown.seen_proof_id));
      form.append('seen_proof_answer', shown.seen_proof_answer);
      if (s.logoRole) form.append('expected_planner_image_rev', rev);
      await api.post(`/proposals/${s.proposalId}/menu-draft/approve`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      step = 'done';
      // It is approved: a refetch that fails now is not a failed approval.
      await Promise.all([loadProposal ? loadProposal() : null, live.current.refetch()]).catch(() => {});
    } catch (err) {
      if (step === 'export') Sentry.captureException(err, { tags: { area: 'menu-designer', step: 'approve-export' } });
      const sent = step === 'post' && err && err.status === 409 && err.code === ALREADY_SENT;
      if (!sent) setError(approveReason(err, step));
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

// ── Release for printing, Put it back for staff, Close request ─────────────

const RETRY = "That didn't go through. Try again.";
const AFTER_EVENT = 'This event has passed. Releasing now adds the $5 print duty for the staff on it if its pay period is still open.';
// What an after-event release left of the $5 print duty (the 200's duty, menuDraftRelease.js).
const DUTY_LINE = new Map([
  ['added', 'Released. The $5 print duty was added.'],
  ['pending', 'Released. The print duty will be added when the event is completed.'],
  ['not_added', "Released. This event's pay period is closed, so no print duty was added."],
  ['check_payroll', "Released. No print duty was added. Check this event's duty lines in payroll."],
]);
const REVIEW_REASON = {
  LEGAL_HOLD: ON_HOLD,
  MENU_MARKED_NONE: MARKED,
  MENU_PRINT_CHANGED: 'A different print file is live now. Refresh to see it.',
  MENU_PROOF_CHANGED: REVIEW_CHANGED,
};
export const REVIEW_BUSY = Object.freeze({ release: 'Releasing...', 'put-back': 'Putting it back...', close: 'Closing...' });
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// The event day (the proposal's event_date, read as text) is before today in Chicago.
export function eventDayPassed(eventDate, today = chicagoDay(new Date())) {
  const ymd = eventDate ? String(eventDate).slice(0, 10) : '';
  return YMD.test(ymd) && ymd < today;
}

// The copy of each review confirm (spec 10.3 and 10.5); afterEvent names the duty instead.
export function reviewConfirm(kind, { afterEvent = false } = {}) {
  if (kind === 'close') {
    return { title: 'Close this request?', actionLabel: 'Close request', actionClass: 'btn btn-primary',
      text: "The menu stays as it is for staff. The client's link will say the menu is no longer open for review." };
  }
  if (kind === 'put-back') {
    return { title: 'Put this menu back for staff?', actionLabel: 'Put it back for staff', actionClass: 'btn btn-primary',
      text: afterEvent ? AFTER_EVENT : 'Staff will be able to download and print it again.' };
  }
  return { title: 'Release for printing?', actionLabel: 'Release for printing', actionClass: 'btn btn-primary',
    text: afterEvent ? AFTER_EVENT : 'Staff will be able to download and print this menu now, without waiting for the client.' };
}

export const reviewReason = (err) => (err && REVIEW_REASON[err.code]) || RETRY;

export function useMenuReview({ proposal, menu, loadProposal }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState('');
  // Counts the writes that settled (landed or refused, the confirm not reopened):
  // the card and the editor move focus off the gone trigger on each.
  const [settled, setSettled] = useState(0);
  const live = useRef(menu);
  live.current = menu;
  const inFlight = useRef(false);
  const proposalId = proposal ? proposal.id : null;
  const eventDate = proposal ? proposal.event_date : null;

  // What the page showed at the press: the approved pair, or the proof.
  const ask = useCallback((kind) => {
    const p = (live.current && live.current.payload) || {};
    setError(null);
    setNotice('');
    if (kind === 'close') {
      if (p.proof && Number.isInteger(p.proof.id)) setConfirm({ kind, body: { proof_id: p.proof.id } });
      return;
    }
    const print = p.print || {};
    setConfirm({
      kind, afterEvent: eventDayPassed(eventDate),
      body: { version: print.approved_version, art_version: print.approved_art_version, ...seenProof(p.proof) },
    });
  }, [eventDate]);

  const refresh = useCallback(
    () => Promise.all([loadProposal ? loadProposal() : null, live.current.refetch()]).catch(() => {}),
    [loadProposal],
  );

  const go = useCallback(async () => {
    const c = confirm;
    setConfirm(null);
    if (!c || inFlight.current || proposalId === null) return;
    inFlight.current = true;
    setBusy(c.kind);
    let reopened = false;
    try {
      if (c.kind === 'close') await api.post(`/proposals/${proposalId}/menu-draft/proof/close`, c.body);
      else {
        const res = await api.post(`/proposals/${proposalId}/menu-draft/release`, c.afterEvent ? { ...c.body, after_event: true } : c.body);
        const duty = c.afterEvent && res && res.data ? DUTY_LINE.get(res.data.duty) : null;
        if (duty) setNotice(duty);
      }
      await refresh();
    } catch (err) {
      const code = err && err.status === 409 ? err.code : null;
      if (code) await refresh();
      reopened = code === 'MENU_EVENT_PASSED' && c.kind !== 'close';
      if (reopened) setConfirm({ ...c, afterEvent: true });
      else if (code !== 'MENU_NOT_HELD' && !(c.kind === 'close' && code === 'MENU_PROOF_CHANGED')) {
        setError({ kind: c.kind, text: reviewReason(err) });
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
      // A reopened confirm takes focus itself.
      if (!reopened) setSettled((n) => n + 1);
    }
  }, [confirm, proposalId, refresh]);

  const cancel = useCallback(() => setConfirm(null), []);
  const clearError = useCallback(() => setError(null), []);
  const clearNotice = useCallback(() => setNotice(''), []);
  return { busy, error, notice, settled, confirm, ask, go, cancel, clearError, clearNotice };
}
