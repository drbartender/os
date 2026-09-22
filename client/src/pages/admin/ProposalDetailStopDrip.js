import React, { useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import { ctDay, fmtDate } from '../../components/adminos/format';

// "Stop follow-ups" (2026-09-22): one-way admin off switch for the event's
// unsigned-proposal drip. Lives beside Archive in the ProposalDetail header.
// Kills the in-flight touches on this proposal and every open option of the
// client for the same date; balance and event-week touches are unaffected.
// Resending does not restart it; only a new proposal starts a fresh sequence.
// Extracted from ProposalDetail.js at the size ratchet.
const DRIP_STATUSES = ['sent', 'viewed', 'modified'];

export default function ProposalDetailStopDrip({ proposal, editing, onStopped }) {
  const toast = useToast();
  const [showModal, setShowModal] = useState(false);
  const [stopping, setStopping] = useState(false);

  if (!proposal || editing) return null;

  const doStop = async () => {
    setStopping(true);
    try {
      const res = await api.post(`/proposals/${proposal.id}/stop-drip`, {});
      const n = res.data.suppressed || 0;
      if (res.data.already_stopped && !n) toast.success('Follow-ups were already stopped.');
      else if (n) toast.success(`Follow-ups stopped. ${n} pending message${n === 1 ? '' : 's'} cancelled.`);
      else toast.success('Follow-ups stopped. Nothing was pending.');
      setShowModal(false);
      if (onStopped) onStopped();
    } catch (err) {
      toast.error(err.message || 'Failed to stop follow-ups.');
    } finally {
      setStopping(false);
    }
  };

  if (proposal.drip_stopped_at) {
    return (
      <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}
        title="Automated follow-ups for this event were stopped by an admin. Resending does not restart them; a new proposal starts a fresh sequence.">
        Follow-ups stopped {fmtDate(ctDay(proposal.drip_stopped_at))}
      </span>
    );
  }
  if (!DRIP_STATUSES.includes(proposal.status)) return null;

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => setShowModal(true)} disabled={stopping}>
        <Icon name="bell" size={12} />Stop follow-ups
      </button>
      {showModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => !stopping && setShowModal(false)}>
          <div className="card modal-card" style={{ width: '100%', maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h3>Stop follow-ups</h3>
              <button type="button" className="btn btn-ghost btn-sm" disabled={stopping}
                onClick={() => setShowModal(false)}>
                <Icon name="x" size={11} />Cancel
              </button>
            </div>
            <div className="card-body">
              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Stop the automated follow-ups for this event? The remaining check-in texts and
                emails about this quote will not go out, on this proposal or any other open option
                for the same date. Balance reminders and event-week messages are not affected.
                This cannot be undone.
              </div>
              <div className="vstack" style={{ gap: 8 }}>
                <button type="button" className="btn btn-primary" disabled={stopping} onClick={doStop}>
                  {stopping ? 'Stopping…' : 'Stop follow-ups'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
