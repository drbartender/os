import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import SignaturePad from '../components/SignaturePad';
import FormBanner from '../components/FormBanner';
import FieldError from '../components/FieldError';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';
import useFormValidation from '../hooks/useFormValidation';

export default function Agreement() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { setProgress } = useOutletContext();

  const [legalText, setLegalText] = useState(null);
  const [legalTextError, setLegalTextError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loadError, setLoadError] = useState('');
  const { validate, fieldClass, inputClass, clearField } = useFormValidation();

  const [form, setForm] = useState({
    full_name: '',
    email: user?.email || '',
    phone: '',
    sms_consent: false,
    signature_data: '',
    signature_method: null,
  });
  const [acks, setAcks] = useState({}); // { ack_ic_status: bool, ... } keys match server

  // Load legal text + existing agreement row in parallel
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get('/agreement/legal-text'),
      api.get('/agreement'),
    ]).then(([textRes, rowRes]) => {
      if (cancelled) return;
      setLegalText(textRes.data);
      // Initialize acks state with every key from server
      const initialAcks = {};
      (textRes.data.acknowledgments || []).forEach(a => { initialAcks[a.key] = false; });
      setAcks(initialAcks);

      const row = rowRes.data;
      if (row && row.full_name) {
        setForm(prev => ({
          ...prev,
          full_name: row.full_name || '',
          email: row.email || user?.email || '',
          phone: row.phone || '',
          sms_consent: !!row.sms_consent,
        }));
      }
    }).catch((e) => {
      if (cancelled) return;
      setLegalTextError(e.message || "We couldn't load the agreement. Please refresh.");
      toast.error("We couldn't load the agreement.");
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleField(e) {
    const { name, value, type, checked } = e.target;
    clearField(name);
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  function handleAck(key) {
    clearField(key);
    setAcks(a => ({ ...a, [key]: !a[key] }));
  }

  const ackList = legalText?.acknowledgments || [];

  const rules = useMemo(() => {
    const base = [
      { field: 'full_name', label: 'Full Name' },
      { field: 'email', label: 'Email' },
      { field: 'signature_data', label: 'Digital Signature', test: (val) => !!val },
    ];
    return base;
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    // Validate core fields
    const result = validate(rules, form);
    if (!result.valid) { setError(result.message); return; }

    // Validate every ack is checked
    const uncheckedAcks = ackList.filter(a => !acks[a.key]);
    if (uncheckedAcks.length > 0) {
      const errs = {};
      uncheckedAcks.forEach(a => { errs[a.key] = 'This acknowledgment is required'; });
      setFieldErrors(errs);
      setError('Please confirm each acknowledgment below before signing.');
      return;
    }

    setLoading(true);
    try {
      const payload = { ...form, ...acks };
      await api.post('/agreement', payload);
      const r = await api.put('/progress/step', { step: 'agreement_completed' });
      setProgress(r.data);
      toast.success('Agreement signed.');
      navigate('/contractor-profile');
    } catch (err) {
      setError(err.message || 'Failed to save agreement.');
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
    } finally {
      setLoading(false);
    }
  }

  if (legalTextError) {
    return (
      <div className="page-container">
        <div className="alert alert-error">{legalTextError}</div>
      </div>
    );
  }

  if (!legalText) {
    return (
      <div className="page-container">
        <div className="loading"><div className="spinner" />Loading agreement…</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 3 of 6</div>
        <h1>Independent Contractor Agreement</h1>
        <p className="text-muted italic">
          This is the contract between you and Dr. Bartender. Please read it carefully — you can come back to it later from your staff portal.
        </p>
      </div>

      {loadError && <div className="alert alert-info">{loadError}</div>}

      {/* ── At a Glance ─────────────────────────────────────── */}
      <div
        className="card"
        style={{
          background: '#F0F8F1',
          border: '1px solid #BEDABF',
          marginBottom: '1.5rem',
        }}
      >
        <h3 style={{ marginBottom: '0.5rem' }}>At a Glance</h3>
        <p className="text-small text-muted" style={{ marginBottom: '0.75rem' }}>
          This box is a plain-English summary. The full contract is below — that's what you're signing.
        </p>
        <ul style={{ paddingLeft: '1.25rem', margin: 0 }}>
          {legalText.at_a_glance.map((bullet, i) => (
            <li key={i} style={{ marginBottom: '0.4rem', fontSize: '0.9rem', color: 'var(--deep-brown)' }}>
              {bullet}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Full formal agreement ───────────────────────────── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.25rem' }}>Full Agreement</h3>
        <p className="text-small text-muted" style={{ marginBottom: '1rem' }}>
          Version {legalText.version} · Effective {legalText.effective_date}
        </p>
        {legalText.clauses.map((clause) => (
          <section key={clause.number} style={{ marginBottom: '1.25rem' }}>
            <h4 style={{ marginBottom: '0.3rem' }}>
              {clause.number}. {clause.title}
            </h4>
            <p className="italic text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              {clause.plain}
            </p>
            <p style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
              {clause.formal}
            </p>
          </section>
        ))}
      </div>

      {/* ── Personal details + acknowledgments + signature ── */}
      <div className="card">
        <h3 style={{ marginBottom: '0.25rem' }}>Your Details</h3>
        <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
          We'll email you a copy of the signed agreement at this address.
        </p>

        <form onSubmit={submit}>
          <div className="two-col">
            <div className={"form-group" + fieldClass('full_name')}>
              <label htmlFor="agreement-full_name" className="form-label">Full Name</label>
              <input
                id="agreement-full_name" name="full_name"
                className={"form-input" + inputClass('full_name')}
                value={form.full_name} onChange={handleField}
                placeholder="Your legal name"
                aria-invalid={!!fieldErrors?.full_name}
              />
              <FieldError error={fieldErrors?.full_name} />
            </div>
            <div className={"form-group" + fieldClass('email')}>
              <label htmlFor="agreement-email" className="form-label">Email</label>
              <input
                id="agreement-email" name="email" type="email"
                className={"form-input" + inputClass('email')}
                value={form.email} onChange={handleField}
                aria-invalid={!!fieldErrors?.email}
              />
              <FieldError error={fieldErrors?.email} />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="agreement-phone" className="form-label">Phone</label>
            <input
              id="agreement-phone" name="phone" type="tel"
              className="form-input"
              value={formatPhoneInput(form.phone)}
              onChange={e => { clearField('phone'); setForm(f => ({ ...f, phone: stripPhone(e.target.value) })); }}
              placeholder="(555) 000-0000"
            />
            <p className="form-helper">
              By providing your phone number you grant us permission to contact you via SMS or voice.
            </p>
          </div>

          <div className="form-group">
            <label className="checkbox-group">
              <input type="checkbox" name="sms_consent" checked={form.sms_consent} onChange={handleField} />
              <span className="checkbox-label">
                I consent to receive SMS messages from Dr. Bartender regarding scheduling.
              </span>
            </label>
          </div>

          <div className="divider" />

          <h4 style={{ marginBottom: '0.75rem' }}>Acknowledgments</h4>
          {ackList.map((a) => (
            <div
              key={a.key}
              className={"form-group" + fieldClass(a.key)}
              style={{ marginBottom: '0.75rem' }}
            >
              <label className="checkbox-group">
                <input
                  type="checkbox"
                  name={a.key}
                  className={inputClass(a.key).trim()}
                  checked={!!acks[a.key]}
                  onChange={() => handleAck(a.key)}
                />
                <span className="checkbox-label">{a.label}</span>
              </label>
              <FieldError error={fieldErrors?.[a.key]} />
            </div>
          ))}

          <div className="divider" />

          <div className={"form-group" + fieldClass('signature_data')}>
            <label className="form-label">Digital Signature</label>
            <SignaturePad
              value={form.signature_data}
              onChange={(data, method) => {
                clearField('signature_data');
                setForm(f => ({ ...f, signature_data: data, signature_method: method }));
              }}
            />
            <FieldError error={fieldErrors?.signature} />
          </div>

          <FormBanner error={error} fieldErrors={fieldErrors} />

          <button type="submit" className="btn btn-primary btn-full mt-2" disabled={loading}>
            {loading ? 'Submitting…' : 'Sign & Continue →'}
          </button>
        </form>
      </div>
    </div>
  );
}
