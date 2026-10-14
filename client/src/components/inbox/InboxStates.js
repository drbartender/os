import React from 'react';
import Icon from '../adminos/Icon';
import { lastGoodLine } from './inboxFormat';

// The list's three states (spec 4.7): loading (first load only), empty, and
// the error card, which says outright that it is not an empty inbox.

const SKELETONS = [['62%', '44%'], ['70%', '38%'], ['55%', '46%'], ['66%', '40%']];
const EMPTY_TITLE = "Nobody's waiting";
const EMPTY_BODY = 'Everyone has a reply. New messages land here the moment a feed delivers them.';

export function ListLoading({ variant = 'phone' }) {
  if (variant === 'desktop') {
    return (
      <div role="status" aria-label="Loading the inbox">
        <div className="ib-skel-note">first sync · fetching the inbox</div>
        {SKELETONS.map(([w1, w2]) => (
          <div key={w1} className="ib-dskel" aria-hidden="true">
            <span className="ib-dskel-icon" />
            <span className="ib-dskel-bars">
              <span className="ib-dskel-bar" style={{ width: w1 }} />
              <span className="ib-dskel-bar ib-dskel-thin" style={{ width: w2 }} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading the inbox">
      <div className="m-skel-note">first sync · fetching the inbox</div>
      {SKELETONS.map(([w1, w2]) => (
        <div key={w1} className="m-card m-card-skel" aria-hidden="true">
          <span className="m-skel-rail" />
          <span className="m-card-body ib-skel-body">
            <span className="m-skel-bar" style={{ width: w1 }} />
            <span className="m-skel-bar thin" style={{ width: w2 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ListEmpty({ variant = 'phone' }) {
  return (
    <div className={variant === 'desktop' ? 'ib-dempty' : 'm-empty ok'}>
      <Icon name="check" size={28} />
      <div className={variant === 'desktop' ? 'ib-dempty-title' : 'm-empty-title'}>{EMPTY_TITLE}</div>
      <div className={variant === 'desktop' ? 'ib-dempty-body' : 'm-empty-body'}>{EMPTY_BODY}</div>
    </div>
  );
}

// The red-bordered error card. The list's copy says outright that it is not
// an empty inbox; an item that fails to load gets the same card (spec 4.2).
// The alert is the message alone: Retry turning to Retrying and back never
// re-announces the card.
export function ErrorCard({ title, body, last, onRetry, pending, variant = 'phone' }) {
  return (
    <>
      <div className={variant === 'desktop' ? 'ib-error ib-error-pane' : 'ib-error'}>
        <span className="ib-error-icon"><Icon name="alert" size={28} /></span>
        <div className="ib-error-msg" role="alert">
          <div className="ib-error-title">{title}</div>
          <div className="ib-error-body">{body}</div>
          {last && <div className="ib-error-last">{last}</div>}
        </div>
        <button
          type="button"
          className={variant === 'desktop' ? 'btn btn-primary ib-error-retry' : 'm-retry-btn ib-error-retry'}
          onClick={onRetry}
          disabled={pending}
        >
          {pending ? 'Retrying' : 'Retry'}
        </button>
      </div>
      <div className="ib-error-hint">Check your connection or try again.</div>
    </>
  );
}

export function ListError({ lastGood, onRetry, pending, variant = 'phone' }) {
  return (
    <ErrorCard
      variant={variant}
      title="Couldn't load the inbox"
      body="This is not an empty inbox. People may still be waiting; the list just didn't arrive."
      last={lastGoodLine(lastGood)}
      onRetry={onRetry}
      pending={pending}
    />
  );
}

// An opened item's first read (spec 4.2 Loading: a skeleton).
export function ItemLoading({ variant = 'phone' }) {
  const bar = variant === 'desktop' ? 'ib-dskel-bar' : 'm-skel-bar';
  return (
    <div className={variant === 'desktop' ? 'ib-item-skel ib-item-skel-desk' : 'ib-item-skel'} role="status" aria-label="Loading the conversation">
      <span className={bar} style={{ width: '38%' }} />
      <span className={bar} style={{ width: '64%' }} />
      <span className={bar} style={{ width: '52%' }} />
    </div>
  );
}

// A key that no longer resolves (spec 4.2 Gone). With a hint the page has
// already followed it; this is the no-hint case.
export function ItemGone({ onBack, variant = 'phone' }) {
  return (
    <div className={variant === 'desktop' ? 'ib-dempty' : 'm-empty'}>
      <div className={variant === 'desktop' ? 'ib-dempty-title' : 'm-empty-title'}>This conversation moved</div>
      <div className={variant === 'desktop' ? 'ib-dempty-body' : 'm-empty-body'}>It may belong to another person now. Find them in the list.</div>
      <button type="button" className={variant === 'desktop' ? 'btn btn-secondary' : 'm-retry-btn'} onClick={onBack}>Back to Inbox</button>
    </div>
  );
}
