import React, { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import SignaturePad from '../components/SignaturePad';
import api from '../utils/api';
import { formatPhoneInput, stripPhone } from '../utils/formatPhone';

export default function Agreement() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { setProgress } = useOutletContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({
    full_name: '',
    email: user?.email || '',
    phone: '',
    sms_consent: false,
    acknowledged_field_guide: false,
    agreed_non_solicitation: false,
    signature_data: '',
    signature_method: null
  });

  useEffect(() => {
    api.get('/agreement').then(r => {
      if (r.data.full_name) {
        setForm(prev => ({
          ...prev,
          full_name: r.data.full_name || '',
          email: r.data.email || user?.email || '',
          phone: r.data.phone || '',
          sms_consent: r.data.sms_consent || false,
          acknowledged_field_guide: r.data.acknowledged_field_guide || false,
          agreed_non_solicitation: r.data.agreed_non_solicitation || false,
        }));
      }
    }).catch(() => setLoadError("We couldn't load your saved agreement. You can still continue and sign below."));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handle(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.acknowledged_field_guide) return setError('Please confirm you have read the Field Guide.');
    if (!form.agreed_non_solicitation) return setError('Please agree to the non-solicitation terms.');
    if (!form.signature_data) return setError('Please provide your digital signature.');
    if (!form.full_name || !form.email) return setError('Full name and email are required.');

    setLoading(true);
    try {
      await api.post('/agreement', form);
      const r = await api.put('/progress/step', { step: 'agreement_completed' });
      setProgress(r.data);
      navigate('/contractor-profile');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save agreement.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container">
      <div className="text-center mb-3">
        <div className="section-label">Step 3 of 6</div>
        <h1>Contractor Agreement</h1>
        <p className="text-muted italic">You've read the Field Guide. You know the protocols. Now it's time to make it official.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
        {/* Agreement Terms */}
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Agreement Terms</h3>
          <p style={{ marginBottom: '0.75rem', fontSize: '0.9rem' }}>By signing below, I confirm that:</p>
          <ul style={{ paddingLeft: '1.25rem' }}>
            {[
              'I am working with Dr. Bartender as an independent contractor, not an employee.',
              'I am responsible for my own taxes.',
              'I have read and understood the expectations in this Field Guide.',
              'I understand that shifts are offered based on availability and performance.',
              'Dr. Bartender can pause or end work opportunities at any time.',
            ].map(item => (
              <li key={item} style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--deep-brown)' }}>{item}</li>
            ))}
          </ul>

          <div className="divider" />

          <h3 style={{ marginBottom: '1rem' }}>Non-Solicitation</h3>
          <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            While working with Dr. Bartender — and for 12 months after — I agree not to:
          </p>
          <ul style={{ paddingLeft: '1.25rem', marginBottom: '0.75rem' }}>
            {[
              'Solicit or accept direct work from Dr. Bartender clients or venues.',
              'Offer my own bartending services to those clients without written approval.',
              'Recruit or poach other Dr. Bartender contractors.',
            ].map(item => (
              <li key={item} style={{ marginBottom: '0.4rem', fontSize: '0.9rem', color: 'var(--deep-brown)' }}>{item}</li>
            ))}
          </ul>
          <p className="text-small text-muted italic">Violating this may result in loss of future work or legal action.</p>
        </div>

        {/* Sign Form */}
        <div className="card">
          <h3 style={{ marginBottom: '0.25rem' }}>Ready to Sign?</h3>
          <p className="text-muted text-small" style={{ marginBottom: '1.25rem' }}>
            This acknowledgment is required to be scheduled for events.
          </p>

          {loadError && <div className="alert alert-info">{loadError}</div>}
          {error && <div className="alert alert-error" role="alert">{error}</div>}

          <form onSubmit={submit}>
            <div className="two-col">
              <div className="form-group">
                <label className="form-label">Full Name</label>
                <input name="full_name" className="form-input" value={form.full_name} onChange={handle} required placeholder="Your legal name" />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input name="email" type="email" className="form-input" value={form.email} onChange={handle} required />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Phone</label>
              <input name="phone" type="tel" className="form-input" value={formatPhoneInput(form.phone)} onChange={e => setForm(f => ({ ...f, phone: stripPhone(e.target.value) }))} placeholder="(555) 000-0000" />
              <p className="form-helper">By providing your phone number you grant us permission to contact you via SMS or voice.</p>
            </div>

            <div className="form-group">
              <label className="checkbox-group">
                <input type="checkbox" name="sms_consent" checked={form.sms_consent} onChange={handle} />
                <span className="checkbox-label">I consent to receive SMS messages from Dr. Bartender regarding scheduling.</span>
              </label>
            </div>

            <div className="divider" />

            <div style={{ marginBottom: '1rem' }}>
              <label className="checkbox-group">
                <input type="checkbox" name="acknowledged_field_guide" checked={form.acknowledged_field_guide} onChange={handle} />
                <span className="checkbox-label">
                  I've read the Dr. Bartender Field Guide and understand what's expected of me.
                </span>
              </label>

              <label className="checkbox-group" style={{ marginTop: '0.5rem' }}>
                <input type="checkbox" name="agreed_non_solicitation" checked={form.agreed_non_solicitation} onChange={handle} />
                <span className="checkbox-label">
                  I agree not to solicit Dr. Bartender clients, venues, or contractors — during or within 12 months after my work with the company.
                </span>
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">Digital Signature</label>
              <SignaturePad
                value={form.signature_data}
                onChange={(data, method) => setForm(f => ({ ...f, signature_data: data, signature_method: method }))}
              />
            </div>

            <button type="submit" className="btn btn-primary btn-full mt-2" disabled={loading}>
              {loading ? 'Submitting...' : 'Sign & Continue →'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
