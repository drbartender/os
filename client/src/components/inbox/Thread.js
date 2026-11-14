// The Inbox thread (default export): day separators, centered system lines (a menu task's with its event
// link and the client's change note under it), and the message bubbles; TaskLink, the menu task's link.

import React, { useLayoutEffect, useRef } from 'react';
import { Link, parsePath, useNavigate } from 'react-router-dom';
import { useMobileView } from '../../context/MobileViewContext';
import { routeScreenKey } from '../../utils/screenKey';
import { TASK_LINK_LABEL } from './inboxThread';

/**
 * A menu task's link (spec 2026-10-19 section 13.2): "Open the menu", named
 * by `label` so two links never read alike. At phone width the event page is
 * the phone event screen, which has no menu editor, so a press first opens the
 * desktop event page for this visit only (MobileViewContext's
 * setDesktopForVisit with the page's screen key, as the phone's search does),
 * then navigates; ?menu=1 opens the editor. At desktop width it is a plain
 * link. A press with a modifier key keeps the browser's own behavior.
 */
export function TaskLink({ to, label }) {
  const { isPhone, setDesktopForVisit } = useMobileView();
  const navigate = useNavigate();
  const onClick = (e) => {
    if (!isPhone || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setDesktopForVisit(routeScreenKey(parsePath(to).pathname));
    navigate(to);
  };
  return <Link className="ib-task-link" to={to} aria-label={label} onClick={onClick}>{TASK_LINK_LABEL}</Link>;
}

// The messages (spec 4.2), from threadModel(): day separators, centered system
// lines, and bubbles (inbound left, outbound right and tinted) that follow the
// Messages page's .sms-bubble, each with its channel tag, time and author.
// A mail bubble shows its subject above the words and its attachment count
// in a muted line under them. A menu task's line (spec 2026-10-19 section
// 13.2) ends with a plain text link to the event (ib-task-link, index.css);
// a change request's note follows it as the client's words, in an inbound
// bubble with no channel tag.
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
            <React.Fragment key={m.key}>
              <div className="ib-sys">
                {m.text}
                {m.failure && <span className="ib-sys-fail">{` · ${m.failure}`}</span>}
                {m.link && <>{' '}<span className="ib-task-tail">{'· '}<TaskLink to={m.link} label={`${TASK_LINK_LABEL}: ${m.text}`} /></span></>}
              </div>
              {m.note && (
                <div className="sms-bubble sms-bubble-inbound ib-bubble">
                  <div className="sms-bubble-body ib-bubble-body">{m.note}</div>
                </div>
              )}
            </React.Fragment>
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
