import React from 'react';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { channelIcon, channelLabel, stampLabel, stateChip, waitParts } from './inboxFormat';

// One waiting person (spec 4.1 and 11). The phone card is the shipped m-card
// with its rail as the wait (big number over a unit, red at 24 hours); the
// desktop row follows the Needs-attention queue (queue-icon, toned by the
// wait). Each is one tap target that opens the person deliberately.
//
// A personal row (personal mail, judged once per mail by the sync,
// server/utils/inbox/personalMail.js, spec 2026-10-14 decision 6; only the
// owner's list ever holds one) carries a "dallas@" chip after the
// channel tags, in the muted StatusChip, inside the tags group so a narrow
// card wraps them together (right-aligned) rather than the chip alone.

const NO_WAIT = { n: '', unit: '', short: '', hot: false, tone: 'info' };

function PersonalChip() {
  return <StatusChip kind="neutral">dallas@</StatusChip>;
}

export function WaitingCard({ row, nowMs, onOpen }) {
  const wait = waitParts(row.waiting_since, nowMs) || NO_WAIT;
  const chip = stateChip(row.state);
  return (
    <button type="button" className="m-card" onClick={() => onOpen(row.person_key)}>
      <span className={wait.hot ? 'm-rail ib-rail-hot' : 'm-rail'}>
        <span className="m-rail-day">{wait.n}</span>
        <span className="m-rail-mon">{wait.unit}</span>
      </span>
      <span className="m-card-body">
        <span className="m-card-head">
          <span className="m-card-title">{row.name}</span>
        </span>
        <span className="ib-need">{row.need}</span>
        <span className="m-card-foot">
          {chip && <StatusChip kind={chip.kind}>{chip.label}</StatusChip>}
          <span className="m-tags">
            {(row.channels || []).map((c) => <span key={c} className="m-tag">{channelLabel(c)}</span>)}
            {row.personal && <PersonalChip />}
          </span>
        </span>
      </span>
    </button>
  );
}

export function WaitingRow({ row, nowMs, selected, onOpen }) {
  const wait = waitParts(row.waiting_since, nowMs) || NO_WAIT;
  const chip = stateChip(row.state);
  const channels = row.channels || [];
  const open = () => onOpen(row.person_key);
  return (
    <div
      className={selected ? 'ib-drow is-selected' : 'ib-drow'}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      {/* The icon is the person's latest channel, toned by the wait. */}
      <div className={`queue-icon ${wait.tone} ib-drow-icon`} aria-hidden="true">
        <Icon name={channelIcon(channels[channels.length - 1])} />
      </div>
      <div className="ib-drow-main">
        <div className="ib-drow-head">
          <span className="ib-drow-name">{row.name}</span>
          <span className={wait.hot ? 'ib-drow-wait ib-hot' : 'ib-drow-wait'}>{wait.short}</span>
        </div>
        <div className="ib-drow-need">{row.need}</div>
        <div className="ib-drow-foot">
          {chip && <StatusChip kind={chip.kind}>{chip.label}</StatusChip>}
          <span className="ib-tags">
            {channels.map((c) => <span key={c} className="ib-tag">{channelLabel(c)}</span>)}
            {row.personal && <PersonalChip />}
          </span>
        </div>
      </div>
    </div>
  );
}

// "<name> snoozed until Wed 8:00 AM" with Wake (spec 4.1, the design). Wake is
// off while a tap is on its way (`busy`, the page's in-flight state).
export function SnoozedRow({ row, nowMs, onWake, busy = false, variant = 'phone' }) {
  const until = stampLabel(row.until, nowMs);
  if (variant === 'desktop') {
    return (
      <div className="ib-dsnz">
        <Icon name="clock" size={12} />
        <span className="ib-dsnz-text">{row.name} snoozed until <span className="ib-num">{until}</span></span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onWake(row)}>Wake</button>
      </div>
    );
  }
  return (
    <div className="ib-snz">
      <span className="ib-snz-icon" aria-hidden="true"><Icon name="clock" size={14} /></span>
      <span className="ib-snz-text">{row.name} snoozed until <span className="ib-num">{until}</span></span>
      <button type="button" className="m-fail-retry" disabled={busy} onClick={() => onWake(row)}>Wake</button>
    </div>
  );
}
