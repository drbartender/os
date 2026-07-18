import React from 'react';
import { formatPhoneInput, stripPhone } from '../../../../utils/formatPhone';

const PARKING_OPTIONS = [
  { value: 'free', label: 'Yes, free on-site parking available' },
  { value: 'paid', label: 'Paid parking required (garage, meter, venue lot)' },
  { value: 'street', label: 'Street parking only' },
  { value: 'none', label: 'No parking / I’ll need to arrange something' },
];

// Day-of details (spec §3.1): contact, parking (with the fee disclosure
// precedent), the promised-but-never-asked bar placement + power questions,
// and access notes. Champagne toast moved to the Enhancement Lab; the coolers
// question is gone (we derive it).
export default function DayOfV2({ plan, selections, updateSelections }) {
  const logistics = selections.logistics || {};
  const contact = logistics.dayOfContact || { name: '', phone: '' };
  const update = (field, value) => updateSelections('logistics', { ...logistics, [field]: value });
  const updateContact = (field, value) => update('dayOfContact', { ...contact, [field]: value });

  const staffCount = plan.num_bartenders || 1;
  const parkingRate = 20;

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>The Day-Of Rundown</h2>
        <p className="text-muted">Don't worry if you don't have every detail yet. You can update this later.</p>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Day-Of Contact</h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>Who should we reach the day of the event?</p>
        <div className="two-col">
          <div className="form-group">
            <label className="form-label">Contact name</label>
            <input type="text" className="form-input" placeholder="Full name" value={contact.name} onChange={(e) => updateContact('name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Mobile number</label>
            <input type="tel" className="form-input" placeholder="(555) 555-5555" value={formatPhoneInput(contact.phone)} onChange={(e) => updateContact('phone', stripPhone(e.target.value))} />
          </div>
        </div>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Parking</h3>
        <div className="form-group">
          <label className="form-label">Is there free, on-site parking for our staff?</label>
          <div className="radio-group">
            {PARKING_OPTIONS.map((opt) => (
              <label key={opt.value} className={`radio-option${logistics.parking === opt.value ? ' selected' : ''}`}>
                <input type="radio" name="parking" checked={logistics.parking === opt.value} onChange={() => update('parking', opt.value)} />
                <span className="radio-label">{opt.label}</span>
              </label>
            ))}
          </div>
          {logistics.parking === 'paid' && (
            <p className="form-helper" style={{ color: 'var(--amber)', marginTop: '0.5rem' }}>
              A ${parkingRate} parking fee per staff member is added to your event balance
              {staffCount > 1 ? ` (${staffCount} staff x $${parkingRate} = $${parkingRate * staffCount})` : ''}.
            </p>
          )}
        </div>
      </div>

      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>The Bar Itself</h3>
        <div className="form-group">
          <label className="form-label">Where does the bar set up?</label>
          <div className="radio-group">
            {[['indoors', 'Indoors'], ['outdoors', 'Outdoors'], ['unsure', 'Not sure yet']].map(([value, label]) => (
              <label key={value} className={`radio-option${selections.barPlacement === value ? ' selected' : ''}`}>
                <input type="radio" name="barPlacement" checked={selections.barPlacement === value} onChange={() => updateSelections('barPlacement', value)} />
                <span className="radio-label">{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Is there a standard outlet within 50 feet of the bar?</label>
          <div className="radio-group">
            {[['yes', 'Yes'], ['no', 'No, or probably not'], ['unsure', 'Not sure yet']].map(([value, label]) => (
              <label key={value} className={`radio-option${selections.powerAtBar === value ? ' selected' : ''}`}>
                <input type="radio" name="powerAtBar" checked={selections.powerAtBar === value} onChange={() => updateSelections('powerAtBar', value)} />
                <span className="radio-label">{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Event Access &amp; Notes</h3>
        <div className="form-group">
          <label className="form-label">Anything that could affect setup or service?</label>
          <textarea
            className="form-textarea"
            rows={5}
            placeholder="e.g. gate codes, elevator instructions, loading dock, timing restrictions, venue rules..."
            value={logistics.accessNotes || ''}
            onChange={(e) => update('accessNotes', e.target.value)}
          />
          <span className="potion-field-note">
            Anything tricky about the venue, like load-in, stairs, or building rules. No need to repeat what you picked above.
          </span>
        </div>
      </div>
    </div>
  );
}
