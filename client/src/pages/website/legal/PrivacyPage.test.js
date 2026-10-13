import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PrivacyPage from './PrivacyPage';

// PublicLayout scrolls to the top on mount; jsdom has no scrollTo.
beforeEach(() => { window.scrollTo = jest.fn(); });

const mount = () => render(<MemoryRouter><PrivacyPage /></MemoryRouter>);

test('names Anthropic among the providers, and what it never receives', () => {
  mount();
  const item = screen.getByText('Anthropic, to sort and summarize messages you send us (without your phone number, email address, or card and account numbers)');
  expect(item.tagName).toBe('LI');
  expect(item.closest('ul')).toHaveTextContent('Twilio, to send and receive text messages and calls');
});

test('the date at the top moved with the change', () => {
  mount();
  expect(screen.getByText('Last updated: October 9, 2026')).toBeInTheDocument();
});
