import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ClientAnswersPanel, { readAnswersOpen, writeAnswersOpen } from './ClientAnswersPanel';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const COCKTAILS = [{ id: 'margarita', name: 'Margarita' }];
const PLANNER = {
  activeModules: { signatureDrinks: true, fullBar: true },
  signatureDrinks: ['margarita'],
  spirits: ['Vodka'],
  crowd: { drinkers: 80, profile: 'moderate' },
  menuStyle: 'house',
  logistics: { parking: 'street_parking' },
};
const RECAP = ['Bar style: Full bar', 'Signature cocktails: French 75'];

const plan = (o = {}) => ({
  id: 42,
  serving_type: null,
  status: 'draft',
  selections: PLANNER,
  submitted_at: null,
  has_consult_selections: false,
  consult_filled_at: null,
  shopping_list_source: 'planner',
  ...o,
});

// CRA resetMocks wipes implementations before every test, so each test mocks.
// consultBody defaults to the current server's shape ({ recap }).
function mockApi(p, { recap = null, consultBody, failUrl = null } = {}) {
  api.get.mockImplementation((url) => {
    if (url === failUrl) return Promise.reject(new Error('boom'));
    if (url === `/drink-plans/${p.id}`) return Promise.resolve({ data: p });
    if (url === '/cocktails/admin') return Promise.resolve({ data: { cocktails: COCKTAILS } });
    if (url === '/mocktails/admin') return Promise.resolve({ data: { mocktails: [] } });
    if (url === `/drink-plans/${p.id}/consult`) return Promise.resolve({ data: consultBody || { recap } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

test('planner only: the drink answers and crowd, never menu design or parking, no switch', async () => {
  mockApi(plan());
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('From the planner, not submitted')).toBeInTheDocument();
  expect(screen.queryByText(/Menu Design/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Parking/)).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Which answers' })).not.toBeInTheDocument();
});

test('both sets, consult newer: opens on the consult, flips to the planner, writes nothing', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: RECAP });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('Signature cocktails: French 75')).toBeInTheDocument();
  expect(screen.getByText('From the consult, Oct 2')).toBeInTheDocument();
  expect(screen.queryByText(/This list was built from/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Planner · not submitted' }));
  expect(screen.getByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText('This list was built from the consult.')).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});

test('a planner submitted after the consult opens on the planner, with the note', async () => {
  mockApi(plan({
    status: 'submitted',
    has_consult_selections: true,
    consult_filled_at: '2026-09-20T15:00:00Z',
    submitted_at: '2026-09-25T15:00:00Z',
    shopping_list_source: 'consult',
  }), { recap: RECAP });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the planner, submitted Sep 25')).toBeInTheDocument();
  expect(screen.getByText('This list was built from the consult.')).toBeInTheDocument();
});

test('a reopen starts on the newest set again (a flip is not remembered)', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: RECAP });
  const first = render(<ClientAnswersPanel planId={42} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Planner · not submitted' }));
  expect(screen.getByText('From the planner, not submitted')).toBeInTheDocument();
  first.unmount();
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the consult, Oct 2')).toBeInTheDocument();
});

test('a consult with nothing to say that built the list: the planner shows alone, with the note', async () => {
  mockApi(plan({ has_consult_selections: true, consult_filled_at: '2026-10-02T15:00:00Z', shopping_list_source: 'consult' }), { recap: null });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('From the planner, not submitted')).toBeInTheDocument();
  expect(screen.getByText('This list was built from the consult, which has no answers to show here.')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Which answers' })).not.toBeInTheDocument();
});

test('a server older than this panel (no recap key) is the error state, never "no answers"', async () => {
  mockApi(plan({ selections: null, has_consult_selections: true, shopping_list_source: 'consult' }), {
    consultBody: { consult_selections: { barType: 'full_bar' } },
  });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText("Couldn't load the client's answers.")).toBeInTheDocument();
  expect(screen.queryByText('No planner or consult answers yet.')).not.toBeInTheDocument();
});

test('a failed catalog read is an error with Retry, never a planner view missing its drinks', async () => {
  const p = plan();
  mockApi(p, { failUrl: '/mocktails/admin' });
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText("Couldn't load the client's answers.")).toBeInTheDocument();
  expect(screen.queryByText(/Crowd:/)).not.toBeInTheDocument();
  mockApi(p);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/Margarita/)).toBeInTheDocument();
});

test('no answers at all: the empty state', async () => {
  mockApi(plan({ selections: null, shopping_list_source: null }));
  render(<ClientAnswersPanel planId={42} />);
  expect(await screen.findByText('No planner or consult answers yet.')).toBeInTheDocument();
});

describe('the remembered open state', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  test('opens by default and remembers a hide', () => {
    window.localStorage.clear();
    expect(readAnswersOpen()).toBe(true);
    writeAnswersOpen(false);
    expect(readAnswersOpen()).toBe(false);
    writeAnswersOpen(true);
    expect(readAnswersOpen()).toBe(true);
  });

  test('blocked storage reads open and a write never throws', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readAnswersOpen()).toBe(true);
    expect(() => writeAnswersOpen(false)).not.toThrow();
  });
});
