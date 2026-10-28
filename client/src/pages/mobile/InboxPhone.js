// InboxPhone (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import StatusChip from '../../components/adminos/StatusChip';
import { WaitingCard, SnoozedRow } from '../../components/inbox/WaitingRows';
import HandledList from '../../components/inbox/HandledList';
import FeedsLine from '../../components/inbox/FeedsLine';
import Thread from '../../components/inbox/Thread';
import ReplyBar from '../../components/inbox/ReplyBar';
import { ContextCard } from '../../components/inbox/ContextViews';
import { ItemBanner, PhoneActions } from '../../components/inbox/ItemActions';
import { SnoozeSheet } from '../../components/inbox/SnoozePickers';
import { ErrorCard, ItemGone, ItemLoading, ListEmpty, ListError, ListLoading } from '../../components/inbox/InboxStates';
import { contextModel, kindLine } from '../../components/inbox/inboxContext';
import { threadModel } from '../../components/inbox/inboxThread';
import { channelCount, stateChip, stateNote, threadChannels, waitParts } from '../../components/inbox/inboxFormat';

// Phone Inbox (spec 4 and 11.2; design InboxPhone.dc.html). Renders INSIDE
// AdminLayout's scrolling .m-main; the header and the tab bar (Inbox first)
// are the chrome's. /inbox is the list; /inbox/:personKey is the full-screen
// item, whose rich header (name, kind, guests) the chrome draws from
// setHeaderDetail. Everything stateful (the list poll, the item read, the
// drafts, the taps) is the page's (pages/admin/Inbox.js) and arrives as props.

const scrollHost = () => document.getElementById('main-content');

function PhoneList({ list, waiting, nowMs, busy, open, run, tab, setTab }) {
  const ready = list.status === 'ready';
  const data = list.data || {};
  const snoozed = ready ? data.snoozed || [] : [];
  const handled = ready ? data.handled || [] : [];
  let waitCount = '';
  if (ready) waitCount = String(waiting.length);
  else if (list.status === 'error') waitCount = '?';
  const oldest = waiting.length ? waitParts(waiting[0].waiting_since, nowMs) : null;
  return (
    <div>
      <div className="m-listbar">
        <div className="m-seg ib-seg" role="radiogroup" aria-label="Inbox view">
          <button type="button" role="radio" aria-checked={tab === 'waiting'}
            className={tab === 'waiting' ? 'm-seg-btn active' : 'm-seg-btn'} onClick={() => setTab('waiting')}>
            Waiting<span className="ib-seg-count">{waitCount}</span>
          </button>
          <button type="button" role="radio" aria-checked={tab === 'handled'}
            className={tab === 'handled' ? 'm-seg-btn active' : 'm-seg-btn'} onClick={() => setTab('handled')}>
            Handled<span className="ib-seg-count">{ready ? handled.length : ''}</span>
          </button>
        </div>
      </div>
      {list.status === 'loading' && <ListLoading />}
      {list.status === 'error' && <ListError lastGood={list.lastGood} pending={list.pending} onRetry={list.refresh} />}
      {ready && tab === 'waiting' && (
        <>
          {waiting.length === 0 && <ListEmpty />}
          {waiting.map((r) => <WaitingCard key={r.person_key} row={r} nowMs={nowMs} onOpen={open} />)}
          {oldest && <div className="m-end"><span>{`${waiting.length} waiting · oldest ${oldest.long}`}</span></div>}
          {snoozed.map((s) => (
            <SnoozedRow key={s.person_key} row={s} nowMs={nowMs} busy={busy} onWake={(row) => run(row.person_key, 'wake', { name: row.name })} />
          ))}
        </>
      )}
      {ready && tab === 'handled' && (
        <HandledList rows={handled} nowMs={nowMs} busy={busy} onReopen={(h) => run(h.personKey, 'reopen', { name: h.name })} />
      )}
      {list.status !== 'loading' && <FeedsLine feeds={data.feeds} ai={data.ai} nowMs={nowMs} failed={list.status === 'error'} />}
    </div>
  );
}

function PhoneItem({ item, itemKey, deliberate, drafts, nowMs, busy, run, refresh, backToList }) {
  const { setHeaderDetail } = useOutletContext() || {};
  const [sheet, setSheet] = useState(false);
  const d = item.status === 'ready' ? item.data : null;
  const name = d ? d.person.name : '';
  const kind = d ? kindLine(d.context) : '';
  const guests = d && d.context && d.context.guests !== undefined ? d.context.guests : null;

  // An item opens at its top, not at the list's scroll offset.
  useLayoutEffect(() => {
    const host = scrollHost();
    if (host) host.scrollTop = 0;
  }, []);
  // The chrome's rich header: back, name, guests, "Booked · Wedding".
  const header = useMemo(() => (name ? { title: name, kind, guests } : null), [name, kind, guests]);
  useEffect(() => {
    if (!setHeaderDetail) return undefined;
    setHeaderDetail(header);
    return () => setHeaderDetail(null);
  }, [header, setHeaderDetail]);

  if (item.status === 'loading' || item.status === 'idle') return <ItemLoading />;
  if (item.status === 'error') {
    return (
      <ErrorCard title="Couldn't load this conversation" body="Nothing was lost; the messages just didn't arrive."
        onRetry={item.refresh} pending={false} />
    );
  }
  if (!d) return <ItemGone onBack={backToList} />;

  const wait = d.waiting ? waitParts(d.waiting_since, nowMs) : null;
  const chip = d.waiting ? stateChip(d.state, { deliberate }) : null;
  const note = d.waiting ? stateNote(d.state, nowMs) : null;
  const chans = threadChannels(d.thread);
  const hasReply = d.reply && d.reply.mode !== 'none';
  return (
    <div className="ib-item">
      <div className="ib-item-body">
        <ItemBanner item={d} nowMs={nowMs} busy={busy}
          onWake={() => run(itemKey, 'wake', { name })} onReopen={() => run(itemKey, 'reopen', { name })} />
        {item.refreshFailed && (
          <div className="m-stale" role="alert">
            <span className="m-stale-dot" aria-hidden="true" />
            <span>Couldn't refresh. This may be out of date.</span>
            <button type="button" className="m-fail-retry" onClick={item.refresh}>Retry</button>
          </div>
        )}
        {wait && (
          <div className="m-detail-when">
            <div className="m-detail-whenline">
              <span>Waiting <span className={wait.hot ? 'ib-wait-long ib-hot' : 'ib-wait-long'}>{wait.long}</span></span>
              {chip && <StatusChip kind={chip.kind}>{chip.label}</StatusChip>}
              {note && <span className="m-detail-setup">{note}</span>}
            </div>
          </div>
        )}
        <ContextCard model={contextModel(d.context, { legalHold: d.legal_hold })} />
        <h2 className="m-more-heading ib-msgs-head">{chans.length ? `Messages · ${channelCount(chans)}` : 'Messages'}</h2>
        <Thread items={threadModel(d.thread, nowMs)} />
      </div>
      {(d.waiting || hasReply) && (
        <div className="ib-dock">
          {d.waiting && (
            <PhoneActions state={d.state} busy={busy}
              onClaim={(c) => run(itemKey, c.action, { takeoverFrom: c.takeoverFrom })}
              onSnooze={() => setSheet(true)}
              onDone={() => run(itemKey, 'done', { name })} />
          )}
          <ReplyBar personKey={itemKey} name={name} reply={d.reply} drafts={drafts} nowMs={nowMs} onSent={refresh} />
        </div>
      )}
      {sheet && (
        <SnoozeSheet name={name} nowMs={nowMs} onClose={() => setSheet(false)}
          onPick={(until) => { setSheet(false); run(itemKey, 'snooze', { until, name }); }} />
      )}
    </div>
  );
}

export default function InboxPhone(props) {
  // The list's tab and scroll offset live here, above the list/item switch,
  // so Back from an item lands where the list was.
  const [tab, setTab] = useState('waiting');
  const offset = useRef(0);
  const { itemKey, open, list } = props;
  const openItem = (key) => {
    const host = scrollHost();
    offset.current = host ? host.scrollTop : 0;
    open(key);
  };
  const ready = list.status === 'ready';
  useLayoutEffect(() => {
    if (itemKey || !ready) return;
    const host = scrollHost();
    if (host) host.scrollTop = offset.current;
  }, [itemKey, ready]);
  // .ib-phone draws no box: it marks the phone Inbox as open for the toast
  // rules (index.css), whichever screen below is showing.
  return (
    <div className="ib-phone">
      {itemKey
        ? <PhoneItem key={itemKey} {...props} />
        : <PhoneList {...props} open={openItem} tab={tab} setTab={setTab} />}
    </div>
  );
}
