import React from 'react';
import FieldError from '../../../../components/FieldError';
import { formatPhoneInput, stripPhone } from '../../../../utils/formatPhone';

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
      </div>
    </div>
  );
}
