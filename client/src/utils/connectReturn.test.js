// connectReturn: the login page's one allowed way back, and its wiring in ProtectedRoute, RedirectIfLoggedIn's route and Login.
import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CONNECT_WRONG_ACCOUNT, connectLoginPath, connectRequestId, connectReturn } from './connectReturn';

const mockUseAuth = jest.fn();
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockUseAuth() }));
jest.mock('./webauthnClient', () => ({ unlockWithPasskey: jest.fn(), isPasskeySupported: () => true }));
jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

// eslint-disable-next-line import/first
import api from './api';
// eslint-disable-next-line import/first
import { ProtectedRoute } from '../App';
// eslint-disable-next-line import/first
import Login from '../pages/Login';

// jsdom has no scrollIntoView; FormBanner scrolls its message into view.
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const ID = 'abcdef12-3456-4789-8abc-def012345678';
const PAGE = `/connect-claude?request=${ID}`;

describe('connectReturn', () => {
  test('accepts the consent path with a well-formed request id, either case', () => {
    expect(connectReturn(PAGE)).toBe(PAGE);
    expect(connectReturn(`/connect-claude?request=${ID.toUpperCase()}`)).toBe(`/connect-claude?request=${ID.toUpperCase()}`);
  });

  test.each([
    ['an absolute URL', `https://evil.example.com${PAGE}`],
    ['an absolute URL to the page host', `https://admin.example.com${PAGE}`],
    ['a protocol-relative URL', `//evil.example.com${PAGE}`],
    ['a backslash path browsers read as protocol-relative', `/\\evil.example.com${PAGE}`],
    ['a javascript: URL', `javascript:alert(1)//${PAGE}`],
    ['another admin path', `/settings?request=${ID}`],
    ['the dashboard', '/dashboard'],
    ['a path that only starts like the page', `/connect-claude-evil?request=${ID}`],
    ['a nested path', `/connect-claude/x?request=${ID}`],
    ['a malformed id', '/connect-claude?request=not-a-uuid'],
    ['an id one character short', `/connect-claude?request=${ID.slice(0, -1)}`],
    ['no id', '/connect-claude'],
    ['a second parameter', `${PAGE}&next=https://evil.example.com`],
    ['a fragment', `${PAGE}#x`],
    ['a trailing newline', `${PAGE}\n`],
    ['a percent-encoded path', encodeURIComponent(PAGE)],
    ['an empty string', ''],
  ])('rejects %s', (label, value) => {
    expect(connectReturn(value)).toBeNull();
  });

  test('rejects what is not a string', () => {
    [null, undefined, 42, {}, [PAGE]].forEach((v) => expect(connectReturn(v)).toBeNull());
  });

  test('connectLoginPath carries the return only for the consent page', () => {
    expect(connectLoginPath(PAGE)).toBe(`/login?return=${encodeURIComponent(PAGE)}`);
    expect(connectLoginPath('/events')).toBe('/login');
    expect(connectLoginPath('/connect-claude?request=bad')).toBe('/login');
    expect(connectLoginPath(`//evil.example.com${PAGE}`)).toBe('/login');
  });

  test('connectRequestId reads only a well-formed id', () => {
    expect(connectRequestId(`?request=${ID}`)).toBe(ID);
    expect(connectRequestId('?request=nope')).toBeNull();
    expect(connectRequestId('')).toBeNull();
    expect(connectRequestId(undefined)).toBeNull();
  });
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

describe('the guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockUseAuth.mockReturnValue({ user: null, loading: false, login: jest.fn(), logout: jest.fn() });
  });

  function renderGuard(url, el) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/connect-claude" element={el} />
          <Route path="/events" element={el} />
          <Route path="/login" element={<Where />} />
          <Route path="/" element={<Where />} />
        </Routes>
      </MemoryRouter>
    );
  }

  test('a signed-out visitor to the consent page lands on login with the way back', () => {
    renderGuard(PAGE, <ProtectedRoute adminStrict returnHere><div>consent</div></ProtectedRoute>);
    expect(screen.getByTestId('where')).toHaveTextContent(`/login?return=${encodeURIComponent(PAGE)}`);
  });

  test('a malformed consent link gets plain login', () => {
    renderGuard('/connect-claude?request=bad', <ProtectedRoute adminStrict returnHere><div>consent</div></ProtectedRoute>);
    expect(screen.getByTestId('where').textContent).toBe('/login');
  });

  test('every other guard keeps plain login', () => {
    renderGuard('/events', <ProtectedRoute adminOnly><div>events</div></ProtectedRoute>);
    expect(screen.getByTestId('where').textContent).toBe('/login');
    renderGuard(PAGE, <ProtectedRoute adminStrict><div>consent</div></ProtectedRoute>);
    expect(screen.getAllByTestId('where')[1].textContent).toBe('/login');
  });

  test('a non-admin session on the consent page is signed out and sent to login with the return', async () => {
    const logout = jest.fn();
    mockUseAuth.mockReturnValue({ user: { id: 50012, role: 'staff' }, loading: false, logout });
    renderGuard(PAGE, <ProtectedRoute adminStrict returnHere><div>consent</div></ProtectedRoute>);
    expect(screen.queryByText('consent')).not.toBeInTheDocument();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('where')).toHaveTextContent(`/login?return=${encodeURIComponent(PAGE)}`);
  });

  test('a non-admin session on another adminStrict page still goes home, not signed out', () => {
    const logout = jest.fn();
    mockUseAuth.mockReturnValue({ user: { id: 50007, role: 'manager' }, loading: false, logout });
    renderGuard('/events', <ProtectedRoute adminStrict><div>events</div></ProtectedRoute>);
    expect(screen.queryByText('events')).not.toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  test('an admin signed in sees the page', () => {
    mockUseAuth.mockReturnValue({ user: { id: 50001, role: 'admin' }, loading: false });
    renderGuard(PAGE, <ProtectedRoute adminStrict returnHere><div>consent</div></ProtectedRoute>);
    expect(screen.getByText('consent')).toBeInTheDocument();
  });
});

describe('Login', () => {
  const login = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: null, loading: false, login });
  });

  function renderLogin(url) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    );
  }

  async function signInAs(user) {
    api.post.mockResolvedValue({ data: { token: 'made-up-token', user } });
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'made-up-password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(login).toHaveBeenCalled());
  }

  test('an admin who came from the consent page goes back to it', async () => {
    renderLogin(`/login?return=${encodeURIComponent(PAGE)}`);
    expect(screen.getByText(/approve Claude/)).toBeInTheDocument();
    await signInAs({ id: 50001, role: 'admin' });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(PAGE));
  });

  test.each([
    ['an absolute URL', `https://evil.example.com${PAGE}`],
    ['a protocol-relative URL', `//evil.example.com${PAGE}`],
    ['another admin path', '/settings'],
    ['a malformed id', '/connect-claude?request=bad'],
  ])('an admin with %s as the return goes where login always sends an admin', async (label, value) => {
    renderLogin(`/login?return=${encodeURIComponent(value)}`);
    expect(screen.getByText('Sign in to your account')).toBeInTheDocument();
    await signInAs({ id: 50001, role: 'admin' });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin'));
  });

  test.each([
    ['a staff account', { id: 50012, role: 'staff', onboarding_status: 'approved' }],
    ['a manager', { id: 50007, role: 'manager', onboarding_status: 'approved' }],
  ])('%s on the consent login is not signed in, is told to use the admin account, and keeps the return', async (label, user) => {
    renderLogin(`/login?return=${encodeURIComponent(PAGE)}`);
    api.post.mockResolvedValue({ data: { token: 'made-up-token', user } });
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'made-up-password' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(CONNECT_WRONG_ACCOUNT)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
    expect(screen.getByText('Sign in with your admin account to approve Claude')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  test('a staff account on the plain login is signed in as before', async () => {
    renderLogin('/login');
    await signInAs({ id: 50012, role: 'staff', onboarding_status: 'approved' });
    expect(screen.queryByText(CONNECT_WRONG_ACCOUNT)).not.toBeInTheDocument();
  });
});
