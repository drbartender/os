import React from 'react';

// Shown at the top of the proposal after a switch lands, because the change the
// client just made happened somewhere else on the page: without this they close
// the drawer and have to hunt for what moved.
//
// Lives in its own file rather than in ProposalView, which is already at the
// 700-line soft cap.
export default function SwitchBanner({
  packageName, note, driftNote, droppedNote, undoName, onUndo, undoBusy, failed,
}) {
  return (
    <div className="oo-banner" role="status">
      <div className="oo-banner-k">Rewritten just now</div>
      <p className="oo-banner-body">
        Your proposal now reads <strong>{packageName}</strong>. {note}
        {droppedNote ? ` ${droppedNote}` : ''}
      </p>
      {/* Said separately rather than folded into the note above: a client who
          sees their total move should hear that some of it was us, not read a
          sentence implying their own choice did all of it. */}
      {driftNote && <p className="oo-banner-drift">{driftNote}</p>}
      {failed ? (
        <p className="oo-banner-failed">
          We could not switch you back automatically. Reply to your proposal
          email and we will restore it.
        </p>
      ) : undoName ? (
        <button type="button" className="oo-banner-undo" onClick={onUndo} disabled={undoBusy}>
          {undoBusy ? 'Undoing…' : `Undo · back to ${undoName}`}
        </button>
      ) : null}
    </div>
  );
}
