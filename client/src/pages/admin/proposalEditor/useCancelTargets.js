import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';

// The cancel-line targets on the editor's two parents, Proposal Detail and
// Event Detail (GET /proposals/:id/cancel-line/targets: the per-line remove
// buttons on the admin breakdown). It lives beside the editor because the
// editor's save and Reload are what move the lines under a loaded set.
//
// An adjustment target is POSITIONAL (`adjustment:<index>`, lineItemCancel.js),
// so a set fetched before the lines moved puts one line's remove button on
// another: delete a line in the editor and the old set binds the next line's
// row to an index that now holds the line after it, and the confirm removes,
// and may refund, the wrong line (consistency review, 2026-10-17). So:
//  - a set is shown only for the read of the booking it was fetched after
//    (the proposal object the page holds), so a new read hides the old set at
//    once and fetches its own;
//  - a late answer for an older request is dropped;
//  - `reload` clears at once and fetches again. The pages call it the moment a
//    save, a Reload or a line removal lands, before they re-read, so even a
//    failed re-read leaves only a set the server answered after the change.
// A second tab or admin moving the lines is out of the page's reach; that
// needs the server to bind a target to its line (fix list).
//
// Absent (null) on error, for a manager (preview and execute are adminOnly
// server-side), and on an archived or completed booking.
export default function useCancelTargets({ proposalId, proposal, isAdmin }) {
  const read = proposal || null;
  const status = read ? read.status : null;
  const eligible = !!isAdmin && !!status && !['archived', 'completed'].includes(status);
  const [loaded, setLoaded] = useState({ read: null, targets: null });
  const seq = useRef(0);

  const reload = useCallback(() => {
    seq.current += 1;
    const mine = seq.current;
    setLoaded({ read: null, targets: null });
    if (!eligible) return;
    api.get(`/proposals/${proposalId}/cancel-line/targets`)
      .then((r) => {
        if (mine !== seq.current) return;
        setLoaded({ read, targets: r.data && r.data.eligible ? r.data.targets : null });
      })
      .catch(() => { if (mine === seq.current) setLoaded({ read: null, targets: null }); });
  }, [proposalId, eligible, read]);

  useEffect(() => { reload(); }, [reload]);

  return { targets: loaded.read !== null && loaded.read === read ? loaded.targets : null, reload };
}
