import React, { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import FieldError from '../../components/FieldError';
import api from '../../utils/api';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import { SMS_CONSENT_LEAD, SMS_CONSENT_VERSION } from '../../constants/smsConsent';

// The standalone SMS opt-in form, built for the Twilio A2P 10DLC campaign after
// two rejections (30909, then 30896) whose real cause was discoverability: the
// wizard's consent checkbox sits on step 2 of /quote, so a reviewer opening the
// page never sees it. Everything a reviewer looks for is in the first screen here.
//
// A THIRD rejection, "Forced Consent Violation" (2026-08-03), landed because the
// form required BOTH the number and the box, so nobody could decline texts and
// still use it. Hence rule 5. See
// docs/superpowers/specs/2026-08-03-sms-optional-consent.md.
//
// THE FIVE RULES THIS PAGE EXISTS TO SATISFY — do not "tidy" any of them away:
//   1. ONE checkbox, SMS only. Never bundle terms acceptance or a marketing
//      opt-in into it; a combined checkbox is itself a rejection reason.
//   2. Unchecked on load. `consent: false` below is a compliance requirement,
//      not a default worth "improving" — never seed it true, never remember it.
//   3. The sentence comes from constants/smsConsent.js, never retyped. It must
//      stay byte-identical to the copy quoted on /privacy, because comparing
//      the two is exactly what a carrier reviewer does.
//   4. FIELD ORDER IS LOAD-BEARING: mobile number, then the checkbox, then name
//      and email. The checkbox must land in the FIRST SCREEN on a real phone.
//      Putting name and email first pushes it under the fold on every phone
//      (390x664 Safari, 375x667, 412x732) and on 1366x768 laptops, which is the
//      exact defect that got us rejected. Note 844 is an iPhone SCREEN height,
//      not its browser viewport — do not validate this against 390x844 and
//      conclude it fits. Putting the number first also keeps the sentence's "at
//      the mobile number provided" referring to a field already filled in.
//   5. THE BOX NEVER BLOCKS SUBMIT, and the number is required only when it is
//      ticked. Both are compliance requirements, not leniency: a reviewer has to
//      be able to fill this in, ignore the checkbox, submit, and get something.
//      Restoring either requirement re-earns the forced-consent rejection.
//      The signal that carries this to a reviewer is the "(optional)" in the
//      number's LABEL, deliberately not a hint line under the field: the label
//      already occupies its line, so it is nearly free, where a hint line is a
//      new one. Measured cost of the word: 0px at 390, 412 and 1366, and 25px at
//      375x667, where the longer label wraps to two lines (487 -> 512 of 667).
//      Budgeted, not free — rule 4 is about exactly this budget. The email path
//      is named in the card's h2, because the hero sub-line that also names it is
//      display:none under 640px and cannot be relied on for a phone.
//
// See docs/superpowers/specs/2026-07-30-sms-opt-in-page.md.

// Focus order for reporting the first invalid field, matching render order.
// No sms_consent entry: the checkbox cannot produce a field error (rule 5), so
// listing it here would be a branch nothing can ever reach.
const FIELD_FOCUS_IDS = [
  ['client_phone', 'sms-phone'],
  ['client_name', 'sms-name'],
  ['client_email', 'sms-email'],
];

export default function SmsOptInPage() {
  const [form, setForm] = useState({ client_name: '', client_email: '', client_phone: '' });
  const [consent, setConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // null until submitted, then 'sms' or 'email' — which success card to show.
  // Taken from the local checkbox, never from the response: the endpoint answers
  // a generic ok for every outcome on purpose, so it cannot be used to probe
  // whether an address is already a client.
  const [done, setDone] = useState(null);
  const doneHeadingRef = useRef(null);
  const alertRef = useRef(null);

  // Runs AFTER the success card is in the DOM, so the ref is guaranteed non-null.
  // The submit button sits well down the page, so without the scroll the card
  // renders above the scroll position and partly behind the sticky header, and
  // the STOP / HELP / START copy is the whole point of it. The focus move is
  // also the actual announcement: role="status" on a node that did not exist a
  // moment ago is not reliably announced on its own.
  useLayoutEffect(() => {
    if (!done) return;
    window.scrollTo(0, 0);
    doneHeadingRef.current?.focus();
  }, [done]);

  // Same race, same fix, for the error banner: it sits at the top of a form
  // whose submit button is far below it, so an unfocused, unscrolled error is
  // an apparently-dead button.
  useLayoutEffect(() => {
    if (!error) return;
    window.scrollTo(0, 0);
    alertRef.current?.focus();
  }, [error]);

  const update = (key, value) => {
    setForm(f => ({ ...f, [key]: value }));
    setFieldErrors(fe => (fe[key] ? { ...fe, [key]: undefined } : fe));
  };

  // Mirrors the server checks in server/routes/smsOptIn.js. The server stays
  // authoritative — this only saves a round trip. The 255-char name/email caps
  // are server-only on purpose: they are column widths, not user-facing rules,
  // and the server's fieldErrors render here if anyone ever hits one.
  const validate = () => {
    const errs = {};
    // Rule 5: the checkbox never blocks submit, and the number is checked ONLY
    // when it is ticked. Not merely "required only then" — not validated at all,
    // because the server ignores and never stores a number on the no-texts path.
    // Rejecting a half-typed number from someone who then decides against texts
    // would dead-end exactly the person this page has to let through.
    if (consent) {
      if (!form.client_phone) errs.client_phone = 'Please enter your mobile number to receive texts';
      else if (stripPhone(form.client_phone).length !== 10) {
        errs.client_phone = 'Please enter a valid 10-digit US mobile number';
      }
    }
    if (!form.client_name.trim()) errs.client_name = 'Please enter your name';
    if (!form.client_email.trim()) errs.client_email = 'Please enter your email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.client_email.trim())) {
      errs.client_email = 'Please enter a valid email address';
    }
    return errs;
  };

  // Without this, a failed submit is silent: you press the button at the bottom
  // of the form and the error that explains why is above the scroll position, or
  // behind the sticky header. Centering rather than scrolling to the top is what
  // keeps the header from covering the thing we just focused.
  const revealFirstError = (errs) => {
    const hit = FIELD_FOCUS_IDS.find(([key]) => errs[key]);
    if (!hit) return;
    const el = document.getElementById(hit[1]);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      revealFirstError(errs);
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/sms/opt-in', {
        client_name: form.client_name.trim(),
        client_email: form.client_email.trim(),
        client_phone: form.client_phone,
        sms_consent: consent,
        sms_consent_version: SMS_CONSENT_VERSION,
      });
      // Scroll and focus are NOT done here; see the layout effect above. This
      // used to call requestAnimationFrame right after setDone, which races
      // React's commit: when the frame won, doneHeadingRef.current was still
      // null and the focus silently never happened. Measured at 390x664 it lost
      // the announcement in 6 of 32 runs, and only on the email card (the
      // heavier of the two) — an intermittent failure on exactly the path this
      // page exists to serve.
      setDone(consent ? 'sms' : 'email');
    } catch (err) {
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicLayout>
      {/* Deliberately compact — no ornament, tighter padding, one-line sub. Every
          pixel here is a pixel the checkbox has to clear on a phone. See rule 4
          above and the .sms-optin-hero note in index.css. */}
      <section className="ws-press-pagehero sms-optin-hero">
        <div className="ws-wrap">
          <div className="ws-press-eyebrow">No. 10 · Stay in the Loop</div>
          <h1 className="ws-press-pagehero-title">Stay in the loop</h1>
          <p className="ws-press-pagehero-sub">
            Updates about your event by email, and by text if you want them.
          </p>
        </div>
      </section>

      <section className="ws-section sms-optin-section">
        <div className="ws-wrap narrow">
          {done ? (
            <div className="wz-card sms-optin-done">
              {/* Distinct headings: this h2 takes focus and carries role=status,
                  so it is the summary a screen reader announces. Announcing
                  "You're signed up" to someone who just declined texts tells
                  them nothing about which thing they signed up for. */}
              <h2 ref={doneHeadingRef} tabIndex={-1} role="status">
                {done === 'sms' ? "You're signed up for texts" : "Thanks, we've got your details"}
              </h2>
              {done === 'sms' ? (
                <>
                  {/* "Texts from us are about..." rather than "We'll text you
                      about... at the number you gave us". The endpoint answers a
                      generic 200 for EVERY outcome on purpose (an outcome-specific
                      response would be an oracle for which emails are clients and
                      which numbers have opted out), so this card also renders when
                      recordSmsConsent refused and rolled the whole submit back —
                      prior_opt_out, or an existing client — where no row, no
                      consent and no number were stored and no text will ever
                      arrive. Describing what our texts ARE keeps every required
                      CTIA disclosure while promising nothing we may not do. */}
                  <p>
                    Texts from us are about your quote, booking, payments, and event
                    details. Message frequency varies. Msg &amp; data rates may apply.
                  </p>
                  <p>
                    Reply <strong>STOP</strong> to any message to opt out, or{' '}
                    <strong>HELP</strong> for help. If you&apos;ve texted us STOP before, reply{' '}
                    <strong>START</strong> to any message from us to turn texts back on.
                  </p>
                </>
              ) : (
                /* THIS COPY HAS BEEN WRONG THREE TIMES, every time by promising
                   something the write cannot deliver. The write is ONE
                   email_leads upsert. Each of these shipped and was caught:
                     - "we won't text you" — false for someone ALREADY a client
                       with SMS on, because this path never touches their clients
                       row;
                     - "we'll email you about your quote, booking, payments and
                       event details" — false, none of those send off an
                       email_leads row (they key off clients and proposals);
                     - "we'll be in touch by email about your event" — still a
                       forward promise, and false for a previously unsubscribed
                       lead, who stays unsubscribed by design (status is
                       deliberately excluded from the upsert's DO UPDATE) and is
                       filtered out of every send.
                   Nothing here may describe a future send. The heading states
                   what we have; this states what the submit did NOT do, which is
                   the one thing the person actually chose. If you are about to
                   add a warmer sentence, it is the fourth instance. */
                <>
                  <p>
                    You left the text box unticked, so this signup doesn&apos;t turn on
                    texts.
                  </p>
                  {/* Names a channel a HUMAN reads, and that is the point. For
                      someone who is not yet a client, coming back and ticking
                      the box genuinely works now (this path writes no clients
                      row, so nothing blocks a later opt-in). For someone who
                      already IS a client it does not — recordSmsConsent refuses
                      any row the submit did not create — and the page cannot
                      tell which without leaking whether the address is a client.
                      An email address is the one instruction that is true for
                      both, and turning SMS back on is a manual flip anyway:
                      nothing in the admin UI writes communication_preferences. */}
                  <p>
                    Want texts later? Email us at{' '}
                    <a href="mailto:contact@drbartender.com">contact@drbartender.com</a>{' '}
                    and we&apos;ll turn them on.
                  </p>
                </>
              )}
              <p className="sms-optin-next">
                Ready for pricing? <Link to="/quote">Request a quote</Link>.
              </p>
            </div>
          ) : (
            <form className="wz-card" onSubmit={submit} noValidate>
              {/* Names BOTH channels, and that is load-bearing on a phone. The
                  hero sub-line is the other place the email path is named, and
                  it is display:none under 640px (index.css), so without "email"
                  here the entire first screen on a phone would read as
                  SMS-only — the reading that earned the forced-consent
                  rejection. Do not shorten this back to "Sign up for updates". */}
              <h2>Get updates by email or text</h2>
              {error && (
                <div className="alert alert-error" role="alert" ref={alertRef} tabIndex={-1}>
                  {error}
                </div>
              )}

              <div className="wz-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  {/* "(optional)" is a compliance signal, not a courtesy — see
                      rule 5. It lives on the label so it costs no height. */}
                  {/* Conditional, because a static "(optional)" contradicts the
                      field once the box is ticked: aria-required flips to true
                      and a blank number 400s, so a screen reader would announce
                      "optional" and "required" together. Rule 5 is unaffected —
                      rule 2 guarantees the box is unticked on load, so a carrier
                      reviewer always lands on "(optional)".
                      "(required)" rather than the "*" the other labels use, and
                      that is deliberate: the two words are the SAME LENGTH, so
                      the label cannot re-wrap when the box is ticked. With "*"
                      the label un-wraps at 375x667 and everything below it —
                      including the checkbox the user's finger is still on —
                      jumps up 25px mid-tap. */}
                  <label htmlFor="sms-phone" className="form-label">
                    Mobile Number {consent ? '(required)' : '(optional)'}
                  </label>
                  <input id="sms-phone" className="form-input" type="tel"
                    value={formatPhoneInput(form.client_phone)}
                    onChange={e => update('client_phone', stripPhone(e.target.value))}
                    placeholder="(312) 555-1234" autoComplete="tel"
                    aria-required={consent} aria-invalid={!!fieldErrors.client_phone} />
                  <FieldError error={fieldErrors.client_phone} />
                </div>

                {/* Rules 1-4 at the top of this file all live in this block. */}
                <div className="form-group wz-consent" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="sms-consent" className="wz-consent-label">
                    <input
                      id="sms-consent"
                      type="checkbox"
                      checked={consent}
                      onChange={e => {
                        setConsent(e.target.checked);
                        // Clear the PHONE error, not a consent one. Unticking is
                        // the action that makes a "your number is required"
                        // error obsolete, and the checkbox itself can no longer
                        // have an error at all (rule 5) — clearing fe.sms_consent
                        // here was a no-op that left "Please enter your mobile
                        // number" and aria-invalid stuck on a field the same
                        // click had just marked optional.
                        setFieldErrors(fe => (fe.client_phone ? { ...fe, client_phone: undefined } : fe));
                      }}
                    />
                    <span className="wz-consent-text">
                      {SMS_CONSENT_LEAD}{' See our '}
                      <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>
                      {' and '}
                      <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link>.
                    </span>
                  </label>
                  {/* No FieldError here on purpose: the checkbox has no validity
                      state to report, and rendering one advertises a
                      required-ness that rule 5 forbids restoring. */}
                </div>

                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="sms-name" className="form-label">Your Name *</label>
                  <input id="sms-name" className="form-input" value={form.client_name}
                    onChange={e => update('client_name', e.target.value)} placeholder="Jane Smith"
                    autoComplete="name" aria-required="true"
                    aria-invalid={!!fieldErrors.client_name} />
                  <FieldError error={fieldErrors.client_name} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="sms-email" className="form-label">Email *</label>
                  <input id="sms-email" className="form-input" type="email" value={form.client_email}
                    onChange={e => update('client_email', e.target.value)} placeholder="jane@example.com"
                    autoComplete="email" aria-required="true"
                    aria-invalid={!!fieldErrors.client_email} />
                  <FieldError error={fieldErrors.client_email} />
                  <p className="sms-optin-why-email">
                    So we can send your quote and confirmations too.
                  </p>
                </div>
              </div>

              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Signing you up…' : 'Sign me up'}
              </button>
              <p className="sms-optin-note">
                We use your number only to text you about your event. We never sell it,
                and we never share it for anyone else&apos;s marketing.
              </p>
            </form>
          )}
        </div>
      </section>
    </PublicLayout>
  );
}
