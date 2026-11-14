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
// section 13.2). The page's Done hands this hook the person's key and name,
// so after the Done lands it reads the item back once and the toast says only
// what that read shows, named for the person so two Dones in a row never read
// alike: the item's status is waiting and an open task holds them
// (state.has_task) "Done. <Name> is still waiting on the menu."; the item's
// own status is handled "Done. <Name> moved to Handled."; anything else (the
// read fails, times out, answers 404, or shows them snoozed, waiting with no
// task, or quiet) a plain "Done.", which is true either way. has_task alone
// is not enough: the server sets it for a snoozed person a task holds too.
// With no name the first two read "Done. Still waiting on the menu." and
// "Done. Moved to Handled.". Every line carries the same Undo. Nothing waits
// on that read (it is a full Inbox load on the server): the action resolves
// and the page refreshes as soon as the Done lands, and the toast follows
// when the read answers or after READ_BACK_MS.
const DONE_PLAIN_TEXT = 'Done.';
const READ_BACK_MS = 4000;

function doneLines(name) {
  const who = typeof name === 'string' ? name.trim() : '';
  if (!who) return { task: 'Done. Still waiting on the menu.', handled: 'Done. Moved to Handled.' };
  return { task: `Done. ${who} is still waiting on the menu.`, handled: `Done. ${who} moved to Handled.` };
}

// The Done line that is true for this person. Never rejects, and never
// settles later than READ_BACK_MS.
function doneText(personKey, name) {
  const lines = doneLines(name);
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(DONE_PLAIN_TEXT), READ_BACK_MS); });
  const read = Promise.resolve()
    .then(() => getItem(personKey))
    .then((res) => {
      const item = res && res.status === 200 && res.data ? res.data : null;
      if (!item) return DONE_PLAIN_TEXT;
      if (item.status === 'waiting' && item.state && item.state.has_task === true) return lines.task;
      return item.status === 'handled' ? lines.handled : DONE_PLAIN_TEXT;
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
    if (action === 'done') doneText(personKey, name).then((text) => toast.success(text, withUndo));
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
