import React, { useState } from 'react';
import { resolveGratuityDisplayLabel } from '../../../utils/gratuityLabels';
import { getPackageBySlug } from '../../../data/packages';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';
import AgreementText from './AgreementText';
import { EVENT_SERVICES_AGREEMENT } from '../../../data/eventServicesAgreement';

export default function ProposalPricingBreakdown({
  proposal,
  includes,
  lineItems,
  snapshot,
  balanceAmount,
  balanceDueDate,
  fullPaymentRequired,
  showSignAndPay,
  showPayOnly,
}) {
  const [termsExpanded, setTermsExpanded] = useState(false);
  return (
    <>
      {/* Package */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>{proposal.package_name}</h2>
        {(() => {
          const detail = getPackageBySlug(proposal.package_slug);
          if (detail) {
            return (
              <>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', marginBottom: '1rem', fontStyle: 'italic' }}>{detail.description}</p>
                {detail.sections.map((section, si) => (
                  <div key={si} style={{ marginBottom: '0.75rem' }}>
                    <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '0.78rem', fontWeight: 400, color: 'var(--brass)', margin: '0 0 0.4rem 0', textTransform: 'uppercase', letterSpacing: '0.18em' }}>{section.heading}</h3>
                    <ul style={styles.includesList}>
                      {section.items.map((item, i) => (
                        <li key={i} style={styles.includesItem}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.5rem', fontStyle: 'italic' }}>{detail.serviceIncludes}</p>
              </>
            );
          }
          return includes.length > 0 ? (
            <ul style={styles.includesList}>
              {includes.map((item, i) => (
                <li key={i} style={styles.includesItem}>{item}</li>
              ))}
            </ul>
          ) : null;
        })()}
      </div>

      {/* Pricing */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Pricing</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {lineItems.map((item, i) => (
              <tr key={i} style={{ borderBottom: '1px dotted rgba(28,22,16,0.22)' }}>
                <td style={{ padding: '0.6rem 0', color: 'var(--deep-brown)', fontSize: '0.95rem' }}>
                  {resolveGratuityDisplayLabel(item.label, snapshot)}
                </td>
                <td style={{ padding: '0.6rem 0', textAlign: 'right', color: Number(item.amount) < 0 ? 'var(--sage)' : 'var(--deep-brown)', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {Number(item.amount) < 0 ? `−${fmt(Math.abs(item.amount))}` : fmt(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--deep-brown)' }}>
              <td style={{ padding: '0.85rem 0 0', fontWeight: 400, fontSize: '1.1rem', color: 'var(--deep-brown)', fontFamily: 'var(--font-display)', letterSpacing: '0.015em' }}>
                Total
              </td>
              <td style={{ padding: '0.85rem 0 0', textAlign: 'right', fontWeight: 400, fontSize: '1.35rem', color: 'var(--deep-brown)', fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}>
                {snapshot ? fmt(snapshot.total) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Service Agreement (collapsed-with-fadeout by default) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Service Agreement</h2>
        <div className={`proposal-terms-scroll ${termsExpanded ? 'is-expanded' : 'is-collapsed'}`}>
          <AgreementText markdown={EVENT_SERVICES_AGREEMENT.markdown} />
        </div>
        <button
          type="button"
          className="proposal-terms-toggle"
          onClick={() => setTermsExpanded((v) => !v)}
        >
          {termsExpanded ? 'Hide details' : 'Read full agreement →'}
        </button>
      </div>

      {/* ── Payment Summary (always visible) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Payment Terms</h2>
        <div style={styles.paymentSummary}>
          {fullPaymentRequired ? (
            <>
              <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
                <span style={styles.paymentLabel}>Full Payment Due</span>
                <span style={styles.paymentValue}>{snapshot ? fmt(snapshot.total) : '—'}</span>
              </div>
              <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                This is the complete cost for your event. No separate deposit, no balance due later.
              </p>
            </>
          ) : (
            <>
              <div style={styles.paymentRow}>
                <span style={styles.paymentLabel}>Deposit Due at Signing</span>
                <span style={styles.paymentValue}>{fmt(DEPOSIT_DOLLARS)}</span>
              </div>
              <div style={styles.paymentRow}>
                <span style={styles.paymentLabel}>Remaining Balance</span>
                <span style={styles.paymentValue}>{fmt(balanceAmount)}</span>
              </div>
              <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
                <span style={styles.paymentLabel}>Balance Due By</span>
                <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
              </div>
            </>
          )}
        </div>

        {/* Potion Planner Link */}
        {proposal.drink_plan_token && (
          <div style={{ background: 'linear-gradient(180deg, var(--paper), var(--card-bg))', border: '2px solid var(--brass)', borderRadius: '10px', padding: '1.5rem', textAlign: 'center', marginTop: '1.5rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 400, letterSpacing: '0.015em' }}>
              Start Planning Your Bar
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: '0 0 1rem', lineHeight: 1.5 }}>
              Explore cocktails, discover flavors, and tell us what kind of bar experience
              you're imagining. Nothing is final — just have fun with it.
            </p>
            <a
              href={`/plan/${proposal.drink_plan_token}`}
              className="btn btn-primary"
              style={{ display: 'inline-block' }}
            >
              Open the Potion Planner
            </a>
          </div>
        )}

        {/* CTA button — mobile-only; desktop has the sticky pay rail */}
        {(showSignAndPay || showPayOnly) && (
          <button
            type="button"
            onClick={() => document.getElementById('sign-pay-section')?.scrollIntoView({ behavior: 'smooth' })}
            className="btn btn-primary proposal-scroll-cta-button"
            style={{ ...styles.ctaButton, background: undefined, color: undefined, fontFamily: undefined, fontWeight: undefined, letterSpacing: undefined }}
          >
            {showSignAndPay ? 'Sign & Secure Your Date' : 'Complete Your Payment'}
          </button>
        )}
      </div>
    </>
  );
}
