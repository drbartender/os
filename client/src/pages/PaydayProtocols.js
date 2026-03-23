import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import FileUpload from '../components/FileUpload';
import W9Form from '../components/W9Form';
import api from '../utils/api';
import { COMPANY_PHONE } from '../utils/constants';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';

const PAYMENT_METHODS = ['Venmo', 'Zelle', 'Cash App', 'PayPal', 'Direct Deposit / ACH', 'Check'];

export default function PaydayProtocols() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [w9File, setW9File] = useState(null);
  const [existingW9, setExistingW9] = useState('');
  const [w9Mode, setW9Mode] = useState('fill'); // 'fill' | 'upload'
  const [w9Done, setW9Done] = useState(false);  // true after W9Form generates PDF

  const [form, setForm] = useState({
    preferred_payment_method: '',
    // Venmo
    venmo_handle: '',
    // Zelle
    zelle_email: '',
    zelle_phone: '',
    // Cash App
    cashtag: '',
    // PayPal
    paypal_email: '',
    // Direct Deposit
    routing_number: '',
    account_number: '',
  });

  useEffect(() => {
    api.get('/payment').then(r => {
      if (r.data.preferred_payment_method) {
        const method = r.data.preferred_payment_method;
        const username = r.data.payment_username || '';
        setForm({
          preferred_payment_method: method,
          venmo_handle:    method === 'Venmo'    ? username : '',
          zelle_email:     method === 'Zelle'    && username.includes('@') ? username : '',
          zelle_phone:     method === 'Zelle'    && !username.includes('@') ? username : '',
          cashtag:         method === 'Cash App' ? username : '',
          paypal_email:    method === 'PayPal'   ? username : '',
          routing_number:  r.data.routing_number  || '',
          account_number:  r.data.account_number  || '',
        });
        const existing = r.data.w9_filename || '';
        setExistingW9(existing);
        if (existing) {
          setW9Mode('upload');
          setW9Done(true);
        }
      }
    }).catch(() => setLoadError("We couldn't load your saved payment info. You can still complete the form below."));
  }, []);

  function handle(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');

    const method = form.preferred_payment_method;
    if (!method) return setError('Please select a payment method.');

    // Method-specific validation
    if (method === 'Venmo' && !form.venmo_handle.trim())
      return setError('Please enter your Venmo @handle.');
    if (method === 'Cash App' && !form.cashtag.trim())
      return setError('Please enter your Cash App $cashtag.');
    if (method === 'Zelle' && !form.zelle_email.trim() && !form.zelle_phone.trim())
      return setError('Please enter the email address or phone number linked to your Zelle account.');
    if (method === 'PayPal' && !form.paypal_email.trim())
      return setError('Please enter your PayPal email or @username.');
    if (method === 'Direct Deposit / ACH') {
      if (!form.routing_number.trim()) return setError('Routing number is required for Direct Deposit.');
      if (!form.account_number.trim()) return setError('Account number is required for Direct Deposit.');
    }

    if (!w9File && !existingW9) return setError('Please complete or upload your W-9.');

    setLoading(true);
    try {
      const data = new FormData();
      data.append('preferred_payment_method', method);

      // Pack method-specific identifier into payment_username for backend compat
      let payment_username = '';
      if (method === 'Venmo')   payment_username = form.venmo_handle;
      if (method === 'Cash App') payment_username = form.cashtag;
      if (method === 'Zelle')    payment_username = form.zelle_email || form.zelle_phone;
      if (method === 'PayPal')   payment_username = form.paypal_email;
      data.append('payment_username', payment_username);

      if (method === 'Direct Deposit / ACH') {
        data.append('routing_number', form.routing_number);
        data.append('account_number', form.account_number);
      }

      if (w9File) data.append('w9', w9File);

      await api.post('/payment', data);
      navigate('/complete');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save payment info.');
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
        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <form onSubmit={submit}>
          {/* ── Payment Method ── */}
          <div className="form-group">
            <label className="form-label">Preferred Method of Payment *</label>
            <select name="preferred_payment_method" className="form-select" value={method} onChange={handle} required>
              <option value="">Select method</option>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {/* ── Method-specific fields ── */}
          {method === 'Venmo' && (
            <div className="form-group">
              <label className="form-label">Venmo @Handle *</label>
              <input
                name="venmo_handle" className="form-input"
                value={form.venmo_handle} onChange={handle}
                placeholder="@yourname"
              />
              <p className="form-helper">Enter your Venmo username starting with @</p>
            </div>
          )}

          {method === 'Cash App' && (
            <div className="form-group">
              <label className="form-label">Cash App $Cashtag *</label>
              <input
                name="cashtag" className="form-input"
                value={form.cashtag} onChange={handle}
                placeholder="$yourname"
              />
              <p className="form-helper">Enter your Cash App $cashtag (the $ is part of it)</p>
            </div>
          )}

          {method === 'Zelle' && (
            <div>
              <div className="form-group">
                <label className="form-label">Zelle Email Address</label>
                <input
                  name="zelle_email" type="email" className="form-input"
                  value={form.zelle_email} onChange={handle}
                  placeholder="you@email.com"
                />
              </div>
              <div style={{ textAlign: 'center', margin: '-0.5rem 0 0.75rem', color: 'var(--text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>
                — or —
              </div>
              <div className="form-group">
                <label className="form-label">Zelle Phone Number</label>
                <input
                  name="zelle_phone" type="tel" className="form-input"
                  value={formatPhoneInput(form.zelle_phone)} onChange={e => setForm(f => ({ ...f, zelle_phone: stripPhone(e.target.value) }))}
                  placeholder="(555) 000-0000"
                />
              </div>
              <p className="form-helper" style={{ marginTop: '-0.75rem', marginBottom: '1rem' }}>
                Provide whichever is linked to your Zelle account — at least one is required.
              </p>
            </div>
          )}

          {method === 'PayPal' && (
            <div className="form-group">
              <label className="form-label">PayPal Email or @Username *</label>
              <input
                name="paypal_email" className="form-input"
                value={form.paypal_email} onChange={handle}
                placeholder="you@email.com or @yourname"
              />
              <p className="form-helper">Enter the email address or @username on your PayPal account</p>
            </div>
          )}

          {method === 'Direct Deposit / ACH' && (
            <div style={{ background: 'var(--parchment)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem', marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--warm-brown)', marginBottom: '0.85rem' }}>
                🏦 Bank Account Details
              </div>
              <div className="form-group">
                <label className="form-label">Routing Number *</label>
                <input
                  name="routing_number" className="form-input"
                  value={form.routing_number} onChange={handle}
                  placeholder="9 digits" maxLength={9} inputMode="numeric"
                  style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                />
                <p className="form-helper">The 9-digit number on the bottom-left of your check</p>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Account Number *</label>
                <input
                  name="account_number" className="form-input"
                  value={form.account_number} onChange={handle}
                  placeholder="Your account number"
                  style={{ fontFamily: 'monospace', letterSpacing: '0.15em' }}
                />
                <p className="form-helper">Your checking account number — found on a check or in your banking app</p>
              </div>
            </div>
          )}

          {method === 'Check' && (
            <div className="alert alert-info" style={{ marginBottom: '1.25rem' }}>
              Checks will be mailed to the address on file. Make sure your mailing address in your Contractor Profile is current.
            </div>
          )}

          {/* ── W-9 ── */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.75rem' }}>
              W-9 Form *
            </div>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'fill' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { setW9Mode('fill'); setW9Done(false); }}
              >
                📋 Fill Out Online
              </button>
              <button
                type="button"
                className={`btn btn-sm ${w9Mode === 'upload' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setW9Mode('upload')}
              >
                📎 Upload Existing W-9
              </button>
            </div>

            {w9Mode === 'fill' ? (
              w9Done ? (
                <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>✓ W-9 filled out and signed — PDF ready to submit.</span>
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
