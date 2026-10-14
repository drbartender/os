import '@testing-library/jest-dom';
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WaitingCard, WaitingRow, SnoozedRow } from './WaitingRows';
import HandledList from './HandledList';
import FeedsLine from './FeedsLine';
import { ListPane } from './DesktopPanes';
import { ListEmpty, ListError } from './InboxStates';

const css = fs.readFileSync(path.join(__dirname, '../../index.css'), 'utf8');

// Tue Oct 6 2026, 2:40 PM Chicago. Invented people only.
const NOW = Date.parse('2026-10-06T19:40:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (o) => ({
  person_key: 'c-1', name: 'Avery Example', kind: 'client', need: 'Add a second bartender?',
  waiting_since: hoursAgo(46), hot: true, channels: ['text_1922', 'email'], state: { type: null }, ...o,
});

test('phone card: the wait rail in red past 24 hours, need, chip, channel tags; a tap opens', () => {
  const onOpen = jest.fn();
  render(<WaitingCard row={row({ state: { type: 'claim', mine: false, by_name: 'Zul' } })} nowMs={NOW} onOpen={onOpen} />);
  const card = screen.getByRole('button');
  expect(card).toHaveClass('m-card');
  expect(card.querySelector('.m-rail')).toHaveClass('ib-rail-hot');
  expect(card.querySelector('.m-rail-day')).toHaveTextContent('46');
  expect(card.querySelector('.m-rail-mon')).toHaveTextContent('HRS');
  expect(screen.getByText('Add a second bartender?')).toHaveClass('ib-need');
  expect(screen.getByText("Zul's on it")).toBeInTheDocument();
  expect(screen.getByText('Text 1922')).toHaveClass('m-tag');
  expect(screen.getByText('Email')).toHaveClass('m-tag');
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledWith('c-1');
});

test('phone card under 24 hours keeps the ink rail', () => {
  render(<WaitingCard row={row({ waiting_since: hoursAgo(7) })} nowMs={NOW} onOpen={() => {}} />);
  expect(screen.getByRole('button').querySelector('.m-rail')).not.toHaveClass('ib-rail-hot');
});

test('desktop row: toned queue icon of the latest channel, short wait, selected stripe', () => {
  render(<WaitingRow row={row({ channels: ['thumbtack'], waiting_since: hoursAgo(5) })} nowMs={NOW} selected onOpen={() => {}} />);
  const r = screen.getByRole('button');
  expect(r).toHaveClass('ib-drow', 'is-selected');
  expect(r.querySelector('.queue-icon')).toHaveClass('warn');
  expect(screen.getByText('5h')).not.toHaveClass('ib-hot');
  expect(screen.getByText('Thumbtack')).toHaveClass('ib-tag');
});

test('snoozed row: "<name> snoozed until" in Chicago time with Wake', () => {
  const onWake = jest.fn();
  const s = { person_key: 'c-3', name: 'Jo Test', until: '2026-10-07T13:00:00.000Z', by_name: 'Zul' };
  render(<SnoozedRow row={s} nowMs={NOW} onWake={onWake} />);
  expect(screen.getByText(/Jo Test snoozed until/)).toHaveTextContent('Jo Test snoozed until Wed 8:00 AM');
  fireEvent.click(screen.getByRole('button', { name: 'Wake' }));
  expect(onWake).toHaveBeenCalledWith(s);
});

test('handled: the intro, day headers, what they needed, reason, who badge (none for Thumbtack) and Reopen', () => {
  const onReopen = jest.fn();
  render(
    <HandledList nowMs={NOW} onReopen={onReopen} rows={[
      { person_key: 'c-2', name: 'Jo Test', need: 'Wants a quote for 75 guests', channel: 'thumbtack', closed_at: '2026-10-06T16:20:00.000Z', reason_text: 'Proposal sent by Zul', by: 'Z' },
      { person_key: 't-8', name: 'Quinn Sample', channel: 'thumbtack', closed_at: '2026-10-05T16:20:00.000Z', reason_text: 'Replied in Thumbtack', by: null },
    ]} />
  );
  expect(screen.getByText('Closed in the last 7 days, and why. Reopen puts it back in Waiting.')).toBeInTheDocument();
  expect(screen.getByText('Today')).toBeInTheDocument();
  expect(screen.getByText('Yesterday')).toBeInTheDocument();
  expect(screen.getByText('Wants a quote for 75 guests')).toHaveClass('ib-hrow-need');
  expect(screen.getByText('Z')).toHaveClass('ib-who', 'ib-who-z');
  expect(screen.getByText('Replied in Thumbtack').closest('.ib-hrow').querySelector('.ib-who')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Reopen' })[0]);
  expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ personKey: 'c-2', name: 'Jo Test' }));
});

test('handled: a row the server sends with no channel draws no empty pill or separator, on either surface', () => {
  const rows = [
    { person_key: 'c-4', name: 'Avery Example', need: 'Add a second bartender?', channel: null, closed_at: '2026-10-06T17:00:00.000Z', reason_text: 'You marked it done', by: 'D' },
    { person_key: 'c-2', name: 'Jo Test', channel: 'thumbtack', closed_at: '2026-10-06T16:20:00.000Z', reason_text: 'Proposal sent by Zul', by: 'Z' },
  ];
  const { rerender } = render(<HandledList nowMs={NOW} onReopen={() => {}} rows={rows} variant="desktop" />);
  const deskBare = screen.getByText('Avery Example').closest('.ib-dhrow');
  expect(deskBare.querySelector('.ib-dhrow-why')).toHaveTextContent(/^You marked it done$/);
  expect(deskBare.querySelector('.ib-dhrow-dot')).toBeNull();
  expect(deskBare.querySelector('.ib-dhrow-ch')).toBeNull();
  const deskTagged = screen.getByText('Jo Test').closest('.ib-dhrow');
  expect(deskTagged.querySelector('.ib-dhrow-why')).toHaveTextContent(/^Proposal sent by Zul · Thumbtack$/);
  expect(deskTagged.querySelector('.ib-dhrow-dot')).not.toBeNull();

  rerender(<HandledList nowMs={NOW} onReopen={() => {}} rows={rows} />);
  const phoneBare = screen.getByText('Avery Example').closest('.ib-hrow');
  expect(phoneBare).toHaveTextContent('You marked it done');
  expect(phoneBare.querySelector('.m-tag')).toBeNull();
  expect(phoneBare.querySelector('.ib-hrow-ch')).toBeNull();
  expect(screen.getByText('Jo Test').closest('.ib-hrow').querySelector('.m-tag')).toHaveTextContent('Thumbtack');
});

test('feeds line: each source, quiet dots, and an unknown line while the list failed', () => {
  const { rerender } = render(<FeedsLine nowMs={NOW} ai={{ status: 'off' }} feeds={[
    { source: 'thumbtack', last_at: hoursAgo(0.2), quiet: false },
    { source: '0082', last_at: null, quiet: true },
  ]} />);
  expect(screen.getByText('Thumbtack 12 min ago')).toBeInTheDocument();
  expect(screen.getByText('0082 never').closest('.ib-feed')).toHaveClass('ib-feed-quiet');
  expect(screen.getByText('AI read off')).toBeInTheDocument();
  rerender(<FeedsLine nowMs={NOW} failed />);
  expect(screen.getByText('Feed status unknown until the inbox loads')).toBeInTheDocument();
});

test('the error card is never the empty state, and shows the last good load in CT', () => {
  const onRetry = jest.fn();
  render(<ListError lastGood={{ at: '2026-10-06T19:12:00.000Z', waiting: 8 }} onRetry={onRetry} pending={false} />);
  expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the inbox");
  expect(screen.getByText('This is not an empty inbox. People may still be waiting; the list just didn\'t arrive.')).toBeInTheDocument();
  expect(screen.getByText('Last good load 2:12 PM CT · 8 were waiting')).toBeInTheDocument();
  expect(screen.getByText('Check your connection or try again.')).toBeInTheDocument();
  expect(screen.queryByText("Nobody's waiting")).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalled();
});

test('the empty state copy', () => {
  render(<ListEmpty />);
  expect(screen.getByText("Nobody's waiting")).toBeInTheDocument();
  expect(screen.getByText('Everyone has a reply. New messages land here the moment a feed delivers them.')).toBeInTheDocument();
});

// The design's pane title (InboxDesktop.dc.html): the icon, the title and the
// LIVE tag sit apart in one flex row.
test('desktop list pane: the People waiting title is its own flex row', () => {
  render(<ListPane list={{ status: 'ready', data: { waiting: [], snoozed: [], handled: [], feeds: [] } }} waiting={[]}
    itemKey={null} nowMs={NOW} open={() => {}} run={() => {}} busy={false} />);
  expect(screen.getByRole('heading', { name: /People waiting/ })).toHaveClass('ib-pane-title');
  expect(css).toContain('html[data-app="admin-os"] .ib-pane-title { display: flex; align-items: center; gap: 6px; }');
});

// A desktop handled row with no who badge (a Thumbtack reply) keeps the
// badge's column, so its name and reason line up with the rows above.
test('desktop handled: a row with no who badge keeps an empty, hidden badge in its column; the phone draws none', () => {
  const rows = [
    { person_key: 'c-2', name: 'Jo Test', channel: 'thumbtack', closed_at: '2026-10-06T16:20:00.000Z', reason_text: 'Proposal sent by Zul', by: 'Z' },
    { person_key: 't-8', name: 'Quinn Sample', channel: 'thumbtack', closed_at: '2026-10-06T16:10:00.000Z', reason_text: 'Replied in Thumbtack', by: null },
  ];
  const { rerender } = render(<HandledList nowMs={NOW} onReopen={() => {}} rows={rows} variant="desktop" />);
  const spacer = screen.getByText('Quinn Sample').closest('.ib-dhrow').firstElementChild;
  expect(spacer).toHaveClass('ib-who', 'ib-who-wide', 'ib-who-none');
  expect(spacer).toHaveAttribute('aria-hidden', 'true');
  expect(spacer).toBeEmptyDOMElement();
  expect(spacer).not.toHaveAttribute('title');
  expect(css).toContain('html[data-app="admin-os"] .ib-who.ib-who-none { visibility: hidden; }');
  rerender(<HandledList nowMs={NOW} onReopen={() => {}} rows={rows} />);
  expect(screen.getByText('Quinn Sample').closest('.ib-hrow').querySelector('.ib-who')).toBeNull();
});

// The alert is the card's message: toggling Retry and Retrying must not
// re-announce the whole card, button included.
test('the error card announces its message, and Retry or Retrying sits outside the alert', () => {
  const { rerender } = render(<ListError lastGood={{ at: '2026-10-06T19:12:00.000Z', waiting: 8 }} onRetry={() => {}} pending={false} />);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent("Couldn't load the inbox");
  expect(alert).toHaveTextContent('This is not an empty inbox.');
  expect(alert).toHaveTextContent('Last good load 2:12 PM CT · 8 were waiting');
  expect(within(alert).queryByRole('button')).toBeNull();
  rerender(<ListError lastGood={{ at: '2026-10-06T19:12:00.000Z', waiting: 8 }} onRetry={() => {}} pending />);
  expect(screen.getByRole('button', { name: 'Retrying' })).toBeDisabled();
  expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull();
});
