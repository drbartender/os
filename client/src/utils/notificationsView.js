// The Notifications screen's copy and state rules (spec 2026-08-13-mobile-admin
// section 3, "Design-session decisions of 2026-10-14", and section 7). Pure:
// no React, no network, so the words the screen shows are pinned by tests.
// Copy law: no em dashes; the typographic apostrophe where the benchmark
// draws one.

export const KIND_GROUPS = [
  {
    label: 'Bookings and payments',
    help: 'A client signs and pays, or a last-minute booking comes in.',
    kinds: [
      { kind: 'booking_signed', label: 'Client signed' },
      { kind: 'booking_signed_paid', label: 'Signed and paid' },
      { kind: 'payment_landed', label: 'Payment landed' },
      { kind: 'booking_last_minute', label: 'Last-minute booking' },
    ],
  },
  {
    label: 'Drink plans',
    help: 'A client submits their drink plan. Your cue to start the shopping list and the menu.',
    kinds: [{ kind: 'drink_plan_submitted', label: 'Plan submitted' }],
  },
  {
    label: 'Staffing',
    help: 'A staff member drops a shift, or asks for cover or a swap.',
    kinds: [
      { kind: 'staffing_drop', label: 'Shift drops' },
      { kind: 'staffing_cover_swap', label: 'Cover and swaps' },
    ],
  },
];

export const NOTE_BLOCKED = 'Android has blocked notifications for DrB OS. Allow them for DrB OS in Android settings, then come back here.';
export const NOTE_SERVER_UNSET = 'Push isn’t set up on the server yet.';
export const FOOT_LINES = [
  'Texts and emails keep coming as they do today. This only adds the phone banner.',
  'Managers see this same page for their own account.',
];
export const OFFLINE_BANNER = { title: 'Offline', body: 'Changing these needs a connection. You are looking at the last saved settings.' };

// An absent key is ON (the server stores only explicit values).
export const kindOn = (prefs, kind) => !prefs || prefs[kind] !== false;

// device: readDevicePushState()'s answer. The server's key gates on and off:
// with no key nothing can subscribe, and a stale subscription cannot be
// served, so the honest state is "not set up on the server".
export function phoneState({ device, publicKey }) {
  if (device === 'unsupported' || device === 'blocked') return device;
  if (!publicKey) return 'server_unset';
  return device === 'on' ? 'on' : 'off';
}

export function phoneSub(state, prompting) {
  if (prompting) return 'Android is asking for permission…';
  if (state === 'on') return 'Banners for what you pick below';
  if (state === 'blocked') return 'Blocked in Android settings';
  if (state === 'server_unset') return 'Not set up on the server yet';
  // No service worker or no Push API: the switch is disabled with no note, so
  // the sub-line is the only place that says why (Task 8 review, 2026-10-14).
  if (state === 'unsupported') return 'Not available in this browser';
  return 'Android asks for permission when you turn this on';
}

export function rowState(state) {
  if (state === 'on') return { text: 'On', tone: 'on' };
  if (state === 'blocked') return { text: 'Blocked', tone: 'warn' };
  return { text: 'Off', tone: 'off' };
}

export function catsIntro(state) {
  return state === 'on'
    ? 'Saved to your account, so every phone you turn on follows these.'
    : 'Saved to your account. Nothing reaches this phone until it is on above.';
}

// test: 'idle' | 'sending' | 'sent' | 'failed'
export function testStatus({ offline, state, test }) {
  if (offline) return { text: 'Offline', tone: 'muted', disabled: true };
  if (state !== 'on') return { text: 'Phone is off', tone: 'muted', disabled: true };
  // Sending keeps the row's ink (the benchmark's nTestInk stays ink 1); the
  // handler ignores a second tap while a send is in flight (decision 15).
  if (test === 'sending') return { text: 'Sending', tone: 'muted', disabled: false };
  if (test === 'sent') return { text: 'Sent', tone: 'ok', disabled: false };
  if (test === 'failed') return { text: 'Didn’t send', tone: 'danger', disabled: false };
  return { text: '', tone: null, disabled: false };
}
