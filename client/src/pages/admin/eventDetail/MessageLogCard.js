import React from 'react';
import { messageTypeLabel } from '../../../utils/messageTypes';

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function MessageLogCard({ messages }) {
  const rows = Array.isArray(messages) ? messages : [];
  return (
    <div className="card">
      <div className="card-head"><h3>Messages</h3></div>
      <div className="card-body">
        {rows.length === 0 ? (
          <div className="muted tiny">No messages sent yet.</div>
        ) : (
          <ul className="message-log-list">
            {rows.map((m) => {
              const label = messageTypeLabel(m.message_type, m.subject);
              const detailId = `message-log-detail-${m.id}`;
              return (
                <li key={m.id} className="message-log-row" tabIndex={0} aria-describedby={detailId}>
                  <span className={`message-log-channel ${m.channel}`}>
                    {m.channel === 'sms' ? 'Text' : 'Email'}
                  </span>
                  <span className="message-log-label">{label}</span>
                  <span className="message-log-recipient tiny muted">{m.recipient}</span>
                  <span className="message-log-time tiny muted">{timeLabel(m.created_at)}</span>
                  <span className={`message-log-status ${m.status === 'failed' ? 'danger' : 'ok'}`}>
                    {m.status === 'failed' ? 'Failed' : 'Sent'}
                  </span>
                  <span className="message-log-detail" role="tooltip" id={detailId}>
                    {m.subject ? (
                      <span className="message-log-detail-text">{m.subject}</span>
                    ) : (
                      <span className="message-log-detail-text muted">No preview saved for this message.</span>
                    )}
                    {m.status === 'failed' && m.error_message ? (
                      <span className="message-log-detail-error">Failed: {m.error_message}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
