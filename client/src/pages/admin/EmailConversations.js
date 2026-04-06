import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';

export default function EmailConversations() {
  const [threads, setThreads] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);

  const fetchThreads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/email-marketing/conversations');
      setThreads(res.data);
    } catch (err) {
      console.error('Error fetching conversations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchThreads(); }, [fetchThreads]);

  const selectThread = async (leadId) => {
    setSelectedLeadId(leadId);
    try {
      const res = await api.get(`/email-marketing/conversations/${leadId}`);
      setMessages(res.data);
    } catch (err) {
      console.error('Error fetching thread:', err);
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !selectedLeadId) return;
    setReplying(true);
    try {
      await api.post(`/email-marketing/conversations/${selectedLeadId}/reply`, {
        body_text: replyText,
        body_html: `<p>${replyText.replace(/\n/g, '<br/>')}</p>`,
      });
      setReplyText('');
      selectThread(selectedLeadId);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to send reply.');
    } finally {
      setReplying(false);
    }
  };

  const handleMarkReplied = async (leadId) => {
    const notes = window.prompt('Add a note about the reply (optional):');
    try {
      await api.post(`/email-marketing/conversations/${leadId}/mark-replied`, { notes });
      fetchThreads();
      if (selectedLeadId === leadId) selectThread(leadId);
    } catch (err) {
      console.error('Error marking replied:', err);
    }
  };

  const selectedThread = threads.find(t => t.lead_id === selectedLeadId);

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;

  return (
    <div className="em-conversations">
      {threads.length === 0 ? (
        <div className="em-empty">
          No conversations yet. Conversations appear when you send replies to leads or mark external replies.
        </div>
      ) : (
        <div className="em-convo-layout">
          {/* Thread List */}
          <div className="em-convo-list">
            {threads.map(thread => (
              <div
                key={thread.lead_id}
                className={`em-convo-item ${selectedLeadId === thread.lead_id ? 'em-convo-item-active' : ''}`}
                onClick={() => selectThread(thread.lead_id)}
              >
                <div className="em-convo-item-header">
                  <strong>{thread.name}</strong>
                  {parseInt(thread.unread_count, 10) > 0 && (
                    <span className="em-unread-badge">{thread.unread_count}</span>
                  )}
                </div>
                <div className="em-convo-item-email">{thread.email}</div>
                <div className="em-convo-item-time">
                  {thread.last_message_at && new Date(thread.last_message_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>

          {/* Message Thread */}
          <div className="em-convo-thread">
            {!selectedLeadId ? (
              <div className="em-convo-placeholder">Select a conversation to view messages.</div>
            ) : (
              <>
                <div className="em-convo-thread-header">
                  <h3>{selectedThread?.name}</h3>
                  <span>{selectedThread?.email}</span>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleMarkReplied(selectedLeadId)}>
                    Mark Reply Received
                  </button>
                </div>

                <div className="em-convo-messages">
                  {messages.map(msg => (
                    <div key={msg.id} className={`em-message em-message-${msg.direction}`}>
                      <div className="em-message-header">
                        <span className="em-message-direction">
                          {msg.direction === 'outbound' ? 'You' : 'Lead'}
                        </span>
                        <span className="em-message-time">{new Date(msg.created_at).toLocaleString()}</span>
                      </div>
                      {msg.subject && <div className="em-message-subject">{msg.subject}</div>}
                      <div className="em-message-body">{msg.body_text || '(HTML content)'}</div>
                    </div>
                  ))}
                </div>

                <div className="em-convo-reply">
                  <textarea
                    className="form-input"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="Type your reply..."
                    rows={3}
                  />
                  <button className="btn btn-primary" onClick={handleReply} disabled={replying || !replyText.trim()}>
                    {replying ? 'Sending...' : 'Send Reply'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
