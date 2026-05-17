import React, { useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const DRAG_THRESHOLD_PX = 4;
const CLICK_DELAY_MS = 250;
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"]';

// A <tr> that navigates on a clean click but yields to text selection.
// Pass `to` for URL navigation (cmd/ctrl/middle-click opens a new tab) OR
// `onActivate` for non-URL activation (open a drawer, dispatch, window.open).
// The mouseup-intent gates (drag threshold, click delay, multi-click cancel,
// active-selection check, interactive-child guard) let admins drag-highlight
// and copy a cell value without the row navigating out from under them.
export default function ClickableRow({ to, onActivate, children, style, ...rest }) {
  const navigate = useNavigate();
  const pressRef = useRef(null);
  const clickTimerRef = useRef(null);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  const activate = (newTab) => {
    if (to) {
      if (newTab) window.open(to, '_blank', 'noopener,noreferrer');
      else navigate(to);
    } else if (onActivate) {
      onActivate();
    }
  };

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    pressRef.current = { x: e.clientX, y: e.clientY };
  };

  const onMouseUp = (e) => {
    const start = pressRef.current;
    pressRef.current = null;
    if (!start || e.button !== 0) return;

    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) return;

    if (e.target.closest(INTERACTIVE_SELECTOR)) return;

    if (e.ctrlKey || e.metaKey) {
      activate(true);
      return;
    }

    if (e.detail > 1) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      activate(false);
    }, CLICK_DELAY_MS);
  };

  const onAuxClick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      activate(true);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') activate(false);
  };

  return (
    <tr
      {...rest}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="link"
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </tr>
  );
}
