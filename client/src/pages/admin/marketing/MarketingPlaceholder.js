import React from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Placeholder for the Marketing tabs not built yet: Overview and Sent, both
 * phase 3 (the plan's lane map assigns them to mkt-h). Compose shipped in
 * phase 2 and mounts the real ComposeTab, so it has no entry here.
 *
 * Each names the phase that delivers it, because a bare "coming soon" on a tab
 * bar reads as "next week" and sets a wrong expectation about the send.
 *
 * One component keyed by route rather than near-identical files, and a
 * default export because React.lazy resolves default exports only.
 */
const CONTENT = {
  overview: {
    title: 'Overview',
    phase: 3,
    blurb: 'How the last campaign did, who replied, and what to send next.',
  },
  sent: {
    title: 'Sent',
    phase: 3,
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
