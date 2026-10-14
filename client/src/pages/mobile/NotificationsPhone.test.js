import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NotificationsPhone from './NotificationsPhone';
import api from '../../utils/api';
import { offlineGet } from '../../utils/offlineRead';
import * as adminPush from '../../utils/adminPush';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() } }));
jest.mock('../../utils/offlineRead', () => ({ offlineGet: jest.fn(), OFFLINE_OK_HEADER: 'X-Offline-Ok' }));
jest.mock('../../utils/adminPush', () => ({
  readDevicePushState: jest.fn(), enableAdminPush: jest.fn(), disableAdminPush: jest.fn(), ADMIN_SW_PATH: '/admin-sw.js',
}));
const mockView = { isPhone: true, desktopView: () => false, setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockView }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

const PREFS = (over = {}) => ({
  data: {
    notification_preferences: {}, categories: [],
    admin_push_preferences: { booking_signed: true, booking_signed_paid: true, payment_landed: true, booking_last_minute: true, drink_plan_submitted: true, staffing_drop: true, staffing_cover_swap: true, ...over.prefs },
    push: { public_key: over.key === undefined ? 'KEY' : over.key, kinds: [] },
  },
  staleAt: over.staleAt || null,
});
const renderScreen = () => render(
  <MemoryRouter initialEntries={['/more/notifications']}>
    <Routes>
      <Route path="/more/notifications" element={<NotificationsPhone />} />
      <Route path="/settings" element={<div>desktop settings</div>} />
    </Routes>
  </MemoryRouter>
);
const sw = (name) => screen.getByRole('switch', { name });

beforeEach(() => {
  offlineGet.mockResolvedValue(PREFS());
  adminPush.readDevicePushState.mockResolvedValue('on');
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: { subscriptions: 1, sent: 1, failed: 0, gone: 0, reason: null } });
});

test('loads the seven switches on, the phone switch on, from the preferences read', async () => {
  renderScreen();
  expect(await screen.findByText('Banners for what you pick below')).toBeInTheDocument();
  expect(offlineGet).toHaveBeenCalledWith('/me/notification-preferences');
  for (const name of ['Client signed', 'Signed and paid', 'Payment landed', 'Last-minute booking', 'Plan submitted', 'Shift drops', 'Cover and swaps']) {
    expect(sw(name)).toHaveAttribute('aria-checked', 'true');
  }
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('Saved to your account, so every phone you turn on follows these.')).toBeInTheDocument();
  expect(screen.getByText('Managers see this same page for their own account.')).toBeInTheDocument();
});

test('a kind switch flips at once, saves, and flips back with Didn’t save when the save fails', async () => {
  let reject;
  api.patch.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Shift drops'));
  expect(sw('Shift drops')).toHaveAttribute('aria-checked', 'false');
  expect(sw('Shift drops')).toHaveAttribute('aria-busy', 'true');
  expect(api.patch).toHaveBeenCalledWith('/me/notification-preferences', { admin_push_preferences: { staffing_drop: false } });
  await act(async () => { reject(new Error('offline')); });
  await waitFor(() => expect(sw('Shift drops')).toHaveAttribute('aria-checked', 'true'));
  expect(screen.getByText('Didn’t save')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Shift drops' }));
  expect(api.patch).toHaveBeenCalledTimes(2);
});

test('the phone switch asks Android, then subscribes; blocked shows the note and disables the test row', async () => {
  adminPush.readDevicePushState.mockResolvedValue('off');
  adminPush.enableAdminPush.mockResolvedValue({ ok: true, state: 'granted' });
  renderScreen();
  await screen.findByText('Android asks for permission when you turn this on');
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
  fireEvent.click(sw('Notifications on this phone'));
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-busy', 'true');
  expect(adminPush.enableAdminPush).toHaveBeenCalledWith('KEY');
  await screen.findByText('Banners for what you pick below');
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');

  adminPush.readDevicePushState.mockResolvedValue('blocked');
  renderScreen();
  const notes = await screen.findAllByText(/Android has blocked notifications for DrB OS/);
  expect(notes.length).toBeGreaterThan(0);
  const blocked = screen.getAllByRole('switch', { name: 'Notifications on this phone' }).pop();
  expect(blocked).toBeDisabled();
});

test('no server key: the switch is disabled with the server note; the row says Phone is off', async () => {
  offlineGet.mockResolvedValue(PREFS({ key: null }));
  adminPush.readDevicePushState.mockResolvedValue('off');
  renderScreen();
  expect(await screen.findByText('Push isn’t set up on the server yet.')).toBeInTheDocument();
  expect(sw('Notifications on this phone')).toBeDisabled();
  expect(screen.getByText('Not set up on the server yet')).toBeInTheDocument();
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
});

test('the test row posts, reads Sent, and Didn’t send with Retry when nothing was sent', async () => {
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(screen.getByRole('button', { name: /Send a test notification/ }));
  expect(api.post).toHaveBeenCalledWith('/me/push-test');
  expect(await screen.findByText('Sent')).toBeInTheDocument();
  api.post.mockResolvedValue({ data: { subscriptions: 1, sent: 0, failed: 1, gone: 0, reason: null } });
  fireEvent.click(screen.getByRole('button', { name: /Send a test notification/ }));
  expect(await screen.findByText('Didn’t send')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry the test notification' })).toBeInTheDocument();
});

test('a stored copy renders the offline banner with its time and disables everything', async () => {
  offlineGet.mockResolvedValue(PREFS({ staleAt: new Date().toISOString() }));
  renderScreen();
  // 'Offline' is also the test row's trailing state, so select the banner's title.
  expect(await screen.findByText('Offline', { selector: '.m-notif-banner-title' })).toBeInTheDocument();
  expect(screen.getByText(/You are looking at the last saved settings/)).toBeInTheDocument();
  // RTL trims the span's own text to 'as of'.
  expect(screen.getByText(/as of/)).toBeInTheDocument();
  for (const s of screen.getAllByRole('switch')) expect(s).toBeDisabled();
  expect(screen.getByText('Offline', { selector: '.m-more-state' })).toBeInTheDocument();
});

test('a failed read with no stored copy offers Retry; the skeleton shows while loading', async () => {
  let resolve;
  offlineGet.mockImplementation(() => new Promise((r) => { resolve = r; }));
  renderScreen();
  expect(document.querySelector('.m-notif-skel')).toBeInTheDocument();
  await act(async () => { resolve(Promise.reject(new Error('down'))); });
  expect(await screen.findByText(/Couldn’t load notification settings/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry loading' })).toBeInTheDocument();
});

test('a desktop-width visit, and a Desktop-view override, both land on Settings', async () => {
  mockView.isPhone = false;
  renderScreen();
  expect(await screen.findByText('desktop settings')).toBeInTheDocument();
  mockView.isPhone = true;
  mockView.desktopView = (k) => k === 'notifications';
  renderScreen();
  expect(await screen.findAllByText('desktop settings')).toHaveLength(2);
  expect(mockView.setDesktopView).toHaveBeenCalledWith('notifications', false);
  expect(mockView.setDesktopView).toHaveBeenCalledWith('settings', true);
  mockView.desktopView = () => false;
});

// Regression pins beyond the brief (implementer self-review, 2026-10-14).
test('the phone switch first renders with this phone\'s real state, never a placeholder Off', async () => {
  let resolveDevice;
  adminPush.readDevicePushState.mockImplementation(() => new Promise((r) => { resolveDevice = r; }));
  renderScreen();
  await waitFor(() => expect(offlineGet).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByRole('switch', { name: 'Notifications on this phone' })).toBeNull();
  expect(document.querySelector('.m-notif-skel')).toBeInTheDocument();
  await act(async () => { resolveDevice('on'); });
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');
});

test('a failed save flips back only its own switch; another switch saved meanwhile stays put', async () => {
  let rejectDrop;
  let resolveCover;
  api.patch
    .mockImplementationOnce(() => new Promise((_, r) => { rejectDrop = r; }))
    .mockImplementationOnce(() => new Promise((r) => { resolveCover = r; }));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Shift drops'));
  fireEvent.click(sw('Cover and swaps'));
  await act(async () => { rejectDrop(new Error('offline')); });
  await act(async () => { resolveCover({ data: {} }); });
  expect(sw('Shift drops')).toHaveAttribute('aria-checked', 'true');
  expect(sw('Cover and swaps')).toHaveAttribute('aria-checked', 'false');
  expect(within(sw('Shift drops').closest('li')).getByText('Didn’t save')).toBeInTheDocument();
  expect(within(sw('Cover and swaps').closest('li')).queryByText('Didn’t save')).toBeNull();
});

test('turning the phone off is busy but never says Android is asking', async () => {
  let resolveOff;
  adminPush.disableAdminPush.mockImplementation(() => new Promise((r) => { resolveOff = r; }));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Notifications on this phone'));
  expect(adminPush.disableAdminPush).toHaveBeenCalledWith();
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByText('Android is asking for permission…')).toBeNull();
  adminPush.readDevicePushState.mockResolvedValue('off');
  await act(async () => { resolveOff({ ok: true }); });
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
});

test('the kind rows and the test row are 44px, as the benchmark draws them', async () => {
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  expect(sw('Plan submitted')).toHaveStyle({ minHeight: '44px' });
  expect(screen.getByRole('button', { name: /Send a test notification/ })).toHaveStyle({ minHeight: '44px' });
});

test('a desktop-width visit reads nothing on its way to Settings', async () => {
  mockView.isPhone = false;
  renderScreen();
  expect(await screen.findByText('desktop settings')).toBeInTheDocument();
  expect(offlineGet).not.toHaveBeenCalled();
  expect(adminPush.readDevicePushState).not.toHaveBeenCalled();
  mockView.isPhone = true;
});

// Fix round 1 (Task 8 review, 2026-10-14).
test('an unsupported browser: the switch is disabled, says so, shows no note, and the test row says Phone is off', async () => {
  adminPush.readDevicePushState.mockResolvedValue('unsupported');
  renderScreen();
  expect(await screen.findByText('Not available in this browser')).toBeInTheDocument();
  expect(sw('Notifications on this phone')).toBeDisabled();
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'false');
  expect(document.querySelector('.m-notif-note')).toBeNull();
  expect(screen.getByText('Phone is off')).toBeInTheDocument();
});

test('turning Off that leaves the phone subscribed says so in a toast and keeps the switch on', async () => {
  adminPush.disableAdminPush.mockResolvedValue({ ok: true });
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Notifications on this phone'));
  await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Could not turn notifications off.'));
  expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'true');
  expect(sw('Notifications on this phone')).not.toHaveAttribute('aria-busy');
});

test('turning Off that lands raises no toast', async () => {
  adminPush.disableAdminPush.mockResolvedValue({ ok: true });
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  adminPush.readDevicePushState.mockResolvedValue('off');
  fireEvent.click(sw('Notifications on this phone'));
  await waitFor(() => expect(sw('Notifications on this phone')).toHaveAttribute('aria-checked', 'false'));
  expect(mockToast.error).not.toHaveBeenCalled();
});

test('the switches are described by their sub-line and their failed save; each Retry names what it retries', async () => {
  api.patch.mockRejectedValue(new Error('offline'));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  expect(sw('Notifications on this phone')).toHaveAccessibleDescription('Banners for what you pick below');
  expect(sw('Shift drops')).not.toHaveAttribute('aria-describedby');
  fireEvent.click(sw('Shift drops'));
  await screen.findByText('Didn’t save');
  expect(sw('Shift drops')).toHaveAccessibleDescription('Didn’t save');
  expect(sw('Cover and swaps')).not.toHaveAttribute('aria-describedby');
  const retry = within(sw('Shift drops').closest('li')).getByRole('button', { name: 'Retry saving Shift drops' });
  expect(retry).toHaveTextContent('Retry');
});

// Final fix wave (2026-10-14): benchmark fidelity and the test row's semantics.
test('the test row is named by its label, described by its status, and the status is a polite live region', async () => {
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  const row = screen.getByRole('button', { name: 'Send a test notification' });
  const status = document.getElementById(row.getAttribute('aria-describedby'));
  expect(status).toHaveAttribute('aria-live', 'polite');
  fireEvent.click(row);
  expect(await screen.findByText('Sent')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send a test notification' })).toHaveAccessibleDescription('Sent');
  api.post.mockResolvedValue({ data: { subscriptions: 1, sent: 0, failed: 1, gone: 0, reason: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
  const failedStatus = await screen.findByText('Didn’t send');
  expect(failedStatus).toHaveAttribute('aria-live', 'polite');
  expect(failedStatus).toHaveAttribute('id');
});

test('a failed kind row keeps the switch first and Retry its sibling after it; Didn’t save is a polite live region', async () => {
  api.patch.mockRejectedValue(new Error('offline'));
  renderScreen();
  await screen.findByText('Banners for what you pick below');
  fireEvent.click(sw('Shift drops'));
  const fail = await screen.findByText('Didn’t save');
  expect(fail).toHaveAttribute('aria-live', 'polite');
  const li = sw('Shift drops').closest('li');
  expect(li).toHaveClass('m-row-retry');
  const kids = Array.from(li.children);
  expect(kids).toHaveLength(2);
  expect(kids[0]).toBe(sw('Shift drops'));
  expect(kids[1]).toHaveClass('m-notif-retry');
  expect(kids[1]).toHaveAccessibleName('Retry saving Shift drops');
  expect(sw('Shift drops').lastElementChild).toHaveClass('m-switch-track');
});

test('the failed-load strip sits in a list row, centred, with its alert and Retry', async () => {
  offlineGet.mockRejectedValue(new Error('down'));
  renderScreen();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Couldn’t load notification settings.');
  const li = alert.closest('li');
  expect(li).toHaveClass('m-notif-note', 'm-notif-note-center');
  expect(li.parentElement.tagName).toBe('UL');
  expect(li.parentElement).toHaveClass('m-more-list');
  expect(within(li).getByRole('button', { name: 'Retry loading' })).toBeInTheDocument();
});

test('the screen sits at the shell inset: no inline padding on the wrapper', async () => {
  const { container } = renderScreen();
  await screen.findByText('Banners for what you pick below');
  const wrapper = container.querySelector('.m-more');
  expect(wrapper).not.toHaveAttribute('style');
});
