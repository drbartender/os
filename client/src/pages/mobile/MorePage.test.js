import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import MorePage from './MorePage';

// Plain functions, not jest.fn: CRA's resetMocks would wipe a jest.fn
// implementation before every test.
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));
jest.mock('../../context/UserPrefsContext', () => ({ useUserPrefs: () => ({ prefs: { skin: 'dark' }, setPref: () => {} }) }));
jest.mock('../../components/mobile/MoreSecurityRow', () => ({ __esModule: true, default: () => null }));
jest.mock('../../utils/installPrompt', () => ({
  canInstall: () => false,
  onInstallAvailability: () => () => {},
  promptInstall: () => {},
}));

// The phone chrome hands badges to the page through the outlet context.
function renderMore(badges) {
  return render(
    <MemoryRouter initialEntries={['/more']}>
      <Routes>
        <Route element={<Outlet context={{ badges }} />}>
          <Route path="/more" element={<MorePage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test('Inbox, Events and Proposals are tabs, so More never lists them', () => {
  renderMore({ inbox_waiting: 4, unread_sms: 2 });
  expect(screen.queryByText('Inbox')).toBeNull();
  expect(screen.queryByText('Events')).toBeNull();
  expect(screen.queryByText('Proposals')).toBeNull();
  expect(screen.getByText('Messages').closest('a')).toHaveTextContent('2');
});

test('a null Inbox count changes nothing on More', () => {
  renderMore({ inbox_waiting: null, unread_sms: 1 });
  expect(screen.queryByText('Inbox')).toBeNull();
  expect(screen.getByText('Messages').closest('a')).toHaveTextContent('1');
  expect(screen.queryByText('!')).toBeNull();
});
