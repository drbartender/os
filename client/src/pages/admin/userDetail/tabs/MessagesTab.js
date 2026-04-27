import React from 'react';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';

export default function MessagesTab({ loading, messages, sending, body, setBody, type, setType, result, send, recipient }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      <div className="card">
        <div className="card-head"><h3>Message history</h3><span className="k">{messages.length}</span></div>
        <div className="card-body vstack" style={{ gap: 10 }}>
          {loading ? (
            <div className="muted tiny">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="muted tiny">No messages sent to this staff member yet.</div>
          ) : (
            messages.map(m => (
              <div
                key={m.id}
                style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 3, border: '1px solid var(--line-1)' }}
              >
                <div className="hstack" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
                  <StatusChip kind={m.status === 'sent' ? 'ok' : 'danger'}>{m.status}</StatusChip>
                  <StatusChip kind={m.message_type === 'invitation' ? 'info' : m.message_type === 'reminder' ? 'warn' : 'neutral'}>
                    {m.message_type}
                  </StatusChip>
                  {m.shift_event_type_label && (
                    <span className="tiny muted">for {m.shift_event_type_label}</span>
                  )}
                  <div className="spacer" style={{ flex: 1 }} />
                  <span className="tiny muted">
                    {m.created_at ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{m.body}</div>
                {m.error_message && (
                  <div className="tiny" style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)', marginTop: 4 }}>
                    Error: {m.error_message}
                  </div>
                )}
                {m.sender_email && (
                  <div className="tiny muted" style={{ marginTop: 4 }}>Sent by {m.sender_email}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Send SMS</h3></div>
          <div className="card-body">
            <form onSubmit={send} className="vstack" style={{ gap: 10 }}>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Type</div>
                <div className="seg" style={{ width: '100%' }}>
                  {['general', 'reminder', 'announcement'].map(t => (
                    <button
                      key={t}
                      type="button"
                      className={type === t ? 'active' : ''}
                      onClick={() => setType(t)}
                      style={{ flex: 1, textTransform: 'capitalize' }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Message</div>
                <textarea
                  className="input"
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={1600}
                  placeholder={`Message to ${recipient}…`}
                  style={{ width: '100%', minHeight: 80, padding: 8 }}
                />
                <div className="tiny muted" style={{ textAlign: 'right', marginTop: 2 }}>{body.length}/1600</div>
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={sending || !body.trim()}
              >
                <Icon name="send" size={11} />{sending ? 'Sending…' : 'Send SMS'}
              </button>
            </form>
            {result && (
              <div
                className="tiny"
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 3,
                  border: result.error ? '1px solid hsl(var(--danger-h) var(--danger-s) 50% / 0.4)' : '1px solid hsl(var(--ok-h) var(--ok-s) 50% / 0.4)',
                  background: result.error ? 'hsl(var(--danger-h) var(--danger-s) 50% / 0.08)' : 'hsl(var(--ok-h) var(--ok-s) 50% / 0.08)',
                  color: result.error ? 'hsl(var(--danger-h) var(--danger-s) 65%)' : 'hsl(var(--ok-h) var(--ok-s) 52%)',
                }}
              >
                {result.error || (result.sent > 0 ? 'Message sent.' : 'Failed to send.')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
