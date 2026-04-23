import React from 'react';
import { formatPhoneInput, stripPhone } from '../../../utils/formatPhone';
import { CHAMPAGNE_TOAST } from '../data/drinkUpgrades';

const PARKING_OPTIONS = [
  { value: 'free', label: 'Yes, free on-site parking available' },
  { value: 'paid', label: 'Paid parking required (garage, meter, venue lot)' },
  { value: 'street', label: 'Street parking only' },
  { value: 'none', label: 'No parking / I\'ll need to arrange something' },
];

const EQUIPMENT_OPTIONS = [
  { value: 'coolers', label: 'Cooler(s) for beer, wine, or mixers' },
  { value: 'other', label: 'Other' },
  { value: 'none', label: 'None — I have everything we need' },
];

export default function LogisticsStep({
  logistics,
  onChange,
  addOns = {},
  toggleAddOn,
  updateAddOnMeta,
  addonPricing = [],
  guestCount,
  numBartenders,
  numBars = 0,
  pricingSnapshot = null,
  plan,
}) {
  const coveredSlugs = plan?.package_covered_addon_slugs || [];
  const dayOfContact = logistics?.dayOfContact || { name: '', phone: '' };
  const parking = logistics?.parking || '';
  const equipment = logistics?.equipment || [];
  const equipmentOther = logistics?.equipmentOther || '';
  const accessNotes = logistics?.accessNotes || '';

  // Parking fee addon pricing
  const parkingAddon = addonPricing.find(a => a.slug === 'parking-fee');
  const parkingRate = parkingAddon ? Number(parkingAddon.rate) : 20;
  const staffCount = (numBartenders || 1);
  const parkingTotal = parkingRate * staffCount;

  const update = (field, value) => {
    // Auto-toggle parking-fee addon when parking selection changes
    if (field === 'parking') {
      const wasPaid = parking === 'paid';
      const nowPaid = value === 'paid';
      if (nowPaid && !wasPaid) {
        // Add parking fee addon
        if (!addOns['parking-fee']) toggleAddOn('parking-fee');
      } else if (!nowPaid && wasPaid) {
        // Remove parking fee addon
        if (addOns['parking-fee']) toggleAddOn('parking-fee');
      }
    }
    onChange({ ...logistics, [field]: value });
  };

  const updateContact = (field, value) => {
    update('dayOfContact', { ...dayOfContact, [field]: value });
  };

  const toggleEquipment = (value) => {
    if (value === 'none') {
      // 'None' clears all other selections and equipmentOther
      const newEquipment = equipment.includes('none') ? [] : ['none'];
      onChange({ ...logistics, equipment: newEquipment, equipmentOther: '' });
      return;
    }
    // Selecting anything else removes 'none'
    const withoutNone = equipment.filter(v => v !== 'none');
    if (withoutNone.includes(value)) {
      update('equipment', withoutNone.filter(v => v !== value));
    } else {
      update('equipment', [...withoutNone, value]);
    }
  };

  // Bar rental pricing from proposal snapshot
  const barRentalInfo = pricingSnapshot?.bar_rental || {};
  const firstBarFee = barRentalInfo.first_bar_fee || 50;
  const additionalBarFee = barRentalInfo.additional_bar_fee || 100;
  const addBarRental = logistics?.addBarRental || false;

  const hasExistingBar = numBars >= 1;
  const canOfferAdditionalBar = hasExistingBar && (numBartenders || 1) >= 2;

  return (
    <div>
      <div className="card" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>
          The Day-Of Rundown
        </h2>
        <p className="text-muted">
          Don't worry if you don't have all the details yet — you can update this later.
        </p>
      </div>

      {/* Day-Of Contact */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Day-Of Contact
        </h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          Who should we contact the day of the event? You can always update this later.
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
              A ${parkingRate} parking fee per staff member will be added
              {staffCount > 1 ? ` (${staffCount} staff × $${parkingRate} = $${parkingTotal})` : ''}.
            </p>
          )}
        </div>
      </div>

      {/* Bar Setup & Equipment */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Bar Setup &amp; Equipment
        </h3>
        <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
          Every bartender arrives with their own bar kit — shakers, jiggers, strainers, and everything they need to pour.
        </p>
        <div className="form-group">
          <label className="form-label">Do you need any additional equipment?</label>
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

      {/* Portable Bar Rental */}
      <div className="card mb-2">
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
          Portable Bar Rental
        </h3>
        {hasExistingBar && !canOfferAdditionalBar && (
          <p className="text-muted text-small" style={{ color: 'var(--warm-brown)' }}>
            Your package includes a portable bar setup &mdash; you're all set.
          </p>
        )}
        {hasExistingBar && canOfferAdditionalBar && (
          <>
            <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
              Your package includes a portable bar setup. Two bartenders can work behind the same bar,
              but a second bar gives you a second service location for your guests.
            </p>
            <label className="checkbox-label" style={{ fontSize: '1rem' }}>
              <input
                type="checkbox"
                checked={addBarRental}
                onChange={() => update('addBarRental', !addBarRental)}
              />
              <span>
                Add a second bar location &mdash; ${additionalBarFee.toFixed(2)}
              </span>
            </label>
          </>
        )}
        {!hasExistingBar && (
          <>
            <p className="text-muted text-small mb-1" style={{ color: 'var(--warm-brown)' }}>
              Need a bar for your event? We'll bring a portable bar setup for your bartender to work behind.
            </p>
            <label className="checkbox-label" style={{ fontSize: '1rem' }}>
              <input
                type="checkbox"
                checked={addBarRental}
                onChange={() => update('addBarRental', !addBarRental)}
              />
              <span>
                Add a portable bar &mdash; ${firstBarFee.toFixed(2)}
              </span>
            </label>
          </>
        )}
      </div>

      {/* Champagne Toast */}
      {!coveredSlugs.includes(CHAMPAGNE_TOAST.addonSlug) && (() => {
        const toastPricing = addonPricing.find(a => a.slug === CHAMPAGNE_TOAST.addonSlug);
        const coupePricing = addonPricing.find(a => a.slug === CHAMPAGNE_TOAST.coupeUpgradeSlug);
        const toastEnabled = !!addOns[CHAMPAGNE_TOAST.addonSlug];
        const coupeEnabled = !!addOns[CHAMPAGNE_TOAST.coupeUpgradeSlug];
        const toastRate = toastPricing ? Number(toastPricing.rate) : 2.50;
        const coupeRate = coupePricing ? Number(coupePricing.rate) : 2.00;
        const toastTotal = guestCount ? (toastRate * guestCount) : null;
        const coupeTotal = guestCount ? (coupeRate * guestCount) : null;
        const servingStyle = addOns[CHAMPAGNE_TOAST.addonSlug]?.servingStyle || '';

        return (
          <div className="card mb-2 champagne-toast-card">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
              Champagne Toast
            </h3>
            <label className="checkbox-label" style={{ fontSize: '1rem' }}>
              <input
                type="checkbox"
                checked={toastEnabled}
                onChange={() => toggleAddOn(CHAMPAGNE_TOAST.addonSlug)}
              />
              <span>
                Add a champagne toast
                {toastTotal
                  ? ` \u2014 $${toastTotal.toFixed(2)} (${guestCount} guests \u00D7 $${toastRate.toFixed(2)})`
                  : ` \u2014 $${toastRate.toFixed(2)}/guest`}
              </span>
            </label>

            {toastEnabled && (
              <>
                {numBartenders === 1 && (
                  <div className="bartender-warning">
                    <strong>Note:</strong> With 1 bartender, the bar will close briefly during champagne service.
                  </div>
                )}

                <div className="serving-options">
                  <label className="form-label" style={{ marginBottom: '0.25rem' }}>
                    How would you like champagne served?
                  </label>
                  {CHAMPAGNE_TOAST.servingStyles.map(opt => (
                    <label
                      key={opt.value}
                      className={`radio-option${servingStyle === opt.value ? ' selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="champagne-serving"
                        checked={servingStyle === opt.value}
                        onChange={() => updateAddOnMeta(CHAMPAGNE_TOAST.addonSlug, { servingStyle: opt.value })}
                      />
                      <span className="radio-label">{opt.label}</span>
                    </label>
                  ))}
                </div>

                {/* Coupe upgrade — max 100 guests */}
                {guestCount && guestCount > 100 ? (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                      Real coupe glasses are available for events up to 100 guests.
                    </span>
                  </div>
                ) : (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={coupeEnabled}
                        onChange={() => toggleAddOn(CHAMPAGNE_TOAST.coupeUpgradeSlug)}
                      />
                      <span>
                        Upgrade to real coupe glasses
                        {coupeTotal
                          ? ` (+$${coupeTotal.toFixed(2)} \u2014 $${coupeRate.toFixed(2)}/guest)`
                          : ` (+$${coupeRate.toFixed(2)}/guest)`}
                      </span>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

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
            placeholder="E.g., gate access codes, elevator instructions, loading dock location, timing restrictions, venue rules..."
            value={accessNotes}
            onChange={(e) => update('accessNotes', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
