// MenuCardFold (React component, default export): the Bar menu card's fold, its Print file, Client image and
// Client review rows with each row's actions, and useCopyLink, the Copy link the card shares.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import Icon from '../../../components/adminos/Icon';
import KebabMenu from '../../../components/adminos/KebabMenu';
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
import { shortDate, reviewValue, canCopyLink, canCloseRequest } from './menuCardState';
import { seenProof } from './exportMenu';

// The Bar menu card's fold (spec 2026-10-01 section 11.1, decision 12): the
// Print file and Client image rows, carrying every action of the two cards
// they replace, AdminMenuPrintBlock (the print file) and EventDetailPlanLogo
// (the client's planner image). They read the proposal and the plan the page
// already loaded, so they keep working when the menu draft GET fails; the
// draft payload only adds the approved date and the image's role.
//
// Props:
//   proposalId, menuPrintKey, menuNotRequired   from the loaded proposal
//   print          the draft payload's print block, or null
//   drinkPlan      the loaded plan (null: none); planLoading while it loads
//   setDrinkPlan   the page's setter; the client-image actions update the
//                  plan's selections through it (DrinkPlanCard and MenuPNG read it)
//   onPrintChange  after a print-file change (reloads the proposal and the draft)
//   onImageChange  after a client-image change (refetches the draft and the image)
//   role           the planner image's role (Logo on top before any draft)
//   thumbUrl       the planner image at ?w=240, or null (then the plan's
//                  companyLogo, when isSafeLogoUrl allows it)
//   review         the Client review row's facts, or null while the draft GET
//                  has not landed (then the row is not drawn): { proof, print
//                  (the GET's blocks), narrow, busyLabel (a review write's
//                  running label, or null), onRelease, onClose, onReadNotes
//                  (null when the editor cannot open) }
// The Client review row (spec 2026-10-19 section 14, a third Print file row):
// the latest proof's line (menuCardState reviewValue), Copy link while the
// link is live (Copied for 2 s; a failure is the row's alert), and a kebab
// with Release for printing while a file is held, Read the client's notes for
// a change request, and Close request for one on a released menu (spec 10.3);
// below 900 px it keeps Copy link and drops the kebab. A running review write
// shows its label in place of the line. The card owns the writes and their
// confirms (exportMenu useMenuReview); the row only asks.
// The Print file row reads the menu's own released file as the approved menu
// even beside a newer held one, never as an upload. Its Remove names the file
// it showed (expected_print_key), and its Upload and Replace file name it with
// the latest proof the review row showed (seen_proof_id, seen_proof_answer); a
// 409 MENU_PRINT_CHANGED (Remove, the upload, the no-menu mark) or
// MENU_PROOF_CHANGED (the upload) says so and reloads the proposal and the draft.

// Defense in depth: even though the server sanitizes companyLogo on every PUT,
// admins click `<a href={companyLogo}>` here. A historical `javascript:` value
// stored before the server-side sanitizer landed could still execute in the
// admin session. The check mirrors the server-side allowlist: same-origin
// `/api/drink-plans/t/` OR absolute URL whose host matches our API origin.
// Anything else (attacker domain, javascript:, data:, file:, http: on the
// public internet) is refused.
export function isSafeLogoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/api/drink-plans/t/')) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!u.pathname.startsWith('/api/drink-plans/t/')) return false;
    const apiUrl = process.env.REACT_APP_API_URL;
    if (!apiUrl) return false;
    return u.host === new URL(apiUrl).host;
  } catch {
    return false;
  }
}

// Mirrors the server's MAX_FILE_SIZE default (server/index.js fileUpload limits).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ROLE_LABEL = { logo: 'Logo on top', reference: 'Style reference', ignore: 'Ignored' };

// api.js normalizes every rejection to { message, code, fieldErrors, status }.
// Bad magic bytes come back on fieldErrors.file (fieldErrors.logo for the
// image). Oversize does NOT: express-fileupload's abortOnLimit sends a
// plain-text 413, which api.js cannot parse into a field error, so the print
// file's size is checked here before the request instead. Everything else
// (the 409 on the not-required flip, network) is a plain message. With no
// field named, the first field error the server sent is read (the card's).
export function errorText(err, fallback, field) {
  const errors = err?.fieldErrors || {};
  const fieldMsg = field ? errors[field] : Object.values(errors).find((v) => typeof v === 'string' && v);
  if (typeof fieldMsg === 'string' && fieldMsg) return fieldMsg;
  return err?.message || fallback;
}

// The print states in which the live file is the menu's own (menuPrintState.js).
const OWN_FILE = new Set(['held', 'approved', 'edited_since_approval']);

// The flag reads from the loaded proposal, so it never depends on the chip.
function printValue(print, menuPrintKey, menuNotRequired) {
  if (menuPrintKey) {
    const p = print || {};
    if (p.print_key === menuPrintKey && p.approved_file_in_use) return `Approved menu · ${shortDate(p.approved_at)}`;
    // An older released file staff still have (a newer one held, or edited since): its release's day.
    if (p.print_key === menuPrintKey && OWN_FILE.has(p.state)) return `Approved menu · ${shortDate(p.released_at || p.approved_at)}`;
    return 'Uploaded file';
  }
  if (menuNotRequired) return 'No menu needed';
  return print && print.state === 'removed' ? 'Removed' : 'None yet';
}

// KebabMenu's trigger is titled "More actions" everywhere; each row's gets its
// own accessible name, set on the rendered trigger.
function NamedKebab({ label, items }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const trigger = ref.current && ref.current.querySelector('.kebab-trigger');
    if (trigger) trigger.setAttribute('aria-label', label);
  });
  return <span ref={ref} className="md-fold-kebab"><KebabMenu items={items} /></span>;
}

const Alert = ({ children }) => (children ? <p className="chip danger md-alert" role="alert">{children}</p> : null);

const COPIED_MS = 2000;
const COPY_FAILED = "Couldn't copy. Open the editor to approve again.";

// Copy link (spec 14): the clipboard, "Copied" for 2 s, or the failure line.
export function useCopyLink() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (url) => {
    setError('');
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
      setError(COPY_FAILED);
    }
  };
  return { copy, copied, error };
}

// The codes for a card that is stale (another file live, or a client answer it
// never saw): each says its sentence and reloads the proposal and the draft.
const STALE_CODES = new Set(['MENU_PRINT_CHANGED', 'MENU_PROOF_CHANGED']);

function PrintFileRow({ proposalId, menuPrintKey, menuNotRequired, print, proof, onPrintChange }) {
  const fileInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const hasFile = !!menuPrintKey;
  const path = `/proposals/${proposalId}/menu-print`;

  // Upload, replace, remove and the not-required flip share one busy flag and
  // reload the proposal (and the draft's print state) after success. A 409
  // MENU_PRINT_CHANGED (another file went live since the card loaded) or, for
  // an upload, MENU_PROOF_CHANGED (the client answered since) says so and
  // reloads them too, so the row shows what is true now.
  const run = async (work, fallback) => {
    setError('');
    setBusy(true);
    try {
      await work();
      if (onPrintChange) await onPrintChange();
    } catch (err) {
      setError(errorText(err, fallback, 'file'));
      if (err && err.status === 409 && STALE_CODES.has(err.code) && onPrintChange) await onPrintChange().catch(() => {});
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is too large. Keep the print file under 10MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    // Upload and Replace file post what the card showed: the file, and the
    // latest proof ('' each for none, or before the draft GET lands).
    const seen = seenProof(proof);
    const form = new FormData();
    form.append('file', file);
    form.append('expected_print_key', shownKey);
    form.append('seen_proof_id', String(seen.seen_proof_id));
    form.append('seen_proof_answer', seen.seen_proof_answer);
    run(() => api.post(path, form, { headers: { 'Content-Type': 'multipart/form-data' } }), 'Upload failed.');
  };
  // Remove and the upload name the file the card showed (the print block's
  // key, else the proposal's), so neither unposts one a client's Looks great just released.
  const shownKey = print ? print.print_key || '' : menuPrintKey || '';
  const remove = () => run(() => api.delete(path, { data: { expected_print_key: shownKey } }), 'Failed to remove the menu file.');
  const setNotRequired = (notRequired) => run(() => api.patch(path, { not_required: notRequired }), 'Failed to update the menu status.');
  const pick = () => fileInputRef.current?.click();

  // The posted file, read back through the admin route. Its own flag, not
  // `busy`: downloading never blocks an upload, and an upload never blocks
  // reading the old file.
  const download = async () => {
    setDownloading(true);
    setError('');
    try {
      await downloadMenuPrint(path);
    } catch (err) {
      setError(errorText(err, 'Could not download the menu file.', 'file'));
    } finally {
      setDownloading(false);
    }
  };

  const pv = busy ? 'Working...' : printValue(print, menuPrintKey, menuNotRequired);
  const items = hasFile
    ? [{ label: 'Replace file', icon: 'pen', onClick: pick, disabled: busy }, { label: 'Remove', icon: 'x', onClick: remove, disabled: busy }]
    : [{ label: menuNotRequired ? 'A menu is needed after all' : 'No menu needed for this event', onClick: () => setNotRequired(!menuNotRequired), disabled: busy }];

  return (
    <div className="md-fold-sec">
      <div className="md-fold-row">
        <input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={handleFileChange} hidden data-testid="menu-print-input" />
        <div className="md-fold-main">
          <div className="meta-k">Print file</div>
          {/* The full value on hover, where a narrow row ellipsizes it. */}
          <div className="md-fold-v" title={pv}>{pv}</div>
        </div>
        {hasFile ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={download} disabled={downloading}>
            <Icon name="download" size={11} />{downloading ? 'Downloading...' : 'Download'}
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={pick} disabled={busy}>Upload</button>
        )}
        <NamedKebab label="Print file actions" items={items} />
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}

function ClientImageRow({ drinkPlan, planLoading, setDrinkPlan, onImageChange, role, thumbUrl }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const companyLogo = drinkPlan?.selections?.companyLogo || '';
  const thumb = thumbUrl || (isSafeLogoUrl(companyLogo) ? companyLogo : null);

  // The admin logo routes answer with the plan's merged selections; the page
  // keeps them so the drink plan card and the house-menu button read the new
  // image at once (the server already persisted it, an atomic JSONB merge).
  const run = async (work, fallback) => {
    setError('');
    setUploading(true);
    try {
      const res = await work();
      if (res.data?.selections && setDrinkPlan) setDrinkPlan((prev) => (prev ? { ...prev, selections: res.data.selections } : prev));
      if (onImageChange) onImageChange();
    } catch (err) {
      setError(errorText(err, fallback, 'logo'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('logo', file);
    run(() => api.post(`/drink-plans/${drinkPlan.id}/logo`, form, { headers: { 'Content-Type': 'multipart/form-data' } }), 'Upload failed.');
  };
  const remove = () => run(() => api.delete(`/drink-plans/${drinkPlan.id}/logo`), 'Failed to remove logo.');
  const pick = () => fileInputRef.current?.click();

  let value;
  if (planLoading && !drinkPlan) value = '';
  else if (!drinkPlan) value = 'No drink plan';
  else if (uploading) value = 'Uploading...';
  else if (!companyLogo) value = 'No image';
  else value = ROLE_LABEL[role] || ROLE_LABEL.logo;

  const items = [
    { label: 'Replace', icon: 'pen', onClick: pick, disabled: uploading },
    { label: 'Remove', icon: 'x', onClick: remove, disabled: uploading },
  ];
  // A KebabMenu href would navigate the admin tab away; open a new one instead.
  if (isSafeLogoUrl(companyLogo)) {
    items.push({ label: 'Download original', icon: 'download', onClick: () => window.open(companyLogo, '_blank', 'noopener,noreferrer') });
  }

  return (
    <div className="md-fold-sec">
      <div className="md-fold-row">
        {drinkPlan && <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" onChange={handleFileChange} hidden data-testid="menu-logo-input" />}
        {drinkPlan && companyLogo && (
          <div className="md-fold-img">{thumb && <img src={thumb} alt="" />}</div>
        )}
        <div className="md-fold-main">
          <div className="meta-k">Client image</div>
          <div className="md-fold-v" title={value || undefined}>{value}</div>
        </div>
        {drinkPlan && !companyLogo && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={pick} disabled={uploading}>Upload</button>
            {/* The kebab's width, so this Upload lines up with the Print file row's. */}
            <span className="md-fold-kebab" aria-hidden="true" />
          </>
        )}
        {drinkPlan && companyLogo && <NamedKebab label="Client image actions" items={items} />}
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}

function ClientReviewRow({ proof, print, narrow = false, busyLabel = null, onRelease, onClose, onReadNotes }) {
  const link = useCopyLink();
  const value = busyLabel || reviewValue(proof);
  const items = [];
  if (print && print.held === true) items.push({ label: 'Release for printing', onClick: () => onRelease && onRelease(), disabled: !!busyLabel });
  if (proof && proof.state === 'changes' && onReadNotes) items.push({ label: "Read the client's notes", onClick: onReadNotes });
  if (canCloseRequest(proof, print)) items.push({ label: 'Close request', onClick: () => onClose && onClose(), disabled: !!busyLabel });
  return (
    <div className="md-fold-sec">
      <div className="md-fold-row">
        <div className="md-fold-main">
          <div className="meta-k">Client review</div>
          <div className="md-fold-v" title={value}>{value}</div>
        </div>
        {canCopyLink(proof) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => link.copy(proof.url)}>{link.copied ? 'Copied' : 'Copy link'}</button>
        )}
        {!narrow && (items.length ? <NamedKebab label="Client review actions" items={items} /> : <span className="md-fold-kebab" aria-hidden="true" />)}
      </div>
      <Alert>{link.error}</Alert>
    </div>
  );
}

export default function MenuCardFold({
  proposalId, menuPrintKey = null, menuNotRequired = false, print = null,
  drinkPlan = null, planLoading = false, setDrinkPlan, onPrintChange, onImageChange, role = 'logo', thumbUrl = null, review = null,
}) {
  return (
    <div className="md-fold">
      <PrintFileRow proposalId={proposalId} menuPrintKey={menuPrintKey} menuNotRequired={menuNotRequired}
        print={print} proof={review ? review.proof : null} onPrintChange={onPrintChange} />
      <ClientImageRow drinkPlan={drinkPlan} planLoading={planLoading} setDrinkPlan={setDrinkPlan}
        onImageChange={onImageChange} role={role} thumbUrl={thumbUrl} />
      {review && <ClientReviewRow {...review} />}
    </div>
  );
}
