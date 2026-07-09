import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent } from '@testing-library/react';
import PaletteContext from '../../context/PaletteContext';
import GlobalSearchButton from './GlobalSearchButton';

test('clicking the launcher opens the palette via context', () => {
  const openPalette = jest.fn();
  render(
    <PaletteContext.Provider value={{ openPalette }}>
      <GlobalSearchButton variant="toolbar" />
    </PaletteContext.Provider>
  );
  const btn = screen.getByRole('button', { name: /open command palette/i });
  expect(btn).toHaveClass('header-search');
  expect(btn).toHaveClass('gsearch-toolbar');
  fireEvent.click(btn);
  expect(openPalette).toHaveBeenCalledTimes(1);
});

test('header variant renders without the toolbar modifier', () => {
  render(
    <PaletteContext.Provider value={{ openPalette: jest.fn() }}>
      <GlobalSearchButton />
    </PaletteContext.Provider>
  );
  const btn = screen.getByRole('button', { name: /open command palette/i });
  expect(btn).not.toHaveClass('gsearch-toolbar');
});
