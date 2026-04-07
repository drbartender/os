import React from 'react';
import PublicLayout from '../../components/PublicLayout';
import QuoteWizard from './QuoteWizard';

export default function QuotePage() {
  return (
    <PublicLayout>
      <div className="ws-section" style={{ paddingTop: '2rem' }}>
        <div className="ws-section-heading">
          <h2>Get Your Instant Quote</h2>
          <p className="ws-section-sub">
            Answer a few questions and see your price immediately — no waiting, no commitment.
          </p>
        </div>
      </div>
      <QuoteWizard />
    </PublicLayout>
  );
}
