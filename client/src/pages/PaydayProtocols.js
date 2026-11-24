// Onboarding step 5, Payday Protocols: the recruit picks how they get paid and fills out or uploads a W-9, in one Submit.
//
// Submit Onboarding is the only finish button: it checks the payout method and the W-9
// together, builds the signed W-9 PDF (utils/w9Pdf.js) and posts both to /api/payment,
// which marks onboarding complete. Every error sits under its own field and the page
// scrolls to the first one. The pay rates live in the Field Guide. The chosen
// person-to-person handle doubles as the public tip page's, and the page says so;
// the other handles are managed in the portal, not here.

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import FileUpload from '../components/FileUpload';
import W9Form from '../components/W9Form';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { EMPTY_W9, W9_FORM_REVISION, validateW9, buildW9File, preloadW9Pdf } from '../utils/w9Pdf';

// New (Tip & Payroll Preferences) — values must match the backend enum.
const PAYMENT_METHODS = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'cashapp', label: 'Cash App' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'direct_deposit', label: 'Direct deposit' },
  { value: 'other', label: 'Other' },
];

// Map any legacy display-label values (saved by previous form revisions) to
// the new lowercase enum so the form rehydrates correctly on re-entry.
function migrateLegacyMethod(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  // Already in new enum
  if (PAYMENT_METHODS.some(m => m.value === v)) return v;
  switch (v.toLowerCase()) {
    case 'venmo': return 'venmo';
    case 'cash app':
    case 'cashapp': return 'cashapp';
    case 'paypal': return 'paypal';
    case 'check': return 'check';
    case 'direct deposit / ach':
    case 'direct deposit':
    case 'ach': return 'direct_deposit';
    case 'zelle': return 'zelle'; // rejoined 2026-07-14 with the payroll redesign
    default: return '';
  }
}

// Cleanup helpers — strip @, $, and full URL prefixes on input change so the
// stored handle is just the username (server-side wants bare handles).
function stripVenmo(s) {
  return String(s || '')
    .replace(/^@/, '')
    .replace(/^https?:\/\/(?:www\.)?venmo\.com\/u?\/?/, '')
    .trim();
}
function stripCashapp(s) {
  return String(s || '')
    .replace(/^\$/, '')
    .replace(/^https?:\/\/(?:www\.)?cash\.app\/\$?/, '')
    .trim();
}

// A W-9 field's error key: the SSN's three boxes share one, and the signature pad
// reports its stroke data under signatureData.
function w9ErrorKey(name) {
  if (name === 'ssn1' || name === 'ssn2' || name === 'ssn3') return 'ssn';
  if (name === 'signatureData' || name === 'signatureMethod') return 'signature';
  return name;
}

// On a failed submit, bring the first offending field into view (the same pattern
// as Agreement.js and ContractorProfile.js). setTimeout lets React commit the error
// marks first, and runs after FormBanner's own scroll to the banner.
function scrollToFirstError() {
  setTimeout(() => {
    const bad = document.querySelector('[aria-invalid="true"], .input-error, .field-error');
    if (bad) {
      bad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof bad.focus === 'function') bad.focus({ preventScroll: true });
    }
  }, 0);
}

// The routing-number checksum the staff portal's route applies
// (server/routes/staffPortal/paymentMethods.js, isValidRoutingNumber). POST
// /api/payment checks nothing, so this page does.
function isRoutingNumber(r) {
  if (!/^\d{9}$/.test(r)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(r[i]) * w[i];
  return sum % 10 === 0;
}

// The handle field each person-to-person payout method uses, and what to say when
// it is empty.
const HANDLE_FIELDS = {
  venmo: { field: 'venmo_handle', missing: 'Enter your Venmo username.' },
  cashapp: { field: 'cashapp_handle', missing: 'Enter your Cash App cashtag.' },
  paypal: { field: 'paypal_url', missing: 'Enter your paypal.me link.' },
  zelle: { field: 'zelle_handle', missing: 'Enter the email or mobile number your Zelle account uses.' },
};
const HANDLE_KEYS = ['venmo_handle', 'cashapp_handle', 'paypal_url', 'zelle_handle'];

// A payout handle is the same value the public tip page shows guests
// (GET /api/public/tip/:token returns all four), so the page says so.
const TIP_PAGE_NOTE = 'This also shows on your public tip page, so guests can tip you there. You can change it later in the staff portal: Tip Card, then Manage methods.';

// The payout half of Submit's check, one message per field so each sits under its
// own input.
function payoutErrors(form) {
  const errors = {};
  const method = form.preferred_payment_method;
  if (!method) {
    errors.preferred_payment_method = 'Pick how you want to be paid.';
    return errors;
  }
  const handle = HANDLE_FIELDS[method];
  if (handle && !String(form[handle.field] || '').trim()) errors[handle.field] = handle.missing;
  if (method === 'direct_deposit') {
    const routing = String(form.routing_number || '').trim();
    const account = String(form.account_number || '').trim();
    if (!routing) errors.routing_number = 'Enter your 9-digit routing number.';
    else if (!isRoutingNumber(routing)) errors.routing_number = "That isn't a valid routing number. Check the 9 digits at the bottom left of a check.";
    if (!account) errors.account_number = 'Enter your account number.';
    else if (!/^\d{4,17}$/.test(account)) errors.account_number = 'An account number is 4 to 17 digits, numbers only.';
  }
  return errors;
}

// A jsPDF chunk that a deploy removed: a retry cannot load it, a reload can.
function isStaleChunk(err) {
  return !!err && (err.name === 'ChunkLoadError' || /Loading chunk|dynamically imported module/i.test(err.message || ''));
}

export default function PaydayProtocols() {
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loadError, setLoadError] = useState('');
  const [w9Mode, setW9Mode] = useState('fill'); // 'fill' | 'upload'
  const [w9, setW9] = useState(EMPTY_W9);       // the online W-9, sent as a PDF on Submit
  const [w9Errors, setW9Errors] = useState({});
  const [w9File, setW9File] = useState(null);   // upload mode only
  const [existingW9, setExistingW9] = useState('');
  const [bankOnFile, setBankOnFile] = useState(null); // { last4 } when bank numbers are saved

  const [form, setForm] = useState({
    // The four handle columns. Only the chosen method's handle is shown and sent;
    // the others go blank, and the server keeps a saved handle when a blank arrives.
    venmo_handle: '',
    cashapp_handle: '',
    paypal_url: '',
    zelle_handle: '',
    preferred_payment_method: '',
    routing_number: '',
    account_number: '',
  });

  // Fetch the PDF library while the page is open, so a deploy during a long
  // W-9 cannot leave Submit asking for a chunk that no longer exists.
  useEffect(() => { preloadW9Pdf(); }, []);

  useEffect(() => {
    api.get('/payment').then(payRes => {
      const pay = payRes.data || {};
      const rawMethod = String(pay.preferred_payment_method || '').trim();
      const method = migrateLegacyMethod(rawMethod);
      const username = pay.payment_username || '';

      setForm(f => ({
        ...f,
        // Prefer the explicit columns; fall back to the legacy single-field
        // payment_username when the matching method was selected before.
        // Pass through strip helpers so legacy URL-shaped values render as bare handles.
        venmo_handle: stripVenmo(pay.venmo_handle || (method === 'venmo' ? username : '')),
        cashapp_handle: stripCashapp(pay.cashapp_handle || (method === 'cashapp' ? username : '')),
        paypal_url: pay.paypal_url || (method === 'paypal' ? username : ''),
        zelle_handle: pay.zelle_handle || (method === 'zelle' ? username : ''),
        preferred_payment_method: method,
      }));

      // GET /payment returns the bank numbers masked ('****' plus the last four).
      // They never go back into the inputs: posted back, the mask would be
      // encrypted over the real numbers. A returning staffer types them again.
      if (pay.routing_number || pay.account_number) {
        const last4 = (String(pay.account_number || '').match(/(\d{4})$/) || [])[1] || '';
        setBankOnFile({ last4 });
      }

      const existing = pay.w9_filename || '';
      setExistingW9(existing);
      if (existing) setW9Mode('upload');
    }).catch(() => {
      setLoadError("We couldn't load your saved payment info. You can still complete the form below.");
      toast.error("We couldn't load your saved payment info.");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function clearFieldError(name) {
    setFieldErrors(fe => {
      if (!fe[name]) return fe;
      const next = { ...fe };
      delete next[name];
      return next;
    });
  }

  // The error class and aria-invalid that scroll-to-first-error looks for.
  function inputProps(name) {
    return fieldErrors[name]
      ? { className: 'form-input input-error', 'aria-invalid': 'true' }
      : { className: 'form-input' };
  }

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    clearFieldError(e.target.name);
  }

  // Wrapped onChange handlers that strip prefixes so the stored value is just
  // the bare handle.
  function handleVenmoHandle(e) {
    setForm(f => ({ ...f, venmo_handle: stripVenmo(e.target.value) }));
    clearFieldError('venmo_handle');
  }
  function handleCashappHandle(e) {
    setForm(f => ({ ...f, cashapp_handle: stripCashapp(e.target.value) }));
    clearFieldError('cashapp_handle');
  }

  function handleW9Field(name, value) {
    setW9(prev => ({ ...prev, [name]: value }));
    const key = w9ErrorKey(name);
    setW9Errors(prev => {
      // Switching between SSN and EIN clears both, since only one is asked for.
      const drop = name === 'use_ein' ? ['ssn', 'ein'] : [key];
      if (!drop.some(k => prev[k])) return prev;
      const next = { ...prev };
      drop.forEach(k => { delete next[k]; });
      return next;
    });
  }

  // Each W-9 mode has its own errors; a switch drops the other mode's.
  function switchW9Mode(mode) {
    setW9Mode(mode);
    setW9Errors({});
    setError('');
    clearFieldError('w9');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setW9Errors({});

    const method = form.preferred_payment_method;

    // Check the payout method and the W-9 together, so one press shows every
    // problem on the page instead of one at a time.
    const payoutProblems = payoutErrors(form);
    let w9Problems = {};
    let uploadMissing = false;
    if (w9Mode === 'fill') {
      w9Problems = validateW9(w9);
    } else if (!w9File && !existingW9) {
      uploadMissing = true;
    }

    if (Object.keys(payoutProblems).length > 0 || Object.keys(w9Problems).length > 0 || uploadMissing) {
      setW9Errors(w9Problems);
      setFieldErrors(uploadMissing ? { ...payoutProblems, w9: 'Please upload your signed W-9.' } : payoutProblems);
      setError('Some answers above need a fix. Each one is marked where it is.');
      scrollToFirstError();
      return;
    }

    setLoading(true);
    try {
      let w9Upload = null;
      if (w9Mode === 'fill') {
        try {
          w9Upload = await buildW9File(w9);
        } catch (pdfErr) {
          console.error('W9 PDF generation error:', pdfErr);
          setError(isStaleChunk(pdfErr)
            ? 'This page was just updated. Reload it and fill in the W-9 again, or switch to Upload Existing W-9.'
            : "We couldn't build your W-9. Please try again, or switch to Upload Existing W-9.");
          return;
        }
      } else {
        w9Upload = w9File;
      }

      const data = new FormData();

      // Only the chosen method's handle is sent. The others are hidden here, so a
      // value typed and then abandoned must not be checked or published; a blank
      // keeps whatever the server already has (COALESCE in POST /api/payment).
      // No preferred_name: step 4 owns the name, and the server ignores it here.
      const chosen = HANDLE_FIELDS[method] ? HANDLE_FIELDS[method].field : null;
      HANDLE_KEYS.forEach(key => {
        data.append(key, key === chosen ? (form[key] || '') : '');
      });
      data.append('preferred_payment_method', method);

      // Legacy column kept for the admin UI and payouts: the chosen method's handle.
      data.append('payment_username', chosen ? (form[chosen] || '') : '');

      if (method === 'direct_deposit') {
        data.append('routing_number', form.routing_number.trim());
        data.append('account_number', form.account_number.trim());
      }

      // Upload mode with a W-9 already on file sends none; the server reuses it.
      if (w9Upload) {
        data.append('w9', w9Upload);
        // The certification event the server records beside the file (audit
        // ESIG-07): the form revision this page drew and how it was signed; a
        // scanned upload says so. Never the TIN, which lives only in the PDF.
        data.append('w9_signature_method', w9Mode === 'fill' ? (w9.signatureMethod || '') : 'upload');
        data.append('w9_form_revision', w9Mode === 'fill' ? W9_FORM_REVISION : '');
      }

      await api.post('/payment', data);
      // Payment saved. Refresh the user so RequirePortal sees the new 'approved'
      // status, but don't fail the success flow if /auth/me errors — Completion.js
      // runs its own refresh on mount as a safety net.
      try { await refreshUser(); } catch { /* ignored; Completion will retry */ }
      toast.success('Payment info saved.');
      navigate('/complete');
    } catch (err) {
      if (err.fieldErrors) {
        // The server's message says "below"; the marks sit above the banner.
        setError('Some answers above need a fix. Each one is marked where it is.');
        setFieldErrors(err.fieldErrors);
        scrollToFirstError();
      } else {
        setError(err.message || 'Failed to save payment info.');
      }
    } finally {
      setLoading(false);
    }
  }

  const method = form.preferred_payment_method;

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 5 of 6</div>
        <h1>Payday Protocols</h1>
        <p className="text-muted italic">
          The last step. Tell us how to pay you and fill out your W-9, then press Submit Onboarding.
        </p>
      </div>

      {loadError && <div className="alert alert-info">{loadError}</div>}

      <form onSubmit={submit} noValidate>
        {/* ── How we pay you (REQUIRED) ── */}
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>How we pay you</h3>
          <p className="text-small text-muted" style={{ marginBottom: '1.25rem' }}>
            Pick one way to receive your wages and pooled tips. Your pay rates are in the
            Field Guide.
          </p>

          <div className={`form-group${fieldErrors.preferred_payment_method ? ' field-error' : ''}`} role="radiogroup" aria-labelledby="pp-payroll-legend">
            <div id="pp-payroll-legend" className="form-label">Pay me out via *</div>
            <div className="radio-group">
              {PAYMENT_METHODS.map(opt => (
                <label
                  key={opt.value}
                  className={`radio-option${method === opt.value ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="preferred_payment_method"
                    value={opt.value}
                    checked={method === opt.value}
                    onChange={handle}
                  />
                  <span className="radio-label">{opt.label}</span>
                </label>
              ))}
            </div>
            <FieldError error={fieldErrors.preferred_payment_method} />
          </div>

          {method === 'venmo' && (
            <div className="form-group">
              <label htmlFor="pp-venmo_handle" className="form-label">Venmo handle *</label>
              <input
                id="pp-venmo_handle" name="venmo_handle" type="text" {...inputProps('venmo_handle')}
                value={form.venmo_handle} onChange={handleVenmoHandle}
                placeholder="yourname"
              />
              <FieldError error={fieldErrors.venmo_handle} />
              <p className="form-helper">Just the username, we'll strip the @ or venmo.com/u/ for you. {TIP_PAGE_NOTE}</p>
            </div>
          )}

          {method === 'cashapp' && (
            <div className="form-group">
              <label htmlFor="pp-cashapp_handle" className="form-label">Cash App handle *</label>
              <input
                id="pp-cashapp_handle" name="cashapp_handle" type="text" {...inputProps('cashapp_handle')}
                value={form.cashapp_handle} onChange={handleCashappHandle}
                placeholder="yourname"
              />
              <FieldError error={fieldErrors.cashapp_handle} />
              <p className="form-helper">Just the cashtag, we'll strip the $ or cash.app/$ for you. {TIP_PAGE_NOTE}</p>
            </div>
          )}

          {method === 'paypal' && (
            <div className="form-group">
              <label htmlFor="pp-paypal_url" className="form-label">PayPal URL *</label>
              <input
                id="pp-paypal_url" name="paypal_url" type="text" {...inputProps('paypal_url')}
                value={form.paypal_url} onChange={handle}
                placeholder="paypal.me/yourname"
              />
              <FieldError error={fieldErrors.paypal_url} />
              <p className="form-helper">Your paypal.me link, either paypal.me/yourname or the full URL. {TIP_PAGE_NOTE}</p>
            </div>
          )}

          {method === 'zelle' && (
            <div className="form-group">
              <label htmlFor="pp-zelle_handle" className="form-label">Zelle email or phone *</label>
              <input
                id="pp-zelle_handle" name="zelle_handle" type="text" {...inputProps('zelle_handle')}
                value={form.zelle_handle} onChange={handle}
                placeholder="Your Zelle email or mobile number"
              />
              <FieldError error={fieldErrors.zelle_handle} />
              <p className="form-helper">The email or US mobile number your Zelle account is enrolled with. {TIP_PAGE_NOTE}</p>
            </div>
          )}

          {method === 'direct_deposit' && (
            <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--warm-brown)', marginBottom: '0.35rem' }}>
                Bank Account Details
              </div>
              <p className="form-helper" style={{ marginTop: 0, marginBottom: '0.85rem' }}>
                Encrypted, and never shared outside Dr. Bartender.
                {bankOnFile && (
                  <>
                    {' '}We have a bank account on file{bankOnFile.last4 ? ` ending in ${bankOnFile.last4}` : ''}.
                    To keep direct deposit, enter your routing and account numbers again; we never show them back in full.
                  </>
                )}
              </p>
              <div className="form-group">
                <label htmlFor="pp-routing_number" className="form-label">Routing Number *</label>
                <input
                  id="pp-routing_number" name="routing_number" {...inputProps('routing_number')}
                  value={form.routing_number} onChange={handle}
                  placeholder="9 digits" maxLength={9} inputMode="numeric" autoComplete="off"
                  style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                />
                <FieldError error={fieldErrors.routing_number} />
                <p className="form-helper">The 9-digit number on the bottom-left of your check</p>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="pp-account_number" className="form-label">Account Number *</label>
                <input
                  id="pp-account_number" name="account_number" {...inputProps('account_number')}
                  value={form.account_number} onChange={handle}
                  placeholder="Your account number" maxLength={17} inputMode="numeric" autoComplete="off"
                  style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                />
                <FieldError error={fieldErrors.account_number} />
                <p className="form-helper">Your checking account number, found on a check or in your banking app</p>
              </div>
            </div>
          )}

          {method === 'check' && (
            <div className="alert alert-info" style={{ marginBottom: 0 }}>
              Checks are mailed to the address on your Contractor Profile. Make sure your mailing address there is current.
            </div>
          )}

          {method === 'other' && (
            <div className="alert alert-info" style={{ marginBottom: 0 }}>
              No problem, we'll coordinate your payout method with you directly before your first payday.
            </div>
          )}
        </div>

        {/* ── W-9 (REQUIRED) ── */}
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Your W-9 *</h3>
          <p className="text-small text-muted" style={{ marginBottom: '1rem' }}>
            Fill it out here, or upload one you already have.
          </p>
          <FieldError error={fieldErrors.w9} />

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-sm ${w9Mode === 'fill' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={w9Mode === 'fill'}
              onClick={() => switchW9Mode('fill')}
            >
              Fill Out Online
            </button>
            <button
              type="button"
              className={`btn btn-sm ${w9Mode === 'upload' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={w9Mode === 'upload'}
              onClick={() => switchW9Mode('upload')}
            >
              Upload Existing W-9
            </button>
          </div>

          {w9Mode === 'fill' ? (
            <W9Form value={w9} onFieldChange={handleW9Field} errors={w9Errors} />
          ) : (
            <FileUpload
              label="Upload Your Signed W-9"
              name="w9"
              helper="Photo or PDF accepted. Need a blank W-9? Download from IRS.gov."
              onChange={(name, file) => { setW9File(file); clearFieldError('w9'); }}
              currentFile={w9File || existingW9}
            />
          )}
        </div>

        <FormBanner error={error} fieldErrors={fieldErrors} />

        <div className="flex gap-2" style={{ justifyContent: 'space-between', marginTop: '1.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/contractor-profile')}>
            ← Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Submitting...' : 'Submit Onboarding →'}
          </button>
        </div>
      </form>
    </div>
  );
}
