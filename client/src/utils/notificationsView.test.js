import '@testing-library/jest-dom';
import {
  KIND_GROUPS, kindOn, phoneState, phoneSub, rowState, testStatus, catsIntro,
  NOTE_BLOCKED, NOTE_SERVER_UNSET, FOOT_LINES, OFFLINE_BANNER,
} from './notificationsView';

test('the three groups carry the seven kinds in the benchmark order with its copy', () => {
  expect(KIND_GROUPS.map((g) => g.label)).toEqual(['Bookings and payments', 'Drink plans', 'Staffing']);
  expect(KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.kind))).toEqual([
    'booking_signed', 'booking_signed_paid', 'payment_landed', 'booking_last_minute', 'drink_plan_submitted', 'staffing_drop', 'staffing_cover_swap',
  ]);
  expect(KIND_GROUPS.flatMap((g) => g.kinds.map((k) => k.label))).toEqual([
    'Client signed', 'Signed and paid', 'Payment landed', 'Last-minute booking', 'Plan submitted', 'Shift drops', 'Cover and swaps',
  ]);
  expect(KIND_GROUPS[1].help).toBe('A client submits their drink plan. Your cue to start the shopping list and the menu.');
});

test('kindOn: absent is on', () => {
  expect(kindOn({}, 'staffing_drop')).toBe(true);
  expect(kindOn({ staffing_drop: false }, 'staffing_drop')).toBe(false);
  expect(kindOn(null, 'staffing_drop')).toBe(true);
});

test('phoneState: the server key gates a device that would otherwise be off or on', () => {
  expect(phoneState({ device: 'on', publicKey: 'k' })).toBe('on');
  expect(phoneState({ device: 'off', publicKey: 'k' })).toBe('off');
  expect(phoneState({ device: 'off', publicKey: null })).toBe('server_unset');
  expect(phoneState({ device: 'on', publicKey: null })).toBe('server_unset');
  expect(phoneState({ device: 'blocked', publicKey: null })).toBe('blocked');
  expect(phoneState({ device: 'unsupported', publicKey: 'k' })).toBe('unsupported');
});

test('the switch row sub-line, the More row state and the intro follow the benchmark copy', () => {
  expect(phoneSub('on', false)).toBe('Banners for what you pick below');
  expect(phoneSub('off', false)).toBe('Android asks for permission when you turn this on');
  expect(phoneSub('blocked', false)).toBe('Blocked in Android settings');
  expect(phoneSub('server_unset', false)).toBe('Not set up on the server yet');
  expect(phoneSub('off', true)).toBe('Android is asking for permission…');
  expect(rowState('on')).toEqual({ text: 'On', tone: 'on' });
  expect(rowState('off')).toEqual({ text: 'Off', tone: 'off' });
  expect(rowState('server_unset')).toEqual({ text: 'Off', tone: 'off' });
  expect(rowState('blocked')).toEqual({ text: 'Blocked', tone: 'warn' });
  expect(catsIntro('on')).toBe('Saved to your account, so every phone you turn on follows these.');
  expect(catsIntro('off')).toBe('Saved to your account. Nothing reaches this phone until it is on above.');
});

test('the test row status', () => {
  expect(testStatus({ offline: true, state: 'on', test: 'idle' })).toEqual({ text: 'Offline', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'off', test: 'idle' })).toEqual({ text: 'Phone is off', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'server_unset', test: 'idle' })).toEqual({ text: 'Phone is off', tone: 'muted', disabled: true });
  expect(testStatus({ offline: false, state: 'on', test: 'idle' })).toEqual({ text: '', tone: null, disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'sending' })).toEqual({ text: 'Sending', tone: 'muted', disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'sent' })).toEqual({ text: 'Sent', tone: 'ok', disabled: false });
  expect(testStatus({ offline: false, state: 'on', test: 'failed' })).toEqual({ text: 'Didn’t send', tone: 'danger', disabled: false });
});

test('copy constants carry no em dash', () => {
  const all = [NOTE_BLOCKED, NOTE_SERVER_UNSET, ...FOOT_LINES, OFFLINE_BANNER.title, OFFLINE_BANNER.body, ...KIND_GROUPS.map((g) => g.help)];
  for (const s of all) expect(s).not.toMatch(/\u2014/);
  expect(NOTE_BLOCKED).toBe('Android has blocked notifications for DrB OS. Allow them for DrB OS in Android settings, then come back here.');
  expect(NOTE_SERVER_UNSET).toBe('Push isn’t set up on the server yet.');
  expect(FOOT_LINES).toEqual(['Texts and emails keep coming as they do today. This only adds the phone banner.', 'Managers see this same page for their own account.']);
  expect(OFFLINE_BANNER).toEqual({ title: 'Offline', body: 'Changing these needs a connection. You are looking at the last saved settings.' });
});

test('an unsupported browser says so on the switch row, not the Off copy', () => {
  expect(phoneSub('unsupported', false)).toBe('Not available in this browser');
  expect(phoneSub('unsupported', false)).not.toMatch(/\u2014/);
});
