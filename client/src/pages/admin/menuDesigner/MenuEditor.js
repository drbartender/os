import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUserPrefs } from '../../../context/UserPrefsContext';
import { useToast } from '../../../context/ToastContext';
import api from '../../../utils/api';
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
import MenuCanvas from './MenuCanvas';
import DesignTab from './DesignTab';
import DrinksTab from './DrinksTab';
import BriefTab from './BriefTab';
import PanelFooter from './PanelFooter';
import { rerollWhy, useInert } from './panelParts';
import { textPatch } from './menuEdits';
import EditorBanner, { EditorEmpty, EditorTopBar } from './EditorBanner';
import ConfirmDialog, { editorConfirm } from './ConfirmDialog';
import menuCardState from './menuCardState';
import { ensureFontsLink, PAIRING_IDS, pairingFor } from './fontPairings';
import { CARD_SIZE, FULL_SIZE, needsPoll } from './useMenuDraft';
import { ExportCanvas, useApproveMenu } from './exportMenu';

// The bar menu editor (spec 2026-10-01 sections 4.2, 10.1, 11.1; Tasks D1, D3),
// in place of the event page body while ?menu=1 is set (useMenuEditorOpen.js).
// The page owns the draft hook, so saves and the brief outlive the editor.
// - The sidebar rail is sidebarOverride, never setPref; cleared on close and unmount.
// - Back button and Escape (no dialog open, not while approving): blur, await
//   flush(), close; a failed flush asks Close anyway or Stay. Browser Back
//   closes at once; the text being edited commits, then it flushes on unmount.
// - Top bar, banners, empty card and Approve's gate come from menuCardState;
//   Approve is useApproveMenu, through the replace confirm over a print file.
// Task D2's tabs get { draft, content, inputs, pieces, brief, diff, configured,
// cap, imageModel, onPatch, onReroll(pieceKey, note), onSelectDrink(key | null),
// selectedDrink, plannerImage, wordsDone, readOnly, referenceFile, onReferenceFile }.

const TABS = [['design', 'Design'], ['drinks', 'Drinks'], ['brief', 'Brief']];
const BUSY = { reroll: 'Re-rolling...', update: 'Updating...', dismiss: 'Dismissing...', 'mark-reviewed': 'Saving...', 'retry-save': 'Retrying...',
  reload: 'Retrying...', download: 'Downloading...', undo: 'Undoing...', generate: 'Generating...', 'retry-words': 'Retrying...' };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const on = () => setVp(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

export default function MenuEditor({ editor, menu, proposal, eventLabel, drinkPlan = null, loadProposal }) {
  const { setSidebarOverride } = useUserPrefs();
  const toast = useToast();
  const rootRef = useRef(null);
  const backRef = useRef(null);
  const panelRef = useRef(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const vp = useViewport();
  const [tab, setTab] = useState(editor.view.tab || null);
  const [selected, setSelected] = useState(editor.view.select || null);
  const [tooLong, setTooLong] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);

  const blurInside = useCallback(() => {
    const el = document.activeElement;
    if (el && rootRef.current && rootRef.current.contains(el) && typeof el.blur === 'function') el.blur();
  }, []);
  const approve = useApproveMenu({ menu, loadProposal, beforeSave: blurInside });
  const approvingRef = useRef(false);
  approvingRef.current = approve.approving;
  // React 18 dispatches no events while a commit removes the editor, so on
  // unmount (browser Back) a blur never reaches the canvas's onBlur: read the
  // text being edited and send it through the same text patch, before the flush.
  const commitActiveText = useCallback(() => {
    const el = document.activeElement;
    const m = menuRef.current;
    const k = el && el.getAttribute ? el.getAttribute('data-mc-k') : null;
    const editing = k && rootRef.current && rootRef.current.contains(el) && el.getAttribute('contenteditable') === 'true';
    if (!editing || !m.draft) return;
    const patch = textPatch(m.draft.content, k, el.textContent);
    if (patch) m.edit({ content: patch });
  }, []);

  useEffect(() => {
    const m = menuRef.current;
    setSidebarOverride('rail');
    m.setImageModel('openai');
    ensureFontsLink(PAIRING_IDS);
    if (backRef.current) backRef.current.focus();
    const stopFull = m.wantSize(FULL_SIZE);
    return () => {
      stopFull();
      setSidebarOverride(null);
      menuRef.current.flush().catch(() => {});
    };
  }, [setSidebarOverride]);
  // Layout cleanups run before the passive one that flushes.
  useLayoutEffect(() => () => commitActiveText(), [commitActiveText]);
  // While Approve runs the panel is inert, and the back button and Escape wait.
  useInert(panelRef, approve.approving);

  const finishClose = useCallback(() => {
    setConfirm(null);
    setSidebarOverride(null);
    editorRef.current.close();
  }, [setSidebarOverride]);
  const closingRef = useRef(false);
  const requestClose = useCallback(async () => {
    if (closingRef.current || approvingRef.current) return;
    closingRef.current = true;
    blurInside();
    try {
      await menuRef.current.flush();
      finishClose();
    } catch (err) {
      setConfirm({ id: 'close' });
    } finally {
      closingRef.current = false;
    }
  }, [blurInside, finishClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const { payload, draft } = menu;
  const st = menuCardState({
    payload: payload ? { ...payload, draft } : null,
    local: {
      loading: menu.loading, loadError: menu.error ? menu.error.message : null,
      saving: menu.save.state === 'saving', saveFailed: menu.save.state === 'failed', savedAt: menu.save.savedAt,
      conflict: menu.save.conflict, approving: approve.approving, approveError: approve.error,
      tooLong, imageModel: menu.imageModel, activityKeys: menu.activityKeys, now: Date.now(),
    },
  });
  const hasDraft = !!(st.thumb && draft);
  const readOnly = !!(draft && draft.read_only);
  const content = (draft && draft.content) || {};
  const wordsDone = content.words_status === 'done';
  const print = (payload && payload.print) || {};
  const brief = (payload && payload.brief) || null;
  const saveFailed = hasDraft && menu.save.state === 'failed';
  const saveText = !hasDraft ? '' : approve.approving ? 'Approving...' : saveFailed ? 'Not saved'
    : needsPoll(payload) ? 'Drafting...' : menu.save.state === 'saving' ? 'Saving...' : 'Saved';
  useEffect(() => { if (!hasDraft) setTooLong([]); }, [hasDraft]);
  const activeTab = tab || (hasDraft ? 'design' : 'brief');

  const run = useCallback(async (id, fn) => {
    setBusy(id);
    try {
      return await fn();
    } catch (err) {
      toast.error((err && err.message) || 'Something went wrong. Please try again.');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  const ACTIONS = {
    reroll: (b) => (readOnly ? undefined : menu.reroll(b.pieceKey)),
    update: () => menu.sync(),
    dismiss: () => menu.dismissPlanChange(),
    'mark-reviewed': () => menu.dismissPlanChange(),
    'retry-save': () => menu.retrySave(),
    reload: () => menu.refetch(),
    download: () => downloadMenuPrint(`/proposals/${proposal.id}/menu-print`),
    undo: async () => {
      await api.patch(`/proposals/${proposal.id}/menu-print`, { not_required: false });
      await Promise.all([loadProposal ? loadProposal() : null, menu.refetch()]);
    },
    generate: () => menu.generate(),
    'retry-words': () => menu.generate(),
    'open-plan': () => requestClose(),
  };
  const onAction = (b) => { if (ACTIONS[b.id]) run(b.id, () => ACTIONS[b.id](b)); };
  const busyLabel = (b) => BUSY[b.id] || 'Working...';
  const onGenerate = () => (hasDraft ? setConfirm({ id: 'start-over' }) : onAction({ id: 'generate' }));
  // The key confirmed over is the one Approve expects (MENU_PRINT_CHANGED otherwise).
  const onApprove = () => {
    if (st.approve.disabled || approve.approving) return;
    approve.clearError();
    if (print.print_key) setConfirm({ id: 'replace', key: print.print_key });
    else approve.run({ expectedPrintKey: '' });
  };
  const onConfirm = () => {
    const c = confirm;
    if (c.id === 'close') { finishClose(); return; }
    setConfirm(null);
    if (c.id === 'start-over') onAction({ id: 'generate' });
    if (c.id === 'replace') approve.run({ expectedPrintKey: c.key });
  };

  const onPatch = useCallback((patch = {}) => {
    const m = menuRef.current;
    if (m.draft) m.edit(patch);
    else if (patch.inputs) m.setBrief(patch.inputs);
  }, []);
  // A read-only draft (no plan on the event) draws nothing.
  const onReroll = useCallback((pieceKey, note) => {
    const m = menuRef.current;
    return m.draft && m.draft.read_only ? undefined : run('reroll', () => m.reroll(pieceKey, { note }));
  }, [run]);
  const onFit = useCallback((f) => {
    const next = Array.isArray(f && f.tooLong) ? f.tooLong : [];
    setTooLong((prev) => (prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next));
  }, []);
  const onSelectDrink = useCallback((key) => {
    setSelected(key || null);
    if (key) setTab('drinks');
  }, []);

  const layers = useMemo(() => ({ ...(menu.layers[CARD_SIZE] || {}), ...(menu.layers[FULL_SIZE] || {}) }), [menu.layers]);
  const plannerImage = brief && brief.has_planner_image
    ? { url: menu.plannerImages[FULL_SIZE] || menu.plannerImages[CARD_SIZE] || null } : null;
  const configured = (payload && payload.configured) || {};
  const cap = (payload && payload.cap) || null;
  const tabProps = {
    draft, content, inputs: (draft && draft.inputs) || menu.brief, pieces: (payload && payload.pieces) || [], brief,
    diff: (payload && payload.diff) || null, configured, cap, imageModel: menu.imageModel,
    onPatch, onReroll, onSelectDrink, selectedDrink: selected, plannerImage, wordsDone, readOnly, drinkPlan,
    referenceFile: menu.referenceFile, onReferenceFile: menu.setReferenceFile,
  };
  const Tab = { design: DesignTab, drinks: DrinksTab, brief: BriefTab }[activeTab];

  const banners = readOnly ? st.banners.map((b) => ({ ...b, buttons: b.buttons.filter((x) => x.id !== 'reroll') })) : st.banners;
  const waitBusy = busy || (approve.approving ? 'approving' : null);
  const allowance = banners.length ? 14 + 46 * banners.length : 14;
  const scale = clamp(Math.min((vp.h - 48 - 56 - allowance - 60) / 1000, (vp.w - 56 - 340 - 64) / 800), 0.3, 0.8);
  const shown = Array.isArray(content.drinks) ? content.drinks.filter((d) => d && !d.hidden).length : 0;
  const count = hasDraft ? shown : Number((payload && payload.plan && payload.plan.drink_count) || 0);
  const pageH = Math.round(1000 * scale);

  return (
    <div className="md-editor" ref={rootRef} role="region" aria-label="Bar menu editor">
      <EditorTopBar ref={backRef} label={eventLabel} chip={st.chip} saveText={saveText} saveFailed={saveFailed}
        onBack={requestClose} backDisabled={approve.approving} onRetrySave={() => onAction({ id: 'retry-save' })} busy={!!waitBusy}
        retryLabel={busy === 'retry-save' ? BUSY['retry-save'] : 'Retry'} approve={st.approve} onApprove={onApprove} />
      <div className="md-ed-body">
        <section className="md-ed-preview" aria-label="Menu preview">
          {banners.length > 0 && (
            <div className="md-ed-banners">
              {banners.map((b) => <EditorBanner key={b.id} banner={b} onAction={onAction} busy={waitBusy} busyLabel={busyLabel} />)}
            </div>
          )}
          <div className="md-ed-scroll scroll-thin">
            <div className="md-ed-col" style={{ width: Math.round(800 * scale) }}>
              <div className="md-ed-meta">
                <span>{`8 × 10 in · ${pairingFor(content.font_pairing).name} · ${count} drinks`}</span>
                {hasDraft && <span>Click text to edit · dotted = AI-written</span>}
              </div>
              {st.progress !== null && st.progress !== undefined && (
                <div className="md-ed-prog" role="progressbar" aria-label="Drafting progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.progress}>
                  <div style={{ width: `${st.progress}%` }} />
                </div>
              )}
              {hasDraft && (
                <MenuCanvas className="md-ed-canvas" content={content} inputs={draft.inputs} pieces={payload.pieces} layers={layers}
                  plannerImage={plannerImage} scale={scale} showStatus onFit={onFit}
                  editable={wordsDone && !draft.read_only && !approve.approving} selectedDrink={selected}
                  onSelectDrink={onSelectDrink} onPatch={onPatch} onReroll={onReroll} canReroll={!readOnly && !rerollWhy(configured, cap)} />
              )}
              {st.id === 'loading' && <div className="md-skel md-ed-skel" style={{ height: pageH }} aria-busy="true" />}
              <EditorEmpty empty={st.empty && st.empty.id !== 'loading' ? st.empty : null} height={pageH}
                onAction={onAction} busy={busy} busyLabel={busyLabel} generate={st.generate} />
            </div>
          </div>
        </section>
        <aside className="md-ed-panel" aria-label="Menu settings" ref={panelRef}>
          <div className="md-ed-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={activeTab === id}
                className={activeTab === id ? 'md-ed-tab is-active' : 'md-ed-tab'} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="md-ed-panel-body scroll-thin">
            <Tab {...tabProps} />
          </div>
          <PanelFooter draft={draft} configured={configured} imageModel={menu.imageModel} onImageModel={menu.setImageModel}
            onGenerate={onGenerate} busy={busy === 'generate' || busy === 'retry-words'} gate={st.generate} />
        </aside>
      </div>
      <ExportCanvas {...approve.exportProps} />
      {confirm && (
        <ConfirmDialog {...editorConfirm(confirm.id, { need: st.generate.need, print })}
          onAction={onConfirm} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
