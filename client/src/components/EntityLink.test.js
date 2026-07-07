import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EntityLink from './EntityLink';

test('renders a real anchor with entity-link class and href', () => {
  render(
    <MemoryRouter>
      <EntityLink to="/staffing/users/7">Zul Ahmed</EntityLink>
    </MemoryRouter>
  );
  const a = screen.getByRole('link', { name: 'Zul Ahmed' });
  expect(a).toHaveAttribute('href', '/staffing/users/7');
  expect(a).toHaveClass('entity-link');
});

test('nullish to renders children without an anchor', () => {
  render(
    <MemoryRouter>
      <EntityLink to={null}>Walk-in Client</EntityLink>
    </MemoryRouter>
  );
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Walk-in Client')).toBeInTheDocument();
});

test('merges extra className', () => {
  render(
    <MemoryRouter>
      <EntityLink to="/clients/3" className="event-client-link">Jane</EntityLink>
    </MemoryRouter>
  );
  expect(screen.getByRole('link')).toHaveClass('entity-link', 'event-client-link');
});
