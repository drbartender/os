import {
  HOT_HOURS, isPersonKey, channelLabel, channelIcon, threadChannel, threadChannels, channelCount, channelJoin,
  waitParts, stateChip, stateNote, stampLabel, agoLabel, feedItems, handledGroups, snoozeOptions, lateNote,
  optOutText, lastGoodLine, sortWaiting, firstWaitingKey, claimButton,
} from './inboxFormat';

// "Now" is Tue Oct 6 2026, 2:40 PM Chicago (CDT, UTC-5). Every fixture is
// ISO-UTC, the wire format.
const NOW = Date.parse('2026-10-06T19:40:00.000Z');
const ago = (mins) => new Date(NOW - mins * 60000).toISOString();

test('person keys: what the server parses, nothing else', () => {
  ['c-12', 's-2', 'c-2147483647', 'p-3125550100', 'p-0012345678', 't-neg_123-AB', 't-123456789012345678']
    .forEach((k) => expect(isPersonKey(k)).toBe(true));
  // A second spelling of one row, past int4, a p- that is not 10 digits, and
  // everything the server's patterns refuse.
  ['c-007', 's-01', 'c-2147483648', `c-${'1'.repeat(21)}`, 'p-312555010', 'p-31255501000',
    '', 'c-', 'x-1', 'c-1a', 'C-1', ' c-1', 'c-1 ', 't-', 't-bad key', 't-a.b', `t-${'a'.repeat(101)}`, null, 12]
    .forEach((k) => expect(isPersonKey(k)).toBe(false));
});

test('channel labels and icons, with a text row mapped through its line', () => {
  expect(channelLabel('text_1922')).toBe('Text 1922');
  expect(channelLabel('staff_text')).toBe('Staff text');
  expect(channelLabel('thumbtack')).toBe('Thumbtack');
  expect(channelLabel('carrier_pigeon')).toBe('Carrier pigeon');
  expect(channelIcon('thumbtack')).toBe('card');
  expect(channelIcon('staff_text')).toBe('userplus');
  expect(channelIcon('text_888')).toBe('chat');
  expect(threadChannel({ channel: 'text', line: '0082' })).toBe('text_0082');
  expect(threadChannel({ channel: 'text', line: null })).toBe('text_888');
  expect(threadChannel({ channel: 'thumbtack' })).toBe('thumbtack');
});

test('thread channels: distinct, first seen first, system rows ignored, optional floor', () => {
  const thread = [
    { direction: 'in', channel: 'thumbtack', at: ago(3000) },
    { direction: 'system', channel: 'thumbtack', at: ago(2900) },
    { direction: 'out', channel: 'text', line: '1922', at: ago(100) },
    { direction: 'in', channel: 'text', line: '1922', at: ago(50) },
  ];
  expect(threadChannels(thread)).toEqual(['thumbtack', 'text_1922']);
  expect(threadChannels(thread, ago(200))).toEqual(['text_1922']);
  expect(channelCount(['text_1922'])).toBe('Text 1922');
  expect(channelCount(['text_1922', 'thumbtack'])).toBe('2 channels');
  expect(channelJoin(['text_1922', 'email'])).toBe('Text 1922 + Email');
});

test('wait parts: minutes, hours, days; red at exactly 24 hours', () => {
  expect(waitParts(ago(26), NOW)).toMatchObject({ n: '26', unit: 'MIN', long: '26 min', short: '26m', hot: false, tone: 'info' });
  expect(waitParts(ago(110), NOW)).toMatchObject({ n: '1', unit: 'HR', long: '1 hr 50 min', short: '1h', tone: 'info' });
  expect(waitParts(ago(60), NOW).long).toBe('1 hr');
  expect(waitParts(ago(4 * 60), NOW)).toMatchObject({ n: '4', unit: 'HRS', long: '4 hrs', tone: 'warn' });
  expect(waitParts(ago(HOT_HOURS * 60 - 1), NOW)).toMatchObject({ n: '23', hot: false, tone: 'warn' });
  expect(waitParts(ago(HOT_HOURS * 60), NOW)).toMatchObject({ n: '24', unit: 'HRS', hot: true, tone: 'danger' });
  expect(waitParts(ago(46 * 60), NOW)).toMatchObject({ n: '46', long: '46 hrs', short: '46h' });
  expect(waitParts(ago(67 * 60), NOW)).toMatchObject({ n: '2', unit: 'DAYS', long: '2 days', short: '2d', hot: true });
  expect(waitParts(null, NOW)).toBeNull();
});

test('state chip: the four states and their copy', () => {
  expect(stateChip({ type: 'claim', mine: true })).toEqual({ kind: 'ok', label: "You're on it" });
  expect(stateChip({ type: 'claim', mine: false, by_name: 'Zul' })).toEqual({ kind: 'info', label: "Zul's on it" });
  expect(stateChip({ type: 'claim', mine: false, by_name: 'Dallas' })).toEqual({ kind: 'info', label: 'Dallas is on it' });
  expect(stateChip({ type: 'promise', mine: true })).toEqual({ kind: 'warn', label: "You said you'd follow up" });
  expect(stateChip({ type: 'promise', mine: false, by_name: null })).toEqual({ kind: 'warn', label: 'Follow-up promised' });
  expect(stateChip({ type: 'reopened' })).toEqual({ kind: 'neutral', label: 'Reopened' });
  expect(stateChip({ type: 'unseen' })).toEqual({ kind: 'accent', label: 'Not read yet' });
  expect(stateChip({ type: null })).toBeNull();
  expect(stateChip(null)).toBeNull();
});

test('a deliberate open drops "Not read yet" and keeps every other chip', () => {
  expect(stateChip({ type: 'unseen' }, { deliberate: true })).toBeNull();
  expect(stateChip({ type: 'reopened' }, { deliberate: true })).toEqual({ kind: 'neutral', label: 'Reopened' });
});

test('state note: who promised what, and since when a claim stands', () => {
  expect(stateNote({ type: 'promise', mine: true, promised_by: 'Monday' }, NOW)).toBe('You said Monday');
  expect(stateNote({ type: 'promise', mine: false, by_name: 'Zul', promised_by: 'Friday' }, NOW)).toBe('Zul said Friday');
  expect(stateNote({ type: 'promise', mine: false, by_name: null, promised_by: 'tomorrow' }, NOW)).toBe('Promised tomorrow');
  expect(stateNote({ type: 'promise', mine: true, promised_by: null }, NOW)).toBeNull();
  // Mon Oct 5, 11:02 AM Chicago.
  expect(stateNote({ type: 'claim', since: '2026-10-05T16:02:00.000Z' }, NOW)).toBe('since Mon 11:02 AM');
  expect(stateNote({ type: 'claim' }, NOW)).toBeNull();
});

test('stamps: time today, weekday within six days, full date beyond', () => {
  expect(stampLabel('2026-10-06T22:41:00.000Z', NOW)).toBe('5:41 PM');
  expect(stampLabel('2026-10-07T13:00:00.000Z', NOW)).toBe('Wed 8:00 AM');
  expect(stampLabel('2026-10-15T13:00:00.000Z', NOW)).toBe('Thu Oct 15, 8:00 AM');
  expect(stampLabel('nope', NOW)).toBe('');
});

test('ago labels for the feeds line', () => {
  expect(agoLabel(ago(0), NOW)).toBe('just now');
  expect(agoLabel(ago(12), NOW)).toBe('12 min ago');
  expect(agoLabel(ago(60), NOW)).toBe('1 hr ago');
  expect(agoLabel(ago(180), NOW)).toBe('3 hrs ago');
  expect(agoLabel(ago(60 * 24), NOW)).toBe('1 day ago');
  expect(agoLabel(ago(60 * 50), NOW)).toBe('2 days ago');
});

test('feed items: each source, never, the quiet flag, and the AI status when not on', () => {
  const items = feedItems([
    { source: 'thumbtack', last_at: ago(12), quiet: false },
    { source: '888', last_at: ago(3), quiet: false },
    { source: '1922', last_at: ago(60 * 50), quiet: true },
    { source: '0082', last_at: null, quiet: true },
  ], { status: 'off' }, NOW);
  expect(items.map((i) => i.text)).toEqual(['Thumbtack 12 min ago', '888 3 min ago', '1922 2 days ago', '0082 never', 'AI read off']);
  expect(items.map((i) => i.quiet)).toEqual([false, false, true, true, true]);
  expect(items[0].title).toBe('Thumbtack last delivered Tue Oct 6, 2:28 PM CT');
  expect(feedItems([], { status: 'on' }, NOW)).toEqual([]);
  expect(feedItems([], { status: 'paused' }, NOW)[0].text).toBe('AI read paused at its daily cap');
  expect(feedItems([], { status: 'failing' }, NOW)[0].text).toBe('AI read failing');
});

test('handled groups by Chicago day, newest first, with the who badge', () => {
  const groups = handledGroups([
    { person_key: 'c-1', name: 'Avery Example', channel: 'text_1922', closed_at: '2026-10-05T18:30:00.000Z', reason_text: 'You texted back from 1922', by: 'D' },
    { person_key: 'c-2', name: 'Jo Test', need: 'Wants a quote for 75 guests', channel: 'thumbtack', closed_at: '2026-10-06T16:20:00.000Z', reason_text: 'Proposal sent by Zul', by: 'Z' },
    { person_key: 't-9', name: 'Quinn Sample', channel: 'thumbtack', closed_at: '2026-10-03T23:18:00.000Z', reason_text: 'Replied in Thumbtack', by: null },
    { person_key: 'c-3', name: 'Robin Case', channel: 'text_888', closed_at: '2026-10-06T13:41:00.000Z', reason_text: 'AI: just a thank-you', by: 'AI' },
  ], NOW);
  expect(groups.map((g) => g.day)).toEqual(['Today', 'Yesterday', 'Sat Oct 3']);
  expect(groups[0].items.map((i) => i.name)).toEqual(['Jo Test', 'Robin Case']);
  expect(groups[0].items[0]).toMatchObject({ time: '11:20 AM', need: 'Wants a quote for 75 guests', reason: 'Proposal sent by Zul', channel: 'Thumbtack' });
  expect(groups[0].items[1].need).toBe('');
  expect(groups[0].items[0].who).toMatchObject({ label: 'Z' });
  expect(groups[0].items[1].who).toMatchObject({ label: 'AI', cls: 'ib-who ib-who-ai' });
  expect(groups[2].items[0].who).toBeNull();
});

test('snooze presets: 3 hours, tomorrow 8:00 AM, and tomorrow through a week out at 8:00 AM', () => {
  const { presets, days } = snoozeOptions(NOW);
  expect(presets[0]).toMatchObject({ label: '3 hours', when: '5:40 PM', until: '2026-10-06T22:40:00.000Z' });
  expect(presets[1]).toMatchObject({ label: 'Tomorrow morning', when: 'Wed 8:00 AM', until: '2026-10-07T13:00:00.000Z' });
  expect(days.map((d) => `${d.dow} ${d.day}`)).toEqual(['WED 7', 'THU 8', 'FRI 9', 'SAT 10', 'SUN 11', 'MON 12', 'TUE 13']);
  expect(days[1]).toMatchObject({ until: '2026-10-08T13:00:00.000Z', label: 'Thu Oct 8, 8:00 AM' });
  // Every pick sits inside the server's 8-day limit, even just after midnight.
  const lateNight = Date.parse('2026-10-06T05:01:00.000Z'); // 12:01 AM Chicago
  snoozeOptions(lateNight).days.forEach((d) => expect(Date.parse(d.until) - lateNight).toBeLessThan(8 * 86400000));
});

test('late hours: outside 8 AM to 9 PM Chicago the composer warns', () => {
  expect(lateNote(Date.parse('2026-10-07T03:40:00.000Z'))).toBe("It's 10:40 PM for them");
  expect(lateNote(Date.parse('2026-10-06T12:59:00.000Z'))).toBe("It's 7:59 AM for them");
  expect(lateNote(Date.parse('2026-10-06T13:00:00.000Z'))).toBeNull(); // 8:00 AM
  expect(lateNote(Date.parse('2026-10-07T01:59:00.000Z'))).toBeNull(); // 8:59 PM
  expect(lateNote(Date.parse('2026-10-07T02:00:00.000Z'))).toBe("It's 9:00 PM for them");
});

test('opted-out copy: with a date, and without one', () => {
  expect(optOutText({ since: '2026-09-28T15:04:00.000Z' })).toBe('Texts are off for this person since Sep 28. Texts from 888, 1922 or 0082 will not deliver.');
  expect(optOutText({ since: null })).toBe('Texts are off for this person. Texts from 888, 1922 or 0082 will not deliver.');
});

test('last good load line carries CT and the count', () => {
  expect(lastGoodLine({ at: '2026-10-06T19:12:00.000Z', waiting: 8 })).toBe('Last good load 2:12 PM CT · 8 were waiting');
  expect(lastGoodLine({ at: '2026-10-06T19:12:00.000Z', waiting: 1 })).toBe('Last good load 2:12 PM CT · 1 was waiting');
  expect(lastGoodLine(null)).toBeNull();
});

test('waiting order and the desktop auto-pick', () => {
  const rows = [
    { person_key: 'c-1', waiting_since: ago(30) },
    { person_key: 'c-2', waiting_since: ago(3000) },
    { person_key: 'c-3', waiting_since: ago(300) },
  ];
  expect(sortWaiting(rows).map((r) => r.person_key)).toEqual(['c-2', 'c-3', 'c-1']);
  expect(firstWaitingKey(rows)).toBe('c-2');
  expect(firstWaitingKey(rows, 'c-2')).toBe('c-3');
  expect(firstWaitingKey([], null)).toBeNull();
});

test('the claim button: On it, release your own, take over someone else', () => {
  expect(claimButton({ type: null })).toMatchObject({ action: 'claim', label: 'On it', icon: 'pin', mine: false });
  expect(claimButton({ type: 'unseen' })).toMatchObject({ action: 'claim', label: 'On it' });
  expect(claimButton({ type: 'claim', mine: true })).toMatchObject({ action: 'release', label: "You're on it", icon: 'check', mine: true });
  expect(claimButton({ type: 'claim', mine: false, by_name: 'Zul' })).toMatchObject({
    action: 'claim', label: 'Take over', longLabel: 'Take over from Zul', icon: 'userplus', takeoverFrom: 'Zul',
  });
});
