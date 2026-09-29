import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { OFFLINE_OK_HEADER } from './offlineRead';

// admin-sw.js is a plain static script, not a module, so it cannot be
// imported. Its top level only declares constants and functions and registers
// listeners on `self`, so it loads in a vm context with a stub `self`, and a
// top-level const is then readable by evaluating its name in that context.
// This test runs the REAL file: it holds no copy of any pattern.
function loadServiceWorker() {
  const src = fs.readFileSync(path.resolve(__dirname, '../../public/admin-sw.js'), 'utf8');
  const listeners = {};
  const self = { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://admin.example.test' } };
  const context = vm.createContext({ self, caches: {}, fetch: () => Promise.reject(new Error('no network in test')), URL, Response: function Response() {}, Headers: function Headers() {}, console, setTimeout, clearTimeout });
  vm.runInContext(src, context);
  return {
    isAllowlisted: vm.runInContext('isAllowlisted', context),
    asksForOffline: vm.runInContext('asksForOffline', context),
    version: vm.runInContext('SW_VERSION', context),
    offlineHeader: vm.runInContext('OFFLINE_HEADER', context),
    onFetch: listeners.fetch,
  };
}
const request = (headers = {}) => ({ headers: { get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null) } });

describe('admin service worker read allowlist', () => {
  const { isAllowlisted, version } = loadServiceWorker();

  test.each([
    '/api/shifts',
    '/api/proposals',
    '/api/proposals/13',
    '/api/shifts/by-proposal/13',
    '/api/admin/badge-counts',
    '/api/admin/search',
    '/api/admin/active-staff',
    '/api/auth/me',
  ])('still caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test.each([
    '/api/shifts/detail/17',
    '/api/invoices/proposal/13',
  ])('caches the event detail and sheet read %s', (p) => {
    expect(isAllowlisted(p)).toBe(true);
  });

  test('caches the drink plan only as its day-of-contact projection', () => {
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=day_of_contact')).toBe(true);
    // The full read carries the plan token, internal notes and venue access notes.
    expect(isAllowlisted('/api/drink-plans/by-proposal/13')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=all')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?fields=day_of_contact&x=1')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13', '?x=1&fields=day_of_contact')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/by-proposal/13/consult', '?fields=day_of_contact')).toBe(false);
    expect(isAllowlisted('/api/drink-plans/13', '?fields=day_of_contact')).toBe(false);
  });

  test.each([
    '/api/shifts/detail/17/extra',
    '/api/shifts/detail/abc',
    '/api/shifts/detail/',
    '/api/shifts/detail/17/',
    '/api/shifts/17/requests',
    '/api/shifts/requests/9',
    '/api/shifts/by-proposal/13/extra',
    '/api/shifts/by-proposal/13%20',
    '/api/shifts/by-proposal/event-details',
    '/api/shifts/by-proposal/',
    '/api/drink-plans/13',
    '/api/drink-plans/by-proposal/13/consult',
    '/api/drink-plans/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/invoices/13',
    '/api/invoices/proposal/13/extra',
    '/api/invoices/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/invoices/client/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/13/cancel-line/targets',
    '/api/proposals/t/0b8f6d2e-1111-4222-8333-444455556666',
    '/api/proposals/financials',
    '/api/stripe/refunds/13',
    '/api/admin/users/12',
    '/api/admin/users/12/seniority',
    '/api/admin/active-staff/extra',
  ])('never caches %s', (p) => {
    expect(isAllowlisted(p)).toBe(false);
    expect(isAllowlisted(p, '?fields=day_of_contact')).toBe(false);
  });

  test('the version was bumped so installed phones pick the new allowlist up', () => {
    expect(version).not.toBe('admin-sw-2026-08-14-v8');
    expect(version).toMatch(/^admin-sw-\d{4}-\d{2}-\d{2}-v10$/);
  });
});

describe('storing and stale-serving are opt-in', () => {
  const { asksForOffline, onFetch, offlineHeader } = loadServiceWorker();

  // The two halves of one contract: offlineGet sends this header, the worker
  // reads it. Each side alone could drift and both suites would stay green.
  test('the worker listens for the header the client sends', () => {
    expect(offlineHeader).toBe(OFFLINE_OK_HEADER.toLowerCase());
  });

  test('a request asks with the header, and only with the value 1', () => {
    expect(asksForOffline(request({ 'x-offline-ok': '1' }), '/api/shifts/detail/17')).toBe(true);
    expect(asksForOffline(request(), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': '0' }), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': 'true' }), '/api/shifts/detail/17')).toBe(false);
    expect(asksForOffline(request({ 'x-offline-ok': '' }), '/api/invoices/proposal/13')).toBe(false);
  });

  test('the identity read is served to every surface, header or not', () => {
    expect(asksForOffline(request(), '/api/auth/me')).toBe(true);
    expect(asksForOffline(request(), '/api/auth/me/extra')).toBe(false);
  });

  // The fetch handler itself, with a fake event: respondWith is the ONLY way
  // the worker can store or answer a request, so "never called" is the proof.
  const fire = (url, { method = 'GET', headers = {}, mode = 'cors' } = {}) => {
    const event = {
      request: { url, method, mode, headers: request(headers).headers, clone() { return this; } },
      respondWith: jest.fn((p) => { Promise.resolve(p).catch(() => {}); }),
      waitUntil: jest.fn(),
    };
    onFetch(event);
    return event;
  };

  test.each([
    'https://api.example.test/api/shifts/detail/17',
    'https://api.example.test/api/invoices/proposal/13',
    'https://api.example.test/api/proposals/13',
    'https://api.example.test/api/shifts/by-proposal/13',
    'https://api.example.test/api/admin/active-staff?limit=100',
    'https://api.example.test/api/drink-plans/by-proposal/13?fields=day_of_contact',
  ])('a desktop read of %s, which sends no header, is left to the network', (url) => {
    const event = fire(url);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
  });

  test.each([
    'https://api.example.test/api/shifts/detail/17',
    'https://api.example.test/api/invoices/proposal/13',
    'https://api.example.test/api/drink-plans/by-proposal/13?fields=day_of_contact',
    'https://api.example.test/api/admin/active-staff?limit=100&shift_id=17',
  ])('a phone read of %s, which sends the header, is handled', (url) => {
    expect(fire(url, { headers: { 'x-offline-ok': '1' } }).respondWith).toHaveBeenCalledTimes(1);
  });

  test('the header cannot widen the allowlist', () => {
    for (const url of [
      'https://api.example.test/api/drink-plans/by-proposal/13',
      'https://api.example.test/api/invoices/t/0b8f6d2e-1111-4222-8333-444455556666',
      'https://api.example.test/api/admin/users/12',
      'https://api.example.test/api/payroll/periods',
    ]) {
      const event = fire(url, { headers: { 'x-offline-ok': '1' } });
      expect(event.respondWith).not.toHaveBeenCalled();
      expect(event.waitUntil).not.toHaveBeenCalled();
    }
  });

  test('a write is never intercepted, header or not', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const url of ['https://api.example.test/api/invoices/proposal/13', 'https://api.example.test/api/shifts/17/assign']) {
        const event = fire(url, { method, headers: { 'x-offline-ok': '1' } });
        expect(event.respondWith).not.toHaveBeenCalled();
        expect(event.waitUntil).not.toHaveBeenCalled();
      }
    }
  });
});
