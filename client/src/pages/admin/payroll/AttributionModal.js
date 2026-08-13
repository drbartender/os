import React, { useEffect, useState, useCallback, useRef } from 'react';
import api from '../../../utils/api';
import { fmtDate } from '../../../components/adminos/format';

const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

// Overlay idiom copied from CancelLineDialog.js (vanilla CSS, no modal class).
const OVERLAY = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

// Run-payroll attribution modal (spec 2026-08-06 §5): who brought the bar,
// who did the pickup, who printed the menu. Opens from the Process intercept
// when GET .../unattributed-duties is non-empty (missing OR stale rows). The
// server 409 is a plain-message backstop; this modal always renders from the
// GET, never from an error body. Confirm PUTs each attribution (the server
// materializes/moves the money) and then hands control back to re-fire
// Process. Dismissing leaves Process blocked; the caller says why.
export default function AttributionModal({ periodId, onDone, onCancel }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState({});
  const [proposals, setProposals] = useState({});
  const [picks, setPicks] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  // Cancel-during-submit must stop the run: without this flag the detached
  // confirm() loop would still call onDone() after an explicit Cancel and
  // process the period against the admin's stated no (re-review NB1). Set on
  // unmount AND on the cancel paths; checked between PUTs and before onDone.
  const aborted = useRef(false);
  // Reset in SETUP, latch in cleanup: under React 18 StrictMode the mount is
  // simulated as setup -> cleanup -> setup with the ref preserved, so a
  // cleanup-only effect would latch true immediately and dead-lock confirm()
  // in dev (round-3 review). A real unmount still ends latched true.
  useEffect(() => {
    aborted.current = false;
    return () => { aborted.current = true; };
  }, []);

  const keyOf = (it) => `${it.proposal_id}:${it.kind}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get(`/admin/payroll/periods/${periodId}/unattributed-duties`);
      setItems(data.items || []);
      setUsers(data.users || {});
      setProposals(data.proposals || {});
      setPicks((prev) => {
        const next = { ...prev };
        for (const it of data.items || []) {
          const k = `${it.proposal_id}:${it.kind}`;
          if (!next[k] && it.eligible_user_ids.length === 1) next[k] = it.eligible_user_ids[0];
        }
        return next;
      });
    } catch (e) {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => { load(); }, [load]);

  const confirm = async () => {
    setRowErrors({});
    const unset = items.filter((it) => !picks[keyOf(it)]);
    if (unset.length) {
      setRowErrors(Object.fromEntries(unset.map((it) => [keyOf(it), 'Pick a staffer'])));
      return;
    }
    setSubmitting(true);
    const errs = {};
    for (const it of items) {
      if (aborted.current) return; // dismissed mid-run; caller already refreshed
      try {
        const res = await api.put('/admin/payroll/duty-attributions', {
          proposal_id: it.proposal_id, kind: it.kind, user_id: picks[keyOf(it)],
        });
        // The server answers 200 even when accrual refused, because the
        // attribution row itself DID save — only the money line did not. Left
        // unread, that reads as success and the modal closes on a no-op: Dallas
        // retried one attribution 14 times on 2026-08-12 with nothing to tell
        // him why (Sentry DRBARTENDER-SERVER-21). Surface it as a row error.
        const accrual = res && res.data && res.data.accrual;
        if (accrual && accrual.skipped) {
          const status = accrual.pay_period_status;
          errs[keyOf(it)] = accrual.reason === 'pay_period_not_open'
            ? `Attribution saved, but no pay line was created: this pay period is ${status || 'closed'}, not open. Duty pay only accrues while a period is open.`
            : `Attribution saved, but no pay line was created (${accrual.reason || 'accrual skipped'}).`;
        }
      } catch (e) {
        errs[keyOf(it)] = e.message;
      }
    }
    if (aborted.current) return; // never process a period the admin cancelled
    setSubmitting(false);
    setRowErrors(errs);
    if (Object.keys(errs).length === 0) onDone();
    else load(); // roster may have moved under us; re-render truth + row errors
  };

  const cancel = () => { aborted.current = true; onCancel(); };

  const proposalLabel = (id) => {
    const p = proposals[id];
    if (!p) return `Proposal ${id}`;
    const who = (p.client_name || '').trim();
    const when = p.event_date ? fmtDate(ymd10(p.event_date)) : '';
    return who ? `${who} · ${when}` : when || `Proposal ${id}`;
  };

  return (
    // Cancel stays available DURING submit (review W6: a stalled PUT must not
    // trap the admin — the writes that landed are refreshed by the caller).
    <div style={OVERLAY} role="dialog" aria-modal="true" onClick={cancel}>
      <div
        className="card modal-card"
        style={{ width: '100%', maxWidth: 560, maxHeight: '85vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-head">
          <div style={{ fontWeight: 600 }}>Who did each duty?</div>
        </div>
        <div className="card-body vstack" style={{ gap: 10 }}>
          <div className="tiny muted">
            These booked duties need a name before the period can process. The
            pay line lands on whoever you pick.
          </div>
          {loading && <div className="muted">Loading…</div>}
          {error && !loading && (
            <div className="vstack" style={{ gap: 8 }}>
              <div className="muted">Couldn't load the duty list.</div>
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div>
            </div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="muted tiny">All duties are attributed. You can process now.</div>
          )}
          {!loading && !error && items.map((it) => {
            const k = keyOf(it);
            return (
              <div key={k} className="vstack" style={{ gap: 4, paddingBottom: 8, borderBottom: '1px solid var(--line-1)' }}>
                <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ minWidth: 150 }}>{proposalLabel(it.proposal_id)}</span>
                  <span className="tiny muted">{it.label || it.kind}</span>
                  {it.stale && <span className="tiny" style={{ color: 'var(--warn, #b45309)' }}>needs re-attribution</span>}
                  <select
                    className="input"
                    value={picks[k] || ''}
                    onChange={(e) => setPicks((p) => ({ ...p, [k]: Number(e.target.value) || '' }))}
                    disabled={submitting}
                  >
                    <option value="">Pick a staffer…</option>
                    {it.eligible_user_ids.map((uid) => (
                      <option key={uid} value={uid}>{users[uid] || `User ${uid}`}</option>
                    ))}
                  </select>
                </div>
                {rowErrors[k] && <div className="tiny" style={{ color: 'var(--danger, #b91c1c)' }}>{rowErrors[k]}</div>}
              </div>
            );
          })}
        </div>
        <div className="card-body hstack" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
            Cancel
          </button>
          {items.length === 0 && !loading && !error ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onDone}>
              Continue processing
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={confirm} disabled={submitting || loading || error}>
              {submitting ? 'Saving…' : 'Confirm and process'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
