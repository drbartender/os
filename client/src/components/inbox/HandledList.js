import React from 'react';
import { handledGroups } from './inboxFormat';

// Recently handled (spec 4.5): the last 7 days by Chicago day, newest first,
// each row with what they needed, the reason, who (D, Z, or a dashed AI mark;
// Thumbtack has none) and Reopen. The need line is spec 4.5's; the design
// drew the row without it, and beside an "AI: ..." reason it is what lets
// Dallas judge the AI's call. A row the server sends with no channel (null)
// draws no channel tag and no separator, never an empty pill.

// The desktop's wide variant keeps the badge's column on a row with no badge
// (an empty, hidden badge), so its name and reason line up with the rows above.
function Who({ who, wide }) {
  if (!who) return wide ? <span className="ib-who ib-who-wide ib-who-none" aria-hidden="true" /> : null;
  return <span className={wide ? `${who.cls} ib-who-wide` : who.cls} title={who.title} aria-hidden="true">{who.label}</span>;
}

// `busy`: a tap is on its way (the page's in-flight state), so Reopen is off.
export default function HandledList({ rows, nowMs, onReopen, busy = false, variant = 'phone' }) {
  const groups = handledGroups(rows, nowMs);
  if (variant === 'desktop') {
    if (groups.length === 0) return <div className="ib-dnote">Nothing closed in the last 7 days.</div>;
    return groups.map((g) => (
      <React.Fragment key={g.day}>
        <div className="ib-dhgroup">{g.day}</div>
        {g.items.map((h) => (
          <div key={h.key} className="ib-dhrow">
            <Who who={h.who} wide />
            <div className="ib-dhrow-main">
              <div className="ib-dhrow-head">
                <span className="ib-dhrow-name">{h.name}</span>
                <span className="ib-dhrow-time">{h.time}</span>
              </div>
              {h.need && <div className="ib-dhrow-need">{h.need}</div>}
              <div className="ib-dhrow-why">
                {h.reason}
                {h.channel ? <> <span className="ib-dhrow-dot" aria-hidden="true">·</span> <span className="ib-dhrow-ch">{h.channel}</span></> : null}
              </div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onReopen(h)}>Reopen</button>
          </div>
        ))}
      </React.Fragment>
    ));
  }
  return (
    <>
      <div className="ib-handled-intro">Closed in the last 7 days, and why. Reopen puts it back in Waiting.</div>
      {groups.length === 0 && (
        <div className="m-empty">
          <div className="m-empty-body">Nothing closed in the last 7 days.</div>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.day} className="ib-hgroup">
          <h2 className="m-more-heading">{g.day}</h2>
          <ul className="m-more-list">
            {g.items.map((h) => (
              <li key={h.key} className="ib-hrow">
                <span className="ib-hrow-main">
                  <span className="ib-hrow-head">
                    <span className="ib-hrow-name">{h.name}</span>
                    <span className="ib-hrow-time">{h.time}</span>
                  </span>
                  {h.need && <span className="ib-hrow-need">{h.need}</span>}
                  <span className="ib-hrow-why">
                    <Who who={h.who} />
                    <span className="ib-hrow-reason">{h.reason}</span>
                  </span>
                  {h.channel ? <span className="ib-hrow-ch"><span className="m-tag">{h.channel}</span></span> : null}
                </span>
                <button type="button" className="m-fail-retry ib-on-card" disabled={busy} onClick={() => onReopen(h)}>Reopen</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
