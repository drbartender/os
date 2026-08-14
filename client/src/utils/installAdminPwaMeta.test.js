import { isAdminHost, installAdminPwaMeta } from './installAdminPwaMeta';

test('isAdminHost mirrors getSiteContext admin mapping, never staff', () => {
  expect(isAdminHost('admin.drbartender.com')).toBe(true);
  expect(isAdminHost('admin.localhost')).toBe(true);
  expect(isAdminHost('localhost')).toBe(true);
  expect(isAdminHost('127.0.0.1')).toBe(true);
  expect(isAdminHost('staff.drbartender.com')).toBe(false);
  expect(isAdminHost('drbartender.com')).toBe(false);
  expect(isAdminHost('hiring.drbartender.com')).toBe(false);
  expect(isAdminHost('')).toBe(false);
});

test('injects manifest link and metas once (jsdom host is localhost)', () => {
  document.head.innerHTML =
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<meta name="theme-color" content="#2C1F0E" />';
  installAdminPwaMeta();
  installAdminPwaMeta(); // idempotent
  expect(
    document.head.querySelectorAll('link[rel="manifest"][href="/admin-manifest.json"]')
  ).toHaveLength(1);
  expect(
    document.head.querySelectorAll('meta[name="mobile-web-app-capable"]')
  ).toHaveLength(1);
  expect(
    document.head.querySelectorAll('meta[name="apple-mobile-web-app-status-bar-style"]')
  ).toHaveLength(1);
  expect(
    document.head.querySelector('meta[name="viewport"]').getAttribute('content')
  ).toContain('viewport-fit=cover');
  // The EXISTING theme-color meta is mutated in place (browsers honor the
  // first match; injecting a second would be dead code).
  const themeMetas = document.head.querySelectorAll('meta[name="theme-color"]');
  expect(themeMetas).toHaveLength(1);
  expect(themeMetas[0].getAttribute('content')).toBe('#196ac8');
});
