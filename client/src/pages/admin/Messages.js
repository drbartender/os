import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

export default function Messages() {
  const toast = useToast();
  const [threads, setThreads] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);

  const fetchThreads = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.get('/sms/conversations');
      setThreads(res.data);
    } catch (err) {
      toast.error('Failed to load conversations. Try refreshing.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchThreads(); }, [fetchThreads]);

  const selectThread = async (clientId) => {
    setSelectedClientId(clientId);
    try {
      const res = await api.get(`/sms/conversations/${clientId}`);
      setMessages(res.data);
      await api.put(`/sms/conversations/${clientId}/read`);
      fetchThreads(true);
    } catch (err) {
      toast.error('Failed to load conversation. Try again.');
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !selectedClientId) return;
    setReplying(true);
    try {
      await api.post(`/sms/conversations/${selectedClientId}/reply`, { body: replyText });
      setReplyText('');
      toast.success('Reply sent.');
      const res = await api.get(`/sms/conversations/${selectedClientId}`);
      setMessages(res.data);
    } catch (err) {
      toast.error(err.message || 'Failed to send reply.');
      try {
        const res = await api.get(`/sms/conversations/${selectedClientId}`);
        setMessages(res.data);
      } catch (_) { /* ignore secondary failure */ }
    } finally {
      setReplying(false);
    }
  };

  const selectedThread = threads.find(t => t.client_id === selectedClientId);

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;

  return (
    <div className="sms-page">
      <h1 className="sms-page-title">Messages</h1>
      {threads.length === 0 ? (
        <div className="sms-empty">
          No SMS conversations yet. Client and staff texts to the business number appear here.
        </div>
      ) : (
        <div className="sms-layout">
          <div className="sms-list">
            {threads.map(thread => (
              <div
                key={thread.client_id}
                className={`sms-list-item ${selectedClientId === thread.client_id ? 'sms-list-item-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => selectThread(thread.client_id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(thread.client_id); } }}
              >
                <div className="sms-list-item-head">
                  <strong>{thread.name || 'Unknown client'}</strong>
                  {thread.unread_count > 0 && (
                    <span className="sms-unread-badge">{thread.unread_count}</span>
                  )}
                </div>
                <div className="sms-list-item-sub">{thread.phone || 'No phone on file'}</div>
                <div className="sms-list-item-time">
                  {thread.last_message_at && new Date(thread.last_message_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>

          <div className="sms-thread">
            {!selectedClientId ? (
              <div className="sms-placeholder">Select a conversation to view messages.</div>
            ) : (
              <>
                <div className="sms-thread-head">
                  <h3>{selectedThread?.name || 'Unknown client'}</h3>
                  <span className="muted">{selectedThread?.phone}</span>
                </div>

                <div className="sms-messages">
                  {messages.map(msg => (
                    <div key={msg.id} className={`sms-bubble sms-bubble-${msg.direction}`}>
                      <div className="sms-bubble-body">{msg.body || '(no text)'}</div>
                      <div className="sms-bubble-meta">
                        {msg.direction === 'outbound' ? 'You' : 'Client'}
                        {' . '}
                        {new Date(msg.created_at).toLocaleString()}
                        {msg.status === 'failed' && ' . failed to send'}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="sms-reply">
                  <textarea
                    className="form-input"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="Type your reply..."
                    rows={3}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleReply}
                    disabled={replying || !replyText.trim() || !selectedThread?.phone}
                  >
                    {replying ? 'Sending...' : 'Send SMS'}
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
