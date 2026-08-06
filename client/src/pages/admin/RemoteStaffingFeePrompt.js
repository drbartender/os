import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { initialFormFromProposal, recoverAddonQuantities } from './proposalEditor/formState';
import { buildProposalPatchBody } from './proposalEditor/patchBody';

// Same overlay the other admin dialogs use (CancelLineDialog).
const OVERLAY = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};

/**
 * Remote Staffing Fee prompt (spec 2026-08-06-contractor-duty-pay-design.md §6).
 *
 * Shared by the two ADMIN send surfaces (ProposalCreate's initial send and
 * ProposalDetail's resend). The public self-serve wizard and Thumbtack
 * auto-drafts deliberately get no popup: an admin reviews those in the editor.
 *
 * Mount it in place of the send you are about to fire. It self-checks and, when
 * there is nothing to ask, calls `onProceed()` immediately, so the caller's flow
 * is "render this, then send when it says so" with no branching of its own.
 *
 * FAIL-OPEN BY DESIGN: a failed check, a missing geocode, or a venue with no
 * street address all proceed to the send. This popup exists to catch money we
 * would otherwise forget to bill; it must never be the reason a proposal does
 * not go out.
 *
 * BILLED AT PROPOSAL TIME OR NEVER. Every choice, including "send without",
 * stamps `remote_fee_prompted_at`, so a client is never asked twice and a fee
 * is never bolted onto an already-booked event.
 *
 * The fee itself is written as an ordinary `{type:'surcharge'}` row in
 * `proposals.adjustments` through the EXISTING editor PATCH payload builder.
 * There is deliberately no second money path: the same builder, the same
 * endpoint, the same recalculation the editor uses.
 */
export default function RemoteStaffingFeePrompt({ proposalId, onProceed }) {
  const toast = useToast();
  const [check, setCheck] = useState(null);
  const [mode, setMode] = useState('loading'); // loading | ask | custom | saving
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState('');
  // The caller unmounts us on proceed, but a double-fire (fast double click,
  // a re-render race) would double-send. One-shot guard.
  const doneRef = useRef(false);
  // Both call sites pass an inline arrow, so `onProceed` has a new identity on
  // every parent render. Reading it through a ref keeps `proceed` stable, which
  // is what stops the check effect below from re-firing the GET on each render.
  const onProceedRef = useRef(onProceed);
  useEffect(() => { onProceedRef.current = onProceed; });

  const proceed = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onProceedRef.current();
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get(`/proposals/${proposalId}/remote-staffing-check`)
      .then((res) => {
        if (cancelled) return;
        if (!res.data || !res.data.should_prompt) { proceed(); return; }
        setCheck(res.data);
        setMode('ask');
      })
      .catch(() => {
        // Never block a send on a check failure.
        if (!cancelled) proceed();
      });
    return () => { cancelled = true; };
  }, [proposalId, proceed]);

  /** Stamp the answer, then let the send run. Stamping is best-effort. */
  const answerAndProceed = useCallback(async () => {
    try {
      await api.post(`/proposals/${proposalId}/remote-fee-prompt-answered`, {});
    } catch {
      // A failed stamp only means the admin may see this once more.
    }
    proceed();
  }, [proposalId, proceed]);

  /**
   * Append the surcharge through the editor's own PATCH builder. The full body
   * is rebuilt from the persisted proposal (plus the add-on catalog, which is
   * what recovers the raw stepper quantities), so this save is byte-equivalent
   * to opening the editor, adding one adjustment, and pressing Save. A partial
   * PATCH would be a bug: the server treats an absent `addon_ids` as an empty
   * set and would strip every add-on off the proposal.
   */
  const addFee = async (dollars) => {
    setErr('');
    const amount = Number(dollars);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErr('Enter a dollar amount above zero.');
      return;
    }
    setMode('saving');
    try {
      const [pRes, pkgRes, addonRes] = await Promise.all([
        api.get(`/proposals/${proposalId}`),
        api.get('/proposals/packages'),
        api.get('/proposals/addons'),
      ]);
      const proposal = pRes.data;
      const packages = pkgRes.data || [];
      const catalog = addonRes.data || [];

      const form = initialFormFromProposal(proposal);
      form.addon_quantities = recoverAddonQuantities(proposal.addons, catalog, {
        durationHours: proposal.event_duration_hours,
      });
      form.adjustments = [
        ...(form.adjustments || []),
        { type: 'surcharge', label: 'Remote Staffing Fee', amount, visible: true },
      ];

      // Same override detection the editor runs: stored num_bartenders is an
      // admin override only when it differs from what the inputs require.
      // Sending it unconditionally would pin staffing; dropping a real one
      // would silently un-charge over-ratio bartenders.
      const originalPkg = packages.find((x) => x.id === Number(proposal.package_id));
      let numBartendersOverride = null;
      const storedBartenders = Number(proposal.num_bartenders);
      if (storedBartenders && originalPkg) {
        const per = Number(originalPkg.guests_per_bartender) || 100;
        const required = Math.max(1, Math.ceil((Number(proposal.guest_count) || 0) / per));
        if (storedBartenders !== required) numBartendersOverride = storedBartenders;
      }

      await api.patch(`/proposals/${proposalId}`, buildProposalPatchBody(form, {
        isClassPackage: originalPkg ? originalPkg.bar_type === 'class' : proposal.class_options != null,
        numBartendersOverride,
      }));
      toast.success(`Remote Staffing Fee added: $${amount.toFixed(2)}.`);
      await answerAndProceed();
    } catch (e) {
      setMode('ask');
      setErr(e?.message || 'Could not add the fee. Try again, or send without it.');
    }
  };

  // The check is a network round-trip that can also geocode on demand, so it is
  // NOT instant. Rendering null here would leave the admin looking at an
  // unchanged page after clicking Send, with no signal anything is happening.
  // A blocking overlay both explains the pause and swallows a second click.
  if (mode === 'loading' || !check) {
    return (
      <div style={OVERLAY}>
        <div className="card" role="status" aria-live="polite" style={{ padding: '18px 22px' }}>
          <span className="muted">Checking staffing for this venue…</span>
        </div>
      </div>
    );
  }

  const miles = Math.round(check.venue_distance_miles);
  const suggestedDollars = check.suggested_fee_cents == null
    ? null
    : Number(check.suggested_fee_cents) / 100;
  const staffers = check.staff_within_40 === 1 ? 'staffer' : 'staffers';
  const busy = mode === 'saving';

  return (
    <div style={OVERLAY}>
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label="Remote Staffing Fee"
        style={{ width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-head">
          <h3>Remote Staffing Fee</h3>
        </div>
        <div className="card-body">
          <p style={{ marginTop: 0 }}>
            This venue is about {miles} miles out, {check.staff_within_40} active {staffers} within 40 miles
            {check.staff_uncounted > 0
              ? ` (${check.staff_uncounted} uncounted, no geocoded address)`
              : ''}
            .
          </p>
          <p>
            Add a Remote Staffing Fee?
            {suggestedDollars != null ? ` Suggested $${suggestedDollars.toFixed(2)}.` : ''}
          </p>
          {suggestedDollars == null && (
            <p className="tiny muted">
              No suggestion for a venue this far out. Price it by hand.
            </p>
          )}
          {mode === 'custom' && (
            <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <span className="tiny muted">Amount $</span>
              <input
                type="text"
                inputMode="decimal"
                value={custom}
                placeholder="0.00"
                disabled={busy}
                onChange={(e) => { setCustom(e.target.value); setErr(''); }}
                style={{ width: 90 }}
                aria-label="Remote Staffing Fee in dollars"
                autoFocus
              />
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => addFee(custom)}>
                Add and send
              </button>
            </div>
          )}
          {err && <div className="tiny" style={{ marginTop: 6, color: 'var(--danger, #b00)' }}>{err}</div>}
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: 14 }}>
            {suggestedDollars != null && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => addFee(suggestedDollars)}>
                {busy ? 'Adding…' : `Add $${suggestedDollars.toFixed(2)} and send`}
              </button>
            )}
            {mode !== 'custom' && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setMode('custom'); setErr(''); }}>
                Custom amount
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={answerAndProceed}>
              Send without
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
