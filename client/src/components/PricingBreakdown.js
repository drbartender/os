import React from 'react';

export default function PricingBreakdown({ snapshot, compact = false }) {
  if (!snapshot || !snapshot.breakdown) return null;

  const formatCurrency = (amount) =>
    `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={{ width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {snapshot.breakdown.map((item, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--cream-dark, #e8e0d4)' }}>
              <td style={{ padding: compact ? '0.4rem 0' : '0.6rem 0', color: 'var(--deep-brown, #3a2218)' }}>
                {item.label}
              </td>
              <td style={{
                padding: compact ? '0.4rem 0' : '0.6rem 0',
                textAlign: 'right',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                color: 'var(--deep-brown, #3a2218)'
              }}>
                {formatCurrency(item.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--deep-brown, #3a2218)' }}>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--deep-brown, #3a2218)'
            }}>
              Total
            </td>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              textAlign: 'right',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--deep-brown, #3a2218)'
            }}>
              {formatCurrency(snapshot.total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
