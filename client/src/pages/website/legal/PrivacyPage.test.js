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

// Spec 2026-10-14 section 9: the Google line names the mailbox reading.
test('names Google for venue lookup and for reading the business mailbox', () => {
  mount();
  const item = screen.getByText('Google, for venue address lookup and to read our business mailbox so client email reaches our inbox');
  expect(item.tagName).toBe('LI');
});

test('the date at the top moved with the change', () => {
  mount();
  expect(screen.getByText('Last updated: October 15, 2026')).toBeInTheDocument();
});
