import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import MobileHeader from './MobileHeader';

const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ usePalette: () => mockPalette }));
const mockMobileView = { setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));

const DETAIL = {
  title: 'Alexis Henderson', kind: 'Wedding Reception', guests: 140,
  venue: 'Grove on the River, 12 River Rd, Rockford', mapHref: 'https://www.google.com/maps/search/?api=1&query=12%20River%20Rd',
};

test('a list screen keeps the plain title, the brand mark and search', () => {
  render(<MobileHeader title="Events" screenKey="events-list" />);
  expect(screen.getByText('Events')).toHaveClass('m-title');
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  expect(screen.getByRole('banner')).not.toHaveClass('m-header-detail');
  expect(screen.getByText(String.fromCharCode(8478))).toHaveClass('m-brandmark');
  expect(screen.queryByRole('button', { name: /^Back/ })).toBeNull();
});

test('a detail screen with no data yet shows the plain title and the back arrow', () => {
  const onBack = jest.fn();
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={onBack} detail={null} />);
  expect(screen.getByText('Event')).toHaveClass('m-title');
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
});

test('the rich header carries client, kind, guests and the venue as an external map link', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={DETAIL} />);
  expect(screen.getByRole('banner')).toHaveClass('m-header', 'm-header-detail');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Alexis Henderson · Wedding Reception');
  expect(screen.getByText('140')).toHaveClass('m-dhead-guests');
  const link = screen.getByRole('link', { name: /Grove on the River/ });
  expect(link).toHaveAttribute('href', DETAIL.mapHref);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.queryByText('Event')).toBeNull();
});

test('no venue, no link; a venue with no map query is plain text; no guests, no count', () => {
  const { rerender } = render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={{ ...DETAIL, venue: '', mapHref: null, guests: null }} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText('GUESTS')).toBeNull();
  rerender(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={{ ...DETAIL, mapHref: null }} />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(/Grove on the River/)).toBeInTheDocument();
});

test('no kind, no separator; zero guests is a count, not a gap', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={{ ...DETAIL, kind: '', guests: 0 }} />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Alexis Henderson$/);
  expect(screen.getByText('0')).toHaveClass('m-dhead-guests');
});

test('the back arrow can name where it goes', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} backLabel="Back to Events" detail={DETAIL} />);
  expect(screen.getByRole('button', { name: 'Back to Events' })).toBeInTheDocument();
});

test('the Desktop-view escape still switches this screen', () => {
  render(<MobileHeader title="Event" screenKey="event-detail" onBack={() => {}} detail={DETAIL} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to desktop view' }));
  expect(mockMobileView.setDesktopView).toHaveBeenCalledWith('event-detail', true);
});
