import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { initialFormFromProposal, recoverAddonQuantities, pricedDurationHours } from '../../pages/admin/proposalEditor/formState';
import { buildProposalPatchBody, staffNotifyFlags } from '../../pages/admin/proposalEditor/patchBody';
import {
  detectNumBartendersOverride, storedGratuityOf, isClassPackageFor, buildCalculateBody,
} from '../../pages/admin/proposalEditor/editorCore';
import { initialDrafts, buildNotifyEntries, draftsOverCap, noticeOutcomes } from '../comms/notifyDrafts';
import {
  confirmViewNow, fieldsChanged, changedSinceOpen, saveErrorText, curfewReason, sheetValuesOf, editLockedReason,
  READ_TIMEOUT_MS,
} from '../../utils/editSheetView';

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
// replaced: the PATCH treats a missing add-on list as "delete every add-on"
// and a missing override as "drop it". It leaves out the venue keys (the sheet
// never edits location), never sends the gratuity mandate, never writes the
// client contact.
//
// One write at a time (a ref: a double tap sends one request). Every PATCH
// re-reads the event first and refuses when its updated_at moved since the
// sheet opened (the on-site-extension overwrite).
export const LOAD_FAILED = "Couldn't load this event. Editing needs a connection.";
export const CURFEW_DECLINED = 'Not saved. The end time is past our 2:00 AM service curfew.';
const NO_STAFF = { enabled: false, sms: false, email: false };
const READ = { timeout: READ_TIMEOUT_MS };

export default function useEditSheet({ proposalId, onSaved, previewDelayMs = 400 }) {
  const toast = useToast();
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
  const handlers = useRef({ onSaved });
  handlers.current = { onSaved };

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
      const locked = editLockedReason(proposal);
      if (locked) { setLoad({ phase: 'locked', proposal, message: locked }); return; }
      const packages = Array.isArray(pkgRes.data) ? pkgRes.data : [];
      const addons = Array.isArray(addonRes.data) ? addonRes.data : [];
      const form = initialFormFromProposal(proposal);
      form.addon_quantities = recoverAddonQuantities(proposal.addons, addons, { durationHours: pricedDurationHours(proposal) });
      const selectedPkg = packages.find((p) => p.id === Number(form.package_id));
      const base = {
        proposal,
        form,
        initial: sheetValuesOf(form),
        override: detectNumBartendersOverride(proposal, packages),
        isClass: isClassPackageFor(selectedPkg, proposal),
        gratuity: storedGratuityOf(proposal),
        openedAt: proposal.updated_at,
      };
      setValues(base.initial);
      setLoad({ phase: 'ready', base });
    }).catch(() => { if (!gone) setLoad({ phase: 'failed' }); });
    return () => { gone = true; };
  }, [proposalId, attempt]);

  const base = load.phase === 'ready' ? load.base : null;
  const formNow = useMemo(() => (base && values ? { ...base.form, ...values } : null), [base, values]);

  // The server's own calculator, asked again whenever a priced field moves.
  // Numbered, so a late answer never describes a form it no longer matches.
  const seq = useRef(0);
  const guests = values ? values.guest_count : null;
  const hours = values ? values.event_duration_hours : null;
  useEffect(() => {
    if (!base) return undefined;
    seq.current += 1;
    const mine = seq.current;
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      api.post('/proposals/calculate', buildCalculateBody(
        { ...base.form, guest_count: guests, event_duration_hours: hours },
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
  }, [base, guests, hours, previewAttempt, previewDelayMs]);

  const changed = !!(base && values && fieldsChanged(base.initial, values));
  const view = base ? confirmViewNow({ proposal: base.proposal, preview, shown, changed }) : null;

  const setValue = useCallback((field, value) => {
    setValues((cur) => (cur ? { ...cur, [field]: value } : cur));
    setError(null);
    // Book it anyway must never send values the sheet no longer shows.
    setCurfew(null);
  }, []);

  // Every PATCH re-reads first and refuses when the event moved since the
  // sheet opened. A curfew refusal is held for the inline confirm. A failure
  // before the PATCH goes out (the re-read, the preflight) reaches run's catch
  // as a definite "didn't save"; the PATCH's own failure is said here, because
  // a write that got no answer may have landed.
  const saveChecked = useCallback(async (body, notify, staffChoice) => {
    const fresh = await api.get(`/proposals/${base.proposal.id}`, READ);
    if (changedSinceOpen(base.openedAt, fresh.data)) { setStale(true); setPending(null); return; }
    const payload = { ...body, ...(staffChoice ? staffNotifyFlags(staffChoice) : {}), notify };
    let res;
    try {
      res = await api.patch(`/proposals/${base.proposal.id}`, payload);
    } catch (err) {
      const reason = curfewReason(err);
      if (reason && !body.acknowledge_past_curfew) {
        setPending(null);
        setCurfew({ reason, body, notify, staff: staffChoice });
        return;
      }
      setError(saveErrorText(err, true));
      return;
    }
    toast.success('Event updated.');
    noticeOutcomes(res.data && res.data.notifications).forEach((o) => toast[o.kind](o.text));
    if (handlers.current.onSaved) handlers.current.onSaved();
  }, [base, toast]);

  const run = useCallback(async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(saveErrorText(err)); } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

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
    phase: load.phase,
    proposal: base ? base.proposal : (load.proposal || null),
    lockedMessage: load.message || null,
    values,
    initial: base ? base.initial : null,
    setValue,
    preview,
    retryPreview,
    view,
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
