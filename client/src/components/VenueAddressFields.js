import React from 'react';
import VenueSearchInput from './VenueSearchInput';

// VENUE_STATES + formatVenue mirror server/utils/venueAddress.js
// (VENUE_STATES + composeVenueLocation) — kept in sync manually
// (same pattern as eventTypes.js). Edit both together.
export const VENUE_STATES = ['Illinois', 'Indiana', 'Michigan', 'Minnesota', 'Wisconsin'];

// Controlled structured-address inputs. Used at the sign+pay gate and the
// admin proposal edit form. value: {venue_name,venue_street,venue_city,
// venue_state,venue_zip}. onChange(field, value).
export default function VenueAddressFields({
  value = {},
  onChange,
  fieldErrors = {},
  requireStreet = false,
  inputClassName = 'form-input',
  selectClassName = 'form-select',
  labelClassName = 'form-label',
  idPrefix = 'venue',
}) {
  const v = value || {};
  const set = (f) => (e) => onChange(f, e.target.value);
  const req = requireStreet ? ' *' : '';

  // Apply a picked venue. The component supplies only the venue_* keys that
  // have a value, so an out-of-area (name-only) result never wipes an address
  // the user already entered. Every parent's onChange is a functional setState,
  // so the per-field calls are safe.
  const applyVenue = (venue) => {
    ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip']
      .forEach((k) => { if (venue[k] !== undefined) onChange(k, venue[k]); });
  };

  return (
    <div className="venue-address-fields">
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-name`}>Venue name (optional)</label>
        <VenueSearchInput
          id={`${idPrefix}-name`}
          value={v.venue_name || ''}
          onChange={(name) => onChange('venue_name', name)}
          onSelect={applyVenue}
          inputClassName={inputClassName}
          placeholder="e.g. Citadel Banquet Hall"
          ariaInvalid={!!fieldErrors.venue_name}
        />
        {fieldErrors.venue_name && <div className="field-error">{fieldErrors.venue_name}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-street`}>Street address{req}</label>
        <input id={`${idPrefix}-street`} className={inputClassName} value={v.venue_street || ''}
          onChange={set('venue_street')} placeholder="123 Main St" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_street} />
        {fieldErrors.venue_street && <div className="field-error">{fieldErrors.venue_street}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-city`}>City *</label>
        <input id={`${idPrefix}-city`} className={inputClassName} value={v.venue_city || ''}
          onChange={set('venue_city')} placeholder="Chicago" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_city} />
        {fieldErrors.venue_city && <div className="field-error">{fieldErrors.venue_city}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-state`}>State *</label>
        <select id={`${idPrefix}-state`} className={selectClassName} value={v.venue_state || ''}
          onChange={set('venue_state')} aria-invalid={!!fieldErrors.venue_state}>
          <option value="">-- Select --</option>
          {VENUE_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        {fieldErrors.venue_state && <div className="field-error">{fieldErrors.venue_state}</div>}
      </div>
      <div className="form-group">
        <label className={labelClassName} htmlFor={`${idPrefix}-zip`}>ZIP (optional)</label>
        <input id={`${idPrefix}-zip`} className={inputClassName} value={v.venue_zip || ''}
          onChange={set('venue_zip')} placeholder="60601" inputMode="numeric" autoComplete="off"
          aria-invalid={!!fieldErrors.venue_zip} />
        {fieldErrors.venue_zip && <div className="field-error">{fieldErrors.venue_zip}</div>}
      </div>
    </div>
  );
}

// Display helper for the read-only "already provided" confirmation.
export function formatVenue(v = {}) {
  const cityState = [v.venue_city, v.venue_state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, v.venue_zip].filter(Boolean).join(' ');
  return [v.venue_name, v.venue_street, cityStateZip].filter(Boolean).join(', ');
}
