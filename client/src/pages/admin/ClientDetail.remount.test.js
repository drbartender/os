import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import api from '../../utils/api';
import ClientDetail from './ClientDetail';

// The route keeps its element when only :id changes. These tests move the page
// from one client to another the way global search does and check that nothing
// of the first client acts on the second: the open edit form, a record request
// for the first that answers late, and one that fails late.

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
// Stable identities: the page's load effect depends on toast.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
jest.mock('../../components/ClientConversation', () => ({ __esModule: true, default: () => null }));

const record = (id, name) => ({
  id,
  name,
  email: `client${id}@example.com`,
  phone: '',
  source: 'direct',
  notes: `notes for ${id}`,
  proposals: [],
});

// The record GET for each id is a promise the test settles, so it can answer
// (or fail) out of order.
let pending;
beforeEach(() => {
  jest.clearAllMocks();
  pending = {};
  api.get.mockImplementation((url) => {
    const m = url.match(/^\/clients\/(\d+)$/);
    if (m) return new Promise((resolve, reject) => { pending[m[1]] = { resolve, reject }; });
    return Promise.resolve({ data: {} });
  });
  api.put.mockImplementation((url, body) => Promise.resolve({ data: body }));
});

function Go() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/clients/2')}>go to 2</button>;
}
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const mount = () => render(
  <MemoryRouter initialEntries={['/clients/1']}>
    <Routes>
      <Route path="/clients/:id" element={<><ClientDetail /><Go /><Where /></>} />
      <Route path="/clients" element={<Where />} />
    </Routes>
  </MemoryRouter>
);

const answer = async (id, name) => { await act(async () => { pending[id].resolve({ data: record(Number(id), name) }); }); };

test('an edit form open on one client is not open on the next', async () => {
  mount();
  await answer('1', 'Client One');
  fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  expect(screen.queryByDisplayValue('Client One')).toBeNull();
  await answer('2', 'Client Two');

  expect(screen.getAllByText('Client Two').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});

test('the first client answering late never replaces the second', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Client Two');
  await answer('1', 'Client One');

  expect(screen.getAllByText('Client Two').length).toBeGreaterThan(0);
  expect(screen.queryByText('Client One')).toBeNull();
});

test('the first client failing late neither moves the admin nor raises a toast', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Client Two');
  await act(async () => { pending['1'].reject(Object.assign(new Error('Server error'), { status: 500 })); });

  expect(screen.getByTestId('where')).toHaveTextContent('/clients/2');
  expect(screen.getAllByText('Client Two').length).toBeGreaterThan(0);
  expect(mockToast.error).not.toHaveBeenCalled();
});
