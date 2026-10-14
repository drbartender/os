import '@testing-library/jest-dom';
import React, { useEffect } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastContext';

// Fires one toast on mount through the real provider.
function Fire({ run }) {
  const toast = useToast();
  useEffect(() => { run(toast); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
const mount = (run) => render(<ToastProvider><Fire run={run} /></ToastProvider>);

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('a one-argument toast is unchanged: text and a dismiss, gone after its default', () => {
  mount((t) => t.success('Saved.'));
  expect(screen.getByText('Saved.')).toBeInTheDocument();
  expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss notification']);
  act(() => { jest.advanceTimersByTime(4999); });
  expect(screen.getByText('Saved.')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(1); });
  expect(screen.queryByText('Saved.')).toBeNull();
});

test('an action draws a button that runs once and dismisses the toast', () => {
  const onClick = jest.fn();
  mount((t) => t.info('Done. Moved to Handled.', { action: { label: 'Undo', onClick } }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Done. Moved to Handled.')).toBeNull();
});

test('duration replaces the default timeout', () => {
  mount((t) => t.success('Snoozed until Wed 8:00 AM.', { duration: 4200 }));
  act(() => { jest.advanceTimersByTime(4199); });
  expect(screen.getByText('Snoozed until Wed 8:00 AM.')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(1); });
  expect(screen.queryByText('Snoozed until Wed 8:00 AM.')).toBeNull();
});

test('a malformed second argument falls back to the defaults', () => {
  mount((t) => t.error('Nope.', { action: { label: 'Undo' }, duration: -5 }));
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  act(() => { jest.advanceTimersByTime(7999); });
  expect(screen.getByText('Nope.')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(1); });
  expect(screen.queryByText('Nope.')).toBeNull();
});
