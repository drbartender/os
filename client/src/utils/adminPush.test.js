import '@testing-library/jest-dom';
import { readDevicePushState, enableAdminPush, disableAdminPush, ADMIN_SW_PATH } from './adminPush';
import * as pushSubscribe from './pushSubscribe';
import * as Sentry from '@sentry/react';

jest.mock('@sentry/react', () => ({ captureMessage: jest.fn() }));
jest.mock('./pushSubscribe', () => ({
  permissionState: jest.fn(),
  isPushSubscribed: jest.fn(),
  subscribePush: jest.fn(),
  unsubscribePush: jest.fn(),
}));
// A plain function over mock-prefixed state: CRA's resetMocks would wipe a
// jest.fn implementation before every test.
let mockAdminHost = true;
const mockHostsSeen = [];
jest.mock('./installAdminPwaMeta', () => ({ isAdminHost: (h) => { mockHostsSeen.push(h); return mockAdminHost; } }));

beforeEach(() => { mockAdminHost = true; mockHostsSeen.length = 0; });

describe('readDevicePushState', () => {
  test('unsupported wins, then blocked, then this device\'s admin subscription', async () => {
    pushSubscribe.permissionState.mockReturnValue('unsupported');
    expect(await readDevicePushState()).toBe('unsupported');
    pushSubscribe.permissionState.mockReturnValue('denied');
    pushSubscribe.isPushSubscribed.mockResolvedValue(true);
    expect(await readDevicePushState()).toBe('blocked');
    pushSubscribe.permissionState.mockReturnValue('granted');
    pushSubscribe.isPushSubscribed.mockResolvedValue(true);
    expect(await readDevicePushState()).toBe('on');
    expect(pushSubscribe.isPushSubscribed).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH });
    pushSubscribe.isPushSubscribed.mockResolvedValue(false);
    expect(await readDevicePushState()).toBe('off');
    pushSubscribe.permissionState.mockReturnValue('default');
    expect(await readDevicePushState()).toBe('off');
  });
});

describe('enableAdminPush and disableAdminPush', () => {
  test('enable passes the admin worker and the server key; no key is server_unset', async () => {
    pushSubscribe.subscribePush.mockResolvedValue({ ok: true, state: 'granted' });
    expect(await enableAdminPush('KEY')).toEqual({ ok: true, state: 'granted' });
    expect(pushSubscribe.subscribePush).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH, vapidKey: 'KEY', surface: 'admin' });
    expect(await enableAdminPush(null)).toEqual({ ok: false, state: 'server_unset' });
  });
  test('enable never throws: a rejected subscribe is a failed state', async () => {
    pushSubscribe.subscribePush.mockRejectedValue(new Error('AbortError'));
    expect(await enableAdminPush('KEY')).toEqual({ ok: false, state: 'failed' });
  });
  test('disable unsubscribes the admin worker', async () => {
    pushSubscribe.unsubscribePush.mockResolvedValue({ ok: true });
    expect(await disableAdminPush()).toEqual({ ok: true });
    expect(pushSubscribe.unsubscribePush).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH, notifyServer: true });
  });
  test('disable never throws: a failed local unsubscribe answers ok and reports a bare warning', async () => {
    pushSubscribe.unsubscribePush.mockRejectedValue(new Error('https://push.example.test/secret-endpoint'));
    expect(await disableAdminPush({ notifyServer: false })).toEqual({ ok: true });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('admin push: local unsubscribe failed', { level: 'warning' });
  });
  test('a clean disable reports nothing', async () => {
    pushSubscribe.unsubscribePush.mockResolvedValue({ ok: true });
    await disableAdminPush();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
  test('disable forwards notifyServer false (logout drops only the browser subscription)', async () => {
    pushSubscribe.unsubscribePush.mockResolvedValue({ ok: true });
    expect(await disableAdminPush({ notifyServer: false })).toEqual({ ok: true });
    expect(pushSubscribe.unsubscribePush).toHaveBeenCalledWith({ swPath: ADMIN_SW_PATH, notifyServer: false });
  });
});

// getRegistration resolves by scope, so off the admin host the admin path
// would find the STAFF registration (2026-10-14). Same gate as utils/adminSw.js.
describe('off the admin host every entry point is a no-op', () => {
  beforeEach(() => { mockAdminHost = false; });
  test('readDevicePushState answers unsupported and reads nothing', async () => {
    pushSubscribe.permissionState.mockReturnValue('granted');
    pushSubscribe.isPushSubscribed.mockResolvedValue(true);
    expect(await readDevicePushState()).toBe('unsupported');
    expect(pushSubscribe.permissionState).not.toHaveBeenCalled();
    expect(pushSubscribe.isPushSubscribed).not.toHaveBeenCalled();
    expect(mockHostsSeen).toEqual([window.location.hostname]);
  });
  test('enableAdminPush answers unsupported and never subscribes', async () => {
    expect(await enableAdminPush('KEY')).toEqual({ ok: false, state: 'unsupported' });
    expect(pushSubscribe.subscribePush).not.toHaveBeenCalled();
  });
  test('disableAdminPush answers ok and never touches a registration', async () => {
    expect(await disableAdminPush()).toEqual({ ok: true });
    expect(await disableAdminPush({ notifyServer: false })).toEqual({ ok: true });
    expect(pushSubscribe.unsubscribePush).not.toHaveBeenCalled();
  });
});
