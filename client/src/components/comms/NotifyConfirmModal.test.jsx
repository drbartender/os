import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import NotifyConfirmModal from './NotifyConfirmModal';

// Pinned before lane ma-e3a moved the draft logic into notifyDrafts.js. The
// edit popup is called with primary="quiet"; the payment and refund popups use
// the same component.
const notices = [{
  type: 'event_details_changed', composable: true, reasons: ['event_date changed'],
  recipient: { name: 'Alexis', email: 'a@example.com', phone: null },
  channels: { email: { available: true, default: true }, sms: { available: true, default: false } },
  draft: { email: { subject: 'Your event moved', body_text: 'Hi' }, sms: { body: 'Moved' } },
}];
const props = { notices, primary: 'quiet', onCancel: () => {}, onQuiet: () => {}, onSend: () => {} };

test('ticks the available, defaulted channels and sends their text (characterization)', () => {
  const onSend = jest.fn();
  render(<NotifyConfirmModal {...props} onSend={onSend} />);
  expect(screen.getByRole('checkbox', { name: 'Email' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Text' })).not.toBeChecked();
  expect(screen.getByText('Date changed. Current contact on file: Alexis (a@example.com).')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send the update' }));
  expect(onSend).toHaveBeenCalledWith([
    { type: 'event_details_changed', channels: ['email'], email: { subject: 'Your event moved', body_text: 'Hi' } },
  ]);
});

test('an emptied subject on a ticked channel disables Send (characterization)', () => {
  render(<NotifyConfirmModal {...props} />);
  fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Send the update' })).toBeDisabled();
});

test("Don't send is rightmost on the edit popup and sends nothing (characterization)", () => {
  const onQuiet = jest.fn();
  render(<NotifyConfirmModal {...props} onQuiet={onQuiet} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent).slice(-3)).toEqual(['Cancel', 'Send the update', "Don't send"]);
  fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
  expect(onQuiet).toHaveBeenCalled();
});
