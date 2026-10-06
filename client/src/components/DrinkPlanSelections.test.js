import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import DrinkPlanSelections from './DrinkPlanSelections';

const plan = {
  serving_type: null,
  selections: {
    activeModules: { signatureDrinks: true, fullBar: true },
    signatureDrinks: ['margarita'],
    customCocktails: ['Spicy Paloma'],
    spirits: ['Vodka'],
    crowd: { drinkers: 80, profile: 'moderate' },
    guestPreferences: { beerVsWine: 'mostly_wine' },
    additionalNotes: 'Bride loves tequila',
    menuStyle: 'house',
    logistics: { parking: 'street_parking', equipment: ['bar_table'] },
    barPlacement: 'outdoors',
  },
};
const cocktails = [{ id: 'margarita', name: 'Margarita' }];

// A regression guard, not a red test: today's card already renders all of this.
test('listOnly keeps the answers that drive the list', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} listOnly />);
  expect(screen.getByText(/Margarita/)).toBeInTheDocument();
  expect(screen.getByText(/Spicy Paloma/)).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('Guest preferences: beer vs wine: mostly wine')).toBeInTheDocument();
  expect(screen.getByText(/Bride loves tequila/)).toBeInTheDocument();
});

test('listOnly drops menu design and every logistics answer', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} listOnly />);
  expect(screen.queryByText(/Menu Design/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Logistics/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Parking/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Bar placement/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Equipment/)).not.toBeInTheDocument();
});

test('the default render is unchanged: menu design, logistics, crowd and guest preferences all show', () => {
  render(<DrinkPlanSelections plan={plan} cocktails={cocktails} />);
  expect(screen.getByText(/Menu Design/)).toBeInTheDocument();
  expect(screen.getByText(/Logistics/)).toBeInTheDocument();
  expect(screen.getByText('Parking: street parking')).toBeInTheDocument();
  expect(screen.getByText('Crowd: 80 drinkers · moderate')).toBeInTheDocument();
  expect(screen.getByText('Guest preferences: beer vs wine: mostly wine')).toBeInTheDocument();
});

test('a legacy plan drops its logistics notes in listOnly', () => {
  const legacy = { serving_type: 'beer-wine-only', selections: { beerStyles: ['IPA'], logisticsNotes: 'Load in via alley' } };
  render(<DrinkPlanSelections plan={legacy} listOnly />);
  expect(screen.getByText(/IPA/)).toBeInTheDocument();
  expect(screen.queryByText(/Load in via alley/)).not.toBeInTheDocument();
});

test('a legacy plan with only logistics notes shows the empty line in listOnly, never the notes', () => {
  const legacy = { serving_type: null, selections: { logisticsNotes: 'Load in via alley' } };
  render(<DrinkPlanSelections plan={legacy} listOnly />);
  expect(screen.getByText("Client hasn't made any selections yet.")).toBeInTheDocument();
  expect(screen.queryByText(/Load in via alley/)).not.toBeInTheDocument();
});

test('a legacy plan with answers never also claims it has none', () => {
  const legacy = { serving_type: null, selections: { beerStyles: ['IPA'] } };
  render(<DrinkPlanSelections plan={legacy} />);
  expect(screen.getByText(/IPA/)).toBeInTheDocument();
  expect(screen.queryByText("Client hasn't made any selections yet.")).not.toBeInTheDocument();
});
