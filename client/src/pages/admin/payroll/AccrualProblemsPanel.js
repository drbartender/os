// AccrualProblemsPanel (React component, default export): the completed events payroll did not take, read from GET /admin/payroll/accrual-problems, with a Retry per event and an audited Dismiss on a recorded row; Process refuses an open period while one is dated in it.
//
// Reasons (server/utils/payrollAccrualFailures.js): 'error' the accrual threw,
// 'no_lines' a completed event in an open period has an approved worker with no
// wage line, 'period_closed' the event's pay period was already closed when it
// completed, so those wages went nowhere and need a hand fix. 'no_lines' is
// never dismissed: processing over it loses that pay for good. The list stays
// on screen while it refetches (only the first load shows nothing), so a
// second tap never lands on a row that moved. onChanged tells the page a
// retry or dismiss may have moved the pay run; reloadKey is the page asking
// the panel to refetch (a Process refused by the accrual gate).

import React, { useEffect, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EntityLink from '../../../components/EntityLink';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

// event_date is a DATE that serializes as a full ISO timestamp; slice to the
// date part before fmtDate (the idiom of the other payroll panels).
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

const REASON = {
  error: {
    chip: 'danger',
    label: 'failed',
    text: 'The payroll accrual failed. Retry runs it again.',
    dismissConfirm: 'Dismiss this failure? Only do this once its staff are paid in full. A worker with no payroll line still blocks the week.',
  },
  no_lines: { chip: 'warn', label: 'no lines', text: 'A worker on this completed event has no payroll line. Retry writes it.' },
  period_closed: {
    chip: 'danger',
    label: 'period closed',
    text: 'Its pay period was already closed, so a worker on this event was not paid. Pay them by hand, then dismiss.',
    dismissConfirm: 'Dismiss this event? Only do this once its staff are paid by hand.',
  },
};

// Why a retry that wrote nothing cleared the row (the accrual's own skip).
const SKIP_TEXT = {
  not_completed: 'it is no longer marked completed',
  no_approved_workers: 'nobody is approved on it',
  legacy_cc_stub_participant: 'a staff member on it is a legacy record',
  proposal_missing_or_no_event_date: 'it has no event date',
  pay_period_not_open: 'its pay period is closed and every worker already has a line',
};

export default function AccrualProblemsPanel({ onChanged, reloadKey = 0 }) {
  const toast = useToast();
  const [items, setItems] = useState(null); // null until the first load
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState({});
  const loadedRef = useRef(false);

  const refresh = () => {
    api.get('/admin/payroll/accrual-problems')
      .then((r) => { loadedRef.current = true; setError(false); setItems(r.data.items || []); })
      .catch(() => {
        // A failed refetch keeps the last list; only the first load degrades.
        if (loadedRef.current) toast.error('Could not refresh the events payroll did not take.');
        else setError(true);
      });
  };
  useEffect(refresh, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (proposalId, kind, reason) => {
    if (busy[proposalId]) return;
    if (kind === 'dismiss' && !window.confirm((REASON[reason] || REASON.error).dismissConfirm)) return;
    setBusy((b) => ({ ...b, [proposalId]: true }));
    try {
      const { data } = await api.post(`/admin/payroll/accrual-problems/${proposalId}/${kind}`);
      if (kind === 'dismiss') toast.success('Dismissed.');
      else if (data.reason) toast.error((REASON[data.reason] || REASON.error).text);
      else if (data.accrual && data.accrual.skipped) {
        toast.success(`Cleared. Payroll had nothing to write: ${SKIP_TEXT[data.accrual.reason] || 'nothing was owed'}.`);
      } else toast.success('Payroll lines written.');
      if (onChanged) onChanged();
    } catch (err) {
      toast.error(err.message || 'That did not work. Try again.');
    } finally {
      setBusy((b) => ({ ...b, [proposalId]: false }));
      refresh();
    }
  };

  if (items === null && !error) return null;
  if (error) {
    return (
      <div className="card" style={{ marginBottom: 16 }}><div className="card-body">
        <span className="muted">Failed to load the events payroll did not take. </span>
        <button type="button" className="btn btn-sm" onClick={() => { setError(false); refresh(); }}>Retry</button>
      </div></div>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="vstack" style={{ gap: 8, marginBottom: 16 }}>
      <div className="tiny muted">
        {items.length} completed event{items.length === 1 ? '' : 's'} payroll did not take.
        A pay period with one of these in it cannot be processed until it is fixed.
      </div>
      {items.map((it) => {
        const r = REASON[it.reason] || REASON.error;
        const lbl = getEventTypeLabel({ event_type: it.event_type, event_type_custom: it.event_type_custom });
        const isBusy = !!busy[it.proposal_id];
        return (
          <div key={it.proposal_id} className="card card-flush">
            <div className="card-body hstack" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusChip kind={r.chip}>{r.label}</StatusChip>
              <div style={{ minWidth: 200, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  <EntityLink to={`/proposals/${it.proposal_id}`}>
                    {it.event_date ? fmtDate(ymd10(it.event_date)) : 'No date'} {lbl}
                  </EntityLink>
                  {it.client_name ? <span className="muted"> · {it.client_name}</span> : null}
                </div>
                <div className="tiny muted">
                  {r.text}
                  {it.reason === 'error' && it.attempts > 1 ? ` Failed ${it.attempts} times.` : ''}
                </div>
              </div>
              <div className="hstack" style={{ gap: 6 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={isBusy}
                  onClick={() => act(it.proposal_id, 'retry', it.reason)}>
                  {isBusy ? 'Working…' : 'Retry'}
                </button>
                {r.dismissConfirm && (
                  <button type="button" className="btn btn-sm" disabled={isBusy}
                    onClick={() => act(it.proposal_id, 'dismiss', it.reason)}>
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
