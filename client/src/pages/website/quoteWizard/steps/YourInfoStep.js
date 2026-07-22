import React from 'react';
import { Link } from 'react-router-dom';
import FieldError from '../../../../components/FieldError';
import { formatPhoneInput, stripPhone } from '../../../../utils/formatPhone';
import { SMS_CONSENT_LEAD } from '../../../../constants/smsConsent';

// SMS_CONSENT_LEAD is everything up to the closing "See our ... " clause, which
// is rendered below as links. LEAD + TAIL is the literal quoted on /privacy and
// stored in sms_consent_log, so the three stay identical by construction.
// Never retype the sentence here.

export default function YourInfoStep({ form, update, fieldClass, inputClass, fieldErrors }) {
  return (
    <div className="wz-card">
      <h3>Where should we send your proposal?</h3>
      <div className="wz-grid">
        <div className={`form-group${fieldClass('client_name')}`} style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="wz-client_name" className="form-label">Your Name *</label>
          <input id="wz-client_name" className={`form-input${inputClass('client_name')}`} value={form.client_name}
            onChange={e => update('client_name', e.target.value)} placeholder="Jane Smith"
            aria-invalid={!!fieldErrors?.client_name} />
          <FieldError error={fieldErrors?.client_name} />
        </div>
        <div className={`form-group${fieldClass('client_email')}`}>
          <label htmlFor="wz-client_email" className="form-label">Email *</label>
          <input id="wz-client_email" className={`form-input${inputClass('client_email')}`} type="email" value={form.client_email}
            onChange={e => update('client_email', e.target.value)} placeholder="jane@example.com"
            aria-invalid={!!fieldErrors?.client_email} />
          <FieldError error={fieldErrors?.client_email} />
        </div>
        <div className="form-group">
          <label htmlFor="wz-client_phone" className="form-label">Phone</label>
          <input id="wz-client_phone" className="form-input" type="tel" value={formatPhoneInput(form.client_phone)}
            onChange={e => update('client_phone', stripPhone(e.target.value))} placeholder="(312) 555-1234" />
        </div>
        <div className="form-group wz-consent" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="wz-sms_consent" className="wz-consent-label">
            <input
              id="wz-sms_consent"
              type="checkbox"
              checked={!!form.sms_consent}
              onChange={e => update('sms_consent', e.target.checked)}
            />
            <span className="wz-consent-text">
              {SMS_CONSENT_LEAD}{' See our '}
              <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>
              {' and '}
              <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link>.
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
