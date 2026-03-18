import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const BASE_URL = process.env.REACT_APP_API_URL
  ? `${process.env.REACT_APP_API_URL}/api`
  : '/api';

const fmt = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${mStr} ${ampm}`;
}

export default function ProposalView() {
  const { token } = useParams();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${BASE_URL}/proposals/t/${token}`)
      .then(res => setProposal(res.data))
      .catch(() => setError('Proposal not found or has expired.'))
      .finally(() => setLoading(false));
  }, [token]);

  const formatDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={{ textAlign: 'center', padding: '4rem' }}>
            <div className="spinner" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={{ textAlign: 'center', padding: '4rem' }}>
            <h2 style={styles.heading}>Oops!</h2>
            <p style={{ color: '#6b4226', marginTop: '0.5rem' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const snapshot = proposal.pricing_snapshot;
  const includes = proposal.package_includes || [];
  const bartenders = snapshot?.staffing?.actual;

  // Build clean line items — name + amount, no math
  const lineItems = [];
  if (snapshot) {
    lineItems.push({ label: proposal.package_name, amount: snapshot.package.base_cost });
    if (snapshot.bar_rental?.total > 0) {
      lineItems.push({ label: 'Bar Rental', amount: snapshot.bar_rental.total });
    }
    if (snapshot.staffing?.total > 0) {
      lineItems.push({ label: 'Additional Staffing', amount: snapshot.staffing.total });
    }
    (snapshot.addons || []).forEach(a => {
      lineItems.push({ label: a.name, amount: a.line_total });
    });
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header / Branding */}
        <div style={styles.header}>
          <h1 style={styles.brand}>Dr. Bartender</h1>
          <p style={styles.tagline}>Your Event Proposal</p>
        </div>

        {/* Event Details */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{proposal.event_name || 'Your Event'}</h2>
          <div style={styles.detailGrid}>
            {proposal.event_date && (
              <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                <span style={styles.detailLabel}>Date</span>
                <span style={styles.detailValue}>{formatDate(proposal.event_date)}</span>
              </div>
            )}
            {proposal.event_start_time && (
              <div style={styles.detailItem}>
                <span style={styles.detailLabel}>Start Time</span>
                <span style={styles.detailValue}>{formatTime(proposal.event_start_time)}</span>
              </div>
            )}
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Duration</span>
              <span style={styles.detailValue}>{proposal.event_duration_hours} hours</span>
            </div>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Guests</span>
              <span style={styles.detailValue}>{proposal.guest_count}</span>
            </div>
            {bartenders != null && (
              <div style={styles.detailItem}>
                <span style={styles.detailLabel}>Bartenders</span>
                <span style={styles.detailValue}>{bartenders}</span>
              </div>
            )}
            {proposal.event_location && (
              <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                <span style={styles.detailLabel}>Location</span>
                <span style={styles.detailValue}>{proposal.event_location}</span>
              </div>
            )}
          </div>
        </div>

        {/* Package */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{proposal.package_name}</h2>
          {includes.length > 0 && (
            <ul style={styles.includesList}>
              {includes.map((item, i) => (
                <li key={i} style={styles.includesItem}>{item}</li>
              ))}
            </ul>
          )}
        </div>

        {/* Pricing — clean name + amount, no math */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Pricing</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #ede3d3' }}>
                  <td style={{ padding: '0.55rem 0', color: '#3a2218', fontSize: '0.95rem' }}>
                    {item.label}
                  </td>
                  <td style={{ padding: '0.55rem 0', textAlign: 'right', color: '#3a2218', fontSize: '0.95rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {fmt(item.amount)}
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

        {/* Footer */}
        <div style={styles.footer}>
          <p style={{ fontSize: '0.85rem', color: '#8b7355' }}>
            Questions? Contact us at contact@drbartender.com or (312) 588-9401
          </p>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #faf5ef 0%, #f5ede0 100%)',
    padding: '2rem 1rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  container: {
    maxWidth: '680px',
    margin: '0 auto',
    background: '#fff',
    borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(58, 34, 24, 0.1)',
    overflow: 'hidden',
  },
  header: {
    textAlign: 'center',
    padding: '2.5rem 2rem 1.5rem',
    borderBottom: '1px solid #e8e0d4',
  },
  brand: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '2rem',
    color: '#3a2218',
    margin: 0,
  },
  tagline: {
    color: '#8b7355',
    marginTop: '0.3rem',
    fontSize: '1rem',
    letterSpacing: '0.05em',
  },
  section: {
    padding: '1.5rem 2rem',
    borderBottom: '1px solid #e8e0d4',
  },
  sectionTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '1.2rem',
    color: '#3a2218',
    marginBottom: '1rem',
  },
  heading: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '1.5rem',
    color: '#3a2218',
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem',
  },
  detailLabel: {
    fontSize: '0.75rem',
    color: '#8b7355',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  detailValue: {
    fontSize: '0.95rem',
    color: '#3a2218',
    fontWeight: 500,
  },
  includesList: {
    margin: 0,
    padding: '0 0 0 1.2rem',
    color: '#6b4226',
  },
  includesItem: {
    fontSize: '0.9rem',
    marginBottom: '0.3rem',
  },
  footer: {
    textAlign: 'center',
    padding: '1.5rem 2rem',
  },
};
