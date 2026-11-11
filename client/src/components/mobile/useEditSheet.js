// useEditSheet (default export): what the phone edit sheet reads and writes, for an event
// (EventDetailPhone) or, with variant 'proposal', a proposal (ProposalDetailPhone).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { initialFormFromProposal, recoverAddonQuantities, pricedDurationHours } from '../../pages/admin/proposalEditor/formState';
import { buildProposalPatchBody, staffNotifyFlags } from '../../pages/admin/proposalEditor/patchBody';
import {
  detectNumBartendersOverride, storedGratuityOf, isClassPackageFor, buildCalculateBody, packageBartendersFor,
} from '../../pages/admin/proposalEditor/editorCore';
import { initialDrafts, buildNotifyEntries, draftsOverCap, noticeOutcomes } from '../comms/notifyDrafts';
import {
  readoutView, fieldsChanged, sheetBasis, basisMoved, saveErrorText, curfewReason, sheetValuesOf, editLockedReason,
  READ_TIMEOUT_MS, SHEET_COPY, proposalLockedReason, proposalRowsOf, proposalSheetValuesOf, proposalFormOf,
  bartenderStepView,
} from '../../utils/editSheetView';
import { ctDay } from '../adminos/format';

// Everything the phone edit sheet (lane ma-e3) reads and writes; EditSheet.js
// draws. Spec 2026-08-13-mobile-admin section 3, brainstorm decisions of
// 2026-10-05.
//
// Reads are FRESH: plain api.get, which the admin service worker neither
// stores nor answers (only offlineRead.js asks it to). A money sheet never
// opens on a stored copy (spec section 7). Every read, and the read-only
// preview and preflight, carry the read timeout and nothing else, so a hung
// request fails visibly; the PATCH carries none (a timed-out write can still
// commit).
//
// The save sends the desktop editor's complete payload (buildProposalPatchBody)
// on the desktop editor's own form state (initialFormFromProposal,
// recoverAddonQuantities, the override detection), with the four sheet fields
// replaced: the PATCH treats a missing add-on list as "delete every add-on".
// It sends the lines as read with the read's adjustments_token, and never the
// retired price override (absent, the server keeps it; spec 2026-10-16). It
// leaves out the venue keys (the sheet never edits location), never sends the
// gratuity mandate, never writes the client contact.
//
// One write at a time (a ref: a double tap sends one request). Every PATCH
// re-reads the event first and refuses when what the save rests on moved since
// the sheet opened (sheetBasis: the payload it writes back, the add-on rows
// included, the readout's money and the lock; the on-site-extension overwrite
// moves the hours). A client page view moves updated_at and none of that, so
// it no longer refuses. The server refuses lines that moved between that
// re-read and the PATCH (409 STALE_EDIT); the sheet says so the same way, with
// Reload.
//
// The proposal variant (plan 2026-11-05, lane proposal-edit-sheet) is the same
// machinery on a proposal, with two more kinds of row: Bartenders, whose
// stepper moves only the Additional Bartender add-on, and the count-taking
// add-ons already on the proposal (editSheetView.js proposalRowsOf). Their
// counts join the form (proposalFormOf), the preview's body and the change
// test; the save is still buildProposalPatchBody on the desktop's own form, so
// every other add-on, its variant and its count ride as read, and the standing
// bartender override still travels. The phone prices nothing: the readout is
// the server's /calculate. Its fresh read is locked unless the detail would
// open the sheet (proposalLockedReason), and its words name a proposal.
//
// onMoved (optional; the proposal detail passes it): told whenever the row the
// page shows may no longer be the row on the server, so the page reads it again
// when the sheet closes: a PATCH going out (answered or not; one with no answer
// may have landed), a save refused because the row moved, and an opening read
// that finds the row locked. The event detail passes none and re-reads on save.
export const LOAD_FAILED = SHEET_COPY.event.loadFailed;
export const CURFEW_DECLINED = 'Not saved. The end time is past our 2:00 AM service curfew.';
const NO_STAFF = { enabled: false, sms: false, email: false };
const READ = { timeout: READ_TIMEOUT_MS };
// Each variant's lock on a read. Module scope: one identity per variant.
const LOCKS = {
  event: editLockedReason,
  proposal: (p) => proposalLockedReason(p, ctDay(new Date())),
};

// The PATCH body a sheet opened on this read would send, unedited: the desktop
// editor's form, add-on recovery and override detection, as the save builds it.
function payloadOf(proposal, packages, addons) {
  const form = initialFormFromProposal(proposal);
  form.addon_quantities = recoverAddonQuantities(proposal.addons, addons, { durationHours: pricedDurationHours(proposal) });
  const selectedPkg = packages.find((p) => p.id === Number(form.package_id));
  return buildProposalPatchBody(form, {
    isClassPackage: isClassPackageFor(selectedPkg, proposal),
    numBartendersOverride: detectNumBartendersOverride(proposal, packages),
    includeGratuityMandate: false,
    includeVenue: false,
  });
}

export default function useEditSheet({ proposalId, onSaved, onMoved, previewDelayMs = 400, inFlight = false, variant = 'event' }) {
  const toast = useToast();
  const isProposal = variant === 'proposal';
  const copy = isProposal ? SHEET_COPY.proposal : SHEET_COPY.event;
  const lockOf = isProposal ? LOCKS.proposal : LOCKS.event;
  const [load, setLoad] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [values, setValues] = useState(null);
  const [preview, setPreview] = useState({ state: 'loading' });
  // The last figure that landed: it stays on screen, dimmed, while the next is on its way.
  const [shown, setShown] = useState(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const [curfew, setCurfew] = useState(null);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [staff, setStaff] = useState(NO_STAFF);
  const handlers = useRef({ onSaved, onMoved });
  handlers.current = { onSaved, onMoved };
  const moved = useCallback(() => { if (handlers.current.onMoved) handlers.current.onMoved(); }, []);

  useEffect(() => {
    let gone = false;
    setLoad({ phase: 'loading' });
    setValues(null); setError(null); setStale(false); setCurfew(null); setPending(null); setShown(null);
    Promise.all([
      api.get(`/proposals/${proposalId}`, READ),
      api.get('/proposals/packages', READ),
      api.get('/proposals/addons', READ),
    ]).then(([pRes, pkgRes, addonRes]) => {
      if (gone) return;
      const proposal = pRes.data || {};
      const locked = lockOf(proposal);
      if (locked) { setLoad({ phase: 'locked', proposal, message: locked }); moved(); return; }
      const packages = Array.isArray(pkgRes.data) ? pkgRes.data : [];
      const addons = Array.isArray(addonRes.data) ? addonRes.data : [];
      const form = initialFormFromProposal(proposal);
      form.addon_quantities = recoverAddonQuantities(proposal.addons, addons, { durationHours: pricedDurationHours(proposal) });
      const selectedPkg = packages.find((p) => p.id === Number(form.package_id));
      const rows = isProposal ? proposalRowsOf(form, packages, addons) : null;
      const base = {
        proposal,
        form,
        rows,
        initial: isProposal ? proposalSheetValuesOf(form, rows) : sheetValuesOf(form),
        override: detectNumBartendersOverride(proposal, packages),
        isClass: isClassPackageFor(selectedPkg, proposal),
        gratuity: storedGratuityOf(proposal),
        packages,
        addons,
        basis: sheetBasis(proposal, payloadOf(proposal, packages, addons), { lockOf }),
      };
      setValues(base.initial);
      setLoad({ phase: 'ready', base });
    }).catch(() => { if (!gone) setLoad({ phase: 'failed' }); });
    return () => { gone = true; };
  }, [proposalId, attempt, isProposal, lockOf, moved]);

  const base = load.phase === 'ready' ? load.base : null;
  const formNow = useMemo(() => {
    if (!base || !values) return null;
    return base.rows ? proposalFormOf(base.form, values, base.rows) : { ...base.form, ...values };
  }, [base, values]);

  // The server's own calculator, asked again whenever a priced field moves.
  // Numbered, so a late answer never describes a form it no longer matches.
  const seq = useRef(0);
  const guests = values ? values.guest_count : null;
  const hours = values ? values.event_duration_hours : null;
  // The proposal variant's add-on state, as one value, so a step on Bartenders
  // or an add-on asks again and a date or a time does not.
  const addonState = values && base && base.rows ? JSON.stringify([values.extra_bartenders, values.addon_counts]) : null;
  useEffect(() => {
    if (!base) return undefined;
    seq.current += 1;
    const mine = seq.current;
    setPreview({ state: 'loading' });
    let form = { ...base.form, guest_count: guests, event_duration_hours: hours };
    if (base.rows && addonState) {
      const [extra, counts] = JSON.parse(addonState);
      form = proposalFormOf(base.form, {
        ...base.initial, guest_count: guests, event_duration_hours: hours, extra_bartenders: extra, addon_counts: counts,
      }, base.rows);
    }
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', buildCalculateBody(
        form,
        {
          proposalId: base.proposal.id,
          numBartendersOverride: base.override,
          tipJar: base.gratuity.tipJar,
          gratuityRate: base.gratuity.rate,
          includeMandate: false,
        },
      ), READ)
        .then((res) => {
          if (mine !== seq.current) return;
          const snap = res.data || {};
          const figure = { state: 'ready', total: snap.total, gratuityTotal: snap.gratuity ? snap.gratuity.total : null };
          setPreview(figure);
          setShown(figure);
        })
        .catch(() => { if (mine === seq.current) setPreview({ state: 'failed' }); });
    }, previewDelayMs);
    return () => clearTimeout(timer);
  }, [base, guests, hours, addonState, previewAttempt, previewDelayMs]);

  const changed = !!(base && values && fieldsChanged(base.initial, values));
  const readout = base ? readoutView({ proposal: base.proposal, preview, shown, changed, inFlight }) : null;

  // The Bartenders row: the package's count at the guests now (a standing
  // override holds whatever the guests), plus the extras, and what it showed
  // when the sheet opened.
  const bartenders = useMemo(() => {
    if (!base || !base.rows || !base.rows.bartender || !values) return null;
    const at = (guestCount) => packageBartendersFor({ package_id: base.form.package_id, guest_count: guestCount }, base.packages, base.override) || 0;
    return {
      ...bartenderStepView(at(values.guest_count), values.extra_bartenders),
      wasShown: at(base.initial.guest_count) + (Number(base.initial.extra_bartenders) || 0),
    };
  }, [base, values]);

  const setValue = useCallback((field, value) => {
    setValues((cur) => (cur ? { ...cur, [field]: value } : cur));
    setError(null);
    // Book it anyway must never send values the sheet no longer shows.
    setCurfew(null);
  }, []);

  // One add-on row's count (the proposal variant).
  const setAddonCount = useCallback((addonId, count) => {
    setValues((cur) => (cur ? { ...cur, addon_counts: { ...(cur.addon_counts || {}), [addonId]: count } } : cur));
    setError(null);
    setCurfew(null);
  }, []);

  // Every PATCH re-reads first and refuses when the event moved since the
  // sheet opened. A curfew refusal is held for the inline confirm. A failure
  // before the PATCH goes out (the re-read, the preflight) reaches run's catch
  // as a definite "didn't save"; the PATCH's own failure is said here, because
  // a write that got no answer may have landed.
  const saveChecked = useCallback(async (body, notify, staffChoice) => {
    const fresh = await api.get(`/proposals/${base.proposal.id}`, READ);
    const read = fresh && fresh.data;
    const nowBasis = read ? sheetBasis(read, payloadOf(read, base.packages, base.addons), { lockOf }) : null;
    if (basisMoved(base.basis, nowBasis)) { setStale(true); setPending(null); moved(); return; }
    const payload = { ...body, ...(staffChoice ? staffNotifyFlags(staffChoice) : {}), notify };
    let res;
    // The write goes out: from here the row may change whatever answer comes.
    moved();
    try {
      res = await api.patch(`/proposals/${base.proposal.id}`, payload);
    } catch (err) {
      const reason = curfewReason(err);
      if (reason && !body.acknowledge_past_curfew) {
        setPending(null);
        setCurfew({ reason, body, notify, staff: staffChoice });
        return;
      }
      if (err && err.code === 'STALE_EDIT') { setStale(true); setPending(null); return; }
      setError(saveErrorText(err, true, copy));
      return;
    }
    toast.success(copy.saved);
    noticeOutcomes(res.data && res.data.notifications).forEach((o) => toast[o.kind](o.text));
    if (handlers.current.onSaved) handlers.current.onSaved();
  }, [base, toast, lockOf, copy, moved]);

  const run = useCallback(async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(saveErrorText(err, false, copy)); } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [copy]);

  const confirm = useCallback(() => run(async () => {
    if (!base || !formNow) return;
    const body = buildProposalPatchBody(formNow, {
      isClassPackage: base.isClass,
      numBartendersOverride: base.override,
      includeGratuityMandate: false,
      includeVenue: false,
    });
    const pre = await api.post(`/proposals/${base.proposal.id}/notify-preflight`, body, READ);
    const notices = pre.data && Array.isArray(pre.data.notices) ? pre.data.notices : [];
    if (notices.length > 0) {
      setDrafts(initialDrafts(notices));
      setStaff(NO_STAFF);
      setPending({ body, notices });
      return;
    }
    await saveChecked(body, [], null);
  }), [run, base, formNow, saveChecked]);

  const sendUpdate = useCallback(() => run(async () => {
    if (!pending) return;
    await saveChecked(pending.body, buildNotifyEntries(pending.notices, drafts), staff);
  }), [run, pending, drafts, staff, saveChecked]);

  const dontSend = useCallback(() => run(async () => {
    if (!pending) return;
    await saveChecked(pending.body, [], staff);
  }), [run, pending, staff, saveChecked]);

  const backToEdit = useCallback(() => { if (!busyRef.current) setPending(null); }, []);

  const toggleChannel = useCallback((i, ch) => {
    setDrafts((cur) => cur.map((d, j) => (j !== i ? d : {
      ...d,
      channels: d.channels.includes(ch) ? d.channels.filter((c) => c !== ch) : [...d.channels, ch],
    })));
  }, []);

  const acknowledgeCurfew = useCallback(() => run(async () => {
    if (!curfew) return;
    const held = curfew;
    setCurfew(null);
    await saveChecked({ ...held.body, acknowledge_past_curfew: true }, held.notify, held.staff);
  }), [run, curfew, saveChecked]);

  const declineCurfew = useCallback(() => { setCurfew(null); setError(CURFEW_DECLINED); }, []);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const retryPreview = useCallback(() => setPreviewAttempt((n) => n + 1), []);

  return {
    copy,
    rows: base ? base.rows : null,
    bartenders,
    setAddonCount,
    phase: load.phase,
    proposal: base ? base.proposal : (load.proposal || null),
    lockedMessage: load.message || null,
    values,
    initial: base ? base.initial : null,
    setValue,
    preview,
    retryPreview,
    readout,
    changed,
    busy,
    error,
    curfew,
    stale,
    pending,
    drafts,
    staff,
    setStaff,
    canSend: !!pending && drafts.some((d) => d.channels.length > 0) && !draftsOverCap(pending.notices, drafts),
    confirm,
    sendUpdate,
    dontSend,
    backToEdit,
    toggleChannel,
    acknowledgeCurfew,
    declineCurfew,
    reload,
  };
}
