import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import useSheetFocus from '../../hooks/useSheetFocus';
import { saveErrorText, READ_TIMEOUT_MS } from '../../utils/editSheetView';

// The internal booking note (proposals.admin_notes; lane ma-e3, spec section
// 3, brainstorm decisions of 2026-10-05): never shown to staff or clients, no
// money. Read fresh (plain api.get with the read timeout and nothing else,
// never the stored copy), saved through PATCH /proposals/:id/notes (no
// timeout: a write can land after the phone gives up) after a re-read: a note
// that changed while the sheet was open is shown, and the text you wrote is
// kept until you choose. A re-read that carries no admin_notes at all shows
// the choice too: the compare fails closed.
// Back and the scrim keep an unsaved draft with the owner (onDraft) as
// { text, base }, base being the note it was written over, so a draft reopened
// after the note moved offers the same choice at once. Cancel and a save clear
// it; Cancel before the note has loaded and shown it leaves it alone.
export const NOTE_LOAD_FAILED = "Couldn't load the note. Editing needs a connection.";
export const NOTE_CHANGED = 'This note changed since you opened it.';
const NOTE_MAX = 10000;
const READ = { timeout: READ_TIMEOUT_MS };

export default function NoteSheet({ proposalId, draft = null, onDraft, onSaved, onClose }) {
  const [phase, setPhase] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [stored, setStored] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState(null);
  const [theirs, setTheirs] = useState(null);
  const textRef = useRef(null);
  const sheetRef = useRef(null);
  const settled = useRef(false);
  const latest = useRef({ text: '', stored: '', phase: 'loading' });
  latest.current = { text, stored, phase };
  const handlers = useRef({ onDraft });
  handlers.current = { onDraft };
  const closers = useRef({});
  closers.current = { onClose: () => { if (!busyRef.current && onClose) onClose(); } };
  useSheetFocus(sheetRef, closers);

  useEffect(() => {
    let gone = false;
    setPhase('loading');
    setError(null);
    api.get(`/proposals/${proposalId}`, READ)
      .then((res) => {
        if (gone) return;
        const note = (res.data && res.data.admin_notes) || '';
        // A kept draft is measured against the note it was written over.
        const base = draft ? draft.base : note;
        setStored(base);
        setText(draft ? draft.text : note);
        setTheirs(note !== base ? note : null);
        setPhase('ready');
      })
      .catch(() => { if (!gone) setPhase('failed'); });
    return () => { gone = true; };
    // The draft seeds the text at open only; a later draft is ours, not new input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalId, attempt]);

  useEffect(() => { if (phase === 'ready' && textRef.current) textRef.current.focus(); }, [phase]);

  // The changed-meanwhile choice is brought into view as it appears, and focus
  // moves to its words: neither choice is the safe one, so no button takes it.
  // Declared after the textarea's focus, so a choice shown at open wins.
  const conflictRef = useRef(null);
  const conflictCopyRef = useRef(null);
  useEffect(() => {
    if (theirs === null) return;
    const box = conflictRef.current;
    if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
    if (conflictCopyRef.current) conflictCopyRef.current.focus({ preventScroll: true });
  }, [theirs]);

  // Closed by Back or the scrim: keep what was written, with the note it was
  // written over, if it differs.
  useEffect(() => () => {
    const l = latest.current;
    if (settled.current || l.phase !== 'ready' || !handlers.current.onDraft) return;
    handlers.current.onDraft(l.text !== l.stored ? { text: l.text, base: l.stored } : null);
  }, []);

  // Every save reads the note again first. `over` is the note being
  // overwritten: the one the text was written over (Save) or the one the
  // choice shows (Save mine). A note that moved since refreshes the choice,
  // and nothing is sent; so does a read with no admin_notes key at all. A
  // failed re-read is a definite "didn't save"; a PATCH that got no answer
  // may have landed, and says so.
  const save = async (over) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const fresh = await api.get(`/proposals/${proposalId}`, READ);
      const known = !!fresh.data && Object.prototype.hasOwnProperty.call(fresh.data, 'admin_notes');
      const now = (known && fresh.data.admin_notes) || '';
      if (!known || now !== over) { setTheirs(now); return; }
      let res;
      try {
        res = await api.patch(`/proposals/${proposalId}/notes`, { admin_notes: text });
      } catch (err) {
        setError(saveErrorText(err, true));
        return;
      }
      settled.current = true;
      if (onDraft) onDraft(null);
      if (onSaved) onSaved(res.data && res.data.admin_notes != null ? res.data.admin_notes : text);
      if (onClose) onClose();
    } catch (err) {
      setError(saveErrorText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const saveMine = () => { setTheirs(null); save(theirs); };
  const discardMine = () => { setStored(theirs); setText(theirs); setTheirs(null); };
  const cancel = () => {
    if (busyRef.current) return;
    // A kept draft the sheet has not shown (still loading, or the read failed) stays kept.
    if (phase === 'ready') {
      settled.current = true;
      if (onDraft) onDraft(null);
    }
    if (onClose) onClose();
  };

  return (
    <>
      <button type="button" className="m-sheet-scrim" aria-label="Close" tabIndex={-1}
        onClick={() => closers.current.onClose()} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Note" tabIndex={-1} ref={sheetRef}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">Note</h2>
          <div className="m-sheet-mix">internal · never shown to staff or clients</div>
        </div>
        <div className={`m-sheet-body${busy ? ' m-sheet-busy' : ''}`}>
          {phase === 'loading' && <div className="m-sheet-state">Loading the note</div>}
          {phase === 'failed' && (
            <div className="m-fail" role="alert">
              <span className="m-fail-msg">{NOTE_LOAD_FAILED}</span>
              <button type="button" className="m-fail-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
            </div>
          )}
          {phase === 'ready' && (
            <>
              <textarea ref={textRef} className="m-note-text" aria-label="Note" rows={8} maxLength={NOTE_MAX}
                value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setError(null); }} />
              {theirs !== null && (
                <div className="m-note-conflict" role="alert" ref={conflictRef}>
                  <div className="m-confirm-copy" tabIndex={-1} ref={conflictCopyRef}>{NOTE_CHANGED}</div>
                  <div className="m-note-theirs">{theirs || 'The note is now empty.'}</div>
                  <div className="m-confirm-btns">
                    <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={discardMine}>Discard mine</button>
                    <button type="button" className="m-act m-act-primary" disabled={busy} onClick={saveMine}>Save mine</button>
                  </div>
                </div>
              )}
              {error && <div className="m-fail" role="alert"><span className="m-fail-msg">{error}</span></div>}
            </>
          )}
        </div>
        <div className="m-acts">
          <button type="button" className="m-act m-act-quiet" disabled={busy} onClick={cancel}>Cancel</button>
          <button type="button" className="m-act m-act-primary"
            disabled={busy || phase !== 'ready' || theirs !== null || text === stored}
            onClick={() => save(stored)}>{busy ? 'Saving' : 'Save'}</button>
        </div>
      </div>
    </>
  );
}
