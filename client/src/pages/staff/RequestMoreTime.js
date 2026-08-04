import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

/**
 * Staff-facing "request more time" panel (spec 2026-07-25 section 5.1).
 *
 * The staffer picks a NEW END TIME from a picker that opens on the contracted
 * end and steps in 30 minutes. NO PRICE is shown, and the API deliberately does
 * not return one (spec decision 2), so there is nothing here to leak.
 */
export default function RequestMoreTime({ shiftId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState(null);
  const [error, setError] = useState('');
  const [choiceHours, setChoiceHours] = useState(null);
  const [productConfirmed, setProductConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/service-extensions/eligibility/${shiftId}`);
      setEligibility(res.data);
    } catch (err) {
      // api.js rejects with the normalized { message, code, fieldErrors, status }
      // shape (client/src/utils/api.js:45-50). err.response NEVER exists on the
      // rejected value, so reading it silently yields undefined and the user
      // always sees the generic fallback message. (A root-config lint rule also
      // flags it, though CRA's build does not load that config.) Models:
      // RequestSheet.js:141-147, ShiftDetail.js:319-327.
      setError(err.message || 'Could not load this event. Try again.');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (choiceHours === null || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/service-extensions', {
        shiftId,
        requestedEndHours: choiceHours,
        hostedProductConfirmed: productConfirmed,
      });
      setSent(true);
    } catch (err) {
      // Normalized error shape again: field errors arrive as err.fieldErrors,
      // the message as err.message. Never err.response (see the note in load()).
      setError(
        (err.fieldErrors && Object.values(err.fieldErrors)[0])
        || err.message
        || 'Could not send the request. Try again.'
      );
      // The baseline moved under us (another extension settled): the picker's
      // times are stale, so refresh them in place instead of telling the
      // staffer to close and reopen.
      if (err.code === 'EXTENSION_BASELINE_MOVED') load();
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="sp-card"><div className="sp-skeleton" style={{ height: '4rem' }} /></div>;
  }

  if (!eligibility) {
    // The eligibility load failed: without it the picker would render as an
    // empty fieldset with a dead submit button. Real error card + Retry.
    return (
      <div className="sp-card">
        <div className="sp-detail-title">Request more time</div>
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">{error || 'Could not load this event. Try again.'}</div>
        </div>
        <div className="sp-row" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
          <button type="button" className="sp-btn sp-btn-sm" onClick={load}>Retry</button>
          <button type="button" className="sp-btn sp-btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="sp-card">
        <div className="sp-detail-title">Request sent</div>
        <p className="sp-detail-sub">
          The client has been texted to confirm. You will get a message either way.
          Until then, bar service ends at the contracted time.
        </p>
        <button type="button" className="sp-btn sp-btn-sm" onClick={onClose}>Close</button>
      </div>
    );
  }

  const blocked = eligibility && !eligibility.eligible;
  const blockedCopy = {
    already_pending: 'A request for this event is already with the client.',
    too_early: 'You can request more time once the event has started.',
    too_late: 'The window to request more time for this event has closed.',
    unparseable_shift_time: 'We could not read this event’s times. Contact management.',
  };

  // Step the picker in 30-minute increments from the contracted end.
  const steps = [];
  if (eligibility) {
    const maxSteps = Math.round((eligibility.maxAdditionalHours || 3) / 0.5);
    for (let i = 1; i <= maxSteps; i++) steps.push(i * 0.5);
  }
  const baseHours = eligibility?.contractedDurationHours;

  return (
    <div className="sp-card">
      <div className="sp-detail-title">Request more time</div>
      <div className="sp-detail-sub">
        Bar service is contracted to end at {eligibility?.contractedEndDisplay || 'the scheduled time'}.
      </div>

      {blocked && (
        <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
          <div className="sp-error-card-msg">
            {blockedCopy[eligibility.reason] || 'More time cannot be requested for this event right now.'}
          </div>
        </div>
      )}

      {!blocked && (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: '0.8rem 0' }}>
            <legend className="sp-detail-sub">New end time</legend>
            {steps.map((added) => (
              <label key={added} className="sp-row" style={{ gap: '0.5rem', padding: '0.35rem 0' }}>
                <input
                  type="radio"
                  name="ext-end"
                  checked={choiceHours === (baseHours + added)}
                  onChange={() => setChoiceHours(baseHours + added)}
                />
                <span>{eligibility.stepLabels?.[String(added)] || `plus ${added * 60} minutes`}</span>
              </label>
            ))}
          </fieldset>

          {eligibility?.isHosted && (
            <label className="sp-row" style={{ gap: '0.5rem', margin: '0.6rem 0' }}>
              <input
                type="checkbox"
                checked={productConfirmed}
                onChange={(e) => setProductConfirmed(e.target.checked)}
              />
              <span>I have the product to serve this extra time.</span>
            </label>
          )}

          {error && (
            <div className="sp-error-card" style={{ marginTop: '0.6rem' }}>
              <div className="sp-error-card-msg">{error}</div>
            </div>
          )}

          <div className="sp-row" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              disabled={choiceHours === null || submitting || (eligibility?.isHosted && !productConfirmed)}
              onClick={submit}
            >
              {submitting ? 'Sending...' : 'Ask the client'}
            </button>
            <button type="button" className="sp-btn sp-btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
