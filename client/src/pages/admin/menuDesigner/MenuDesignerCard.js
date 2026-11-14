// MenuDesignerCard (React component, default export): the event page's Bar menu card, its draft thumbnail,
// table C state and next action, the client review's writes and confirms, and the fold below it.

import React, { useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import { downloadMenuPrint } from '../../../utils/downloadMenuPrint';
import StatusChip from '../../../components/adminos/StatusChip';
import MenuCanvas from './MenuCanvas';
import MenuCardFold, { errorText, isSafeLogoUrl, useCopyLink } from './MenuCardFold';
import ConfirmDialog from './ConfirmDialog';
import menuCardState, { defaultImageModel } from './menuCardState';
import { REVIEW_BUSY, reviewConfirm, useMenuReview } from './exportMenu';
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
// The in-place actions (Generate, Retry, Update draft, Dismiss, Undo) draw with
// the read model's default image model (configured.default_image_model, Gemini
// when its key is set, else GPT Image; spec 2026-10-19 section 16), never the
// editor's toggle. An action passes itself to its handler, so the unchecked
// notice's Update draft sends its scope (bar, the bar-only rebuild). The card
// hands menuCardState the hook's held brief and reference file, as the editor
// does, so before a draft its look, hint, image count and gate are those of
// the run its own Generate posts (spec 2026-10-19 sections 9.1 and 9.2).
// The client review (spec 2026-10-19 sections 10.3, 10.5 and 14; lane
// menu-approve-send): Release for printing and Put it back for staff (table
// C's actions) and the fold's Release for printing and Close request go
// through one useMenuReview, whose confirm draws over the page (the editor's
// ConfirmDialog in a fixed layer), whose running label holds every action and
// reads on the button and the Client review row, and whose refusal is the
// card's alert line; a landed after-event release leaves one role="status"
// line saying what happened to the $5 print duty until the card's next
// action; once a write settles, focus moves to the card's heading.
// Copy link copies the proof's link (Copied for 2 s), and
// Released's ghost Download reads the print file back. The fold's Read the
// client's notes opens the editor's Brief tab.

const NARROW_PX = 900;
const THUMB_SCALE = 0.12;
const BTN = { primary: 'btn btn-primary btn-sm', secondary: 'btn btn-secondary btn-sm', ghost: 'btn btn-ghost btn-sm' };
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < NARROW_PX;
// Each in-place action's own busy label (11.1), and Undo's message (the old card's).
const BUSY_LABEL = {
  generate: 'Generating...', 'retry-words': 'Generating...', update: 'Updating...', dismiss: 'Dismissing...',
  undo: 'Undoing...', 'retry-save': 'Retrying...', reload: 'Retrying...', download: 'Downloading...',
};
// Table C's actions that write through the review's confirm (exportMenu useMenuReview).
const REVIEW_ACTIONS = new Set(['release', 'put-back']);
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
  const review = useMenuReview({ proposal, menu, loadProposal });
  const link = useCopyLink();
  // A settled review write leaves focus on the card's heading, a stable element,
  // since the pressed trigger is disabled, then gone (review.settled).
  const headingRef = useRef(null);
  useEffect(() => {
    if (review.settled && headingRef.current) headingRef.current.focus();
  }, [review.settled]);
  const { payload, draft } = menu;
  const imageModel = defaultImageModel(payload && payload.configured);
  const st = menuCardState({
    payload: payload ? { ...payload, draft } : null,
    local: {
      loading: menu.loading,
      loadError: menu.error ? menu.error.message : null,
      saving: menu.save.state === 'saving',
      saveFailed: menu.save.state === 'failed',
      savedAt: menu.save.savedAt,
      conflict: menu.save.conflict,
      imageModel,
      activityKeys: menu.activityKeys,
      now: Date.now(),
      // The look this card's Generate posts before a draft is the held brief's,
      // as in the editor (menuCardState lookOf), so its words and gate match the run.
      heldInputs: menu.brief,
      referenceFile: menu.referenceFile,
    },
  });
  useEffect(() => {
    if (!actionError) return;
    if (actionError.at === null) setActionError({ ...actionError, at: st.id });
    else if (actionError.at !== st.id) setActionError(null);
  }, [st.id, actionError]);
  const editorReady = typeof onOpenEditor === 'function';
  const canEdit = editorReady && !narrow;

  // A print-file change moves the derived print state: reload both. Any other
  // action ends the after-event release's duty line (review.notice).
  const onPrintChange = async () => {
    review.clearNotice();
    if (loadProposal) await loadProposal();
    await menu.refetch();
  };
  const onImageChange = () => {
    review.clearNotice();
    menu.refetch();
    menu.refreshPlannerImage();
  };

  const IN_PLACE = {
    generate: () => menu.generate({ imageModel }),
    'retry-words': () => menu.generate({ imageModel }),
    update: (a) => menu.sync(a.scope ? { scope: a.scope } : { imageModel }),
    dismiss: () => menu.dismissPlanChange(),
    undo: async () => {
      await api.patch(`/proposals/${proposal.id}/menu-print`, { not_required: false });
      await onPrintChange();
    },
    'retry-save': () => menu.retrySave(),
    reload: () => menu.refetch(),
    download: () => downloadMenuPrint(`/proposals/${proposal.id}/menu-print`),
  };

  // The hook's actions resolve only once a GET after them lands, so the row
  // stays held (no second paid Generate) until the card shows the new state.
  const run = async (a) => {
    setActionError(null);
    review.clearNotice();
    setBusy(a.id);
    try {
      await IN_PLACE[a.id](a);
    } catch (err) {
      setActionError({ text: errorText(err, FALLBACK[a.id] || 'Something went wrong. Please try again.'), at: null });
    } finally {
      setBusy(null);
    }
  };

  const held = !!busy || !!review.busy;
  const button = (a) => {
    if (!a) return null;
    if (REVIEW_ACTIONS.has(a.id)) {
      return (
        <button key={a.id} type="button" className={BTN[a.style] || BTN.secondary} onClick={() => review.ask(a.id)} disabled={held}>
          {review.busy === a.id ? REVIEW_BUSY[a.id] : a.label}
        </button>
      );
    }
    if (a.id === 'copy-link') {
      const url = payload && payload.proof ? payload.proof.url : null;
      const copy = () => { review.clearNotice(); link.copy(url); };
      return (
        <button key={a.id} type="button" className={BTN[a.style] || BTN.ghost} onClick={copy}>{link.copied ? 'Copied' : a.label}</button>
      );
    }
    if (a.editor) {
      return canEdit ? (
        <button key={a.id} type="button" className={BTN[a.style] || BTN.primary} onClick={() => onOpenEditor(a.editor)}>{a.label}</button>
      ) : null;
    }
    const gate = a.id === 'generate' && st.generate.disabled ? st.generate : null;
    return (
      <button key={a.id} type="button" className={BTN[a.style] || BTN.primary} onClick={() => run(a)}
        disabled={held || !!gate} title={gate ? gate.hint : undefined}>
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
        <h3 ref={headingRef} tabIndex={-1}>Bar menu</h3>
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
            {review.error && <p className="chip danger md-alert" role="alert">{review.error.text}</p>}
            {review.notice && <p className="chip info md-alert" role="status">{review.notice}</p>}
            {link.error && <p className="chip danger md-alert" role="alert">{link.error}</p>}
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
        review={payload ? {
          proof: payload.proof || null, print: payload.print || null, narrow,
          busyLabel: review.busy ? REVIEW_BUSY[review.busy] : null,
          onRelease: () => review.ask('release'), onClose: () => review.ask('close'),
          onReadNotes: canEdit ? () => onOpenEditor({ tab: 'brief' }) : null,
        } : null}
      />
      {review.confirm && (
        <div className="md-cf-page">
          <ConfirmDialog {...reviewConfirm(review.confirm.kind, review.confirm)} onAction={review.go} onCancel={review.cancel} />
        </div>
      )}
    </div>
  );
}
