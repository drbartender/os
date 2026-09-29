import React, { Suspense, createContext, useContext, useEffect } from 'react';
import '@testing-library/jest-dom';
import { render, screen, act } from '@testing-library/react';
import usePhoneHeader from './usePhoneHeader';

const Setter = createContext(null);
// Counts renders that drew event 13's header while the path was another one.
const seen = { wrong: 0 };

function Chrome({ pathname, children }) {
  const { headerDetail, setHeaderDetail } = usePhoneHeader(pathname);
  if (headerDetail && headerDetail.path !== pathname) seen.wrong += 1;
  return (
    <div>
      <div data-testid="header">{headerDetail ? headerDetail.title : 'none'}</div>
      <Setter.Provider value={setHeaderDetail}>{children}</Setter.Provider>
    </div>
  );
}
// A page sets its header from a passive effect and clears it on the way out,
// as EventDetailPhone does.
function Page({ title, path }) {
  const set = useContext(Setter);
  useEffect(() => {
    if (title) set({ title, path });
    return () => set(null);
  }, [set, title, path]);
  return <div>page</div>;
}
// Suspends while `gate` is a pending promise.
function Late({ gate }) {
  if (gate && !gate.done) throw gate.promise;
  return null;
}
function gateOf() {
  const gate = { done: false };
  gate.promise = new Promise((resolve) => { gate.open = () => { gate.done = true; resolve(); }; });
  return gate;
}
const header = () => screen.getByTestId('header').textContent;

beforeEach(() => { seen.wrong = 0; });

test('a header shows on the path it was set for', () => {
  render(<Chrome pathname="/events/13"><Page title="Alexis Henderson" path="/events/13" /></Chrome>);
  expect(header()).toBe('Alexis Henderson');
});

test('no header is drawn until a page sets one, and clearing it shows none', () => {
  const view = render(<Chrome pathname="/events/13"><Page title={null} /></Chrome>);
  expect(header()).toBe('none');
  view.rerender(<Chrome pathname="/events/13"><Page title="Alexis Henderson" path="/events/13" /></Chrome>);
  expect(header()).toBe('Alexis Henderson');
  view.rerender(<Chrome pathname="/events/13"><Page title={null} /></Chrome>);
  expect(header()).toBe('none');
});

test('the header of one event is never drawn on another, in any render', () => {
  // The page keeps its old title for the render that changes the route, as a
  // screen does until its own effect has cleared what it held.
  const view = render(<Chrome pathname="/events/13"><Page title="Alexis Henderson" path="/events/13" /></Chrome>);
  expect(header()).toBe('Alexis Henderson');
  view.rerender(<Chrome pathname="/events/14"><Page title={null} /></Chrome>);
  expect(header()).toBe('none');
  view.rerender(<Chrome pathname="/events/14"><Page title="June Marrow" path="/events/14" /></Chrome>);
  expect(header()).toBe('June Marrow');
  expect(seen.wrong).toBe(0);
});

test('a header set while the path is already the next one belongs to the next one', () => {
  const view = render(<Chrome pathname="/events/13"><Page title={null} /></Chrome>);
  view.rerender(<Chrome pathname="/events/14"><Page title="June Marrow" path="/events/14" /></Chrome>);
  expect(header()).toBe('June Marrow');
  view.rerender(<Chrome pathname="/events/13"><Page title="June Marrow" path="/events/14" /></Chrome>);
  expect(header()).toBe('none');
});

test('a suspended boundary that hides the chrome and reveals it leaves the header in place', async () => {
  const gate = gateOf();
  const tree = (g) => (
    <Suspense fallback={<div>loading</div>}>
      <Chrome pathname="/events/13">
        <Page title="Alexis Henderson" path="/events/13" />
        <Late gate={g} />
      </Chrome>
    </Suspense>
  );
  const view = render(tree(null));
  expect(header()).toBe('Alexis Henderson');
  view.rerender(tree(gate));
  expect(screen.getByText('loading')).toBeInTheDocument();
  await act(async () => { gate.open(); await gate.promise; });
  expect(screen.queryByText('loading')).toBeNull();
  expect(header()).toBe('Alexis Henderson');
});
