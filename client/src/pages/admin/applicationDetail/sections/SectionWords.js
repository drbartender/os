import React from 'react';

const Block = ({ label, children }) => (
  <div>
    <div className="tiny muted" style={{
      textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4,
    }}>{label}</div>
    <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
      {children}
    </div>
  </div>
);

// Three free-text fields the applicant filled in. why_dr_bartender is given
// quote treatment with the display font. Customer service approach + extra
// info appear below dividers when present.
export default function SectionWords({ a }) {
  return (
    <div className="card">
      <div className="card-head"><h3>In their own words</h3></div>
      <div className="card-body vstack" style={{ gap: 14 }}>
        <Block label="Why Dr. Bartender?">
          {a.why_dr_bartender
            ? <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
                "{a.why_dr_bartender}"
              </span>
            : <span className="muted">Not provided.</span>}
        </Block>
        {a.customer_service_approach && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <Block label="Customer service approach">{a.customer_service_approach}</Block>
          </div>
        )}
        {a.additional_info && (
          <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12 }}>
            <Block label="Additional info">{a.additional_info}</Block>
          </div>
        )}
      </div>
    </div>
  );
}
