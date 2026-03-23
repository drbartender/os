import React from 'react';
import { formatPhoneInput, stripPhone } from '../../../utils/formatPhone';

const PARKING_OPTIONS = [
  { value: 'free', label: 'Yes, free on-site parking available' },
  { value: 'paid', label: 'Paid parking required (garage, meter, venue lot)' },
  { value: 'street', label: 'Street parking only' },
  { value: 'none', label: 'No parking / I\'ll need to arrange something' },
];

const EQUIPMENT_OPTIONS = [
  { value: 'portable_bar', label: 'Portable bar' },
  { value: 'coolers', label: 'Cooler(s) for beer, wine, or mixers' },
  { value: 'other', label: 'Other' },
];

export default function LogisticsStep({ logistics, onChange }) {
  const dayOfContact = logistics?.dayOfContact || { name: '', phone: '' };
  const parking = logistics?.parking || '';
  const equipment = logistics?.equipment || [];
  const equipmentOther = logistics?.equipmentOther || '';
  const accessNotes = logistics?.accessNotes || '';

  const update = (field, value) => {
    onChange({ ...logistics, [field]: value });
  };

  const updateContact = (field, value) => {
    update('dayOfContact', { ...dayOfContact, [field]: value });
  };

  const toggleEquipment = (value) => {
    if (equipment.includes(value)) {
      update('equipment', equipment.filter(v => v !== value));
    } else {
      update('equipment', [...equipment, value]);
    }
  };

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          Logistics &amp; Final Details
        </h2>
        <p className="text-muted">
          A few important details to help us prepare for your event.
        </p>
      </div>

      {/* Day-Of Contact */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Day-Of Contact
        </h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          Who should we contact the day of the event?
        </p>
        <div className="two-col">
          <div className="form-group">
            <label className="form-label">Contact Name</label>
            <input
              type="text"
              className="form-input"
              placeholder="Full name"
              value={dayOfContact.name}
              onChange={(e) => updateContact('name', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Mobile Number</label>
            <input
              type="tel"
              className="form-input"
              placeholder="(555) 555-5555"
              value={formatPhoneInput(dayOfContact.phone)}
              onChange={(e) => updateContact('phone', stripPhone(e.target.value))}
            />
          </div>
        </div>
      </div>

      {/* Parking */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Parking Information
        </h3>
        <div className="form-group">
          <label className="form-label">Is there free, on-site parking available for our staff?</label>
          <div className="radio-group">
            {PARKING_OPTIONS.map(opt => (
              <label
                key={opt.value}
                className={`radio-option${parking === opt.value ? ' selected' : ''}`}
              >
                <input
                  type="radio"
                  name="parking"
                  checked={parking === opt.value}
                  onChange={() => update('parking', opt.value)}
                />
                <span className="radio-label">{opt.label}</span>
              </label>
            ))}
          </div>
          {parking === 'paid' && (
            <p className="form-helper" style={{ color: 'var(--amber)', marginTop: '0.5rem' }}>
              A $20 parking fee will be added to the final invoice to cover day-of access.
            </p>
          )}
        </div>
      </div>

      {/* Bar Setup & Equipment */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Bar Setup &amp; Equipment
        </h3>
        <div className="form-group">
          <label className="form-label">What would you like us to bring?</label>
          <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
            If this was discussed earlier, this is just a quick double-check so we don't miss anything.
          </p>
          <div className="checkbox-grid">
            {EQUIPMENT_OPTIONS.map(opt => (
              <label key={opt.value} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={equipment.includes(opt.value)}
                  onChange={() => toggleEquipment(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          {equipment.includes('other') && (
            <div className="form-group mt-1">
              <input
                type="text"
                className="form-input"
                placeholder="What else should we bring?"
                value={equipmentOther}
                onChange={(e) => update('equipmentOther', e.target.value)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Event Access & Notes */}
      <div className="card">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Event Access &amp; Notes
        </h3>
        <div className="form-group">
          <label className="form-label">
            Anything we should be aware of that could affect setup or service?
          </label>
          <textarea
            className="form-textarea"
            rows={5}
            placeholder="E.g., gate access codes, elevator instructions, loading dock location, timing restrictions, venue rules, guest count..."
            value={accessNotes}
            onChange={(e) => update('accessNotes', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
