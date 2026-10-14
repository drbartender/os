import React from 'react';
import { Link } from 'react-router-dom';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { NO_QUOTE_TEXT } from './inboxContext';

// The context card (spec 4.2) from contextModel(): the phone card (label and
// value rows, a three-column money grid, equal link buttons) and the desktop
// Context pane (stacked rows, money as a ledger, small secondary buttons).

function PhoneLink({ link }) {
  if (link.href) {
    return (
      <a className="ib-ctx-link" href={link.href} target="_blank" rel="noopener noreferrer">
        {link.label}<span className="ib-ctx-link-icon"><Icon name="external" size={12} /></span>
      </a>
    );
  }
  return (
    <Link className="ib-ctx-link" to={link.to}>
      {link.label}<span className="ib-ctx-link-icon"><Icon name="right" size={12} /></span>
    </Link>
  );
}

export function ContextCard({ model }) {
  if (!model) return null;
  const m = model.money;
  return (
    <section className="m-section ib-ctx" aria-label="Context">
      {model.hold && <div className="ib-hold" role="note">{model.hold}</div>}
      <div className="ib-ctx-head">
        <StatusChip kind={model.chip.kind}>{model.chip.label}</StatusChip>
        <span className="ib-ctx-type">{model.type}</span>
      </div>
      {model.rows.map((r) => (
        <div key={r.key} className="ib-ctx-row">
          <span className="ib-ctx-label">{r.label}</span>
          <span className="ib-ctx-value">{r.value}</span>
          {r.chip && <StatusChip kind={r.chip.kind}>{r.chip.label}</StatusChip>}
        </div>
      ))}
      {m && (
        <div className="ib-money">
          <div className="ib-money-cell">
            <span className="ib-money-label">Total</span>
            <span className="ib-money-amt">{m.total}</span>
          </div>
          <div className="ib-money-cell">
            <span className="ib-money-label">Paid</span>
            <span className="ib-money-amt">{m.paid}</span>
          </div>
          <div className="ib-money-cell">
            <span className="ib-money-label">Balance</span>
            <span className={m.settled ? 'ib-money-amt ib-bal-settled' : 'ib-money-amt ib-bal-open'}>{m.balance}</span>
            {m.sub && <span className="ib-money-sub">{m.sub}</span>}
          </div>
        </div>
      )}
      {model.showNoQuote && <div className="ib-ctx-none">{NO_QUOTE_TEXT}</div>}
      {model.links.length > 0 && (
        <div className="ib-ctx-links">
          {model.links.map((l) => <PhoneLink key={l.key} link={l} />)}
        </div>
      )}
    </section>
  );
}

function PaneLink({ link }) {
  if (link.href) {
    return (
      <a className="btn btn-secondary btn-sm" href={link.href} target="_blank" rel="noopener noreferrer">
        {link.label}<Icon name="external" size={12} />
      </a>
    );
  }
  return <Link className="btn btn-secondary btn-sm" to={link.to}>{link.label}<Icon name="external" size={12} /></Link>;
}

export function ContextPane({ model }) {
  const m = model && model.money;
  return (
    <div className="card card-flush scroll-thin ib-pane ib-ctx-pane">
      <div className="card-head">
        <h3>Context</h3>
        {model && <StatusChip kind={model.chip.kind}>{model.chip.label}</StatusChip>}
      </div>
      {!model && <div className="ib-dnote">Pick someone from the list.</div>}
      {model && (
        <>
          {model.hold && <div className="ib-hold ib-hold-pane" role="note">{model.hold}</div>}
          <div className="ib-cp-type">
            {model.type}
            {model.guests !== null && <span className="ib-cp-guests">{` · ${model.guests} guests`}</span>}
          </div>
          {model.rows.map((r) => (
            <div key={r.key} className="ib-cp-row">
              <span className="ib-cp-label">{r.label}</span>
              <span className="ib-cp-value">
                {r.value}
                {r.chip && <StatusChip kind={r.chip.kind}>{r.chip.label}</StatusChip>}
              </span>
            </div>
          ))}
          {m && (
            <div className="ib-cp-money">
              <div className="ib-cp-mrow"><span>Total</span><span className="ib-cp-mval">{m.total}</span></div>
              <div className="ib-cp-mrow"><span>Paid</span><span className="ib-cp-mval">{m.paid}</span></div>
              <div className={m.settled ? 'ib-cp-mrow ib-cp-bal ib-bal-settled' : 'ib-cp-mrow ib-cp-bal ib-bal-open'}>
                <span>Balance {m.sub && <span className="ib-cp-balsub">{m.sub}</span>}</span>
                <span className="ib-cp-mval">{m.balance}</span>
              </div>
            </div>
          )}
          {model.showNoQuote && <div className="ib-cp-none">{NO_QUOTE_TEXT}</div>}
          {model.links.length > 0 && (
            <div className="ib-cp-links">
              {model.links.map((l) => <PaneLink key={l.key} link={l} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
