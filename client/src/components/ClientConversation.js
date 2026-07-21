import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';

// Shared SMS thread + reply pane, keyed on a clientId. Used by the admin inbox
// (Messages.js) and the client detail page (ClientDetail.js) so both surfaces
// render and behave identically. Renders two siblings (.sms-messages, .sms-reply)
// with no wrapper so it inherits the flex layout of whatever contains it.
export default function ClientConversation({ clientId, phone, markReadOnOpen = true, onActivity }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const messagesRef = useRef(null);

  // Load the thread when the client changes. Marking read is a deliberate view
  // action, so it is gated on markReadOnOpen (the inbox passes false when it
  // merely auto-opens the newest thread on a bare page visit). onActivity lets a
  // host refresh its unread badges after the read clears. Deps intentionally
  // [clientId] only: markReadOnOpen/onActivity/toast are stable per mount here
  // (the inbox remounts this via key on each open), and listing onActivity would
  // refire the load on every parent render.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/sms/conversations/${clientId}`);
        if (!alive) return;
        setMessages(res.data);
        if (markReadOnOpen) {
          await api.put(`/sms/conversations/${clientId}/read`);
          if (onActivity) onActivity();
        }
      } catch (err) {
        if (alive) toast.error('Failed to load conversation. Try again.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Keep the newest message in view whenever the thread loads or grows.
  // `loading` is a dependency, not just `messages`: on a deliberate open the
  // mark-read await sits between setMessages and setLoading(false), so those
  // land in two separate commits. A messages-only effect therefore fired on the
  // commit that still rendered the "Loading messages..." placeholder (nothing to
  // scroll yet) and never re-fired on the commit that actually painted the
  // bubbles, leaving every clicked thread parked at the top of its history.
  // Layout effect so the pin happens before paint rather than flashing the
  // oldest messages first.
  useLayoutEffect(() => {
    if (loading) return;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const handleReply = async () => {
    if (!replyText.trim() || !clientId) return;
    setReplying(true);
    try {
      await api.post(`/sms/conversations/${clientId}/reply`, { body: replyText });
      setReplyText('');
      toast.success('Reply sent.');
      const res = await api.get(`/sms/conversations/${clientId}`);
      setMessages(res.data);
      // Replying is engagement: clear any lingering unread badge.
      await api.put(`/sms/conversations/${clientId}/read`);
      if (onActivity) onActivity();
    } catch (err) {
      toast.error(err.message || 'Failed to send reply.');
      // The reply endpoint saves a failed send as a row; re-fetch to show it.
      try {
        const res = await api.get(`/sms/conversations/${clientId}`);
        setMessages(res.data);
      } catch (_) { /* ignore secondary failure */ }
    } finally {
      setReplying(false);
    }
  };

  return (
    <>
      <div className="sms-messages" ref={messagesRef}>
        {loading ? (
          <div className="muted tiny">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="muted tiny">No texts yet.</div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`sms-bubble sms-bubble-${msg.direction}`}>
              <div className="sms-bubble-body">{msg.body || '(no text)'}</div>
              <div className="sms-bubble-meta">
                {msg.direction === 'outbound' ? 'You' : 'Client'}
                {' . '}
                {new Date(msg.created_at).toLocaleString('en-US', { hour12: false })}
                {msg.status === 'failed' && ' . failed to send'}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sms-reply">
        <textarea
          className="form-input"
          value={replyText}
          onChange={e => setReplyText(e.target.value)}
          placeholder="Type your reply..."
          rows={3}
          disabled={!phone}
        />
        <button
          className="btn btn-primary"
          onClick={handleReply}
          disabled={replying || !replyText.trim() || !phone}
        >
          {replying ? 'Sending...' : 'Send SMS'}
        </button>
        {!phone && <div className="tiny muted">No phone number on file.</div>}
      </div>
    </>
  );
}
