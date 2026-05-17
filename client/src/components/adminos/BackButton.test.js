import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import BackButton from './BackButton';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function EventsList() {
  return (
    <div>
      <h1>Events List</h1>
      <Link to="/events/1">Open event 1</Link>
    </div>
  );
}

function EventDetail() {
  return (
    <div>
      <BackButton fallback="/events" />
      <h1>Event 1 Detail</h1>
    </div>
  );
}

function Harness() {
  return (
    <Routes>
      <Route path="/events" element={<EventsList />} />
      <Route path="/events/1" element={<EventDetail />} />
    </Routes>
  );
}

describe('BackButton', () => {
  test('renders an icon button labelled Back', () => {
    render(
      <MemoryRouter initialEntries={['/events/1']}>
        <Harness />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  test('with in-app history, goes back to the previous location (navigate(-1))', () => {
    render(
      <MemoryRouter initialEntries={['/events']}>
        <Harness />
        <LocationProbe />
      </MemoryRouter>
    );
    expect(screen.getByText('Events List')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open event 1'));
    expect(screen.getByText('Event 1 Detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/events');
    expect(screen.getByText('Events List')).toBeInTheDocument();
  });

  test('on cold entry (no in-app history), falls back to the section list', () => {
    render(
      <MemoryRouter initialEntries={['/events/1']}>
        <Harness />
        <LocationProbe />
      </MemoryRouter>
    );
    expect(screen.getByText('Event 1 Detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/events');
    expect(screen.getByText('Events List')).toBeInTheDocument();
  });
});
