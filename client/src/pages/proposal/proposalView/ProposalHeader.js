import React from 'react';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { formatTime, calcEndTime } from './helpers';
import styles from './styles';

export default function ProposalHeader({ proposal, bartenders }) {
  const formatDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.brand}>Dr. Bartender</h1>
        <p style={styles.tagline}>Your Event Proposal</p>
      </div>

      {/* Event Details */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Your {getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })} proposal</h2>
        <div style={styles.detailGrid}>
          {proposal.event_type && (
            <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
              <span style={styles.detailLabel}>Event Type</span>
              <span style={styles.detailValue}>{getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })}</span>
            </div>
          )}
          {proposal.event_date && (
            <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
              <span style={styles.detailLabel}>Date</span>
              <span style={styles.detailValue}>{formatDate(proposal.event_date)}</span>
            </div>
          )}
          {proposal.event_start_time && (
            <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
              <span style={styles.detailLabel}>Service Time</span>
              <span style={styles.detailValue}>
                {formatTime(proposal.event_start_time)} – {calcEndTime(proposal.event_start_time, proposal.event_duration_hours)}
              </span>
            </div>
          )}
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
    </>
  );
}
