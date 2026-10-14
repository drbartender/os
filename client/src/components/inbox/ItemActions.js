import React, { useRef, useState } from 'react';
import Icon from '../adminos/Icon';
import { claimButton, stampLabel } from './inboxFormat';
import { SnoozeMenu } from './SnoozePickers';

// On it, Snooze and Done (spec 4.4), and the banner an item shows when it is
// not waiting. The phone gets three equal buttons in thumb reach (the
// shipped m-act); the desktop puts them in the thread header as btn
// variants, with Snooze opening a panel of choices (a disclosure: the button
// says expanded or not, and promises no ARIA menu).

export function PhoneActions({ state, busy, onClaim, onSnooze, onDone }) {
  const c = claimButton(state);
  return (
    <div className="m-acts ib-acts">
      <button
        type="button"
        className={c.mine ? 'm-act m-act-quiet ib-act ib-act-mine' : 'm-act m-act-quiet ib-act'}
        aria-pressed={c.mine}
        disabled={busy}
        onClick={() => onClaim(c)}
      >
        <Icon name={c.icon} size={16} />{c.label}
      </button>
      <button type="button" className="m-act m-act-quiet ib-act" disabled={busy} onClick={onSnooze}>
        <Icon name="clock" size={16} />Snooze
      </button>
      <button type="button" className="m-act m-act-quiet ib-act" disabled={busy} onClick={onDone}>
        <Icon name="check" size={16} />Done
      </button>
    </div>
  );
}

export function DesktopActions({ state, busy, nowMs, onClaim, onSnooze, onDone }) {
  const [menu, setMenu] = useState(false);
  // The menu's anchor: a press on it is not an outside click, and Escape
  // hands focus back to it.
  const snoozeButton = useRef(null);
  const c = claimButton(state);
  return (
    <div className="ib-thead-acts">
      <button type="button" className="btn btn-secondary" aria-pressed={c.mine} disabled={busy} onClick={() => onClaim(c)}>
        <Icon name={c.icon} />{c.longLabel}
      </button>
      <button
        ref={snoozeButton}
        type="button"
        className="btn btn-secondary"
        aria-expanded={menu}
        disabled={busy}
        onClick={() => setMenu((v) => !v)}
      >
        <Icon name="clock" />Snooze<Icon name="down" />
      </button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDone}>
        <Icon name="check" />Done
      </button>
      {menu && (
        <SnoozeMenu
          nowMs={nowMs}
          anchorRef={snoozeButton}
          onClose={() => setMenu(false)}
          onPick={(until) => { setMenu(false); onSnooze(until); }}
        />
      )}
    </div>
  );
}

/**
 * The item is not waiting: snoozed (Wake), handled in the last 7 days
 * (Reopen, with the reason when the payload carries `closed`), or simply not
 * waiting (Reopen). Reads the item payload's `status` and `snooze` (lane
 * inbox-engine) and `closed`.
 */
export function ItemBanner({ item, nowMs, busy, onWake, onReopen, variant = 'phone' }) {
  if (!item || item.waiting) return null;
  let text = 'Not waiting on a reply';
  let label = 'Reopen';
  let onTap = onReopen;
  if (item.snooze) {
    text = `Snoozed until ${stampLabel(item.snooze.until, nowMs)}`;
    label = 'Wake';
    onTap = onWake;
  } else if (item.closed) {
    text = ['Handled', item.closed.reason_text, stampLabel(item.closed.closed_at, nowMs)].filter(Boolean).join(' · ');
  } else if (item.status === 'handled') {
    text = 'Handled in the last 7 days';
  }
  if (variant === 'desktop') {
    return (
      <div className="ib-dclosed">
        <span className="ib-closed-icon"><Icon name="check" size={14} /></span>
        <span className="ib-dclosed-text">{text}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onTap}>{label}</button>
      </div>
    );
  }
  return (
    <div className="ib-closed">
      <span className="ib-closed-icon"><Icon name="check" size={16} /></span>
      <span className="ib-closed-text">{text}</span>
      <button type="button" className="m-fail-retry" disabled={busy} onClick={onTap}>{label}</button>
    </div>
  );
}
