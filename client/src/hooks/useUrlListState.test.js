import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import useUrlListState from './useUrlListState';

const DEFAULTS = { tab: 'upcoming', q: '' };

function Harness() {
  const [state, setState] = useUrlListState(DEFAULTS);
  const loc = useLocation();
  return (
    <div>
      <div data-testid="tab">{state.tab}</div>
      <div data-testid="q">{state.q}</div>
      <div data-testid="search">{loc.search}</div>
      <button onClick={() => setState({ tab: 'past' })}>past</button>
      <button onClick={() => setState({ tab: 'upcoming' })}>reset-tab</button>
      <button onClick={() => setState({ q: 'ketan' })}>type</button>
    </div>
  );
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Harness />
    </MemoryRouter>
  );
}

test('reads defaults when params absent, and param values when present', () => {
  renderAt('/events?tab=past&drawer=shift&drawerId=9');
  expect(screen.getByTestId('tab')).toHaveTextContent('past');
  expect(screen.getByTestId('q')).toHaveTextContent('');
});

test('setState writes non-defaults and omits defaults from the URL', () => {
  renderAt('/events');
  fireEvent.click(screen.getByText('past'));
  expect(screen.getByTestId('search')).toHaveTextContent('?tab=past');
  fireEvent.click(screen.getByText('reset-tab'));
  expect(screen.getByTestId('search')).toHaveTextContent('');
});

test('writes replace history: Back crosses pages, never filter states', () => {
  function BackProbe() {
    const [, setState] = useUrlListState(DEFAULTS);
    const loc = useLocation();
    return (
      <div>
        <div data-testid="path">{loc.pathname}</div>
        <button onClick={() => setState({ tab: 'past' })}>flip1</button>
        <button onClick={() => setState({ q: 'ketan' })}>flip2</button>
      </div>
    );
  }
  function Backer() {
    const navigate = useNavigate();
    return <button onClick={() => navigate(-1)}>back</button>;
  }
  render(
    <MemoryRouter initialEntries={['/other', '/events']} initialIndex={1}>
      <BackProbe />
      <Backer />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByText('flip1'));
  fireEvent.click(screen.getByText('flip2'));
  fireEvent.click(screen.getByText('back'));
  expect(screen.getByTestId('path')).toHaveTextContent('/other');
});

test('inline defaults literal is safe (captured on first render)', () => {
  function InlineHarness() {
    const [state, setState] = useUrlListState({ tab: 'upcoming' });
    return (
      <div>
        <div data-testid="tab2">{state.tab}</div>
        <button onClick={() => setState({ tab: 'past' })}>go-past</button>
      </div>
    );
  }
  render(
    <MemoryRouter initialEntries={['/events']}>
      <InlineHarness />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByText('go-past'));
  expect(screen.getByTestId('tab2')).toHaveTextContent('past');
});

test('preserves undeclared params (drawer passthrough)', () => {
  renderAt('/events?drawer=shift&drawerId=9');
  fireEvent.click(screen.getByText('type'));
  const s = screen.getByTestId('search').textContent;
  expect(s).toContain('drawer=shift');
  expect(s).toContain('drawerId=9');
  expect(s).toContain('q=ketan');
});
