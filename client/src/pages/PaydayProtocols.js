import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import FileUpload from '../components/FileUpload';
import W9Form from '../components/W9Form';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { COMPANY_PHONE } from '../utils/constants';
import useFormValidation from '../hooks/useFormValidation';

// New (Tip & Payroll Preferences) — values must match the backend enum.
const PAYMENT_METHODS = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'cashapp', label: 'Cash App' },
  { value: 'paypal', label: 'PayPal' },
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
    case 'zelle': return ''; // No longer offered — force re-pick
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

export default function PaydayProtocols() {
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loadError, setLoadError] = useState('');
  const [legacyNotice, setLegacyNotice] = useState('');
  const [w9File, setW9File] = useState(null);
  const [existingW9, setExistingW9] = useState('');
  const [w9Mode, setW9Mode] = useState('fill'); // 'fill' | 'upload'
  const [w9Done, setW9Done] = useState(false);  // true after W9Form generates PDF

  const [form, setForm] = useState({
    // Tip & Payroll Preferences (new — Tip QR page Phase 2)
    preferred_name: '',
    venmo_handle: '',
    cashapp_handle: '',
    paypal_url: '',
    preferred_payment_method: '',
    // Direct deposit (existing — kept)
    routing_number: '',
    account_number: '',
  });

  useEffect(() => {
    // Load saved payment profile + the contractor profile so we can pre-fill
    // preferred_name (which lives on contractor_profiles, not payment_profiles).
    Promise.all([
      api.get('/payment').catch(() => ({ data: {} })),
      api.get('/contractor').catch(() => ({ data: {} })),
    ]).then(([payRes, profRes]) => {
      const pay = payRes.data || {};
      const prof = profRes.data || {};
      const rawMethod = String(pay.preferred_payment_method || '').trim();
      const method = migrateLegacyMethod(rawMethod);
      const username = pay.payment_username || '';

      setForm(f => ({
        ...f,
        preferred_name: prof.preferred_name || '',
        // Prefer the explicit columns; fall back to the legacy single-field
        // payment_username when the matching method was selected before.
        // Pass through strip helpers so legacy URL-shaped values render as bare handles.
        venmo_handle: stripVenmo(pay.venmo_handle || (method === 'venmo' ? username : '')),
        cashapp_handle: stripCashapp(pay.cashapp_handle || (method === 'cashapp' ? username : '')),
        paypal_url: pay.paypal_url || (method === 'paypal' ? username : ''),
        preferred_payment_method: method,
        routing_number: pay.routing_number || '',
        account_number: pay.account_number || '',
      }));

      if (rawMethod.toLowerCase() === 'zelle') {
        setLegacyNotice('Zelle is no longer offered. Please pick a new payroll method below.');
      }

      const existing = pay.w9_filename || '';
      setExistingW9(existing);
      if (existing) {
        setW9Mode('upload');
        setW9Done(true);
      }
    }).catch(() => {
      setLoadError("We couldn't load your saved payment info. You can still complete the form below.");
      toast.error("We couldn't load your saved payment info.");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    clearField(e.target.name);
  }

  // Wrapped onChange handlers that strip prefixes so the stored value is just
  // the bare handle.
  function handleVenmoHandle(e) {
    setForm(f => ({ ...f, venmo_handle: stripVenmo(e.target.value) }));
    clearField('venmo_handle');
  }
  function handleCashappHandle(e) {
    setForm(f => ({ ...f, cashapp_handle: stripCashapp(e.target.value) }));
    clearField('cashapp_handle');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    const method = form.preferred_payment_method;

    // Build rules dynamically based on selected payment method.
    const rules = [
      { field: 'preferred_name', label: 'Preferred Name' },
      { field: 'preferred_payment_method', label: 'Pay me out via' },
    ];

    if (method === 'venmo')
      rules.push({ field: 'venmo_handle', label: 'Venmo handle' });
    if (method === 'cashapp')
      rules.push({ field: 'cashapp_handle', label: 'Cash App handle' });
    if (method === 'paypal')
      rules.push({ field: 'paypal_url', label: 'PayPal URL' });
    if (method === 'direct_deposit') {
      rules.push({ field: 'routing_number', label: 'Routing Number' });
      rules.push({ field: 'account_number', label: 'Account Number' });
    }

    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }

    if (!w9File && !existingW9) {
      setFieldErrors({ w9: 'Please complete or upload your W-9.' });
      setError('Please complete or upload your W-9.');
      return;
    }

    setLoading(true);
    try {
      const data = new FormData();

      // New Tip & Payroll Preferences fields (snake_case to match backend).
      data.append('preferred_name', String(form.preferred_name || '').trim());
      data.append('venmo_handle', form.venmo_handle || '');
      data.append('cashapp_handle', form.cashapp_handle || '');
      data.append('paypal_url', form.paypal_url || '');
      data.append('preferred_payment_method', method);

      // Legacy column kept for backward compat with admin UI / payouts —
      // pack the chosen method's handle into payment_username.
      let payment_username = '';
      if (method === 'venmo')   payment_username = form.venmo_handle;
      if (method === 'cashapp') payment_username = form.cashapp_handle;
      if (method === 'paypal')  payment_username = form.paypal_url;
      data.append('payment_username', payment_username);

      if (method === 'direct_deposit') {
        data.append('routing_number', form.routing_number);
        data.append('account_number', form.account_number);
      }

      if (w9File) data.append('w9', w9File);

      await api.post('/payment', data);
      // Payment saved. Refresh the user so RequirePortal sees the new 'approved'
      // status, but don't fail the success flow if /auth/me errors — Completion.js
      // runs its own refresh on mount as a safety net.
      try { await refreshUser(); } catch { /* ignored; Completion will retry */ }
      toast.success('Payment info saved.');
      navigate('/complete');
    } catch (err) {
      setError(err.message || 'Failed to save payment info.');
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
    } finally {
      setLoading(false);
    }
  }

  const method = form.preferred_payment_method;
  // A P2P method (venmo/cashapp/paypal) is BOTH the payroll target and a tip-page
  // handle — it lives in one shared column, so it is collected once in Card A
  // and shown read-only in Card B (no duplicate input bound to the same state).
  const p2pPayroll = method === 'venmo' || method === 'cashapp' || method === 'paypal';

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 5 of 6</div>
        <h1>Payday Protocols</h1>
        <p className="text-muted italic">
          Everything you need to know about when, how, and how much you'll get paid — and your W-9 and payment preferences.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: '1.25rem' }}>Your Pay Rate</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.8rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: '0.35rem' }}>Bartenders</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 700, color: 'var(--deep-brown)' }}>$20<span style={{ fontSize: '1rem' }}>/hr</span></div>
            <p className="text-small text-muted" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Plus tips from jars, digital codes, or pooled gratuity</p>
          </div>
          <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.8rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: '0.35rem' }}>Barbacks / Servers</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 700, color: 'var(--deep-brown)' }}>$35<span style={{ fontSize: '1rem' }}>/hr</span></div>
            <p className="text-small text-muted" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Gratuity included in rate</p>
          </div>
        </div>
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          <strong>Why the difference?</strong> Bartenders earn a lower base rate because they receive tips directly from guests
          (via tip jars, digital codes, or pooled gratuity). Barback and server rates include gratuity so their total
          compensation is comparable.
        </div>
        <p className="text-small text-muted">
          Tips from multi-bartender events will be pooled and split evenly.
          Tip methods vary by event — details will be shared before each gig.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: '1rem' }}>Time Expectations & Punctuality</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          No need to track hours or punch a clock — your pay is based on contracted time, which includes:
        </p>
        <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
          Event time + 1 hour for setup + 30 minutes for breakdown
        </div>
        <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>If you're running late, call someone:</p>
        <ul style={{ paddingLeft: '1.25rem', fontSize: '0.9rem' }}>
          <li style={{ marginBottom: '0.35rem' }}>Dr. Bartender Company Line: <strong>{COMPANY_PHONE}</strong></li>
          <li style={{ marginBottom: '0.35rem' }}>The client contact info will be shared before the event.</li>
        </ul>
        <p className="text-small text-muted italic" style={{ marginTop: '0.75rem' }}>
          Arriving more than 10 minutes late without notice will result in a 20% reduction in your contracted pay.
          Excessive tardiness will result in being removed from staffing. Show up on time, stay in the loop.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: '0.25rem' }}>Final Step: Get Set Up For Payday</h3>
        <p className="text-muted text-small" style={{ marginBottom: '1.5rem' }}>
          Tell us how to pay you — and complete your W-9 to keep it official.
        </p>

        {loadError && <div className="alert alert-info">{loadError}</div>}
        {legacyNotice && <div className="alert alert-info">{legacyNotice}</div>}

        <form onSubmit={submit}>
          {/* ── Card A — How we pay you (REQUIRED) ── */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ marginBottom: '0.35rem' }}>How we pay you</h3>
            <p className="text-small text-muted" style={{ marginBottom: '0.25rem' }}>
              Pick one way to receive your wages and pooled tips. This is the only
              payment detail we require to finish onboarding.
            </p>
            <p className="text-small text-muted italic" style={{ marginBottom: '1.25rem' }}>
              Encrypted and never shared outside Dr. Bartender.
            </p>

            <div className={`form-group${fieldClass('preferred_payment_method')}`} role="radiogroup" aria-labelledby="pp-payroll-legend">
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
            </div>

            {method === 'venmo' && (
              <div className={`form-group${fieldClass('venmo_handle')}`}>
                <label htmlFor="pp-venmo_handle" className="form-label">Venmo handle *</label>
                <input
                  id="pp-venmo_handle" name="venmo_handle" type="text"
                  className={`form-input${inputClass('venmo_handle')}`}
                  value={form.venmo_handle} onChange={handleVenmoHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the username — we'll strip the @ or venmo.com/u/ for you.</p>
              </div>
            )}

            {method === 'cashapp' && (
              <div className={`form-group${fieldClass('cashapp_handle')}`}>
                <label htmlFor="pp-cashapp_handle" className="form-label">Cash App handle *</label>
                <input
                  id="pp-cashapp_handle" name="cashapp_handle" type="text"
                  className={`form-input${inputClass('cashapp_handle')}`}
                  value={form.cashapp_handle} onChange={handleCashappHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the cashtag — we'll strip the $ or cash.app/$ for you.</p>
              </div>
            )}

            {method === 'paypal' && (
              <div className={`form-group${fieldClass('paypal_url')}`}>
                <label htmlFor="pp-paypal_url" className="form-label">PayPal URL *</label>
                <input
                  id="pp-paypal_url" name="paypal_url" type="text"
                  className={`form-input${inputClass('paypal_url')}`}
                  value={form.paypal_url} onChange={handle}
                  placeholder="paypal.me/yourname"
                />
                <p className="form-helper">Either paypal.me/yourname or a full URL.</p>
              </div>
            )}

            {method === 'direct_deposit' && (
              <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--warm-brown)', marginBottom: '0.85rem' }}>
                  Bank Account Details
                </div>
                <div className={`form-group${fieldClass('routing_number')}`}>
                  <label htmlFor="pp-routing_number" className="form-label">Routing Number *</label>
                  <input
                    id="pp-routing_number" name="routing_number" className={`form-input${inputClass('routing_number')}`}
                    value={form.routing_number} onChange={handle}
                    placeholder="9 digits" maxLength={9} inputMode="numeric"
                    style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                  />
                  <p className="form-helper">The 9-digit number on the bottom-left of your check</p>
                </div>
                <div className={`form-group${fieldClass('account_number')}`} style={{ marginBottom: 0 }}>
                  <label htmlFor="pp-account_number" className="form-label">Account Number *</label>
                  <input
                    id="pp-account_number" name="account_number" className={`form-input${inputClass('account_number')}`}
                    value={form.account_number} onChange={handle}
                    placeholder="Your account number"
                    style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                  />
                  <p className="form-helper">Your checking account number — found on a check or in your banking app</p>
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
                No problem — we'll coordinate your payout method with you directly before your first payday.
              </div>
            )}
          </div>

          {/* ── Card B — Your public tip page (handles OPTIONAL) ── */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ marginBottom: '0.35rem' }}>Your public tip page</h3>
            <p className="text-small text-muted" style={{ marginBottom: '1.25rem' }}>
              Your tip page lives at <strong>drbartender.com/tip/your-name</strong> with a
              QR you can print. Your name is required; the tip handles below are
              <strong> optional</strong> — add them now, later from My Tip Page, or never.
              None of this is shared outside DRB.
            </p>

            <div className={`form-group${fieldClass('preferred_name')}`}>
              <label htmlFor="pp-preferred_name" className="form-label">Preferred name *</label>
              <input
                id="pp-preferred_name" name="preferred_name" type="text"
                className={`form-input${inputClass('preferred_name')}`}
                value={form.preferred_name} onChange={handle}
                maxLength={80} required
                placeholder="What customers see on your tip page"
              />
              <p className="form-helper">
                The name customers see on your tip page. Use whatever you go by — your real name, a nickname, a stage name.
              </p>
            </div>

            {p2pPayroll && (
              <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
                Your payroll {method === 'venmo' ? 'Venmo' : method === 'cashapp' ? 'Cash App' : 'PayPal'}{' '}
                handle is already on your tip page — no need to re-enter it here.
              </div>
            )}

            {method !== 'venmo' && (
              <div className={`form-group${fieldClass('venmo_handle')}`}>
                <label htmlFor="pp-venmo_handle-tip" className="form-label">Venmo handle <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-venmo_handle-tip" name="venmo_handle" type="text"
                  className={`form-input${inputClass('venmo_handle')}`}
                  value={form.venmo_handle} onChange={handleVenmoHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the username — we'll strip the @ or venmo.com/u/ for you.</p>
              </div>
            )}

            {method !== 'cashapp' && (
              <div className={`form-group${fieldClass('cashapp_handle')}`}>
                <label htmlFor="pp-cashapp_handle-tip" className="form-label">Cash App handle <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-cashapp_handle-tip" name="cashapp_handle" type="text"
                  className={`form-input${inputClass('cashapp_handle')}`}
                  value={form.cashapp_handle} onChange={handleCashappHandle}
                  placeholder="yourname"
                />
                <p className="form-helper">Just the cashtag — we'll strip the $ or cash.app/$ for you.</p>
              </div>
            )}

            {method !== 'paypal' && (
              <div className={`form-group${fieldClass('paypal_url')}`} style={{ marginBottom: 0 }}>
                <label htmlFor="pp-paypal_url-tip" className="form-label">PayPal URL <span className="text-muted">(optional)</span></label>
                <input
                  id="pp-paypal_url-tip" name="paypal_url" type="text"
                  className={`form-input${inputClass('paypal_url')}`}
                  value={form.paypal_url} onChange={handle}
                  placeholder="paypal.me/yourname"
                />
                <p className="form-helper">Either paypal.me/yourname or a full URL.</p>
              </div>
            )}
          </div>

          {/* ── W-9 (unchanged, still required) ── */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
              W-9 Form *
            </div>
            <FieldError error={fieldErrors?.w9} />

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'fill' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { setW9Mode('fill'); setW9Done(false); }}
              >
                Fill Out Online
              </button>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'upload' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setW9Mode('upload')}
              >
                Upload Existing W-9
              </button>
            </div>

            {w9Mode === 'fill' ? (
              w9Done ? (
                <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>W-9 filled out and signed — PDF ready to submit.</span>
                  <button type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--success)', borderColor: 'var(--success)' }} onClick={() => { setW9Done(false); setW9File(null); }}>
                    Edit W-9
                  </button>
                </div>
              ) : (
                <W9Form
                  onComplete={(file) => {
                    setW9File(file);
                    setW9Done(true);
                  }}
                />
              )
            ) : (
              <FileUpload
                label="Upload Your Signed W-9"
                name="w9"
                helper="Photo or PDF accepted. Need a blank W-9? Download from IRS.gov."
                onChange={(name, file) => setW9File(file)}
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
    </div>
  );
}
