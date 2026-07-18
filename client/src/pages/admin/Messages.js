import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import useUrlListState from '../../hooks/useUrlListState';
import EntityLink from '../../components/EntityLink';
import ClientConversation from '../../components/ClientConversation';

export default function Messages() {
  const toast = useToast();
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  // The open thread is a {clientId, nonce, markRead} triple. `nonce` is the
  // remount key for ClientConversation: bumping it on every open (auto or click)
  // re-runs the component's load+markRead, so re-clicking an already-open thread
  // still clears its badge. `markRead` is false only for the bare-visit auto-open
  // of the newest thread, which must not silently clear an unread count.
  const [open, setOpen] = useState({ clientId: null, nonce: 0, markRead: false });
  // Selected thread lives in the URL (?client=<id>) so Back from a client
  // profile reopens the same conversation. Empty = the newest-thread default.
  const [listState, setListState] = useUrlListState({ client: '' });

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

  const selectThread = (clientId) => {
    setListState({ client: String(clientId) });
    setOpen(o => ({ clientId, nonce: o.nonce + 1, markRead: true }));
  };

  // On first load with nothing selected, open the URL-named thread (a deliberate
  // open, mark read) or fall back to the newest thread (a convenience, do NOT
  // mark read). threads are newest-received-first from the server.
  useEffect(() => {
    if (open.clientId || threads.length === 0) return;
    const fromUrl = listState.client
      ? threads.find(t => String(t.client_id) === listState.client)
      : null;
    if (fromUrl) setOpen(o => ({ clientId: fromUrl.client_id, nonce: o.nonce + 1, markRead: true }));
    else setOpen(o => ({ clientId: threads[0].client_id, nonce: o.nonce + 1, markRead: false }));
  }, [threads, open.clientId, listState.client]);

  const selectedThread = threads.find(t => t.client_id === open.clientId);

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
                className={`sms-list-item ${open.clientId === thread.client_id ? 'sms-list-item-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => selectThread(thread.client_id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(thread.client_id); } }}
              >
                <div className="sms-list-item-head">
                  <strong>
                    <EntityLink
                      to={thread.client_id ? '/clients/' + thread.client_id : null}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {thread.name || 'Unknown client'}
                    </EntityLink>
                  </strong>
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
            {!open.clientId ? (
              <div className="sms-placeholder">Select a conversation to view messages.</div>
            ) : (
              <>
                <div className="sms-thread-head">
                  <h3>
                    <EntityLink to={selectedThread?.client_id ? '/clients/' + selectedThread.client_id : null}>
                      {selectedThread?.name || 'Unknown client'}
                    </EntityLink>
                  </h3>
                  <span className="muted">{selectedThread?.phone}</span>
                </div>
                <ClientConversation
                  key={open.nonce}
                  clientId={open.clientId}
                  phone={selectedThread?.phone}
                  markReadOnOpen={open.markRead}
                  onActivity={() => fetchThreads(true)}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
