import React from 'react';
import PublicLayout from '../../../components/PublicLayout';

// Shared shell for /privacy and /terms so the two pages cannot drift apart
// visually. Matches the other website pages: PublicLayout wrapper, press
// pagehero, narrow prose column.
export default function LegalLayout({ eyebrow, title, intro, lastUpdated, children }) {
  return (
    <PublicLayout>
      <section className="ws-press-pagehero">
        <div className="ws-wrap">
          <div className="ornament" aria-hidden="true">⚗</div>
          <div className="ws-press-eyebrow">{eyebrow}</div>
          <h1 className="ws-press-pagehero-title">{title}</h1>
          <p className="ws-press-pagehero-sub">{intro}</p>
        </div>
      </section>

      <section className="ws-section">
        <div className="ws-wrap narrow">
          <div className="ws-legal-updated">Last updated: {lastUpdated}</div>
          <div className="ws-legal-prose">{children}</div>
        </div>
      </section>
    </PublicLayout>
  );
}
