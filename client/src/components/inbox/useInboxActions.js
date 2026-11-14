// useInboxActions (default export): the Inbox taps (On it, Done, Snooze, Wake, Reopen) and the seen write, each
// with its toast and the page's refresh; Done on a person a menu task still holds says so.

import { useCallback, useMemo } from 'react';
import { useToast } from '../../context/ToastContext';
import { getItem, postAction, postSeen, undoAction } from './inboxApi';
import { stampLabel, UNDO_TOAST_MS } from './inboxFormat';

// The taps (spec 4.4): On it, Done, Snooze, Wake, Reopen, plus the seen write
// of a deliberate open (spec 4.2). After each the page refetches what it
// shows and refreshes the badges (spec 10), through `refresh`. Done, Snooze,
// Wake and Reopen toast with Undo for about 4 seconds; Undo calls the DELETE
// route, which marks the action undone and never deletes it. Claim and
// release toast without Undo (tapping again is the undo).
//
// A tap that lands re-reads the item only when it leaves the user on it:
// never after Done or Snooze (the page moves away, so that answer would be
// thrown away), and after anything else only when the tapped person is the
// open item (`openKey()`), so a Wake or Reopen from a list row re-reads the
// item on screen only when it is that row's person. The list and the badges
// refetch every time.
//
// Done closes the conversation and never a menu task (spec 2026-10-19
// section 13.2). The page's Done hands this hook only the person's key, so
// after the Done lands it reads the item back once: when an open task still
// holds the person (state.has_task) the toast reads "Done. Still waiting on
// the menu." with the same Undo; with no task it is unchanged. Nothing waits
// on that read (it is a full Inbox load on the server): the action resolves
// and the page refreshes as soon as the Done lands, and the toast follows
// when the read answers. A read that fails, or has not answered within
// READ_BACK_MS, toasts a plain "Done.", which is true either way.
const DONE_TEXT = 'Done. Moved to Handled.';
const DONE_TASK_TEXT = 'Done. Still waiting on the menu.';
const DONE_PLAIN_TEXT = 'Done.';
const READ_BACK_MS = 4000;

// The Done line that is true for this person. Never rejects, and never
// settles later than READ_BACK_MS.
function doneText(personKey) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(DONE_PLAIN_TEXT), READ_BACK_MS); });
  const read = Promise.resolve()
    .then(() => getItem(personKey))
    .then((res) => {
      if (!res || (res.status !== 200 && res.status !== 404)) return DONE_PLAIN_TEXT;
      const state = res.status === 200 && res.data ? res.data.state : null;
      return state && state.has_task === true ? DONE_TASK_TEXT : DONE_TEXT;
    })
    .catch(() => DONE_PLAIN_TEXT);
  return Promise.race([read, limit]).finally(() => clearTimeout(timer));
}

export default function useInboxActions({ refresh, openKey }) {
  const toast = useToast();

  const undo = useCallback(async (id) => {
    try {
      await undoAction(id);
    } catch (err) {
      toast.error((err && err.message) || "Couldn't undo that.");
    }
    refresh();
  }, [toast, refresh]);

  const act = useCallback(async (personKey, action, { until, name, takeoverFrom } = {}) => {
    let res;
    try {
      res = await postAction(personKey, action, until);
    } catch (err) {
      toast.error((err && err.message) || "Couldn't save that. Try again.");
      refresh();
      return false;
    }
    const id = res && res.data ? res.data.id : null;
    const withUndo = id === null || id === undefined
      ? undefined
      : { action: { label: 'Undo', onClick: () => undo(id) }, duration: UNDO_TOAST_MS };
    if (action === 'done') doneText(personKey).then((text) => toast.success(text, withUndo));
    else if (action === 'snooze') toast.info(`Snoozed until ${stampLabel(until, Date.now())}.`, withUndo);
    else if (action === 'wake' || action === 'reopen') toast.info(`${name || 'They'} ${name ? 'is' : 'are'} back in Waiting.`, withUndo);
    else if (action === 'claim') toast.success(takeoverFrom ? `Taken over from ${takeoverFrom}.` : "You're on it.");
    else if (action === 'release') toast.info('Released. Back to unclaimed.');
    const leaves = action === 'done' || action === 'snooze';
    refresh({ item: !leaves && (!openKey || openKey() === personKey) });
    return true;
  }, [toast, refresh, undo, openKey]);

  // Best effort: a seen write that fails leaves "Not read yet" up for the
  // other person, which is the safe direction.
  const markSeen = useCallback(
    (personKey) => postSeen(personKey).then(() => refresh({ item: false })).catch(() => {}),
    [refresh]
  );

  return useMemo(() => ({ act, undo, markSeen }), [act, undo, markSeen]);
}
