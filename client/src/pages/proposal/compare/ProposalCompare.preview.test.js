import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

jest.mock('../../../utils/api', () => ({ __esModule: true, API_BASE_URL: '/api', default: { get: jest.fn() } }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import axios from 'axios';
import api from '../../../utils/api';
import ProposalCompare from './ProposalCompare';

// The admin preview reads the authed endpoint (drafts included), never redirects,
// and never lets a choose button open the client's proposal page. The public page
// keeps its single-option redirect to the sign page.

const option = (id, status, name, clientVisible) => ({
  id, token: `tok-${id}`, status, package_id: id, package_name: name, package_slug: null,
  package_category: null, pricing_type: 'flat', total_price: '1000.00', deposit_amount: '100.00',
  floor_reason: null, billed_guests: null, floor_applied: false, client_visible: clientVisible,
});
const payload = (options) => ({
  group_token: 'g1', decided: false, chosen_token: null, client_name: 'Test Client',
  event_header: { event_type: 'wedding', guest_count: 100, event_duration_hours: 4, event_date: '2027-04-20' },
  options,
});

const mount = (path, el) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/compare/:token" element={<ProposalCompare />} />
      <Route path="/compare/:token/preview" element={el} />
      <Route path="/proposal/:token" element={<div data-testid="sign-page" />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { jest.clearAllMocks(); });

test('preview shows the draft option, names it, and turns the choose buttons off', async () => {
  api.get.mockResolvedValue({ data: payload([
    option(1, 'viewed', 'The Core Reaction', true),
    option(2, 'draft', 'The Enhanced Solution', false),
  ]) });
  mount('/compare/g1/preview', <ProposalCompare preview />);

  expect(await screen.findByText(/Hidden from the client: The Enhanced Solution \(not sent yet\)/)).toBeInTheDocument();
  // One sent option: the client's link skips to that proposal, and the banner says so.
  expect(screen.getByText(/currently opens a single proposal, not this comparison/)).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/proposals/group/g1/preview');
  expect(axios.get).not.toHaveBeenCalled();
  const choose = screen.getAllByRole('button', { name: 'Choose this one' });
  expect(choose.length).toBeGreaterThan(0);
  choose.forEach((b) => expect(b).toBeDisabled());
});

test('preview does not redirect a single-option or decided group', async () => {
  api.get.mockResolvedValue({ data: { ...payload([option(1, 'viewed', 'The Core Reaction', true)]), decided: true, chosen_token: 'tok-1' } });
  mount('/compare/g1/preview', <ProposalCompare preview />);
  expect(await screen.findByText(/opens the option they booked, not this comparison/)).toBeInTheDocument();
  expect(screen.queryByTestId('sign-page')).toBeNull();
});

test('the public page still sends a single visible option to its sign page', async () => {
  axios.get.mockResolvedValue({ data: payload([option(1, 'viewed', 'The Core Reaction', undefined)]) });
  mount('/compare/g1', null);
  expect(await screen.findByTestId('sign-page')).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
});

test('preview with two sent options and a draft says the client sees it minus the draft', async () => {
  api.get.mockResolvedValue({ data: payload([
    option(1, 'viewed', 'The Core Reaction', true),
    option(2, 'sent', 'The Enhanced Solution', true),
    option(3, 'draft', 'The Premium Formula', false),
  ]) });
  mount('/compare/g1/preview', <ProposalCompare preview />);
  expect(await screen.findByText(/sees this comparison without the hidden options/)).toBeInTheDocument();
  expect(screen.getByText(/Hidden from the client: The Premium Formula \(not sent yet\)/)).toBeInTheDocument();
});
