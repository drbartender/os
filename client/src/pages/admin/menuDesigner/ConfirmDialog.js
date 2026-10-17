import React, { useLayoutEffect, useRef } from 'react';

// The bar menu editor's confirm dialog (spec 2026-10-01 section 11.1, Confirm
// dialog): a 400 px card over a scrim inside the editor, a title, a line of
// text, then Cancel (ghost) and the action, right-aligned. Focus moves into it
// on open (to Cancel, the safe key) and returns to the control that opened it
// on close. Escape and Cancel close it; Tab stays inside it.
//
// Props:
//   title, text          the 15 px title and the 12.5 px line
//   actionLabel          the action button's label
//   actionClass          its classes (default 'btn btn-primary')
//   cancelLabel          default 'Cancel'
//   onAction, onCancel   called on click (onCancel also on Escape)
// editorConfirm(id, { need, print }) -> the copy of the editor's three
//   confirms: 'start-over' (need: the images Generate uses), 'replace' (print:
//   the GET's print, approved_file_in_use and approved_at) and 'close' (a
//   failed save on closing; Stay is the cancel).

export function editorConfirm(id, { need = 0, print = {} } = {}) {
  if (id === 'start-over') {
    return {
      title: 'Start over?', actionLabel: 'Start over', actionClass: 'btn btn-danger',
      text: `This discards the draft, its drawings and your text edits, then drafts again from the plan. Uses about ${need} images.`,
    };
  }
  if (id === 'replace') {
    const day = print.approved_at ? new Date(print.approved_at) : null;
    const date = day && !Number.isNaN(day.getTime()) ? day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return {
      title: 'Replace the print file?', actionLabel: 'Replace and approve', actionClass: 'btn btn-primary',
      text: print.approved_file_in_use
        ? `Staff will download this version instead of the one approved ${date}.`
        : 'Staff currently download a manual upload. Approving makes this draft the print file instead.',
    };
  }
  return {
    title: 'Close with an unsaved change?', actionLabel: 'Close anyway', actionClass: 'btn btn-primary', cancelLabel: 'Stay',
    text: "Your last change didn't save. Close anyway keeps it on the event page, where you can retry it.",
  };
}

export default function ConfirmDialog({
  title, text, actionLabel, actionClass = 'btn btn-primary', cancelLabel = 'Cancel', onAction, onCancel,
}) {
  const boxRef = useRef(null);
  const cancelRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // A layout effect: focus and the Escape listener arrive with the dialog's
  // commit, so an Escape pressed the moment it shows is never missed.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    if (cancelRef.current) cancelRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (onCancelRef.current) onCancelRef.current();
        return;
      }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const els = [...boxRef.current.querySelectorAll('button:not([disabled])')];
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div className="md-cf-scrim">
      <div className="md-cf" ref={boxRef} role="dialog" aria-modal="true" aria-labelledby="md-cf-title" aria-describedby="md-cf-text">
        <div className="md-cf-title" id="md-cf-title">{title}</div>
        <div className="md-cf-text" id="md-cf-text">{text}</div>
        <div className="md-cf-actions">
          <button type="button" className="btn btn-ghost" ref={cancelRef} onClick={() => onCancel && onCancel()}>{cancelLabel}</button>
          <button type="button" className={actionClass} onClick={() => onAction && onAction()}>{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}
