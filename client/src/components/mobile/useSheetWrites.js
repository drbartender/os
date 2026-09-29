import { useCallback, useRef, useState } from 'react';
import api from '../../utils/api';
import { buildShiftView, roleStep, READ_ONLY_NOTE } from '../../utils/staffingSheet';

// The assignment sheet's writes: the only place the phone writes staffing.
//   approve / assign -> POST   /shifts/:id/assign          { user_id, position }
//   deny             -> PUT    /shifts/requests/:requestId { status: 'denied' }
//   remove           -> DELETE /shifts/requests/:requestId
//
// `position` keys payroll's tip split. The rules, each pinned by a test in
// AssignmentSheet.test.js:
//
// BEFORE A WRITE. Every write re-reads the shift, from the network and never
// from the phone's cache, and is refused unless the fresh roster still
// justifies it:
//   - the shift is not finished and not cancelled;
//   - approve: the same request is still pending (not withdrawn, not denied by
//     someone else), and when the tap was a plain Approve, the fresh request
//     still resolves to the same single role;
//   - assign: the person has no pending request and no place on the roster
//     (a denied request, or an approved one that was dropped, does not block);
//   - approve and assign: the role is still open;
//   - deny: the request is still pending; remove: the person is still on the
//     roster.
// A person already on the roster IN THE ROLE BEING WRITTEN means an earlier tap
// landed and only its answer was lost: nothing is sent, so nobody is texted or
// emailed twice. In another role, someone placed them from another screen, and
// the phone never writes over that. A request that is gone is already closed,
// unless the person is back under a new request.
//
// AFTER A FAILURE. Each row holds its own failed save: what it was (`label`),
// why it failed, and the write to repeat. It leaves the screen in THREE ways
// only: its own Retry (which repeats exactly that write, re-read included), a
// new WRITE on the same row, or Dismiss. Opening or closing a row, a confirm,
// the search field and anything done to another row never remove it: a tap
// that writes nothing must not erase the only record that a save failed.
//
// DURING A WRITE. `busyKey` and `busyLabel` name the write in flight, so the
// sheet can say so: on a weak link a write takes seconds. Busy ends when the
// WRITE settles. The re-read after it is for display only and holds nothing:
// the next write re-reads for itself.
//
// AFTER A SUCCESS, AND AFTER A REFUSAL. The owner is told at once: a refusal
// means the roster moved, so the owner's copy is behind as well. The roster
// is then re-read. After a save, if that read fails or is answered from the
// cache, the roster on screen is from before the save: `behind` says so, until
// a fresh roster goes on screen by any path.
export const OFFLINE_SAVE = "No connection, didn't save.";
export const ROSTER_MOVED = 'The roster changed. Check the open roles and try again.';
export const PERSON_MOVED = 'This person’s place on the shift changed. Check the roster and try again.';

const refusal = (status, message) => Object.assign(new Error(message), { status });
const isTransport = (err) => !err || err.status === 0 || err.code === 'NETWORK_ERROR';
const same = (a, b) => Number(a) === Number(b);

// showFresh(data): put a roster the re-read fetched on screen.
// reload(): re-read the roster for display; resolves true when a LIVE answer
//   was put on screen, false when none was, null when a newer read took over.
// onDone(ok): a write settled (the sheet closes its confirm).
// handlers: a ref to { onChanged }.
export default function useSheetWrites({ shiftId, showFresh, reload, onDone, handlers }) {
  const [writing, setWriting] = useState(null);   // { key, label }: the write in flight
  const [failures, setFailures] = useState({});
  const [behind, setBehind] = useState(false);
  const [justAssigned, setJustAssigned] = useState([]);
  const busyRef = useRef(false);      // the synchronous half of `busy`: a second tap lands before a render

  const forget = useCallback((key) => setFailures(({ [key]: gone, ...rest }) => rest), []);

  const run = useCallback(async (key, label, write) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setWriting({ key, label });
    forget(key);
    let ok = false;
    let refused = false;
    try {
      await write();
      ok = true;
    } catch (err) {
      const transport = isTransport(err);
      refused = !transport;
      const message = transport ? OFFLINE_SAVE : ((err && err.message) || 'Something went wrong. Try again.');
      setFailures((prev) => ({ ...prev, [key]: { label, message, write } }));
    } finally {
      busyRef.current = false;
      setWriting(null);
      onDone(ok);
    }
    // Nothing reached the server: nothing moved, and there is nothing to read.
    if (!ok && !refused) return;
    if (handlers.current.onChanged) handlers.current.onChanged();
    const shown = await reload();
    if (shown === true) setBehind(false);
    else if (shown === false && ok) setBehind(true);
  }, [forget, handlers, reload, onDone]);

  const reread = useCallback(async () => {
    const fresh = await api.get(`/shifts/detail/${shiftId}`);
    if (fresh.staleAt) throw refusal(0, OFFLINE_SAVE);
    const now = buildShiftView(fresh.data && fresh.data.shift, fresh.data && fresh.data.requests);
    // The refusal puts the roster it read on screen, and that roster is fresh.
    const moved = (why) => { showFresh(fresh.data || null); setBehind(false); return refusal(409, why); };
    if (now.closedReason) throw moved(READ_ONLY_NOTE[now.closedReason]);
    return { now, moved };
  }, [shiftId, showFresh]);

  // person: a roster row or a picker candidate. direct: a plain Approve, whose
  // role came from roleStep and not from a role row.
  const place = useCallback((person, role, { direct = false } = {}) => {
    const verb = person.kind === 'candidate' ? 'Assign' : 'Approve';
    return run(person.key, `${person.name} · ${verb} as ${role}`, async () => {
      const { now, moved } = await reread();
      const theirs = now.rows.filter((r) => same(r.userId, person.userId));
      const held = theirs.find((r) => r.kind === 'rostered');
      if (held && held.position !== role) throw moved(PERSON_MOVED);
      if (!held) {
        const asked = theirs[0] || null;                    // their own pending request, if any
        const expected = person.kind === 'candidate'
          ? !asked
          : !!asked && same(asked.requestId, person.requestId);
        if (!expected) throw moved(PERSON_MOVED);
        if (!now.openRoles.some((r) => r.role === role)) throw moved(ROSTER_MOVED);
        if (direct) {
          const step = roleStep(now, asked);
          if (step.kind !== 'direct' || step.role !== role) throw moved(PERSON_MOVED);
        }
        await api.post(`/shifts/${shiftId}/assign`, { user_id: person.userId, position: role });
      }
      setJustAssigned((prev) => (prev.includes(person.userId) ? prev : prev.concat(person.userId)));
    });
  }, [run, reread, shiftId]);

  const settle = useCallback((row, verb, write) => run(row.key, `${row.name} · ${verb}`, async () => {
    const { now, moved } = await reread();
    const mine = now.rows.find((r) => same(r.requestId, row.requestId));
    if (!mine) {
      if (now.rows.some((r) => same(r.userId, row.userId))) throw moved(PERSON_MOVED);
    } else {
      if ((mine.kind === 'rostered') !== (verb === 'Remove')) throw moved(PERSON_MOVED);
      await write();
    }
    // Off the shift: if they are assigned again, they are a candidate again.
    setJustAssigned((prev) => prev.filter((id) => !same(id, row.userId)));
  }), [run, reread]);

  const deny = useCallback(
    (row) => settle(row, 'Deny', () => api.put(`/shifts/requests/${row.requestId}`, { status: 'denied' })),
    [settle]
  );
  const remove = useCallback(
    (row) => settle(row, 'Remove', () => api.delete(`/shifts/requests/${row.requestId}`)),
    [settle]
  );
  const retry = useCallback((key) => {
    const held = failures[key];
    if (held) run(key, held.label, held.write);
  }, [failures, run]);
  const refresh = useCallback(async () => {
    const shown = await reload();
    if (shown !== null) setBehind(!shown);
  }, [reload]);

  return {
    busy: writing !== null,
    busyKey: writing ? writing.key : null,
    busyLabel: writing ? writing.label : null,
    failures, behind, justAssigned, place, deny, remove, retry, forget, refresh,
  };
}
