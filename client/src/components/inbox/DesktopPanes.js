// Exports ListPane, ThreadPane. Header generated from the file's exports by migrate-headers on
// 2026-10-27; replace with what it does.

import React, { useState } from 'react';
import Icon from '../adminos/Icon';
import StatusChip from '../adminos/StatusChip';
import { WaitingRow, SnoozedRow } from './WaitingRows';
import HandledList from './HandledList';
import FeedsLine from './FeedsLine';
import Thread from './Thread';
import ReplyBar from './ReplyBar';
import { DesktopActions, ItemBanner } from './ItemActions';
import { ErrorCard, ItemGone, ItemLoading, ListEmpty, ListError, ListLoading } from './InboxStates';
import { threadModel } from './inboxThread';
import { channelJoin, stateChip, stateNote, threadChannels, waitParts } from './inboxFormat';

// The desktop's first two panes (spec 11.3): People waiting (LIVE, the
// Waiting and "Handled, last 7 days" tabs, the Snoozed group, the feeds
// footer) and the thread (header with the wait, channels and actions, the
// messages, the composer). The context pane is ContextViews.ContextPane.

export function ListPane({ list, waiting, itemKey, nowMs, busy, open, run }) {
  const [tab, setTab] = useState('waiting');
  const ready = list.status === 'ready';
  const data = list.data || {};
  const handled = ready ? data.handled || [] : [];
  const snoozed = ready ? data.snoozed || [] : [];
  let count = '';
  if (ready) count = String(waiting.length);
  else if (list.status === 'error') count = '?';
  return (
    <div className="card card-flush ib-pane">
      <div className="card-head">
        <h3 className="ib-pane-title"><Icon name="mail" size={12} /> People waiting <span className="k">Live</span></h3>
        <span className="k">{count}</span>
      </div>
      <div className="nat-tabs ib-tabs">
        <button type="button" aria-pressed={tab === 'waiting'} className={tab === 'waiting' ? 'nat-tab is-active' : 'nat-tab'} onClick={() => setTab('waiting')}>
          Waiting <span className="ib-tab-count">{count}</span>
          {ready && waiting.length > 0 && <span className="nat-dot danger" />}
        </button>
        <button type="button" aria-pressed={tab === 'handled'} className={tab === 'handled' ? 'nat-tab is-active' : 'nat-tab'} onClick={() => setTab('handled')}>
          Handled, last 7 days <span className="ib-tab-count">{ready ? handled.length : ''}</span>
        </button>
      </div>
      <div className="scroll-thin ib-pane-scroll">
        {list.status === 'loading' && <ListLoading variant="desktop" />}
        {list.status === 'error' && <ListError variant="desktop" lastGood={list.lastGood} pending={list.pending} onRetry={list.refresh} />}
        {ready && tab === 'waiting' && (
          <>
            {waiting.length === 0 && <ListEmpty variant="desktop" />}
            {waiting.map((r) => (
              <WaitingRow key={r.person_key} row={r} nowMs={nowMs} selected={r.person_key === itemKey} onOpen={open} />
            ))}
            {snoozed.map((s) => (
              <SnoozedRow key={s.person_key} variant="desktop" row={s} nowMs={nowMs} busy={busy}
                onWake={(row) => run(row.person_key, 'wake', { name: row.name })} />
            ))}
          </>
        )}
        {ready && tab === 'handled' && (
          <HandledList variant="desktop" rows={handled} nowMs={nowMs} busy={busy} onReopen={(h) => run(h.personKey, 'reopen', { name: h.name })} />
        )}
      </div>
      {list.status !== 'loading' && (
        <FeedsLine variant="desktop" feeds={data.feeds} ai={data.ai} nowMs={nowMs} failed={list.status === 'error'} />
      )}
    </div>
  );
}

export function ThreadPane({ item, itemKey, deliberate, drafts, nowMs, busy, run, refresh, backToList }) {
  if (!itemKey) {
    return <div className="card card-flush ib-pane ib-thread-pane"><div className="ib-dnote">Pick someone from the list.</div></div>;
  }
  if (item.status === 'loading' || item.status === 'idle') {
    return <div className="card card-flush ib-pane ib-thread-pane"><ItemLoading variant="desktop" /></div>;
  }
  if (item.status === 'error') {
    return (
      <div className="card card-flush ib-pane ib-thread-pane">
        <ErrorCard variant="desktop" title="Couldn't load this conversation" body="Nothing was lost; the messages just didn't arrive."
          onRetry={item.refresh} pending={false} />
      </div>
    );
  }
  if (item.status !== 'ready' || !item.data) {
    return <div className="card card-flush ib-pane ib-thread-pane"><ItemGone variant="desktop" onBack={backToList} /></div>;
  }
  const d = item.data;
  const name = d.person.name;
  const wait = d.waiting ? waitParts(d.waiting_since, nowMs) : null;
  const chip = d.waiting ? stateChip(d.state, { deliberate }) : null;
  const note = d.waiting ? stateNote(d.state, nowMs) : null;
  const stretch = threadChannels(d.thread, d.waiting ? d.waiting_since : null);
  const chans = stretch.length ? stretch : threadChannels(d.thread);
  // "Waiting 46 hrs · Text 1922 + Email · You said Monday" (the design).
  const tail = [chans.length ? channelJoin(chans) : null, note].filter(Boolean);
  return (
    <div className="card card-flush ib-pane ib-thread-pane">
      <div className="ib-thead">
        <div className="ib-thead-main">
          <div className="ib-thead-name">{name}</div>
          <div className="ib-thead-sub">
            {chip && <StatusChip kind={chip.kind}>{chip.label}</StatusChip>}
            <span>
              {wait && <>Waiting <span className={wait.hot ? 'ib-wait-long ib-hot' : 'ib-wait-long'}>{wait.long}</span>{tail.length ? ' · ' : ''}</>}
              {tail.join(' · ')}
            </span>
          </div>
        </div>
        {d.waiting && (
          <DesktopActions
            key={itemKey}
            state={d.state}
            busy={busy}
            nowMs={nowMs}
            onClaim={(c) => run(itemKey, c.action, { takeoverFrom: c.takeoverFrom })}
            onSnooze={(until) => run(itemKey, 'snooze', { until, name })}
            onDone={() => run(itemKey, 'done', { name })}
          />
        )}
      </div>
      <ItemBanner variant="desktop" item={d} nowMs={nowMs} busy={busy}
        onWake={() => run(itemKey, 'wake', { name })} onReopen={() => run(itemKey, 'reopen', { name })} />
      {item.refreshFailed && (
        <div className="ib-refresh-fail" role="alert">
          <span>Couldn't refresh this conversation. It may be out of date.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={item.refresh}>Retry</button>
        </div>
      )}
      <Thread variant="desktop" items={threadModel(d.thread, nowMs)} />
      <ReplyBar key={itemKey} variant="desktop" personKey={itemKey} name={name} reply={d.reply} drafts={drafts} nowMs={nowMs} onSent={refresh} />
    </div>
  );
}
