import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import StatusChip from '../../../components/adminos/StatusChip';
import MenuCanvas from './MenuCanvas';
import MenuCardFold, { errorText, isSafeLogoUrl } from './MenuCardFold';
import menuCardState from './menuCardState';
import { CARD_SIZE } from './useMenuDraft';

// The Bar menu card on the event page's right column (spec 2026-10-01 section
// 11.1 and table C; decision 12). The top half is the AI draft (thumbnail,
// status, next action); the fold is the print file and the client image
// (MenuCardFold), which works even when the draft cannot load.
//
// Props:
//   proposal                  the loaded proposal (id, menu_print_key, menu_not_required)
//   drinkPlan, planLoading    the loaded plan and its loading flag
//   setDrinkPlan, loadProposal  the page's plan setter and proposal reload
//   menu                      useMenuDraft(proposal id), called once by the page
//   onOpenEditor              ({ tab?, select? }) opens the editor; until the editor
//                             lane passes it, the editor actions and the thumbnail's
//                             click do not render
// The in-place actions (Generate, Retry, Update draft, Dismiss, Undo) always draw
// with GPT Image (section 4.1).

const NARROW_PX = 900;
const THUMB_SCALE = 0.12;
const BTN = { primary: 'btn btn-primary btn-sm', secondary: 'btn btn-secondary btn-sm', ghost: 'btn btn-ghost btn-sm' };
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < NARROW_PX;
// Each in-place action's own busy label (11.1), and Undo's message (the old card's).
const BUSY_LABEL = {
  generate: 'Generating...', 'retry-words': 'Retrying...', update: 'Updating...', dismiss: 'Dismissing...',
  undo: 'Undoing...', 'retry-save': 'Retrying...', reload: 'Retrying...',
};
const FALLBACK = { undo: 'Failed to update the menu status.' };

function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const onResize = () => setNarrow(isNarrow());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

function Skeleton() {
  return (
    <div className="card-body md-card-body" aria-busy="true">
      <div className="md-thumb md-skel" />
      <div className="md-card-text">
        <div className="md-skel md-skel-line" />
        <div className="md-skel md-skel-line md-skel-short" />
      </div>
    </div>
  );
}

export default function MenuDesignerCard({
  proposal, drinkPlan = null, planLoading = false, setDrinkPlan, loadProposal, menu, onOpenEditor,
}) {
  const narrow = useNarrow();
  const [busy, setBusy] = useState(null);
  // { text, at }: at is the card state the line first showed under; the next
  // state clears it (set after the action's own refetch, which lands first).
  const [actionError, setActionError] = useState(null);
  const { payload, draft } = menu;
  const st = menuCardState({
    payload: payload ? { ...payload, draft } : null,
    local: {
      loading: menu.loading,
      loadError: menu.error ? menu.error.message : null,
      saving: menu.save.state === 'saving',
      saveFailed: menu.save.state === 'failed',
      savedAt: menu.save.savedAt,
      conflict: menu.save.conflict,
      imageModel: 'openai',
      activityKeys: menu.activityKeys,
      now: Date.now(),
    },
  });
  useEffect(() => {
    if (!actionError) return;
    if (actionError.at === null) setActionError({ ...actionError, at: st.id });
    else if (actionError.at !== st.id) setActionError(null);
  }, [st.id, actionError]);
  const editorReady = typeof onOpenEditor === 'function';
  const canEdit = editorReady && !narrow;

  // A print-file change moves the derived print state: reload both.
  const onPrintChange = async () => {
    if (loadProposal) await loadProposal();
    await menu.refetch();
  };
  const onImageChange = () => {
    menu.refetch();
    menu.refreshPlannerImage();
  };

  const IN_PLACE = {
    generate: () => menu.generate({ imageModel: 'openai' }),
    'retry-words': () => menu.generate({ imageModel: 'openai' }),
    update: () => menu.sync({ imageModel: 'openai' }),
    dismiss: () => menu.dismissPlanChange(),
    undo: async () => {
      await api.patch(`/proposals/${proposal.id}/menu-print`, { not_required: false });
      await onPrintChange();
    },
    'retry-save': () => menu.retrySave(),
    reload: () => menu.refetch(),
  };

  // The hook's actions resolve only once a GET after them lands, so the row
  // stays held (no second paid Generate) until the card shows the new state.
  const run = async (a) => {
    setActionError(null);
    setBusy(a.id);
    try {
      await IN_PLACE[a.id]();
    } catch (err) {
      setActionError({ text: errorText(err, FALLBACK[a.id] || 'Something went wrong. Please try again.'), at: null });
    } finally {
      setBusy(null);
    }
  };

  const button = (a) => {
    if (!a) return null;
    if (a.editor) {
      return canEdit ? (
        <button key={a.id} type="button" className={BTN[a.style] || BTN.primary} onClick={() => onOpenEditor(a.editor)}>{a.label}</button>
      ) : null;
    }
    const gate = a.id === 'generate' && st.generate.disabled ? st.generate : null;
    return (
      <button key={a.id} type="button" className={BTN[a.style] || BTN.primary} onClick={() => run(a)}
        disabled={!!busy || !!gate} title={gate ? gate.hint : undefined}>
        {busy === a.id ? BUSY_LABEL[a.id] || 'Working...' : a.label}
      </button>
    );
  };

  const hasEditorAction = !!(st.thumb || (st.primary && st.primary.editor) || (st.secondary && st.secondary.editor));
  const actions = [button(st.primary), button(st.secondary)].filter(Boolean);
  const brief = payload && payload.brief;
  const companyLogo = (drinkPlan && drinkPlan.selections && drinkPlan.selections.companyLogo) || '';
  const plannerUrl = menu.plannerImages[CARD_SIZE] || (isSafeLogoUrl(companyLogo) ? companyLogo : null);
  const plannerImage = brief && brief.has_planner_image ? { url: plannerUrl } : null;
  const generateHeld = [st.primary, st.secondary].some((a) => a && a.id === 'generate') && st.generate.disabled;
  const role = (draft && draft.inputs && draft.inputs.planner_image_role) || (menu.brief && menu.brief.planner_image_role) || 'logo';

  let thumb = <div className="md-thumb-empty">8 × 10</div>;
  if (st.thumb && draft) {
    const canvas = (
      <MenuCanvas content={draft.content} inputs={draft.inputs} pieces={payload.pieces} layers={menu.layers[CARD_SIZE]}
        plannerImage={plannerImage} scale={THUMB_SCALE} showStatus aria-hidden="true" />
    );
    thumb = canEdit
      ? <button type="button" className="md-thumb-canvas" onClick={() => onOpenEditor({})} aria-label="Open the bar menu editor">{canvas}</button>
      : <div className="md-thumb-canvas">{canvas}</div>;
  }

  return (
    // card-flush: the head, body and fold own the inset, as the design draws it
    // (the fold's top rule runs edge to edge), not the legacy .card padding.
    <div className="card card-flush md-card">
      <div className="card-head">
        <h3>Bar menu</h3>
        {st.chip && <StatusChip kind={st.chip.kind}>{st.chip.text}</StatusChip>}
      </div>
      {st.id === 'loading' ? <Skeleton /> : (
        <div className="card-body md-card-body">
          <div className="md-thumb">{thumb}</div>
          <div className="md-card-text">
            <div className="md-card-msg">{st.message}</div>
            {st.sub && <div className="md-card-sub">{st.sub}</div>}
            {st.progress !== null && st.progress !== undefined && (
              <div className="md-card-prog" role="progressbar" aria-label="Drafting progress"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.progress}>
                <div style={{ width: `${st.progress}%` }} />
              </div>
            )}
            {actions.length > 0 && <div className="md-card-actions">{actions}</div>}
            {generateHeld && <div className="md-card-note">{st.generate.hint}</div>}
            {editorReady && narrow && hasEditorAction && <div className="md-card-note">Edit the menu on a wider screen.</div>}
            {menu.reconnecting && <div className="md-card-note" role="status">Reconnecting...</div>}
            {actionError && <p className="chip danger md-alert" role="alert">{actionError.text}</p>}
          </div>
        </div>
      )}
      <MenuCardFold
        proposalId={proposal.id}
        menuPrintKey={proposal.menu_print_key || null}
        menuNotRequired={!!proposal.menu_not_required}
        print={payload ? payload.print : null}
        drinkPlan={drinkPlan}
        planLoading={planLoading}
        setDrinkPlan={setDrinkPlan}
        onPrintChange={onPrintChange}
        onImageChange={onImageChange}
        role={role}
        thumbUrl={menu.plannerImages[CARD_SIZE] || null}
      />
    </div>
  );
}
