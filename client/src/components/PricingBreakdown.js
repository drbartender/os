import React from 'react';

export default function PricingBreakdown({ snapshot, compact = false }) {
  if (!snapshot || !snapshot.breakdown) return null;

  const formatCurrency = (amount) => {
    const num = Number(amount);
    const abs = Math.abs(num);
    const formatted = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return num < 0 ? `-${formatted}` : formatted;
  };

  return (
    <div style={{ width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {snapshot.breakdown.map((item, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line-1)' }}>
              <td style={{ padding: compact ? '0.4rem 0' : '0.6rem 0', color: 'var(--ink-1)' }}>
                {item.label}
              </td>
              <td style={{
                padding: compact ? '0.4rem 0' : '0.6rem 0',
                textAlign: 'right',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                color: Number(item.amount) < 0 ? 'hsl(var(--ok-h) var(--ok-s) 38%)' : 'var(--ink-1)'
              }}>
                {formatCurrency(item.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--line-3)' }}>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--ink-1)'
            }}>
              Total
            </td>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              textAlign: 'right',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--ink-1)'
            }}>
              {formatCurrency(snapshot.total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
