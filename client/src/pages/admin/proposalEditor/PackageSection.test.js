import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PackageSection, { partitionPackages } from './PackageSection';

// Shapes mirror live service_packages rows. Mixology 101 carries
// category 'byob' on purpose: that is what the live class rows actually hold,
// so a partition that keyed on category would put it in the wrong bucket.
const CORE = {
  id: 1, name: 'The Core Reaction', category: 'byob', pricing_type: 'flat',
  bar_type: 'service_only', base_rate_4hr: 350, extra_hour_rate: 100,
};
const BASE = {
  id: 3, name: 'The Base Compound', category: 'hosted', pricing_type: 'per_guest',
  bar_type: 'full_bar', base_rate_4hr: 18, base_rate_4hr_small: 23, extra_hour_rate: 5,
};
const FORMULA = {
  id: 6, name: 'Formula No. 5', category: 'hosted', pricing_type: 'per_guest',
  bar_type: 'full_bar', base_rate_4hr: 33, base_rate_4hr_small: 39, extra_hour_rate: 9,
};
const MIXOLOGY = {
  id: 2077, name: 'Mixology 101', category: 'byob', pricing_type: 'per_guest',
  bar_type: 'class', base_rate_4hr: 35, extra_hour_rate: 0,
};
const SPIRITS = {
  id: 2078, name: 'Spirits Tasting', category: 'byob', pricing_type: 'per_guest',
  bar_type: 'class', base_rate_4hr: 35, extra_hour_rate: 0,
};
const ALL = [CORE, BASE, FORMULA, MIXOLOGY, SPIRITS];

const baseForm = {
  package_id: '', addon_ids: [], addon_variants: {}, addon_quantities: {},
  client_provides_glassware: false, class_options: null, syrup_selections: [],
};

function renderSection(over = {}) {
  const update = jest.fn();
  const props = {
    editForm: { ...baseForm, ...(over.editForm || {}) },
    packages: over.packages || ALL,
    filteredAddons: [],
    selectedPkg: over.selectedPkg ?? null,
    update,
    toggleAddon: jest.fn(),
    setAddonQty: jest.fn(),
    setVariant: jest.fn(),
  };
  return { update, ...render(<PackageSection {...props} />) };
}

test('classes split on bar_type, hosted on per-guest, everything else stays loose', () => {
  const { loose, hosted, classes } = partitionPackages(ALL);
  expect(loose.map(p => p.id)).toEqual([1]);
  expect(hosted.map(p => p.id)).toEqual([3, 6]);
  expect(classes.map(p => p.id)).toEqual([2077, 2078]);
});

test('both groups start collapsed, so no grouped package is on screen', () => {
  renderSection();
  expect(screen.queryByText('Formula No. 5')).not.toBeInTheDocument();
  expect(screen.queryByText('Mixology 101')).not.toBeInTheDocument();
  // The loose remainder is never folded.
  expect(screen.getByText('The Core Reaction')).toBeInTheDocument();
});

test('a collapsed group names the selected package in its header', () => {
  renderSection({ editForm: { package_id: '2077' }, selectedPkg: MIXOLOGY });
  expect(screen.getByRole('button', { name: /Classes/ })).toHaveTextContent('Mixology 101');
  expect(screen.getByRole('button', { name: /Hosted packages/ })).not.toHaveTextContent('Mixology 101');
});

test('expanding a group reveals its packages', () => {
  renderSection();
  fireEvent.click(screen.getByRole('button', { name: /Hosted packages/ }));
  expect(screen.getByText('Formula No. 5')).toBeInTheDocument();
  // The other group stays shut.
  expect(screen.queryByText('Mixology 101')).not.toBeInTheDocument();
});

test('picking a package inside an expanded group selects it', () => {
  const { update } = renderSection();
  fireEvent.click(screen.getByRole('button', { name: /Hosted packages/ }));
  fireEvent.click(screen.getByRole('radio', { name: /Formula No\. 5/ }));
  expect(update).toHaveBeenCalledWith('package_id', '6');
});
