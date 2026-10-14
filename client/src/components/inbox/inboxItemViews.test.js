import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Thread from './Thread';
import { ContextCard, ContextPane } from './ContextViews';
import { DesktopActions, ItemBanner, PhoneActions } from './ItemActions';
import { SnoozeMenu, SnoozeSheet } from './SnoozePickers';
import { contextModel } from './inboxContext';
import { threadModel } from './inboxThread';

// Tue Oct 6 2026, 2:40 PM Chicago. Invented people only.
const NOW = Date.parse('2026-10-06T19:40:00.000Z');

test('thread: day separators, system lines, authors, Not delivered and a Photo link', () => {
  render(<Thread items={threadModel([
    { ref: 'sms:1', direction: 'in', channel: 'text', line: '1922', at: '2026-10-06T15:12:00.000Z', text: 'Any update?', media: [] },
    { ref: 'pal:2', direction: 'system', channel: null, line: null, at: '2026-10-06T15:20:00.000Z', text: 'Proposal sent by Zul' },
    { ref: 'pal:5', direction: 'system', channel: null, line: null, at: '2026-10-06T15:25:00.000Z', text: 'You sent the proposal', failed: true, failure_reason: 'No email or text went out' },
    { ref: 'sms:3', direction: 'out', channel: 'text', line: '1922', at: '2026-10-06T15:30:00.000Z', text: 'On it', author_name: 'You', failed: true, failure_reason: 'Unreachable (30003)', media: [] },
    { ref: 'sms:4', direction: 'in', channel: 'text', line: '1922', at: '2026-10-06T15:40:00.000Z', text: '', media: [{ url: 'https://example.test/m/1', content_type: 'image/png' }] },
  ], NOW)} />);
  expect(screen.getByText('Today')).toBeInTheDocument();
  expect(screen.getByText('Proposal sent by Zul')).toHaveClass('ib-sys');
  expect(screen.getByText('· No email or text went out')).toHaveClass('ib-sys-fail');
  expect(screen.getByText('You · 10:30 AM')).toBeInTheDocument();
  expect(screen.getByText('Not delivered: Unreachable (30003)')).toBeInTheDocument();
  expect(screen.getByText('On it').closest('.sms-bubble')).toHaveClass('sms-bubble-outbound', 'ib-bubble-failed');
  expect(screen.getByRole('link', { name: 'Photo' })).toHaveAttribute('href', 'https://example.test/m/1');
});

test('context card: the legal-hold banner, rows with chips, the money grid and links', () => {
  const model = contextModel({
    kind: 'client', status_chip: 'Booked', event_type_label: 'Wedding', guests: 160,
    when_text: 'Sat Oct 24 · 6–11 PM', where_text: 'Example Hall, Chicago',
    proposal: { id: 41, status_label: 'Signed Sep 12', chip: 'Signed' },
    money: { total: 4200, paid: 1000, balance: 3200, due_date: '2026-10-10' },
    links: { client_id: 7, proposal_id: 41, event_id: 41 },
  }, { legalHold: true });
  render(<MemoryRouter><ContextCard model={model} /></MemoryRouter>);
  expect(screen.getByRole('note')).toHaveTextContent('Legal hold: check with Dallas before contacting');
  expect(screen.getByText('Booked')).toBeInTheDocument();
  expect(screen.getByText('Signed')).toBeInTheDocument();
  expect(screen.getByText('$3,200')).toHaveClass('ib-bal-open');
  expect(screen.getByText('due Oct 10')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Event' })).toHaveAttribute('href', '/events/41');
});

test('context pane (desktop) shows the same facts, and asks for a pick when empty', () => {
  const { rerender } = render(<MemoryRouter><ContextPane model={null} /></MemoryRouter>);
  expect(screen.getByText('Pick someone from the list.')).toBeInTheDocument();
  const model = contextModel({ kind: 'staff', role: 'Bartender', shift: { id: 9, when_text: 'Sat Oct 10 · 4–11 PM', event_text: 'Sample wedding', roster: { filled: 3, total: 4 } }, links: { user_id: 31, shift_id: 9 } });
  rerender(<MemoryRouter><ContextPane model={model} /></MemoryRouter>);
  expect(screen.getByText('1 open')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Staff profile' })).toHaveAttribute('href', '/staffing/users/31');
});

test('phone actions: On it, Take over on someone else\'s claim, You\'re on it on your own', () => {
  const onClaim = jest.fn();
  const { rerender } = render(<PhoneActions state={{ type: null }} busy={false} onClaim={onClaim} onSnooze={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'On it' }));
  expect(onClaim).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'claim' }));
  rerender(<PhoneActions state={{ type: 'claim', mine: false, by_name: 'Zul' }} busy={false} onClaim={onClaim} onSnooze={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
  expect(onClaim).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'claim', takeoverFrom: 'Zul' }));
  rerender(<PhoneActions state={{ type: 'claim', mine: true }} busy={false} onClaim={onClaim} onSnooze={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: "You're on it" }));
  expect(onClaim).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'release' }));
});

test('the banner on an item that is not waiting: Handled with Reopen, Snoozed with Wake', () => {
  const onReopen = jest.fn();
  const onWake = jest.fn();
  const { rerender } = render(<ItemBanner nowMs={NOW} onReopen={onReopen} onWake={onWake}
    item={{ waiting: false, status: 'handled', closed: { reason_text: 'You texted back from 1922', closed_at: '2026-10-06T19:41:00.000Z', by: 'D' }, snooze: null }} />);
  expect(screen.getByText('Handled · You texted back from 1922 · 2:41 PM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  expect(onReopen).toHaveBeenCalled();
  rerender(<ItemBanner nowMs={NOW} onReopen={onReopen} onWake={onWake}
    item={{ waiting: false, status: 'snoozed', closed: null, snooze: { until: '2026-10-07T13:00:00.000Z', by_name: 'Zul', mine: false } }} />);
  expect(screen.getByText('Snoozed until Wed 8:00 AM')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Wake' }));
  expect(onWake).toHaveBeenCalled();
  // A handled payload without `closed` still offers Reopen.
  rerender(<ItemBanner nowMs={NOW} onReopen={onReopen} onWake={onWake} item={{ waiting: false, status: 'handled', snooze: null }} />);
  expect(screen.getByText('Handled in the last 7 days')).toBeInTheDocument();
  rerender(<ItemBanner nowMs={NOW} onReopen={onReopen} onWake={onWake} item={{ waiting: true, status: 'waiting' }} />);
  expect(screen.queryByRole('button')).toBeNull();
});

// The desktop Snooze menu. tap() fires a pointer's real order, so the menu's
// outside-mousedown listener hears the press before the button hears its click.
describe('the desktop Snooze menu', () => {
  const tap = (el) => { fireEvent.mouseDown(el); fireEvent.mouseUp(el); fireEvent.click(el); };
  const actions = (onSnooze = () => {}) => (
    <DesktopActions state={{ type: null }} busy={false} nowMs={NOW} onClaim={() => {}} onSnooze={onSnooze} onDone={() => {}} />
  );

  test('the Snooze button closes its own open menu; a click elsewhere and a pick still close it', () => {
    const onSnooze = jest.fn();
    render(<div><button type="button">Elsewhere</button>{actions(onSnooze)}</div>);
    const snooze = screen.getByRole('button', { name: /Snooze/ });
    tap(snooze);
    expect(screen.getByRole('group', { name: 'Snooze until' })).toBeInTheDocument();
    tap(snooze);
    expect(screen.queryByRole('group', { name: 'Snooze until' })).toBeNull();
    expect(snooze).toHaveAttribute('aria-expanded', 'false');
    tap(snooze);
    tap(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('group', { name: 'Snooze until' })).toBeNull();
    tap(snooze);
    tap(screen.getByRole('button', { name: /3 hours/ }));
    expect(screen.queryByRole('group', { name: 'Snooze until' })).toBeNull();
    expect(onSnooze).toHaveBeenCalledWith(new Date(NOW + 3 * 3600 * 1000).toISOString());
  });

  test('it focuses its first option on open, and a re-render with a new onClose leaves focus where the user is', () => {
    const before = jest.fn();
    const after = jest.fn();
    const view = render(<SnoozeMenu nowMs={NOW} onPick={() => {}} onClose={before} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /3 hours/ }));
    const pick = screen.getByRole('button', { name: /Pick a date/ });
    pick.focus();
    // The 30 s clock tick: the owner re-renders and passes a new onClose.
    view.rerender(<SnoozeMenu nowMs={NOW + 30000} onPick={() => {}} onClose={after} />);
    expect(document.activeElement).toBe(pick);
    fireEvent.keyDown(pick, { key: 'Escape' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
  });

  test('Escape closes the menu and puts focus back on the Snooze button', () => {
    render(actions());
    const snooze = screen.getByRole('button', { name: /Snooze/ });
    // A keyboard user: Enter on the focused button is a click with no press.
    snooze.focus();
    fireEvent.click(snooze);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /3 hours/ }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Snooze until' })).toBeNull();
    expect(document.activeElement).toBe(snooze);
  });

  // No arrow-key contract and content that is not an item: a labelled group
  // of plain buttons, not a menu (code-review 2026-10-09).
  test('it is a labelled group of plain buttons: no menu or menuitem role, and the Snooze button promises no menu', () => {
    render(actions());
    const snooze = screen.getByRole('button', { name: /Snooze/ });
    expect(snooze).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(snooze);
    expect(snooze).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Snooze until' });
    fireEvent.click(within(group).getByRole('button', { name: /Pick a date/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryAllByRole('menuitem')).toEqual([]);
    // Two presets, Pick a date, and the seven days.
    expect(within(group).getAllByRole('button')).toHaveLength(10);
  });

  // The design's desktop menu has no caption under the days; the phone sheet
  // keeps its own.
  test('the date grid has no caption on the desktop; the phone sheet keeps it', () => {
    render(actions());
    fireEvent.click(screen.getByRole('button', { name: /Snooze/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pick a date/ }));
    expect(screen.getByRole('button', { name: 'Wed Oct 7, 8:00 AM' })).toBeInTheDocument();
    expect(screen.queryByText('wakes at 8:00 AM on the day you pick')).toBeNull();
  });

  test('Escape from a field the user tabbed on to closes the menu and leaves focus in that field', () => {
    render(<div>{actions()}<textarea aria-label="Reply" /></div>);
    fireEvent.click(screen.getByRole('button', { name: /Snooze/ }));
    // The menu stays open when focus tabs out of it (no press, no Escape yet).
    const reply = screen.getByRole('textbox', { name: 'Reply' });
    reply.focus();
    expect(screen.getByRole('group', { name: 'Snooze until' })).toBeInTheDocument();
    fireEvent.keyDown(reply, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Snooze until' })).toBeNull();
    expect(document.activeElement).toBe(reply);
  });
});

// The phone Snooze sheet for an unknown number, whose name is the formatted
// phone. Sentry's click breadcrumbs serialize the clicked element's and its
// ancestors' aria-label, title, alt, name and type, so none of them may carry
// the name: the dialog takes its accessible name from the title's text, which
// a crumb never reads. The fixture is built from parts (the repo is public):
// a fiction-range number.
test('the phone Snooze sheet for an unknown number puts no digit of its name where a click crumb reads', () => {
  const parts = ['773', '555', ['01', '63'].join('')];
  const name = `(${parts[0]}) ${parts[1]}-${parts[2]}`;
  render(<SnoozeSheet name={name} nowMs={NOW} onPick={() => {}} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog', { name: `Snooze ${name}` });
  expect(dialog).toHaveAttribute('aria-labelledby', screen.getByRole('heading', { name: `Snooze ${name}` }).id);
  const CRUMB_ATTRS = ['aria-label', 'title', 'alt', 'name', 'type'];
  const crumbValues = () => Array.from(document.body.querySelectorAll('*'))
    .flatMap((el) => CRUMB_ATTRS.map((a) => el.getAttribute(a)).filter(Boolean));
  const digits = new Set(name.replace(/\D/g, ''));
  expect(crumbValues().filter((v) => [...v].some((ch) => digits.has(ch)))).toEqual([]);
  // The date grid's labels carry dates ("Wed Oct 7, 8:00 AM"), never the number.
  fireEvent.click(screen.getByRole('button', { name: /Pick a date/ }));
  expect(crumbValues().filter((v) => parts.some((part) => v.includes(part)))).toEqual([]);
  expect(screen.getByText('wakes at 8:00 AM on the day you pick')).toBeInTheDocument();
});
