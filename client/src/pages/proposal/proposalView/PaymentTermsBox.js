import React from 'react';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';

const NONE = { kind: 'none', amountPaid: 0, total: 0, remaining: 0, completed: false };

// The "Payment Terms" box under the pricing breakdown. Before payment it
// states the terms (deposit at signing, remainder by the due date). Once the
// ROW is in a paid state it states what happened, from paidState(): never
// "Deposit Due at Signing" on a booking that is paid. While a checkout
// redirect is settling it states nothing numeric at all.
//
// Renders a fragment: the caller's section div wraps this AND the Potion
// Planner link AND the mobile CTA, so this component must not bring its own.
// `state` defaults to the none shape so the component is safe on its own.
export default function PaymentTermsBox({
  state = NONE, settling = false, fullPaymentRequired, snapshotTotal, balanceAmount, balanceDueDate,
}) {
  let rows;
  if (settling) {
    rows = (
      <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Confirming your payment.
      </p>
    );
  } else if (state.kind === 'full') {
    rows = (
      <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
        <span style={styles.paymentLabel}>Paid in full</span>
        <span style={styles.paymentValue}>{fmt(state.amountPaid)}</span>
      </div>
    );
  } else if (state.kind === 'deposit') {
    rows = (
      <>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Deposit paid</span>
          <span style={styles.paymentValue}>{fmt(state.amountPaid)}</span>
        </div>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Remaining balance</span>
          <span style={styles.paymentValue}>{fmt(state.remaining)}</span>
        </div>
        <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
          <span style={styles.paymentLabel}>Balance due by</span>
          <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
        </div>
      </>
    );
  } else if (fullPaymentRequired) {
    rows = (
      <>
        <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
          <span style={styles.paymentLabel}>Full Payment Due</span>
          <span style={styles.paymentValue}>{snapshotTotal != null ? fmt(snapshotTotal) : '—'}</span>
        </div>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          This is the complete cost for your event. No separate deposit, no balance due later.
        </p>
      </>
    );
  } else {
    rows = (
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
    );
  }

  return (
    <>
      <h2 style={styles.sectionTitle}>Payment Terms</h2>
      <div style={styles.paymentSummary}>{rows}</div>
    </>
  );
}
