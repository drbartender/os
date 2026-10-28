// FeedsLine (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React from 'react';
import { feedItems } from './inboxFormat';

// The feeds line that closes the list (spec 4.6): when each source last
// delivered, a quiet dot at 48 hours (information, not an alarm), and the AI
// read's status when it is not on. While the list has not loaded, the feeds
// are unknown and the line says so instead of guessing.
export default function FeedsLine({ feeds, ai, nowMs, failed = false, variant = 'phone' }) {
  const items = failed
    ? [{ key: 'unknown', text: 'Feed status unknown until the inbox loads', quiet: true, title: '' }]
    : feedItems(feeds, ai, nowMs);
  return (
    <div className={variant === 'desktop' ? 'ib-feeds ib-feeds-pane' : 'ib-feeds'}>
      <span className="ib-feeds-label">Feeds</span>
      {items.map((f, i) => (
        <span key={f.key} className={f.quiet ? 'ib-feed ib-feed-quiet' : 'ib-feed'} title={f.title || undefined}>
          {f.quiet && <span className="ib-feed-dot" aria-hidden="true" />}
          <span>{f.text}</span>
          {i < items.length - 1 && <span className="ib-feed-sep" aria-hidden="true">·</span>}
        </span>
      ))}
    </div>
  );
}
