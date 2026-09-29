import React from 'react';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';

// The presentational sections of the phone event detail (spec
// 2026-08-13-mobile-admin section 4 Detail; benchmark 2026-09-15, Event
// detail). They render what client/src/utils/eventDetailView.js derived and
// hold no state and make no read: EventDetailPhone owns both.

export function Caret({ open }) {
  return (
    <span className={`m-section-caret${open ? ' m-section-caret-open' : ''}`} aria-hidden="true">
      <Icon name="right" size={16} />
    </span>
  );
}

function PhoneLine({ label, links, who }) {
  if (!label) return null;
  return (
    <div className="m-contact-line">
      {links.telHref
        ? <a className="m-contact-link" href={links.telHref}>{label}</a>
        : <span className="m-contact-plain">{label}</span>}
      {links.smsHref && <a className="m-contact-act" href={links.smsHref} aria-label={`Text ${who}`}>Text</a>}
    </div>
  );
}

export function ContactsSection({ open, onToggle, contacts, planState, clientName }) {
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="users" size={20} />
        <span className="m-section-name">Contacts</span>
        {(planState === 'ready' || planState === 'none') && <span className="m-section-sum">{contacts.summary}</span>}
        <Caret open={open} />
      </button>
      {open && (
        <>
          <div className="m-section-label">Client</div>
          <div className="m-contact">
            <PhoneLine label={contacts.client.phone} links={contacts.client} who={clientName || 'the client'} />
            {contacts.client.email && (
              <div className="m-contact-line">
                {/* An address that gets no link (eventDetailView.js) is text, and looks like text. */}
                {contacts.client.mailHref
                  ? <a className="m-contact-link" href={contacts.client.mailHref}>{contacts.client.email}</a>
                  : <span className="m-contact-plain">{contacts.client.email}</span>}
              </div>
            )}
            {!contacts.client.phone && !contacts.client.email && (
              <div className="m-section-note">No phone or email on file.</div>
            )}
          </div>
          <div className="m-section-label">Day-of contact</div>
          {contacts.dayOf && (
            <div className="m-contact">
              <div className="m-contact-name">{contacts.dayOf.name}</div>
              <PhoneLine label={contacts.dayOf.phone} links={contacts.dayOf} who={contacts.dayOf.name} />
            </div>
          )}
          {!contacts.dayOf && planState === 'failed' && (
            <div className="m-section-note">The day-of contact needs a connection.</div>
          )}
          {!contacts.dayOf && planState === 'loading' && (
            <div className="m-section-note">Loading the day-of contact</div>
          )}
          {!contacts.dayOf && (planState === 'ready' || planState === 'none') && (
            <div className="m-section-note">
              <Icon name="clock" size={16} />
              <span>Not received yet. Collected with the drink plan; often the client themselves.</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function MoneySection({ open, onToggle, fin, moneyState }) {
  return (
    <section className="m-section">
      <button type="button" className="m-section-row" aria-expanded={open} onClick={onToggle}>
        <Icon name="dollar" size={20} />
        <span className="m-section-name">Financials</span>
        <span className="m-section-num">{fin.total}</span>
        {fin.chip && <StatusChip kind={fin.chip.kind}>{fin.chip.label}</StatusChip>}
        <Caret open={open} />
      </button>
      {open && (
        <>
          <div className="m-section-label">Package &amp; extras</div>
          {fin.lines.map((line, i) => (
            <div className="m-money-row" key={`${line.label}-${i}`}>
              <span className="m-money-main"><span className="m-money-label">{line.label}</span></span>
              <span className="m-money-amt">{line.amount}</span>
            </div>
          ))}
          <div className="m-money-row m-money-total">
            <span className="m-money-main"><span className="m-money-label">Total</span></span>
            <span className="m-money-amt">{fin.total}</span>
          </div>
          <div className="m-section-label">Payments</div>
          {fin.payments === null && (
            <div className="m-section-note">
              {moneyState === 'loading' ? 'Loading the payment detail' : 'Payment detail needs a connection.'}
            </div>
          )}
          {fin.noPayments && <div className="m-section-note">No payments yet.</div>}
          {(fin.payments || []).map((pay) => (
            <div className="m-money-row m-money-pay" key={pay.key}>
              <span className="m-money-main">
                <span className="m-money-label">{pay.label}</span>
                <span className="m-money-sub">{pay.sub}</span>
              </span>
              <span className="m-money-amt">{pay.amount}</span>
            </div>
          ))}
          {fin.pending.map((pay) => (
            <div className="m-money-row m-money-pay" key={pay.key}>
              <span className="m-money-main">
                <span className="m-money-label">{pay.label}</span>
                {pay.sub ? <span className="m-money-sub">{pay.sub}</span> : null}
              </span>
              <span className="m-money-amt">{pay.amount}</span>
            </div>
          ))}
          {fin.showPaidToDate && (
            <div className="m-money-row">
              <span className="m-money-main"><span className="m-money-label">Paid to date</span></span>
              <span className="m-money-amt">{fin.paidToDate}</span>
            </div>
          )}
          {fin.balance && (
            <div className={`m-money-row m-money-bal${fin.balance.inFlight ? ' m-money-flight' : ''}`}>
              <span className="m-money-main">
                <span className="m-money-label">{fin.balance.label}</span>
                <span className="m-money-sub">{fin.balance.sub}</span>
              </span>
              <span className="m-money-amt">{fin.balance.amount}</span>
            </div>
          )}
          {fin.overpaid && (
            <div className="m-money-row m-money-bal">
              <span className="m-money-main">
                <span className="m-money-label">Overpaid</span>
                <span className="m-money-sub">{fin.overpaid.sub}</span>
              </span>
              <span className="m-money-amt">{fin.overpaid.amount}</span>
            </div>
          )}
          {fin.paidInFull && !fin.overpaid && (
            <div className="m-money-row m-money-paid">
              <span className="m-money-main"><span className="m-money-label">Paid in full</span></span>
              <span className="m-money-amt">{fin.total}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
