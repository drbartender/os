// ReplyBar (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useEffect, useRef, useState } from 'react';
import Icon from '../adminos/Icon';
import { useToast } from '../../context/ToastContext';
import { sendText } from './inboxApi';
import { lateNote, optOutText } from './inboxFormat';

// The reply area (spec 4.3) for the person's latest channel, from the item
// payload's `reply`:
//   text  the FROM switch (the enabled lines, on `default_line`), the box and
//         Send. The hint beside the switch names `their_line`, the line of
//         their latest inbound text: "last texted 1922" (the desktop says
//         "they last texted 1922", the design's copy) when the switch is on
//         it, a warning when it is not, nothing when they never texted us.
//         Staff get no switch, just the staff-line caption.
//   open  "Open in Thumbtack", "Open in Gmail" or "Open in Zola" and the
//         caption the server writes for that app (`app.caption`).
//   none  nothing.
// Opted out replaces the box with the notice (keeping another channel's Open
// button); a bad number says it cannot receive texts.
//
// Sending: Send is disabled while a send is in flight, and the in-flight ref
// drops a second tap that lands before the disabled button renders. The send
// id comes from the drafts store, and only an answer the text route itself
// gives spends it: the server answers a spent id the same way forever only
// for answers it stored or decided under that id (spec 17 item 3, as ruled
// 2026-10-09).
//   spent  a 201 (delivered or not), and the route's own refusals below: a
//          Twilio failure, INBOX_SEND_UNRECORDED, a reused id, opted out, not
//          textable, a line not on or not allowed, a bad number, a refused
//          request, and any 404. The next tap is a new attempt, or a failed
//          text could never be resent.
//   kept   everything else: no answer (NETWORK_ERROR: the server may have
//          sent it), 409 INBOX_SEND_IN_PROGRESS (the first send is still
//          running), no code (a rate limit or a proxy in front of the route),
//          INTERNAL_ERROR (an unexpected error the route never stored), an
//          auth or permission refusal from the middleware in front of the
//          route, and any code this page does not know. The next tap is the
//          same attempt, so it can never text twice.
// A failed send keeps the draft; the refetch after every send shows the
// failed row ("Not delivered") in the thread. The success toast has no Undo:
// a text cannot be recalled.

const STAFF_LINE = 'Sends from the staff line, same as the shift texts';
// The codes POST /admin/inbox/:personKey/text answers with itself
// (server/utils/inbox/textSend.js and the route's key check).
const SPENDS_SEND_ID = [
  'EXTERNAL_SERVICE_ERROR', 'INBOX_SEND_UNRECORDED', 'INBOX_SEND_ID_REUSED', 'INBOX_OPTED_OUT',
  'INBOX_NOT_TEXTABLE', 'INBOX_LINE_NOT_ENABLED', 'INBOX_LINE_NOT_ALLOWED', 'INBOX_BAD_NUMBER', 'VALIDATION_ERROR',
];
const spendsSendId = (err) => Boolean(err) && (err.status === 404 || SPENDS_SEND_ID.includes(err.code));

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'them';
}

// The server words each app's caption (spec 2026-10-14 section 4.4); a
// payload from before that change falls back to the Thumbtack wording.
function captionOf(app) {
  const caption = typeof app.caption === 'string' ? app.caption.trim() : '';
  return caption || `Closes here on its own once you reply in ${app.name}.`;
}

// https only (as the thread's media links): an app link that is not an
// https string (a javascript: or data: URL) is never rendered.
const HTTPS = /^https:\/\//i;
const linkable = (app) => Boolean(app) && typeof app.url === 'string' && HTTPS.test(app.url);

function OpenApp({ app, desk }) {
  if (!linkable(app)) return null;
  const caption = captionOf(app);
  if (desk) {
    return (
      <div className="ib-dopen">
        <span className="ib-dopen-hint">{caption}</span>
        <a className="btn btn-primary" href={app.url} target="_blank" rel="noopener noreferrer">
          Open in {app.name}<Icon name="external" />
        </a>
      </div>
    );
  }
  return (
    <>
      <a className="ib-open-btn" href={app.url} target="_blank" rel="noopener noreferrer">
        Open in {app.name}<Icon name="external" size={16} />
      </a>
      <div className="ib-caption ib-caption-center">{caption}</div>
    </>
  );
}

function Notice({ lead, text, app, desk }) {
  if (desk) {
    return (
      <div className="ib-doptout">
        <span className="ib-feed-dot" aria-hidden="true" />
        <span className="ib-doptout-text">{lead && <strong>{lead} </strong>}{text}</span>
        {linkable(app) && (
          <a className="btn btn-primary" href={app.url} target="_blank" rel="noopener noreferrer">
            Open in {app.name}<Icon name="external" />
          </a>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="m-sheet-note ib-optout" role="note">
        <span className="m-sheet-note-dot" aria-hidden="true" />
        <span className="m-sheet-note-text">{lead && <strong>{lead} </strong>}{text}</span>
      </div>
      {linkable(app) && (
        <a className="ib-open-btn" href={app.url} target="_blank" rel="noopener noreferrer">
          Open in {app.name}<Icon name="external" size={16} />
        </a>
      )}
    </>
  );
}

export default function ReplyBar({ personKey, name, reply, drafts, nowMs, onSent, variant = 'phone' }) {
  const toast = useToast();
  const desk = variant === 'desktop';
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  if (!reply || reply.mode === 'none') return null;
  const wrap = (children) => (desk ? <div className="sms-reply ib-reply">{children}</div> : children);
  if (reply.mode === 'open') return wrap(<OpenApp app={reply.app} desk={desk} />);
  if (reply.opted_out) return wrap(<Notice lead="Opted out of texts." text={optOutText(reply.opted_out)} app={reply.app} desk={desk} />);
  if (reply.bad_number) return wrap(<Notice lead={null} text="This number can't receive texts." app={reply.app} desk={desk} />);

  const draft = drafts.draftOf(personKey);
  const lines = reply.lines && reply.lines.length ? reply.lines : ['888'];
  let line = lines[0];
  if (lines.includes(draft.line)) line = draft.line;
  else if (lines.includes(reply.default_line)) line = reply.default_line;
  const prefixes = reply.first_text_prefix || {};
  const prefix = prefixes[line] ? String(prefixes[line]).trim() : null;
  const their = reply.their_line || null;
  const late = lateNote(nowMs);
  // An unknown number (a p- key) is named by its formatted phone, whose
  // first word is the area code: the placeholder says "this number".
  const who = String(personKey || '').startsWith('p-') ? 'this number' : firstName(name);
  const placeholder = reply.staff ? `Text ${who}` : `Text ${who} from ${line}`;
  const canSend = !sending && draft.text.trim().length > 0;

  const send = async () => {
    const body = drafts.draftOf(personKey).text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    const sendId = drafts.sendIdFor(personKey);
    try {
      const res = await sendText(personKey, { body, line, sendId });
      drafts.spend(personKey);
      const message = res && res.data ? res.data.message : null;
      if (message && message.failed) {
        toast.error(message.failure_reason ? `Not delivered: ${message.failure_reason}` : 'Not delivered.');
      } else {
        drafts.clear(personKey);
        toast.success(`Sent from ${(message && message.line) || line}.`);
      }
    } catch (err) {
      const code = err && err.code;
      if (spendsSendId(err)) drafts.spend(personKey);
      if (code === 'INBOX_SEND_IN_PROGRESS') toast.info('Still sending, check the thread.');
      else toast.error((err && err.message) || 'Not sent. Try again.');
    } finally {
      inFlight.current = false;
      if (alive.current) setSending(false);
      if (onSent) onSent();
    }
  };

  const fromSwitch = !reply.staff && (
    desk ? (
      <div className="ib-dfrom">
        <span className="ib-dfrom-label">From</span>
        <div className="ib-dseg" role="radiogroup" aria-label="Send from">
          {lines.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={l === line}
              className={l === line ? 'ib-dseg-btn is-on' : 'ib-dseg-btn'} onClick={() => drafts.setLine(personKey, l)}>{l}</button>
          ))}
        </div>
        {their && (
          <span className={line === their ? 'ib-dfrom-hint' : 'ib-dfrom-hint ib-from-warn'}>
            {line === their ? `they last texted ${their}` : `heads up: they texted ${their}`}
          </span>
        )}
      </div>
    ) : (
      <div className="ib-from">
        <span className="ib-from-label">From</span>
        <div className="m-seg ib-seg ib-from-seg" role="radiogroup" aria-label="Send from">
          {lines.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={l === line}
              className={l === line ? 'm-seg-btn active ib-line-btn' : 'm-seg-btn ib-line-btn'} onClick={() => drafts.setLine(personKey, l)}>{l}</button>
          ))}
        </div>
        {their && (
          <span className={line === their ? 'ib-from-hint' : 'ib-from-hint ib-from-warn'}>
            {line === their ? `last texted ${their}` : `they texted ${their}`}
          </span>
        )}
      </div>
    )
  );
  const notes = (
    <>
      {late && <div className="ib-caption ib-late">{late}</div>}
      {prefix && <div className="ib-caption">{`This first text from ${line} starts with "${prefix}"`}</div>}
    </>
  );

  if (desk) {
    return (
      <div className="sms-reply ib-reply">
        {fromSwitch}
        {notes}
        <textarea className="form-input" rows={3} maxLength={1600} aria-label="Reply" placeholder={`${placeholder}...`}
          value={draft.text} onChange={(e) => drafts.setText(personKey, e.target.value)} />
        <div className="ib-dsend">
          <span className="ib-dsend-note">
            {reply.staff ? `${STAFF_LINE}.` : `Sends as SMS from ${line}${reply.recipient_display ? ` to ${reply.recipient_display}` : ''}.`}
          </span>
          <button type="button" className="btn btn-primary" disabled={!canSend} onClick={send}>
            <Icon name="send" />{sending ? 'Sending' : (reply.staff ? 'Send text' : `Send from ${line}`)}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {fromSwitch}
      {notes}
      <div className="ib-compose">
        <textarea className="ib-compose-input" rows={1} maxLength={1600} aria-label="Reply" placeholder={placeholder}
          value={draft.text} onChange={(e) => drafts.setText(personKey, e.target.value)} />
        <button type="button" className="ib-send" aria-label={`Send from ${line}`} disabled={!canSend} onClick={send}>
          <Icon name="send" size={18} />
        </button>
      </div>
      {reply.staff && <div className="ib-caption">{STAFF_LINE}</div>}
    </>
  );
}
