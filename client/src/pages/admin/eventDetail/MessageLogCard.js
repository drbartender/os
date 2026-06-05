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
            {rows.map((m) => (
              <li key={m.id} className="message-log-row">
                <span className={`message-log-channel ${m.channel}`}>
                  {m.channel === 'sms' ? 'Text' : 'Email'}
                </span>
                <span className="message-log-label">{messageTypeLabel(m.message_type, m.subject)}</span>
                <span className="message-log-recipient tiny muted">{m.recipient}</span>
                <span className="message-log-time tiny muted">{timeLabel(m.created_at)}</span>
                <span
                  className={`message-log-status ${m.status === 'failed' ? 'danger' : 'ok'}`}
                  title={m.status === 'failed' ? (m.error_message || 'Failed') : 'Sent'}
                >
                  {m.status === 'failed' ? 'Failed' : 'Sent'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
