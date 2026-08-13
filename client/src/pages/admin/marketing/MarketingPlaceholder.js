import React from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Placeholder for the Marketing tabs phase 1 does not build.
 *
 * Each names the phase that delivers it, because a bare "coming soon" on a tab
 * bar reads as "next week" and sets a wrong expectation about the send. Compose
 * and Sent are phase 2 (the send path); Overview is phase 3.
 *
 * One component keyed by route rather than three near-identical files, and a
 * default export because React.lazy resolves default exports only.
 */
const CONTENT = {
  overview: {
    title: 'Overview',
    phase: 3,
    blurb: 'How the last campaign did, who replied, and what to send next.',
  },
  compose: {
    title: 'Compose',
    phase: 2,
    blurb: 'Write a campaign, pick an audience, and preview it before it goes out.',
  },
  sent: {
    title: 'Sent',
    phase: 2,
    blurb: 'Everything that has gone out, who received it, and what came back.',
  },
};

export default function MarketingPlaceholder() {
  const { pathname } = useLocation();
  const key = pathname.split('/').filter(Boolean).pop();
  const c = CONTENT[key] || CONTENT.overview;

  return (
    <div className="mkt-state">
      <h2>{c.title}</h2>
      <p>{c.blurb}</p>
      <p className="mkt-muted">Arriving in phase {c.phase}.</p>
    </div>
  );
}
