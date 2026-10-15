import React, { useLayoutEffect, useRef } from 'react';

// The messages (spec 4.2), from threadModel(): day separators, centered system
// lines, and bubbles (inbound left, outbound right and tinted) that follow the
// Messages page's .sms-bubble, each with its channel tag, time and author.
// A mail bubble shows its subject above the words and its attachment count
// in a muted line under them.
// The desktop pane scrolls itself and keeps the newest message in view, like
// ClientConversation; the phone thread flows in the page.
export default function Thread({ items, variant = 'phone' }) {
  const desk = variant === 'desktop';
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (desk && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [desk, items.length]);
  return (
    <div className={desk ? 'sms-messages ib-thread ib-thread-desk scroll-thin' : 'ib-thread'} ref={ref}>
      {items.length === 0 && <div className="ib-sys">No messages in the last 30 days.</div>}
      {items.map((m) => {
        if (m.type === 'day') {
          return <div key={m.key} className={desk ? 'ib-day ib-day-desk' : 'm-end ib-day'}><span>{m.label}</span></div>;
        }
        if (m.type === 'sys') {
          return (
            <div key={m.key} className="ib-sys">
              {m.text}
              {m.failure && <span className="ib-sys-fail">{` · ${m.failure}`}</span>}
            </div>
          );
        }
        return (
          <div
            key={m.key}
            className={`sms-bubble ${m.out ? 'sms-bubble-outbound' : 'sms-bubble-inbound'} ib-bubble${m.failed ? ' ib-bubble-failed' : ''}`}
          >
            <div className="ib-bubble-meta">
              <span className={desk ? 'ib-tag' : 'm-tag'}>{m.tag}</span>
              <span className="ib-bubble-time">{m.meta}</span>
            </div>
            {m.relay && <div className="ib-bubble-relay">{m.relay}</div>}
            {m.subject && <div className="ib-bubble-subject">{m.subject}</div>}
            {m.body && <div className="sms-bubble-body ib-bubble-body">{m.body}</div>}
            {m.media.length > 0 && (
              <div className="ib-media">
                {m.media.map((x) => (
                  <a key={x.key} className="ib-media-link" href={x.url} target="_blank" rel="noopener noreferrer">{x.label}</a>
                ))}
              </div>
            )}
            {m.attachments && <div className="ib-bubble-attach">{m.attachments}</div>}
            {m.failure && <div className="ib-bubble-fail">{m.failure}</div>}
          </div>
        );
      })}
    </div>
  );
}
