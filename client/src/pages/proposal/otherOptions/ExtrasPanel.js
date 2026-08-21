import React from 'react';
import { fmt } from '../proposalView/helpers';
import { isTimedPerGuestAddon, timedPerGuestRateLabel } from '../../../utils/addonRateLabel';

// The extras strip, scoped to the rung the client is STANDING ON.
//
// Not "add to every option": the drawer's rungs are commit-only, so the only
// configuration a client can actually change extras on is their own. Scoping
// here is what stops the strip listing things that would silently vanish the
// moment they committed.
//
// Nothing here writes. Toggling re-quotes every rung against the draft so the
// comparison stays like-for-like, and the client's proposal is untouched until
// they commit.

function rateLabel(x, hours) {
  if (x.rate === null) return '';
  if (x.billing_type === 'per_guest') return `${fmt(x.rate)} per guest`;
  // The listed per_guest_timed rate covers four hours; hours past four bill
  // extra_hour_rate per guest on top. This is a number a client can hold us to,
  // so it never shows the bare four-hour figure.
  if (isTimedPerGuestAddon(x)) return timedPerGuestRateLabel(x, { money: fmt });
  if (x.billing_type === 'per_hour') return `${fmt(x.rate)} an hour${hours ? ` · ${hours} hours` : ''}`;
  if (x.billing_type === 'per_100_guests') return `${fmt(x.rate)} per 100 guests`;
  if (x.billing_type === 'per_staff') return `${fmt(x.rate)} per staff member`;
  return fmt(x.rate);
}

function Row({ x, hours, on, blocked, onToggle }) {
  if (blocked) {
    return (
      <div className="oo-extra oo-extra-blocked">
        <span className="oo-extra-name">{x.name}</span>
        <span className="oo-extra-reason">{blocked}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={on ? 'oo-extra oo-extra-on' : 'oo-extra'}
      onClick={() => onToggle(x.addon_id)}
      aria-pressed={on}
    >
      <span className="oo-extra-name">{x.name}</span>
      <span className="oo-extra-rate">{rateLabel(x, hours)}</span>
    </button>
  );
}

export default function ExtrasPanel({
  chips, groups, hours, onToggle, expanded, onExpand, summary, blockedFor, isOn,
}) {
  if (!chips.length && !groups.length) return null;
  return (
    <div className="oo-extras">
      {!expanded ? (
        <button
          type="button"
          className="oo-extras-collapsed"
          onClick={onExpand}
          aria-expanded={false}
        >
          <span className="oo-extras-k">＋ Extras · add to your package</span>
          <span className="oo-extras-summary">{summary}</span>
        </button>
      ) : (
        <>
          <div className="oo-extras-head">
            <span className="oo-extras-k">Add to your package</span>
            <button type="button" className="oo-back" onClick={onExpand}>done ↑</button>
          </div>
          <p className="oo-extras-note">your total updates when you do</p>
          <div className="oo-extra-rows">
            {chips.map((x) => (
              <Row
                key={x.addon_id}
                x={x}
                hours={hours}
                on={isOn(x.addon_id)}
                blocked={blockedFor(x)}
                onToggle={onToggle}
              />
            ))}
          </div>
          {groups.map((g) => (
            <div className="oo-extra-group" key={g.label}>
              <div className="oo-extra-group-k">{g.label}</div>
              <div className="oo-extra-rows">
                {g.items.map((x) => (
                  <Row
                    key={x.addon_id}
                    x={x}
                    hours={hours}
                    on={isOn(x.addon_id)}
                    blocked={blockedFor(x)}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
