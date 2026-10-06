import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
import api from '../../utils/api';
import PackageDetails from './PackageDetails';

// Package details on Event Detail and Proposal Detail: package contents, then
// every add-on with its catalog description, and a bundle's included items.

const CATALOG = [
  { id: 1, slug: 'the-foundation', name: 'The Foundation', description: 'The essentials, handled.' },
  { id: 2, slug: 'ice-delivery-only', name: 'Ice Delivery' },
  { id: 3, slug: 'cups-disposables-only', name: 'Cups & Disposables' },
  { id: 4, slug: 'bottled-water-only', name: 'Bottled Water' },
  { id: 5, slug: 'champagne-toast', name: 'Champagne Toast', description: 'A glass for every guest.' },
];
const ADDONS = [
  { id: 11, addon_id: 1, addon_name: 'The Foundation' },
  { id: 12, addon_id: 5, addon_name: 'Champagne Toast', variant: 'non-alcoholic-bubbles' },
];
const SNAPSHOT_ADDONS = [{ id: 5, name: 'Non-Alcoholic Bubbles Toast' }];

const open = () => {
  const details = screen.getByText('Package details').closest('details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
};

beforeEach(() => jest.clearAllMocks());

test('renders nothing with no package contents and no add-ons', () => {
  const { container } = render(<PackageDetails packageStructured={null} includes={[]} addons={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the disclosure for add-ons alone (the old one needed package contents)', () => {
  render(<PackageDetails packageStructured={null} includes={[]} addons={ADDONS} snapshotAddons={SNAPSHOT_ADDONS} />);
  expect(screen.getByText('Package details')).toBeInTheDocument();
  expect(screen.getByText('Add-ons')).toBeInTheDocument();
});

test('on open: descriptions, the variant name the pricing card prints, and what the bundle includes', async () => {
  api.get.mockResolvedValue({ data: CATALOG });
  render(<PackageDetails packageStructured={[{ heading: 'Bar', items: ['Bartender'] }]} includes={[]} addons={ADDONS} snapshotAddons={SNAPSHOT_ADDONS} />);
  open();
  expect(await screen.findByText('The essentials, handled.')).toBeInTheDocument();
  expect(screen.getByText('Includes: Ice Delivery, Cups & Disposables, Bottled Water')).toBeInTheDocument();
  expect(screen.getByText('Non-Alcoholic Bubbles Toast')).toBeInTheDocument();
  expect(screen.getByText('A glass for every guest.')).toBeInTheDocument();
  expect(screen.getByText('Bartender')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/proposals/addons');
});

test('fetches the catalog once, however often the disclosure is toggled', async () => {
  api.get.mockResolvedValue({ data: CATALOG });
  render(<PackageDetails packageStructured={null} includes={['Bartender']} addons={ADDONS} />);
  open();
  await screen.findByText('The essentials, handled.');
  open();
  open();
  expect(api.get).toHaveBeenCalledTimes(1);
});

test('a failed catalog keeps the names and says the details could not load', async () => {
  api.get.mockRejectedValue({ message: 'nope' });
  render(<PackageDetails packageStructured={null} includes={[]} addons={ADDONS} snapshotAddons={SNAPSHOT_ADDONS} />);
  open();
  expect(await screen.findByText('Add-on details could not be loaded.')).toBeInTheDocument();
  expect(screen.getByText('The Foundation')).toBeInTheDocument();
  expect(screen.getByText('Non-Alcoholic Bubbles Toast')).toBeInTheDocument();
});

test('a retired add-on (not in the active catalog) shows its stored name only', async () => {
  api.get.mockResolvedValue({ data: CATALOG });
  render(<PackageDetails packageStructured={null} includes={[]} addons={[{ id: 13, addon_id: 99, addon_name: 'Old Neon Sign' }]} />);
  open();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(await screen.findByText('Old Neon Sign')).toBeInTheDocument();
  expect(screen.queryByText(/^Includes:/)).toBeNull();
});

test('no catalog fetch when there are no add-ons to describe', () => {
  render(<PackageDetails packageStructured={null} includes={['Bartender']} addons={[]} />);
  open();
  expect(api.get).not.toHaveBeenCalled();
});

// Code review, 2026-10-06: the fetch used to fire only from the toggle, so a
// disclosure already open when the proposal reloaded with its first add-on
// never loaded the catalog until it was closed and reopened.
test('a disclosure already open when add-ons arrive still loads their details', async () => {
  api.get.mockResolvedValue({ data: CATALOG });
  const { rerender } = render(<PackageDetails packageStructured={null} includes={['Bartender']} addons={[]} />);
  open();
  expect(api.get).not.toHaveBeenCalled();
  rerender(<PackageDetails packageStructured={null} includes={['Bartender']} addons={ADDONS} />);
  expect(await screen.findByText('The essentials, handled.')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(1);
});
