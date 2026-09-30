import React, { useState } from 'react';
import { resolveGratuityDisplayLabel } from '../../../utils/gratuityLabels';
import { getPackageBySlug } from '../../../data/packages';
import { fmt } from './helpers';
import styles from './styles';
import AgreementText from './AgreementText';
import PaymentTermsBox from './PaymentTermsBox';
import { agreementForVersion } from '../../../data/eventServicesAgreement';

// Whole dollars print bare ($575), anything else to the cent ($5.75).
const rate = (n) => (Number.isInteger(Number(n)) ? `$${Number(n).toLocaleString('en-US')}` : fmt(n));

// The figure is the PACKAGE line of an on-site extension. The bar's quote also
// carries gratuity, over-included bartenders and timed add-ons for the added
// time (Section 8.1), and on a no-tip-jar booking gratuity alone is $50 per
// staffer per hour, so the line says what rides on top rather than reading as
// the whole price.
function addedTimeLine(t, guestCount) {
  let basis = '';
  if (t.per_guest_rate !== null && t.per_guest_rate !== undefined) {
    const atMinimum = Number(t.billed_guests) > Number(guestCount);
    basis = ` (${rate(t.per_guest_rate)} per guest, ${t.billed_guests} ${atMinimum ? 'guest minimum' : 'guests'})`;
  }
  return `Added time on the day: ${rate(t.hourly)} per hour for the package${basis}, `
    + 'plus gratuity and any extra bartenders or timed add-ons, billed in 30 minute steps.';
}

export default function ProposalPricingBreakdown({
  proposal,
  includes,
  lineItems,
  snapshot,
  balanceAmount,
  balanceDueDate,
  fullPaymentRequired,
  paid,
  settling,
  pendingPayment = false,
  showSignAndPay,
  showPayOnly,
  showOptionsEntry,
  onOpenOptions,
  entryRef,
}) {
  const [termsExpanded, setTermsExpanded] = useState(false);
  // A signed proposal shows the agreement version its client signed; an
  // unsigned one shows the version they would sign now.
  const agreement = agreementForVersion(proposal.client_signature_document_version);
  // The added-time rate Section 8.1 points the client at. Server-computed by
  // the function the on-site extension bills with; null when there is nothing
  // to state (a class, no package). Hidden under an agreement version that
  // states its own rate.
  const addedTime = agreement.additionalTimeOnProposal ? proposal.additional_time : null;
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
            {/* Settling: the row is unconfirmed (spec 2026-08-28 decision 1).
                The contract lines stay, the webhook never rewrites those; the
                Gratuity line and the Total are what the webhook writes, so
                neither renders until it has. */}
            {lineItems.filter((item) => !(settling && item.gratuity)).map((item, i) => (
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
                {settling ? (pendingPayment ? 'Pending' : '—') : snapshot ? fmt(snapshot.total) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
        {/* P4 (fix #8): name the hosted minimum that bound. Legacy snapshots
            without floor_reason render nothing (null-guard). */}
        {snapshot?.floor_reason === 'guest_min' && (
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Small event minimum applied (billed as {snapshot.billed_guests} guests).
          </p>
        )}
        {snapshot?.floor_reason === 'dollar_min' && (
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Hosted minimum $550 applied.
          </p>
        )}
        {addedTime && (
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {addedTimeLine(addedTime, proposal.guest_count)}
          </p>
        )}
        {/* The ONE way into the options ladder. Deliberately here rather than at
            the bottom of the page: the old entry button sat below everything, so
            browsing scrolled the signature out of view with nothing pulling the
            client back, which is the conversion leak this redesign exists to
            fix. Gated on options_available (the server's cheap predicate for
            "the switch endpoint would accept this proposal") so it can never
            open into an apology. */}
        {showOptionsEntry && (
          <button type="button" className="oo-entry" onClick={onOpenOptions} ref={entryRef}>
            <span className="oo-entry-head">
              Want us to handle more of this? See every option, priced for your night →
            </span>
            <span className="oo-entry-sub">
              From bar service only up to a fully stocked bar: switch any time before you sign.
            </span>
          </button>
        )}
      </div>

      {/* ── Service Agreement (collapsed-with-fadeout by default) ── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Service Agreement</h2>
        <div className={`proposal-terms-scroll ${termsExpanded ? 'is-expanded' : 'is-collapsed'}`}>
          <AgreementText markdown={agreement.markdown} />
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
        <PaymentTermsBox
          state={paid}
          settling={settling}
          pending={!!pendingPayment}
          fullPaymentRequired={fullPaymentRequired}
          snapshotTotal={snapshot ? snapshot.total : null}
          balanceAmount={balanceAmount}
          balanceDueDate={balanceDueDate}
        />

        {/* Potion Planner Link */}
        {proposal.drink_plan_token && (
          <div style={{ background: 'linear-gradient(180deg, var(--paper), var(--card-bg))', border: '2px solid var(--brass)', borderRadius: '10px', padding: '1.5rem', textAlign: 'center', marginTop: '1.5rem' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 400, letterSpacing: '0.015em' }}>
              Start Planning Your Bar
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: '0 0 1rem', lineHeight: 1.5 }}>
              Explore cocktails, discover flavors, and tell us what kind of bar experience
              you're imagining. Nothing is final, just have fun with it.
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
