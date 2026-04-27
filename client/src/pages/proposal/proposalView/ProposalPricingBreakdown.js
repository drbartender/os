import React from 'react';
import { getPackageBySlug } from '../../../data/packages';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';

export default function ProposalPricingBreakdown({
  proposal,
  includes,
  lineItems,
  snapshot,
  balanceAmount,
  balanceDueDate,
  showSignAndPay,
  showPayOnly,
}) {
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
                <p style={{ color: '#6b4226', fontSize: '0.95rem', marginBottom: '1rem', fontStyle: 'italic' }}>{detail.description}</p>
                {detail.sections.map((section, si) => (
                  <div key={si} style={{ marginBottom: '0.75rem' }}>
                    <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#4a2c17', margin: '0 0 0.25rem 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{section.heading}</h3>
                    <ul style={styles.includesList}>
                      {section.items.map((item, i) => (
                        <li key={i} style={styles.includesItem}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p style={{ color: '#6b4226', fontSize: '0.85rem', marginTop: '0.5rem', fontStyle: 'italic' }}>{detail.serviceIncludes}</p>
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
              <tr key={i} style={{ borderBottom: '1px solid #ede3d3' }}>
                <td style={{ padding: '0.55rem 0', color: '#3a2218', fontSize: '0.95rem' }}>
                  {item.label}
                </td>
                <td style={{ padding: '0.55rem 0', textAlign: 'right', color: Number(item.amount) < 0 ? '#2d6a4f' : '#3a2218', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {Number(item.amount) < 0 ? `-${fmt(Math.abs(item.amount))}` : fmt(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid #3a2218' }}>
              <td style={{ padding: '0.75rem 0', fontWeight: 700, fontSize: '1.1rem', color: '#3a2218', fontFamily: 'Georgia, "Times New Roman", serif' }}>
                Total
              </td>
              <td style={{ padding: '0.75rem 0', textAlign: 'right', fontWeight: 700, fontSize: '1.1rem', color: '#3a2218', fontFamily: 'Georgia, "Times New Roman", serif' }}>
                {snapshot ? fmt(snapshot.total) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Terms & Conditions (always visible) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Standard Terms and Conditions</h2>
        <div style={styles.contractScroll}>
          <p style={styles.contractText}>
            This agreement is made between <strong>Dr. Bartender, LLC</strong> ("Dr. Bartender") and the Client. These terms govern the provision of bartending services and outline the responsibilities of both parties.
          </p>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>2. Termination and Cancellation</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}><strong>Client Cancellation:</strong> If canceled within 30 days of the event, the full contract amount is due. Outside of 30 days, only the deposit is non-refundable.</li>
            <li style={styles.contractListItem}><strong>Dr. Bartender Cancellation:</strong> If Dr. Bartender cancels, the Client will receive a full refund of any paid amount, including the deposit.</li>
          </ul>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>3. Dr. Bartender's Duties</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}>Perform all services professionally and safely.</li>
            <li style={styles.contractListItem}>Staff events based on the anticipated number of guests.</li>
            <li style={styles.contractListItem}>Clean and remove all equipment brought to the event.</li>
            <li style={styles.contractListItem}>Maintain necessary permits and liquor liability insurance.</li>
            <li style={styles.contractListItem}>Act as the sole provider of bartending services unless otherwise agreed upon.</li>
          </ul>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>4. Client's Duties</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}>Provide prompt payment as outlined in the Event-Specific Agreement.</li>
            <li style={styles.contractListItem}>Supply an accurate guest count no later than 14 days before the event.</li>
            <li style={styles.contractListItem}>Specify whether Dr. Bartender will supply alcohol. If the Client provides alcohol, they assume responsibility for quality and quantity.</li>
          </ul>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>5. Insurance</p>
          <p style={styles.contractText}>
            Dr. Bartender maintains liquor liability insurance with a $1,000,000 limit per occurrence and a $2,000,000 aggregate. Proof of insurance is available upon request.
          </p>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>6. Indemnification</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}><strong>Dr. Bartender:</strong> Will indemnify the Client for claims arising directly from its services, excluding incidents caused by event guests.</li>
            <li style={styles.contractListItem}><strong>Client:</strong> Will indemnify Dr. Bartender for incidents arising from willful conduct, error, or negligence by the Client or event guests.</li>
          </ul>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>7. Force Majeure</p>
          <p style={styles.contractText}>
            Neither party is responsible for performance delays due to uncontrollable events (e.g., natural disasters, acts of God). Services will resume once conditions permit.
          </p>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>8. Photography and Social Media</p>
          <p style={styles.contractText}>
            The Client consents to Dr. Bartender photographing the event for promotional use. Dr. Bartender agrees to provide the Client with copies of event photos upon request.
          </p>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>9. Service of Alcohol</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}><strong>Age Verification:</strong> Alcohol will only be served to legally eligible guests with valid identification.</li>
            <li style={styles.contractListItem}><strong>Right to Refuse Service:</strong> Dr. Bartender reserves the right to refuse service to intoxicated or inappropriate guests.</li>
            <li style={styles.contractListItem}><strong>Drink Limit Policy:</strong> All-inclusive packages do not imply unlimited alcohol; limits are set to ensure guest safety.</li>
          </ul>

          <p style={{ ...styles.contractText, fontWeight: 600 }}>10. Miscellaneous Terms</p>
          <ul style={styles.contractList}>
            <li style={styles.contractListItem}><strong>Independent Contractor:</strong> Dr. Bartender acts as an independent contractor.</li>
            <li style={styles.contractListItem}><strong>Jurisdiction:</strong> This agreement is governed by Illinois state law, with any disputes settled in Winnebago County, IL.</li>
            <li style={styles.contractListItem}><strong>Entire Agreement:</strong> These terms represent the entire understanding between the Client and Dr. Bartender.</li>
          </ul>

          <p style={styles.contractText}>
            By signing below, the Client agrees to all terms above and confirms that the event details in this proposal are accurate.
          </p>
        </div>
      </div>

      {/* ── Payment Summary (always visible) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Payment Terms</h2>
        <div style={styles.paymentSummary}>
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
        </div>

        {/* Potion Planner Link */}
        {proposal.drink_plan_token && (
          <div style={{ background: 'linear-gradient(135deg, #f8f0e3, #f3e8d5)', border: '2px solid #c17d3c', borderRadius: '12px', padding: '1.5rem', textAlign: 'center', marginTop: '1.5rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display, Georgia, serif)', color: '#2C1F0E', margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
              Start Planning Your Bar
            </h3>
            <p style={{ color: '#6b4226', fontSize: '0.9rem', margin: '0 0 1rem', lineHeight: 1.5 }}>
              Explore cocktails, discover flavors, and tell us what kind of bar experience
              you're imagining. Nothing is final — just have fun with it.
            </p>
            <a
              href={`/plan/${proposal.drink_plan_token}`}
              style={{ display: 'inline-block', background: '#c17d3c', color: '#fff', padding: '0.65rem 1.75rem', borderRadius: '8px', textDecoration: 'none', fontWeight: 600, fontSize: '1rem' }}
            >
              Open the Potion Planner
            </a>
          </div>
        )}

        {/* CTA button */}
        {(showSignAndPay || showPayOnly) && (
          <button
            onClick={() => document.getElementById('sign-pay-section')?.scrollIntoView({ behavior: 'smooth' })}
            style={styles.ctaButton}
          >
            {showSignAndPay ? 'Sign & Secure Your Date' : 'Complete Your Payment'}
          </button>
        )}
      </div>
    </>
  );
}
