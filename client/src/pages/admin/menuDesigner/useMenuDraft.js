import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import useMenuLayers, { CARD_SIZE, FULL_SIZE } from './useMenuLayers';

// The event page's menu draft hook (spec 2026-10-01 sections 4, 10.1 and 10.2;
// decision 11). EventDetailPage calls it once and hands it to the card (and the
// editor, next lane), so a pending or failed save and the pre-draft brief
// outlive the editor's open and close.
// - GET /proposals/:id/menu-draft on mount, then every 2 s while the words step
//   or any piece is pending or working. A failed GET backs off to 10 s
//   (reconnecting) and keeps trying while anything is drawing or an action
//   waits on it; a failed first load is the error.
// - Layers: useMenuLayers.js (layers, plannerImages, plannerImageRevs).
// - An action (generate, sync, dismissPlanChange, reroll) resolves only once a
//   GET made after it lands, so its caller stays busy until the card can show
//   the new state, and the version it returns is kept for the next request.
// - edit({ content?, inputs? }) overlays top-level keys and PATCHes them 800 ms
//   after the last edit, to the id they were made for. A 409 drops them,
//   refetches and sets save.conflict; another failure keeps them (state
//   'failed', retrySave()). flush() resolves once saved, rejects when it fails.
// - The brief inputs and a held reference file last the page visit; imageModel
//   opens at 'openai' on every mount, never persisted, and rides each image
//   request unless the caller passes one (the card always passes 'openai').
// - A proposalId change sends pending edits to the OLD id, then resets it all.

export const POLL_MS = 2000;
export const BACKOFF_MS = 10000;
export const SAVE_DEBOUNCE_MS = 800;
export { CARD_SIZE, FULL_SIZE };
export const DEFAULT_BRIEF = Object.freeze({ planner_image_role: 'logo', reference_source: 'none', art_direction: '', drb_mark: true });

const OPEN = new Set(['pending', 'working']);
const NO_EDITS = Object.freeze({ content: {}, inputs: {} });
const IDLE = Object.freeze({ state: 'idle', savedAt: null, conflict: false });
const has = (o) => !!o && Object.keys(o).length > 0;
const pick = (from, keep) => Object.fromEntries(Object.entries(from).filter(([k, v]) => keep(k, v)));

const isOpen = (p) => !!p && OPEN.has(p.status);
const arr = (v) => (Array.isArray(v) ? v : []);

// The pieces of a job the hook first saw already under way: a job that drew
// new pieces (Generate, Update draft) counts every piece it could have drawn,
// a re-roll only the open one.
function missedStart(pieces) {
  const fresh = pieces.some((p) => isOpen(p) && !(p.drawn_count > 0));
  return fresh ? pieces.filter((p) => isOpen(p) || !(p.drawn_count > 1)).map((p) => p.piece_key) : [];
}

export function needsPoll(payload) {
  const draft = payload && payload.draft;
  if (!draft) return false;
  if (OPEN.has(draft.content && draft.content.words_status)) return true;
  return arr(payload.pieces).some(isOpen);
}

export default function useMenuDraft(proposalId) {
  const id = proposalId === null || proposalId === undefined || proposalId === '' ? null : String(proposalId);
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [overlay, setOverlay] = useState(NO_EDITS);
  const [save, setSave] = useState(IDLE);
  const [brief, setBriefState] = useState(DEFAULT_BRIEF);
  const [referenceFile, setReferenceFile] = useState(null);
  const [imageModel, setImageModel] = useState('openai');

  const live = useRef(null);
  const fetchGen = useRef(0);
  const pollTimer = useRef(null);
  const saveTimer = useRef(null);
  const pending = useRef(null);
  const inflight = useRef(null);
  const versions = useRef(new Map());
  const waiters = useRef([]);
  const ownStart = useRef(false);
  const activity = useRef([]);
  const payloadFor = useRef(null);
  const latest = useRef({});
  latest.current = { payload, overlay, brief, referenceFile, imageModel };

  const fetchDraft = useCallback(async () => {
    const pid = live.current;
    if (!pid) return;
    clearTimeout(pollTimer.current);
    const gen = ++fetchGen.current;
    const again = (ms) => { if (live.current === pid && fetchGen.current === gen) pollTimer.current = setTimeout(fetchDraft, ms); };
    try {
      const { data } = await api.get(`/proposals/${pid}/menu-draft`);
      if (live.current !== pid || fetchGen.current !== gen) return;
      const known = versions.current.get(pid);
      // An answer from before our own PATCH landed: ask again rather than step back.
      if (data && data.draft && known !== undefined && data.draft.version < known) { again(POLL_MS); return; }
      if (data && data.draft) versions.current.set(pid, data.draft.version);
      const pieces = arr(data && data.pieces);
      const open = pieces.filter(isOpen).map((p) => p.piece_key);
      const seed = activity.current.length || ownStart.current ? activity.current : missedStart(pieces);
      activity.current = needsPoll(data) ? [...new Set([...seed, ...open])] : [];
      ownStart.current = false;
      payloadFor.current = pid;
      setPayload(data);
      setLoadError(null);
      setReconnecting(false);
      if (needsPoll(data)) again(POLL_MS);
      waiters.current.splice(0).forEach((w) => w(true));
    } catch (err) {
      if (live.current !== pid || fetchGen.current !== gen) return;
      const cur = latest.current.payload;
      // Something is drawing, or an action waits on this GET: keep trying, slower.
      if ((err && err.status === 429) || waiters.current.length || (cur && needsPoll(cur))) {
        setReconnecting(true);
        again(BACKOFF_MS);
      } else if (!cur) setLoadError({ message: (err && err.message) || "Couldn't load the menu draft.", status: err && err.status });
    }
  }, []);

  // One PATCH at a time, chained; the record carries the id it was made for.
  // snap is a record taken out of pending already (an event change sends it).
  const sendPending = useCallback((snap) => {
    const run = (inflight.current || Promise.resolve()).catch(() => {}).then(() => {
      const rec = snap || pending.current;
      if (!rec) return undefined;
      if (!snap) pending.current = null;
      const body = { version: versions.current.get(rec.id) };
      if (has(rec.content)) body.content = rec.content;
      if (has(rec.inputs)) body.inputs = rec.inputs;
      return api.patch(`/proposals/${rec.id}/menu-draft`, body).then((res) => {
        versions.current.set(rec.id, res.data.version);
        if (live.current !== rec.id) return;
        setPayload((prev) => (prev && prev.draft ? { ...prev, draft: { ...prev.draft, version: res.data.version,
          content: { ...prev.draft.content, ...rec.content }, inputs: { ...prev.draft.inputs, ...rec.inputs } } } : prev));
        // Keys edited again while this save flew stay in the overlay.
        setOverlay((prev) => ({ content: pick(prev.content, (k, v) => rec.content[k] !== v), inputs: pick(prev.inputs, (k, v) => rec.inputs[k] !== v) }));
        setSave({ state: pending.current ? 'saving' : 'saved', savedAt: Date.now(), conflict: false });
        // The print state is derived on the server: a save that moved an approved
        // draft's version makes it edited since approval, so ask now rather
        // than leave Approved (and a disabled Approve) on screen.
        const cur = latest.current.payload;
        if (cur && cur.print && cur.print.state === 'approved') fetchDraft();
      }, (err) => {
        if (live.current !== rec.id) throw err;
        if (err && err.status === 409) {
          pending.current = null;
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
          setOverlay(NO_EDITS);
          setSave({ ...IDLE, conflict: true });
          fetchDraft();
        } else {
          const newer = pending.current || { content: {}, inputs: {} };
          pending.current = { id: rec.id, content: { ...rec.content, ...newer.content }, inputs: { ...rec.inputs, ...newer.inputs } };
          setSave((s) => ({ ...s, state: 'failed' }));
        }
        throw err;
      });
    });
    inflight.current = run;
    const done = () => { if (inflight.current === run) inflight.current = null; };
    run.then(done, done);
    return run;
  }, [fetchDraft]);

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (inflight.current) await inflight.current;
    if (pending.current) await sendPending();
  }, [sendPending]);
  const retrySave = useCallback(() => sendPending(), [sendPending]);

  const edit = useCallback(({ content, inputs } = {}) => {
    const pid = live.current;
    const cur = latest.current.payload;
    if (!pid || !cur || !cur.draft) return;
    const was = pending.current && pending.current.id === pid ? pending.current : { content: {}, inputs: {} };
    pending.current = { id: pid, content: { ...was.content, ...content }, inputs: { ...was.inputs, ...inputs } };
    setOverlay((prev) => ({ content: { ...prev.content, ...content }, inputs: { ...prev.inputs, ...inputs } }));
    setSave((s) => ({ ...s, state: 'saving', conflict: false }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; sendPending().catch(() => {}); }, SAVE_DEBOUNCE_MS);
  }, [sendPending]);

  useEffect(() => {
    if (!id) return undefined;
    live.current = id;
    const waiting = waiters.current; // one array for the hook's life, spliced, never replaced
    activity.current = [];
    payloadFor.current = null;
    setPayload(null); setLoadError(null); setReconnecting(false);
    setOverlay(NO_EDITS); setSave(IDLE);
    setBriefState(DEFAULT_BRIEF); setReferenceFile(null); setImageModel('openai');
    fetchDraft();
    return () => {
      live.current = null;
      clearTimeout(pollTimer.current);
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      waiting.splice(0).forEach((w) => w(false));
      // Best effort, to the id the edits were made for (spec 10.1). Taken out
      // now, so the next event's edits or a failing in-flight PATCH cannot
      // overwrite it before it is sent.
      const snap = pending.current;
      pending.current = null;
      if (snap) sendPending(snap).catch(() => {});
    };
  }, [id, fetchDraft, sendPending]);

  const layers = useMenuLayers(id, payloadFor.current === id ? payload : null);

  const draft = useMemo(() => {
    const d = payload && payload.draft;
    if (!d || (!has(overlay.content) && !has(overlay.inputs))) return d || null;
    return { ...d, content: { ...d.content, ...overlay.content }, inputs: { ...d.inputs, ...overlay.inputs } };
  }, [payload, overlay]);

  // The in-place and editor actions. Each settles the pending save first where
  // the server checks the version, keeps the version it returns, and resolves
  // (or rethrows) only once a GET made after it lands, whatever the answer.
  const action = useCallback((run, { settle = true } = {}) => async (...args) => {
    const pid = live.current;
    if (!pid) return undefined;
    if (settle) await flush().catch(() => {});
    try {
      const data = await run(pid, ...args);
      if (data && Number.isInteger(data.version)) versions.current.set(pid, data.version);
      return data;
    } finally {
      if (live.current === pid) {
        const landed = new Promise((resolve) => { waiters.current.push(resolve); });
        ownStart.current = true;
        fetchDraft();
        await landed;
      }
    }
  }, [flush, fetchDraft]);

  const generate = useMemo(() => action(async (pid, { imageModel: model } = {}) => {
    const { payload: cur, overlay: ov, brief: b, referenceFile: file, imageModel: chosen } = latest.current;
    const src = cur && cur.draft ? { ...cur.draft.inputs, ...ov.inputs } : b;
    const form = new FormData();
    // A newly chosen upload replaces any reference; the planner image then is not one.
    const role = file && src.planner_image_role === 'reference' ? 'ignore' : src.planner_image_role || 'logo';
    form.append('planner_image_role', role);
    form.append('reference_source', file ? 'upload' : src.reference_source || 'none');
    form.append('art_direction', src.art_direction || '');
    form.append('drb_mark', String(src.drb_mark !== false));
    form.append('image_model', model || chosen);
    if (file) form.append('reference', file);
    const res = await api.post(`/proposals/${pid}/menu-draft/generate`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    if (file && live.current === pid) setReferenceFile(null);
    return res.data;
  }), [action]);

  const sync = useMemo(() => action(async (pid, { imageModel: model } = {}) => (
    (await api.post(`/proposals/${pid}/menu-draft/sync`, { version: versions.current.get(pid), image_model: model || latest.current.imageModel })).data
  )), [action]);

  const dismissPlanChange = useMemo(() => action(async (pid) => (
    (await api.post(`/proposals/${pid}/menu-draft/dismiss-plan-change`, { version: versions.current.get(pid) })).data
  )), [action]);

  const reroll = useMemo(() => action(async (pid, pieceKey, { note, imageModel: model } = {}) => {
    const body = { image_model: model || latest.current.imageModel };
    if (typeof note === 'string' && note.trim()) body.note = note.trim();
    return (await api.post(`/proposals/${pid}/menu-draft/pieces/${encodeURIComponent(pieceKey)}/reroll`, body)).data;
  }, { settle: false }), [action]);

  const setBrief = useCallback((patch) => setBriefState((b) => ({ ...b, ...patch })), []);
  const clearConflict = useCallback(() => setSave((s) => ({ ...s, conflict: false })), []);

  return {
    proposalId: id, payload, draft, loading: !!id && !payload && !loadError, error: loadError, reconnecting,
    refetch: fetchDraft, layers: layers.layers, plannerImages: layers.plannerImages, plannerImageRevs: layers.plannerImageRevs,
    wantSize: layers.wantSize, refreshPlannerImage: layers.refreshPlannerImage, activityKeys: activity.current,
    edit, flush, retrySave, save, clearConflict,
    brief, setBrief, referenceFile, setReferenceFile, imageModel, setImageModel,
    generate, sync, dismissPlanChange, reroll,
  };
}
