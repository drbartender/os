// The consent page's login return, end to end through the real App, AuthContext, guards, Login and the phone lock screen.
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ENROLLED_KEY } from './mobileLock';
import { CONNECT_WRONG_ACCOUNT } from './connectReturn';

jest.mock('./api', () => {
  const api = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), put: jest.fn(), patch: jest.fn(),
    interceptors: { request: { use: () => {} }, response: { use: () => {} } },
  };
  return { __esModule: true, default: api, API_BASE_URL: '/api', markStaleFromHeaders: (r) => r };
});
// The page itself is ConnectClaude.test.js's subject; here it only shows where the browser landed.
jest.mock('../pages/admin/ConnectClaude', () => {
  const R = require('react');
  const { useLocation } = require('react-router-dom');
  return { __esModule: true, default: () => { const l = useLocation(); return R.createElement('div', null, `CONSENT ${l.pathname}${l.search}`); } };
});
jest.mock('./webauthnClient', () => ({
  unlockWithPasskey: jest.fn(), isPasskeySupported: () => true, registerPasskey: jest.fn(),
}));

// eslint-disable-next-line import/first
import api from './api';
// eslint-disable-next-line import/first
import App from '../App';

// jsdom has no scrollIntoView; FormBanner scrolls its message into view.
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const ID = 'abcdef12-3456-4789-8abc-def012345678';
const PAGE = `/connect-claude?request=${ID}`;
const LOGIN_BACK = `/login?return=${encodeURIComponent(PAGE)}`;
const ADMIN = { id: 50001, role: 'admin', onboarding_status: 'approved' };
const MANAGER = { id: 50007, role: 'manager', onboarding_status: 'approved' };
const STAFF = { id: 50012, role: 'staff', onboarding_status: 'approved' };

function at(url) { window.history.replaceState({}, '', url); }
function here() { return window.location.pathname + window.location.search; }
function viewport(matches) {
  window.matchMedia = jest.fn().mockReturnValue({
    matches, addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(),
  });
}
function me(user) {
  api.get.mockImplementation((url) => (url === '/auth/me'
    ? (user ? Promise.resolve({ data: { user } }) : Promise.reject({ status: 401, code: 'TOKEN_EXPIRED' }))
    : Promise.reject({ status: 404 })));
}
async function signIn(user) {
  api.post.mockImplementation((url) => (url === '/auth/login'
    ? Promise.resolve({ data: { token: 'made-up-token', user } }) : Promise.reject({ status: 404 })));
  fireEvent.change(await screen.findByLabelText(/email address/i), { target: { name: 'email', value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { name: 'password', value: 'made-up-password' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /sign in/i })); });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  viewport(false);
  api.get.mockImplementation(() => Promise.reject({ status: 404 }));
  api.post.mockImplementation(() => Promise.reject({ status: 404 }));
});

test('signed out: login carries the return, and an admin sign-in lands on the consent page', async () => {
  at(PAGE);
  render(<App />);
  await screen.findByText(/sign in with your admin account to approve claude/i);
  expect(here()).toBe(LOGIN_BACK);
  await signIn(ADMIN);
  expect(await screen.findByText(`CONSENT ${PAGE}`)).toBeInTheDocument();
});

test('an expired desktop session: login still carries the return', async () => {
  window.localStorage.setItem('token', 'made-up-expired');
  me(null);
  at(PAGE);
  render(<App />);
  await screen.findByText(/sign in with your admin account to approve claude/i);
  expect(here()).toBe(LOGIN_BACK);
});

test.each([['a manager', MANAGER], ['a staff account', STAFF]])('%s signing in at the return link stays on it, told to use the admin account', async (label, user) => {
  at(LOGIN_BACK);
  render(<App />);
  await signIn(user);
  expect(await screen.findByText(CONNECT_WRONG_ACCOUNT)).toBeInTheDocument();
  expect(here()).toBe(LOGIN_BACK);
  expect(window.localStorage.getItem('token')).toBeNull();
  await signIn(ADMIN);
  expect(await screen.findByText(`CONSENT ${PAGE}`)).toBeInTheDocument();
});

test('a staff session already on the admin origin opens the consent link: signed out, login with the return and the notice', async () => {
  window.localStorage.setItem('token', 'made-up-staff-token');
  me(STAFF);
  at(PAGE);
  render(<App />);
  expect(await screen.findByText(CONNECT_WRONG_ACCOUNT)).toBeInTheDocument();
  expect(here()).toBe(LOGIN_BACK);
  expect(window.localStorage.getItem('token')).toBeNull();
  expect(screen.queryByText(/CONSENT/)).not.toBeInTheDocument();
});

test.each([
  '//evil.example.com',
  `https://evil.example.com${PAGE}`,
  `${PAGE}&next=//evil.example.com`,
  '/dashboard',
])('a crafted return (%s) is ignored for an admin', async (bad) => {
  at(`/login?return=${encodeURIComponent(bad)}`);
  render(<App />);
  await screen.findByText(/sign in to your account/i);
  await signIn(ADMIN);
  await waitFor(() => expect(window.location.pathname).not.toBe('/login'));
  expect(window.location.origin).toBe('http://localhost');
  expect(screen.queryByText(/CONSENT/)).not.toBeInTheDocument();
});

test('an admin already signed in who opens the login return link goes straight to the consent page', async () => {
  window.localStorage.setItem('token', 'made-up-token');
  me(ADMIN);
  at(LOGIN_BACK);
  render(<App />);
  expect(await screen.findByText(`CONSENT ${PAGE}`)).toBeInTheDocument();
});

test('a manager already signed in who opens the login return link is not sent to the consent page', async () => {
  window.localStorage.setItem('token', 'made-up-token');
  me(MANAGER);
  at(LOGIN_BACK);
  render(<App />);
  await waitFor(() => expect(window.location.pathname).not.toBe('/login'));
  expect(screen.queryByText(/CONSENT/)).not.toBeInTheDocument();
});

test('the phone lock screen: Use password instead keeps the consent return', async () => {
  viewport(true);
  window.localStorage.setItem('token', 'made-up-expired');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  me(null);
  at(PAGE);
  render(<App />);
  await screen.findByRole('dialog', { name: /locked/i });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /use password instead/i })); });
  await screen.findByText(/sign in with your admin account to approve claude/i);
  expect(here()).toBe(LOGIN_BACK);
  await signIn(ADMIN);
  expect(await screen.findByText(`CONSENT ${PAGE}`)).toBeInTheDocument();
});
