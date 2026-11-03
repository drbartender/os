// The W-9 fill-out fields for onboarding, with each field's error shown under it.
//
// Controlled by the Payday Protocols page, which holds the form (shaped like EMPTY_W9 in
// utils/w9Pdf.js), checks it and builds the signed PDF when the recruit presses Submit
// Onboarding. There is no button here: a second finish button inside the W-9 used to
// read as the end of onboarding, and recruits left before the real Submit.

import React from 'react';
import SignaturePad from './SignaturePad';
import FieldError from './FieldError';

const TAX_CLASSIFICATIONS = [
  'Individual/sole proprietor or single-member LLC',
  'C Corporation',
  'S Corporation',
  'Partnership',
  'Trust/Estate',
  'LLC – C Corporation',
  'LLC – S Corporation',
  'LLC – Partnership',
  'Other',
];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

/**
 * @param {object}   value          the form, shaped like EMPTY_W9
 * @param {function} onFieldChange  (name, value) for one field; the signature sends
 *                                  signatureData and signatureMethod
 * @param {object}   errors         field name to message, from validateW9
 */
export default function W9Form({ value, onFieldChange, errors = {} }) {
  function handle(e) {
    const { name, value: v, type, checked } = e.target;
    onFieldChange(name, type === 'checkbox' ? checked : v);
  }

  // The class and aria-invalid the page's scroll-to-first-error looks for.
  function inputProps(field) {
    return errors[field]
      ? { className: 'form-input input-error', 'aria-invalid': 'true' }
      : { className: 'form-input' };
  }

  // The three SSN boxes share the row in proportion to their digits (3, 2, 4), so
  // they fit a phone without clipping and stop growing past maxWidth on a desktop.
  const ssnBox = { textAlign: 'center', letterSpacing: '0.15em', fontFamily: 'monospace', fontSize: '1rem', minWidth: 0, paddingLeft: '0.25rem', paddingRight: '0.25rem' };

  return (
    <div style={{ border: '2px solid var(--border-dark)', borderRadius: 'var(--radius-lg)', padding: 'clamp(0.85rem, 4vw, 1.5rem)', background: 'var(--card-bg)' }}>
      <div style={{ marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)' }}>
        <h4 style={{ margin: 0, color: 'var(--deep-brown)' }}>Form W-9</h4>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Fill it out and sign below. It is sent with the rest of this page when you press Submit Onboarding.
        </p>
      </div>

      {/* Line 1: Name */}
      <div className="form-group">
        <label htmlFor="w9-name" className="form-label">1. Name as shown on your income tax return *</label>
        <input id="w9-name" name="name" {...inputProps('name')} value={value.name} onChange={handle} placeholder="Your full legal name" autoComplete="name" />
        <FieldError error={errors.name} />
      </div>

      {/* Line 2: Business name */}
      <div className="form-group">
        <label htmlFor="w9-business_name" className="form-label">2. Business name / DBA (if different from above)</label>
        <input id="w9-business_name" name="business_name" className="form-input" value={value.business_name} onChange={handle} placeholder="Leave blank if same as above" />
      </div>

      {/* Line 3: Tax classification */}
      <div className="form-group">
        <label htmlFor="w9-tax_classification" className="form-label">3. Federal tax classification *</label>
        <select id="w9-tax_classification" name="tax_classification" className="form-select" value={value.tax_classification} onChange={handle}>
          {TAX_CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Address */}
      <div className="form-group">
        <label htmlFor="w9-address" className="form-label">5. Street Address *</label>
        <input id="w9-address" name="address" {...inputProps('address')} value={value.address} onChange={handle} placeholder="123 Main St, Apt 4B" autoComplete="street-address" />
        <FieldError error={errors.address} />
      </div>
      {/* City on its own row and State beside ZIP: three across left the State
          select too narrow to show its value on a phone. */}
      <div className="form-group">
        <label htmlFor="w9-city" className="form-label">City *</label>
        <input id="w9-city" name="city" {...inputProps('city')} value={value.city} onChange={handle} autoComplete="address-level2" />
        <FieldError error={errors.city} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div className="form-group">
          <label htmlFor="w9-state" className="form-label">State *</label>
          <select
            id="w9-state" name="state"
            className={errors.state ? 'form-select input-error' : 'form-select'}
            aria-invalid={errors.state ? 'true' : undefined}
            value={value.state} onChange={handle}
          >
            <option value="">Select</option>
            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <FieldError error={errors.state} />
        </div>
        <div className="form-group">
          <label htmlFor="w9-zip" className="form-label">ZIP *</label>
          <input id="w9-zip" name="zip" {...inputProps('zip')} value={value.zip} onChange={handle} placeholder="60601" maxLength={10} inputMode="numeric" autoComplete="postal-code" />
          <FieldError error={errors.zip} />
        </div>
      </div>

      {/* Part I: TIN */}
      <div className="form-group">
        <div className="form-label">Part I: Taxpayer Identification Number *</div>
        <label className="checkbox-group" style={{ marginBottom: '0.75rem' }}>
          <input type="checkbox" name="use_ein" checked={value.use_ein} onChange={handle} />
          <span className="checkbox-label">I use an EIN (business) instead of SSN (personal)</span>
        </label>

        {!value.use_ein ? (
          <div>
            <div id="w9-ssn-label" style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
              Social Security Number
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', maxWidth: 300 }} role="group" aria-labelledby="w9-ssn-label">
              <input
                name="ssn1" aria-label="SSN, first 3 digits" {...inputProps('ssn')} value={value.ssn1} onChange={handle}
                maxLength={3} placeholder="XXX" inputMode="numeric" autoComplete="off"
                style={{ ...ssnBox, flex: '3 1 0' }}
              />
              <span aria-hidden="true" style={{ color: 'var(--warm-brown)', fontWeight: 700, fontSize: '1.1rem' }}>-</span>
              <input
                name="ssn2" aria-label="SSN, middle 2 digits" {...inputProps('ssn')} value={value.ssn2} onChange={handle}
                maxLength={2} placeholder="XX" inputMode="numeric" autoComplete="off"
                style={{ ...ssnBox, flex: '2 1 0' }}
              />
              <span aria-hidden="true" style={{ color: 'var(--warm-brown)', fontWeight: 700, fontSize: '1.1rem' }}>-</span>
              <input
                name="ssn3" aria-label="SSN, last 4 digits" {...inputProps('ssn')} value={value.ssn3} onChange={handle}
                maxLength={4} placeholder="XXXX" inputMode="numeric" autoComplete="off"
                style={{ ...ssnBox, flex: '4 1 0' }}
              />
            </div>
            <FieldError error={errors.ssn} />
            <p className="form-helper">Format: XXX-XX-XXXX. Transmitted securely and used only for tax/payment purposes.</p>
          </div>
        ) : (
          <div>
            <label htmlFor="w9-ein" style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--warm-brown)', marginBottom: '0.5rem' }}>
              Employer Identification Number (EIN)
            </label>
            <input
              id="w9-ein" name="ein" {...inputProps('ein')} value={value.ein} onChange={handle}
              placeholder="XX-XXXXXXX" inputMode="numeric" autoComplete="off"
              style={{ maxWidth: 220, fontFamily: 'monospace', letterSpacing: '0.15em' }}
            />
            <FieldError error={errors.ein} />
          </div>
        )}
      </div>

      {/* Part II: Certification */}
      <div className="form-group" style={{ marginBottom: 0 }}>
        <div className="form-label">Part II: Certification & Signature *</div>
        <div style={{
          background: '#FFFDF5', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '0.75rem',
          fontSize: '0.8rem', color: 'var(--deep-brown)', lineHeight: 1.6
        }}>
          Under penalties of perjury, I certify that: <strong>(1)</strong> The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me);{' '}
          <strong>(2)</strong> I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding;{' '}
          <strong>(3)</strong> I am a U.S. citizen or other U.S. person;{' '}
          <strong>(4)</strong> The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--warm-brown)', fontWeight: 600, marginBottom: '0.4rem' }}>
          Sign below with your mouse or finger:
        </p>
        {/* The glow marks an unsigned pad; the message under it is what
            scroll-to-first-error lands on, since the pad has no input of its own. */}
        <div className={errors.signature ? 'input-error' : undefined}>
          <SignaturePad
            onChange={(data, method) => { onFieldChange('signatureData', data); onFieldChange('signatureMethod', method); }}
            value={value.signatureData}
          />
        </div>
        <FieldError error={errors.signature} />
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: 0 }}>
          Date: <strong>{new Date().toLocaleDateString()}</strong>
        </p>
      </div>
    </div>
  );
}
