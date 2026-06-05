import React from 'react';
import { Countdown, SummaryAside, NextUpCard, ProcedureTimeline } from '../OverviewWidgets';
const isPast = (focus) => focus.event_date && new Date(focus.event_date + 'T12:00:00') < new Date();
export default function OverviewTab({ focus }) {
  const past = isPast(focus);
  return (<div className="cp-case-body"><div className="cp-case-main">
    <Countdown focus={focus} />
    {past ? <a className="btn client-btn-primary" href="/quote">Book us again</a> : <NextUpCard focus={focus} />}
    <ProcedureTimeline focus={focus} />
    <div className="cp-locked-card"><div className="cp-locked-title">Day-of details</div>
      <p>Day-of details unlock closer to the date.</p></div>
  </div><SummaryAside focus={focus} /></div>);
}
