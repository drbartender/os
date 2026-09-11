import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import MenuDesignStep from './MenuDesignStep';

// The v1 "no printed menu" note reassures a BYOB client their picks still
// drive the shopping list; a hosted client has no list, so the note must not
// promise one.
const props = { selections: { menuStyle: 'none' }, activeModules: [], onChange: () => {} };

test('BYOB no-menu note points at the shopping list', () => {
  render(<MenuDesignStep {...props} hosted={false} />);
  expect(screen.getAllByText(/shopping list/i).length).toBeGreaterThan(0);
});

test('hosted no-menu note never mentions a shopping list', () => {
  render(<MenuDesignStep {...props} hosted />);
  expect(screen.queryAllByText(/shopping list/i)).toHaveLength(0);
});
