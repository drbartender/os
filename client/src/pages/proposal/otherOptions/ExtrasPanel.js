import React from 'react';
import { fmt } from '../proposalView/helpers';
import { isTimedPerGuestAddon, timedPerGuestRateLabel } from '../../../utils/addonRateLabel';

// Extras apply to EVERY option at once, which is the point: toggling a
// champagne toast moves all the prices together, so the comparison the client
// was in the middle of stays a fair one instead of quietly becoming
// apples-to-oranges.
//
// An extra that doesn't apply to a given lane simply isn't priced into that
// option (the server gates each option on applies_to), so the client never has
// to reason about which ones are compatible with what.
function rateLabel(x, hours) {
  if (x.rate === null) return '';
  if (x.billing_type === 'per_guest') return `${fmt(x.rate)} per guest`;
  // The listed per_guest_timed rate covers four hours; hours past four bill
  // extra_hour_rate per guest on top. This panel is what a client compares
  // options against, so it never shows the bare four-hour number.
  if (isTimedPerGuestAddon(x)) return timedPerGuestRateLabel(x, { money: fmt });
  if (x.billing_type === 'per_hour') return `${fmt(x.rate)} an hour${hours ? ` · ${hours} hours` : ''}`;
  if (x.billing_type === 'per_100_guests') return `${fmt(x.rate)} per 100 guests`;
  if (x.billing_type === 'per_staff') return `${fmt(x.rate)} per staff member`;
  return fmt(x.rate);
}

export default function ExtrasPanel({ extras, hours, onToggle }) {
  if (!extras.length) return null;
  return (
    <div className="oo-extras">
      <div className="oo-extras-head">
        <h3 className="oo-h3">Add to every option</h3>
        <p className="oo-sub">The prices above move with these.</p>
      </div>
      <div className="oo-extras-grid">
        {extras.map((x) => (
          <button
            type="button"
            key={x.addon_id}
            className={x.selected ? 'oo-extra oo-extra-on' : 'oo-extra'}
            aria-pressed={x.selected}
            onClick={() => onToggle(x.addon_id)}
          >
            <span className="oo-extra-check" aria-hidden="true">{x.selected ? '✓' : ''}</span>
            <span className="oo-extra-body">
              <span className="oo-extra-name">{x.name}</span>
              <span className="oo-extra-rate">{rateLabel(x, hours)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
