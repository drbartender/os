import React from 'react';
import { formatDollars } from './money';
import { deriveNextUp } from './nextUp';
const daysUntil = (d) => d ? Math.ceil((new Date(String(d).slice(0, 10) + 'T12:00:00') - new Date()) / 86400000) : null;
const ORDER = ['draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed'];
const at = (s) => ORDER.indexOf(s);

export function Countdown({ focus }) {
  const d = daysUntil(focus.event_date);
  if (d === null) return <div className="cp-countdown-card"><div className="cp-countdown-foot">Date to be confirmed.</div></div>;
  return <div className="cp-countdown-card"><div className="cp-countdown-stamp-num">{Math.abs(d)}</div>
    <div className="cp-countdown-foot">{d < 0 ? 'took place' : 'days to go'}</div></div>;
}
export function SummaryAside({ focus }) {
  const pct = focus.total_price > 0 ? Math.min(100, Math.round((focus.amount_paid / focus.total_price) * 100)) : 0;
  return (<aside className="cp-summary-card">
    <div className="cp-summary-leader"><span>Total</span><span>{formatDollars(focus.total_price)}</span></div>
    <div className="cp-summary-leader"><span>Paid</span><span>{formatDollars(focus.amount_paid)} ({pct}%)</span></div>
    {focus.balance_due > 0 && <div className="cp-summary-leader"><span>Balance</span><span>{formatDollars(focus.balance_due)}</span></div>}
    <div className="cp-case-pay-bar"><div className="cp-case-pay-bar-fill" style={{ width: `${pct}%` }} /></div>
  </aside>);
}
export function NextUpCard({ focus }) {
  const n = deriveNextUp(focus); if (!n) return null;
  return <div className="cp-next-card"><div className="cp-next-title">{n.label}</div>
    <a className="btn client-btn-primary" href={n.href}>{n.cta}</a></div>;
}
export function ProcedureTimeline({ focus }) {
  const i = at(focus.status);
  const steps = [
    { k: 'quote', name: 'Quote prepared', done: i >= at('sent') },
    { k: 'deposit', name: 'Deposit paid', done: i >= at('deposit_paid') },
    { k: 'menu', name: 'Potion plan', done: focus.drink_plan_submitted },
    { k: 'balance', name: 'Balance paid', done: focus.booked && focus.balance_due <= 0 },
    { k: 'event', name: 'Event day', done: i >= at('completed') },
    { k: 'wrap', name: 'Wrap-up', done: i >= at('completed') },
  ];
  return <ol className="cp-procedure">{steps.map(s => <li key={s.k} className={`cp-proc-step ${s.done ? 'done' : ''}`}>{s.name}</li>)}</ol>;
}
