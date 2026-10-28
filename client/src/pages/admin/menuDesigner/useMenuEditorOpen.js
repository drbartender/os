// useMenuEditorOpen (default export). Header generated from the file's exports by migrate-headers
// on 2026-10-27; replace with what it does.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// The bar menu editor's open state (spec 2026-10-01 sections 4.2 and 10.1),
// for EventDetailPage: the query parameter ?menu=1, so browser Back closes the
// editor and moving to another event (whose URL has no ?menu=1) drops it.
//
// useMenuEditorOpen(proposalId) -> { open, view, openEditor(view), close() }
//   openEditor({ tab?, select? }) pushes one history entry (flagged in
//   location.state); view is that request, for this event only. close() pops
//   that entry, or, for an editor reached by link with nothing pushed behind
//   it, drops the parameter in place; it acts once per entry. When the editor
//   closes, focus returns to the card control that opened it.

const EDITOR_STATE = 'menuEditor';

const labelOf = (el) => (el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : '');
const canGoBack = () => {
  const s = typeof window !== 'undefined' && window.history ? window.history.state : null;
  return !s || typeof s.idx !== 'number' || s.idx > 0;
};

// The card remounts on close, so the opener is found again by its label, else
// the thumbnail, else the card's first button.
function focusOpener(label) {
  const card = document.querySelector('.md-card');
  if (!card) return;
  const buttons = [...card.querySelectorAll('button:not([disabled])')];
  const el = (label && buttons.find((b) => labelOf(b) === label)) || card.querySelector('button.md-thumb-canvas') || buttons[0];
  if (el) el.focus();
}

// The open state, for EventDetailPage: { open, view: { tab?, select? }, openEditor(view), close() }.
export default function useMenuEditorOpen(proposalId) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const open = params.get('menu') === '1';
  const pushed = !!(location.state && location.state[EDITOR_STATE]);
  const [view, setView] = useState({ id: null });
  const opener = useRef(null);
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [location.key]);

  const openEditor = useCallback((v = {}) => {
    const el = document.activeElement;
    opener.current = el && el !== document.body ? labelOf(el) : null;
    setView({ ...v, id: proposalId });
    const next = new URLSearchParams(params);
    next.set('menu', '1');
    setParams(next, { state: { [EDITOR_STATE]: true } });
  }, [params, setParams, proposalId]);

  // Pop the entry openEditor pushed; an editor reached by link has none behind it.
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (pushed && canGoBack()) { navigate(-1); return; }
    const next = new URLSearchParams(params);
    next.delete('menu');
    setParams(next, { replace: true });
  }, [params, setParams, pushed, navigate]);

  // At the commit that brings the card back, so focus never sits on the body.
  const was = useRef(open);
  useLayoutEffect(() => {
    if (was.current && !open) focusOpener(opener.current);
    was.current = open;
  }, [open]);

  return { open, view: view.id === proposalId ? view : {}, openEditor, close };
}
