import { useCallback, useMemo } from 'react';
import { useToast } from '../../context/ToastContext';
import { postAction, postSeen, undoAction } from './inboxApi';
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
    if (action === 'done') toast.success('Done. Moved to Handled.', withUndo);
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
