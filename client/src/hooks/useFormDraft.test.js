import '@testing-library/jest-dom';
import React, { useState, useEffect } from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import useFormDraft from './useFormDraft';
import api from '../utils/api';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

function Harness({ initial = { city: '' } }) {
  const [form, setForm] = useState(initial);
  const { restoredAt, clearDraft, ready } = useFormDraft('application', form, d => setForm(f => ({ ...f, ...d })));
  return (
    <div>
      <div data-testid="city">{form.city}</div>
      <div data-testid="ready">{String(ready)}</div>
      <div data-testid="restored">{restoredAt || ''}</div>
      <button onClick={() => setForm(f => ({ ...f, city: 'Chicago' }))}>type</button>
      <button onClick={clearDraft}>clear</button>
    </div>
  );
}

// Mirrors ContractorProfile: the page loads saved profile data on mount, and
// the draft load waits on it. `profile` stands in for that server-loaded data.
function Gated({ enabled, profile }) {
  const [form, setForm] = useState({ phone: '' });
  useEffect(() => {
    if (profile) setForm(f => ({ ...f, ...profile }));
  }, [profile]);
  useFormDraft('contractor_profile', form, d => setForm(f => ({ ...f, ...d })), { enabled });
  return <div data-testid="phone">{form.phone}</div>;
}

beforeEach(() => {
  jest.useFakeTimers();
  api.get.mockReset();
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue({ data: {} });
});

afterEach(() => { jest.useRealTimers(); });

it('restores a stored draft on mount', async () => {
  api.get.mockResolvedValue({ data: { data: { city: 'Evanston' }, updated_at: '2026-07-23T20:00:00Z' } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('city')).toHaveTextContent('Evanston'));
  expect(screen.getByTestId('restored')).toHaveTextContent('2026-07-23T20:00:00Z');
});

it('leaves the form alone when there is no draft', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  expect(screen.getByTestId('city')).toHaveTextContent('');
  expect(screen.getByTestId('restored')).toHaveTextContent('');
});

it('does not announce a restore for a draft of empty fields', async () => {
  api.get.mockResolvedValue({ data: { data: { city: '', name: '' }, updated_at: '2026-07-23T20:00:00Z' } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  expect(screen.getByTestId('restored')).toHaveTextContent('');
});

it('never saves an untouched form', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.put).not.toHaveBeenCalled();
});

it('does not save when an edit returns the form to its starting value', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness initial={{ city: 'Chicago' }} />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  act(() => { screen.getByText('type').click(); }); // sets city back to 'Chicago'
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).not.toHaveBeenCalled();
});

it('does not fetch until enabled', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  const { rerender } = render(<Gated enabled={false} />);
  await act(async () => {});
  expect(api.get).not.toHaveBeenCalled();

  rerender(<Gated enabled={true} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/progress/draft/contractor_profile'));
});

// The outcome the `enabled` gate exists to guarantee, not just the mechanism.
// This is the spec Risk "draft restore versus server-loaded profile data".
it('lets the draft win over already-loaded profile data', async () => {
  api.get.mockResolvedValue({ data: { data: { phone: '7735551111' }, updated_at: '2026-07-26T12:00:00Z' } });

  // enabled=false models the page before /contractor resolves. The profile
  // value lands first, exactly as ContractorProfile's own fetch would set it.
  const { rerender } = render(<Gated enabled={false} profile={{ phone: '3125550000' }} />);
  await waitFor(() => expect(screen.getByTestId('phone')).toHaveTextContent('3125550000'));

  // Now the profile fetch has settled, so the draft is allowed to load.
  rerender(<Gated enabled={true} profile={{ phone: '3125550000' }} />);
  await waitFor(() => expect(screen.getByTestId('phone')).toHaveTextContent('7735551111'));
});

it('saves on a debounce after a change', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); });
  expect(api.put).not.toHaveBeenCalled();

  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).toHaveBeenCalledWith('/progress/draft/application', { data: { city: 'Chicago' } });
});

it('coalesces rapid edits into one save', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); jest.advanceTimersByTime(500); });
  act(() => { screen.getByText('type').click(); jest.advanceTimersByTime(500); });
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(api.put).toHaveBeenCalledTimes(1);
});

// Regression: three independent review lenses reproduced this. A save armed just
// before submit was never cancelled, so the PUT landed AFTER the DELETE and
// re-INSERTed the row via the ON CONFLICT upsert. Nothing then removed it, and the
// next visit announced "We saved your answers from ..." for a submitted form.
// Reachable on the ordinary path: the last field sits directly above the submit
// button, so a keystroke under 1.5s before the click is normal, not contrived.
it('cancels a save armed before clearDraft, so the row is never resurrected', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); });          // arms a PUT for +1500ms
  await act(async () => { jest.advanceTimersByTime(300); }); // user clicks submit here

  await act(async () => { screen.getByText('clear').click(); });
  expect(api.delete).toHaveBeenCalled();

  // Let the original debounce window expire in full, plus margin.
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(api.put).not.toHaveBeenCalled();
});

it('ignores a late timer even if one somehow survives cancellation', async () => {
  // Belt and braces: the callback itself re-checks clearedRef, so even a timer the
  // cancellation missed cannot issue the write.
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));

  act(() => { screen.getByText('type').click(); });
  await act(async () => { screen.getByText('clear').click(); });
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(api.put).not.toHaveBeenCalled();
});

it('clearDraft deletes server side', async () => {
  api.get.mockResolvedValue({ data: { data: null } });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  await act(async () => { screen.getByText('clear').click(); });
  expect(api.delete).toHaveBeenCalledWith('/progress/draft/application');
});

it('a failed save is swallowed and never surfaces to the user', async () => {
  // Assert on the rejection itself, not on the rendered output. The harness has
  // no error surface, so checking that the city still reads "Chicago" would pass
  // whether the hook swallowed the rejection or let it escape.
  const onUnhandled = jest.fn();
  process.on('unhandledRejection', onUnhandled);

  api.get.mockResolvedValue({ data: { data: null } });
  api.put.mockRejectedValue({ message: 'Network error. Check your connection.' });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
  act(() => { screen.getByText('type').click(); });
  await act(async () => { jest.advanceTimersByTime(1500); });

  expect(api.put).toHaveBeenCalled();          // it really did try
  expect(onUnhandled).not.toHaveBeenCalled();  // and the failure went nowhere
  expect(screen.getByTestId('city')).toHaveTextContent('Chicago');
  process.off('unhandledRejection', onUnhandled);
});
