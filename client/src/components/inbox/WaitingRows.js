// The Inbox list rows: WaitingCard (phone) and WaitingRow (desktop), each one tap target that opens the
// person, with a menu task's event link beside it; SnoozedRow, a snoozed person with Wake.

import React from 'react';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { channelIcon, channelLabel, stampLabel, stateChip, waitParts } from './inboxFormat';
import { taskLink, TASK_LINK_LABEL } from './inboxThread';
import { TaskLink } from './Thread';

// One waiting person (spec 4.1 and 11). The phone card is the shipped m-card
// with its rail as the wait (big number over a unit, red at 24 hours); the
// desktop row follows the Needs-attention queue (queue-icon, toned by the
// wait). Each is one tap target that opens the person deliberately.
//
// A personal row (personal mail, judged once per mail by the sync,
// server/utils/inbox/personalMail.js, spec 2026-10-14 decision 6; only the
// owner's list ever holds one) carries a "dallas@" chip after the
// channel tags, in the muted StatusChip, inside the tags group so a narrow
// card wraps them together (right-aligned) rather than the chip alone. A
// pitch row (the AI read the newest inbound as a solicitation, decision 12)
// carries a "Pitch" chip there in the same style.
//
// A menu task's row (spec 2026-10-19 section 13.2) shows the task's text as
// its need line and, when the server sends the task's event link, a plain
// text link to the event right after the row: beside the tap target, never
// inside it (a link inside a button is no link, and a press on it must open
// the event, not the person). The phone puts it on a line tucked under its
// own card (ib-task-line), the desktop on the bottom of its row (ib-dtask-line,
// which takes the row's border, hover and selected tones; index.css). No row
// draws Done. The link is named for the person ("Open the menu for <name>"),
// and on a phone it opens the desktop event page for one visit (TaskLink).

const NO_WAIT = { n: '', unit: '', short: '', hot: false, tone: 'info' };

function TaskLinkLine({ row, variant }) {
  const link = taskLink(row.link);
  if (!link) return null;
  return (
    <div className={variant === 'desktop' ? 'ib-dtask-line' : 'ib-task-line'}>
      <TaskLink to={link} label={`${TASK_LINK_LABEL} for ${row.name}`} />
    </div>
  );
}

function PersonalChip() {
  return <StatusChip kind="neutral">dallas@</StatusChip>;
}

function PitchChip() {
  return <StatusChip kind="neutral">Pitch</StatusChip>;
}

export function WaitingCard({ row, nowMs, onOpen }) {
  const wait = waitParts(row.waiting_since, nowMs) || NO_WAIT;
  const chip = stateChip(row.state);
  return (
    <>
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
              {row.pitch && <PitchChip />}
              {row.personal && <PersonalChip />}
            </span>
          </span>
        </span>
      </button>
      <TaskLinkLine row={row} variant="phone" />
    </>
  );
}

export function WaitingRow({ row, nowMs, selected, onOpen }) {
  const wait = waitParts(row.waiting_since, nowMs) || NO_WAIT;
  const chip = stateChip(row.state);
  const channels = row.channels || [];
  const open = () => onOpen(row.person_key);
  return (
    <>
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
              {row.pitch && <PitchChip />}
              {row.personal && <PersonalChip />}
            </span>
          </div>
        </div>
      </div>
      <TaskLinkLine row={row} variant="desktop" />
    </>
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
