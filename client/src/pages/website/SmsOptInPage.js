import React, { useRef, useState } from 'react';
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
// THE FOUR RULES THIS PAGE EXISTS TO SATISFY — do not "tidy" any of them away:
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
//
// See docs/superpowers/specs/2026-07-30-sms-opt-in-page.md.

// Focus order for reporting the first invalid field, matching render order.
const FIELD_FOCUS_IDS = [
  ['client_phone', 'sms-phone'],
  ['sms_consent', 'sms-consent'],
  ['client_name', 'sms-name'],
  ['client_email', 'sms-email'],
];

export default function SmsOptInPage() {
  const [form, setForm] = useState({ client_name: '', client_email: '', client_phone: '' });
  const [consent, setConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const doneHeadingRef = useRef(null);
  const alertRef = useRef(null);

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
    if (!form.client_phone) errs.client_phone = 'Please enter your mobile number';
    else if (stripPhone(form.client_phone).length !== 10) {
      errs.client_phone = 'Please enter a valid 10-digit US mobile number';
    }
    if (!consent) errs.sms_consent = 'Please check the box to agree to receive text messages';
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
        sms_consent: true,
        sms_consent_version: SMS_CONSENT_VERSION,
      });
      setDone(true);
      // The submit button sits well down the page, so the success card would
      // otherwise render above the scroll position (and partly behind the sticky
      // header) — the STOP / HELP / START copy is the whole point of it.
      window.scrollTo(0, 0);
      requestAnimationFrame(() => doneHeadingRef.current?.focus());
    } catch (err) {
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err.message || 'Something went wrong. Please try again.');
      window.scrollTo(0, 0);
      requestAnimationFrame(() => alertRef.current?.focus());
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
          <div className="ws-press-eyebrow">No. 10 · Text Updates</div>
          <h1 className="ws-press-pagehero-title">Get text updates</h1>
          <p className="ws-press-pagehero-sub">
            Texts about your quote, booking, payments, and event details.
          </p>
        </div>
      </section>

      <section className="ws-section sms-optin-section">
        <div className="ws-wrap narrow">
          {done ? (
            <div className="wz-card sms-optin-done">
              <h2 ref={doneHeadingRef} tabIndex={-1} role="status">You&apos;re signed up</h2>
              <p>
                We&apos;ll text you about your quote, booking, payments, and event details
                at the number you gave us. Message frequency varies. Msg &amp; data rates
                may apply.
              </p>
              <p>
                Reply <strong>STOP</strong> to any message to opt out, or{' '}
                <strong>HELP</strong> for help. If you&apos;ve texted us STOP before, reply{' '}
                <strong>START</strong> to any message from us to turn texts back on.
              </p>
              <p className="sms-optin-next">
                Ready for pricing? <Link to="/quote">Request a quote</Link>.
              </p>
            </div>
          ) : (
            <form className="wz-card" onSubmit={submit} noValidate>
              <h2>Sign up for text updates</h2>
              {error && (
                <div className="alert alert-error" role="alert" ref={alertRef} tabIndex={-1}>
                  {error}
                </div>
              )}

              <div className="wz-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="sms-phone" className="form-label">Mobile Number *</label>
                  <input id="sms-phone" className="form-input" type="tel"
                    value={formatPhoneInput(form.client_phone)}
                    onChange={e => update('client_phone', stripPhone(e.target.value))}
                    placeholder="(312) 555-1234" autoComplete="tel"
                    aria-required="true" aria-invalid={!!fieldErrors.client_phone} />
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
                        setFieldErrors(fe => (fe.sms_consent ? { ...fe, sms_consent: undefined } : fe));
                      }}
                      aria-required="true"
                      aria-invalid={!!fieldErrors.sms_consent}
                    />
                    <span className="wz-consent-text">
                      {SMS_CONSENT_LEAD}{' See our '}
                      <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>
                      {' and '}
                      <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link>.
                    </span>
                  </label>
                  <FieldError error={fieldErrors.sms_consent} />
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
                {submitting ? 'Signing you up…' : 'Sign up for text updates'}
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
