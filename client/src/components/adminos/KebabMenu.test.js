import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import KebabMenu from './KebabMenu';

// Repro for the kebab comm-link bug: a portal-rendered <a mailto:/tel:/sms:>
// must stay connected to the document through the click, because the browser
// runs the link's OS hand-off as the click's default action AFTER the
// (discrete) React event dispatch. If the menu unmounts the anchor
// synchronously in its own onClick, the hand-off is silently cancelled.
describe('KebabMenu — communication href items', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
  }

  test('clicked mailto anchor survives the click, then the menu closes', () => {
    render(
      <KebabMenu items={[{ label: 'Email', icon: 'mail', href: 'mailto:test@example.com' }]} />
    );

    openMenu();

    const emailLink = screen.getByRole('menuitem', { name: /email/i });
    expect(emailLink.tagName).toBe('A');
    expect(emailLink.getAttribute('href')).toBe('mailto:test@example.com');

    // After the click the anchor must STILL be in the DOM so the browser can
    // perform the mailto: hand-off. The buggy code unmounts it here.
    fireEvent.click(emailLink);
    expect(emailLink.isConnected).toBe(true);

    // The close is deferred, not skipped — it still happens on the next tick.
    act(() => {
      jest.runAllTimers();
    });
    expect(screen.queryByRole('menuitem', { name: /email/i })).toBeNull();
  });

  test('tel: and sms: anchors also survive the click', () => {
    render(
      <KebabMenu
        items={[
          { label: 'Call', icon: 'phone', href: 'tel:5551234567' },
          { label: 'Text', icon: 'chat', href: 'sms:5551234567' },
        ]}
      />
    );

    openMenu();
    const callLink = screen.getByRole('menuitem', { name: /call/i });
    fireEvent.click(callLink);
    expect(callLink.isConnected).toBe(true);
    act(() => {
      jest.runAllTimers();
    });

    openMenu();
    const textLink = screen.getByRole('menuitem', { name: /text/i });
    fireEvent.click(textLink);
    expect(textLink.isConnected).toBe(true);
  });

  test('non-href (onClick) items still fire and still close synchronously', () => {
    const onClick = jest.fn();
    render(<KebabMenu items={[{ label: 'View', icon: 'eye', onClick }]} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /view/i }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: /view/i })).toBeNull();
  });
});
