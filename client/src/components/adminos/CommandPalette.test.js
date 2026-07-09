import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

// Two record groups so ordering (clients before events) and wrap-around are real.
const RESULTS = {
  clients: [{ type: 'client', id: 7, name: 'Ana Smith', detail: 'ana@example.com' }],
  proposals: [],
  events: [{ type: 'event', id: 12, name: 'Bo Smith', detail: 'Wedding · Aug 2, 2026' }],
  staff: [],
};
const EMPTY = { clients: [], proposals: [], events: [], staff: [] };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette() {
  const onClose = jest.fn();
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <CommandPalette open onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>
  );
  return { onClose, input: screen.getByRole('combobox') };
}

describe('CommandPalette keyboard selection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    api.get.mockReset();
  });
  afterEach(() => {
    act(() => { jest.runOnlyPendingTimers(); });
    jest.useRealTimers();
  });

  test('Enter activates the top record hit and closes', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText('Ana Smith')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/7');
    expect(onClose).toHaveBeenCalled();
  });

  test('ArrowDown/ArrowUp move the active option with wrap; Enter fires the selection', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    // No nav label contains "smith", so the flat list is exactly the 2 records.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveClass('active');
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // wraps to top
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    fireEvent.keyDown(input, { key: 'ArrowUp' });   // wraps to bottom
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/events/12');
  });

  test('Enter while results are loading latches; fires the top record on arrival (fast-typist path)', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const { onClose, input } = renderPalette();
    // "sett" matches the "Settings" nav item, which IS on screen while loading —
    // the latch must prevent Enter from misfiring onto it.
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); }); // request in flight
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no nav misfire
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolveSearch({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/3');
    expect(onClose).toHaveBeenCalled();
  });

  test('Enter before the debounce even fires still latches (sub-200ms typist)', async () => {
    api.get.mockResolvedValue({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'sett' } });
    fireEvent.keyDown(input, { key: 'Enter' }); // debounce hasn't fired yet — nothing is loading
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no nav misfire
    await act(async () => { jest.advanceTimersByTime(200); }); // debounce fires; mocked request resolves
    expect(screen.getByTestId('location')).toHaveTextContent('/clients/3');
    expect(onClose).toHaveBeenCalled();
  });

  test('the latch clears if the user keeps typing', async () => {
    let resolveFirst;
    api.get
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smi' } });
    act(() => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'Enter' });               // latch set
    fireEvent.change(input, { target: { value: 'smit' } });   // keystroke clears it
    act(() => { jest.advanceTimersByTime(200); });            // second request fires
    await act(async () => { resolveFirst({ data: { results: RESULTS } }); }); // stale, dropped
    await act(async () => {});                                // flush second resolve
    expect(screen.getByText('Ana Smith')).toBeInTheDocument(); // results shown…
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // …but no auto-jump
  });

  test('Enter never activates stale rows from the previous query', async () => {
    api.get
      .mockResolvedValueOnce({ data: { results: RESULTS } })
      .mockResolvedValueOnce({ data: { results: EMPTY } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText('Ana Smith')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'smithx' } }); // old rows still on screen
    fireEvent.keyDown(input, { key: 'Enter' });               // must latch, NOT jump to stale Ana Smith
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    await act(async () => { jest.advanceTimersByTime(200); }); // 'smithx' returns empty → latch clears, visible no-op
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('an explicit arrow selection beats the latch', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'Enter' });      // latch set while loading
    fireEvent.keyDown(input, { key: 'ArrowDown' });  // arrow clears the latch, takes manual control
    fireEvent.keyDown(input, { key: 'Enter' });      // fires the explicit selection (Settings nav)
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
    expect(onClose).toHaveBeenCalled();
    await act(async () => { resolveSearch({ data: { results: EMPTY } }); }); // late arrival is inert
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
  });

  test('single-char query stays under the server floor; Enter activates the first matching nav item', () => {
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'e' } });
    act(() => { jest.advanceTimersByTime(200); });
    expect(api.get).not.toHaveBeenCalled(); // 2-char floor
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/events'); // "Events" is the first label containing "e"
  });

  test('selection resets to the top on a new keystroke', async () => {
    api.get.mockResolvedValue({ data: { results: RESULTS } });
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: 'smith' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
    fireEvent.change(input, { target: { value: 'smiths' } });
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
    await act(async () => { jest.advanceTimersByTime(200); }); // flush the second fetch
  });

  test('Enter with zero matches is a no-op', async () => {
    api.get.mockResolvedValue({ data: { results: EMPTY } });
    const { onClose, input } = renderPalette();
    fireEvent.change(input, { target: { value: 'zzzz' } });
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a latched Enter never fires after the palette is dismissed', async () => {
    let resolveSearch;
    api.get.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const onClose = jest.fn();
    const { rerender } = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CommandPalette open onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    );
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'sett' } });
    act(() => { jest.advanceTimersByTime(200); });   // request in flight
    fireEvent.keyDown(input, { key: 'Enter' });      // latch armed
    rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CommandPalette open={false} onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    );                                               // parent-initiated close (Esc path)
    await act(async () => {
      resolveSearch({ data: { results: { ...EMPTY, clients: [{ type: 'client', id: 3, name: 'Cate Settler', detail: '' }] } } });
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'); // no ghost navigation
    expect(onClose).not.toHaveBeenCalled();
  });
});
