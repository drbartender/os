import React from 'react';
import { formatPhoneInput } from '../../../../utils/formatPhone';

export default function ReviewStep({ form, replaceStep, selectedPkg, addons, stripIncludedAddons }) {
  return (
    <div className="wz-card">
      <h3>Review your proposal</h3>
      <div className="wz-review-summary">
        <div className="wz-review-section">
          <div className="wz-review-heading">
            <h4>Event Details</h4>
            <button type="button" className="wz-review-edit" onClick={() => replaceStep(0)}>Edit</button>
          </div>
          <div className="wz-review-grid">
            {form.event_type && <div><span className="wz-review-label">Event Type</span><span>{form.event_type === 'Other' ? form.event_type_custom : form.event_type}</span></div>}
            <div><span className="wz-review-label">Guests</span><span>{form.guest_count}</span></div>
            <div><span className="wz-review-label">Duration</span><span>{form.event_duration_hours} hours</span></div>
            {form.event_date && <div><span className="wz-review-label">Date</span><span>{form.event_date}</span></div>}
            {form.event_city && <div><span className="wz-review-label">Location</span><span>{[form.event_city, form.event_state].filter(Boolean).join(', ')}</span></div>}
          </div>
        </div>
        <div className="wz-review-section">
          <div className="wz-review-heading">
            <h4>Contact</h4>
            <button type="button" className="wz-review-edit" onClick={() => replaceStep(1)}>Edit</button>
          </div>
          <div className="wz-review-grid">
            <div><span className="wz-review-label">Name</span><span>{form.client_name}</span></div>
            <div><span className="wz-review-label">Email</span><span>{form.client_email}</span></div>
            {form.client_phone && <div><span className="wz-review-label">Phone</span><span>{formatPhoneInput(form.client_phone)}</span></div>}
          </div>
        </div>
        {selectedPkg && (
          <div className="wz-review-section">
            <h4>Package</h4>
            <p>{selectedPkg.name}</p>
          </div>
        )}
        {(stripIncludedAddons(form.addon_ids).length > 0 || form.client_provides_glassware) && (
          <div className="wz-review-section">
            <h4>Add-ons</h4>
            <ul className="wz-review-addons">
              {stripIncludedAddons(form.addon_ids).map(id => {
                const addon = addons.find(a => a.id === id);
                return addon ? <li key={id}>{addon.name}</li> : null;
              })}
              {form.client_provides_glassware && <li>Client providing own glassware</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
