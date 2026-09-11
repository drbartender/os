import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import DrinksV2 from './DrinksV2';

// A hosted package whose contents are not entered yet falls back to this BYOB
// picker (content-readiness switch); its banner must not promise that client
// a shopping list.
const catalog = { cocktailCategories: [], mocktailCategories: [], cocktails: [], mocktails: [] };
const props = { selections: {}, updateSelections: () => {}, catalog };

test('BYOB picker banner promises the shopping list', () => {
  render(<DrinksV2 plan={{ package_category: 'byob' }} {...props} />);
  expect(screen.getAllByText(/shopping list/i).length).toBeGreaterThan(0);
});

test('hosted fallback picker never mentions a shopping list', () => {
  render(<DrinksV2 plan={{ package_category: 'hosted' }} {...props} />);
  expect(screen.queryAllByText(/shopping list/i)).toHaveLength(0);
});

// The >4-cocktails warning is the other place this screen mentions the list.
const fivePicked = { signatureDrinks: ['a', 'b', 'c', 'd', 'e'] };

test('BYOB over-pick warning mentions the shopping list', () => {
  render(<DrinksV2 plan={{ package_category: 'byob' }} {...props} selections={fivePicked} />);
  expect(screen.getByText(/shopping list grows fast/i)).toBeInTheDocument();
});

test('hosted over-pick warning never mentions a shopping list', () => {
  render(<DrinksV2 plan={{ package_category: 'hosted' }} {...props} selections={fivePicked} />);
  expect(screen.getByText(/service slows down/i)).toBeInTheDocument();
  expect(screen.queryAllByText(/shopping list/i)).toHaveLength(0);
});
