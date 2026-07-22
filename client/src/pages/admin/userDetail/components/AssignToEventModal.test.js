import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, waitFor } from '@testing-library/react';
import AssignToEventModal from './AssignToEventModal';
import api from '../../../../utils/api';

jest.mock('../../../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../../../components/EntityLink', () => ({
  __esModule: true,
  default: ({ children }) => <span>{children}</span>,
}));

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };

// Money seam: the button label states the role this row will POST into
// shift_requests.position, which payroll's tip split keys on. These pin which
// role gets preselected from the roster + the feed's approved_by_role aggregate.

function mockFeed(shift) {
  api.get.mockResolvedValue({
    data: [{
      id: 7,
      client_name: 'Rivera Wedding',
      event_date: '2026-08-01',
      approved_count: 0,
      ...shift,
    }],
  });
}

function renderModal() {
  return render(
    <AssignToEventModal userId={42} staffName="Casey" onClose={() => {}} toast={toast} />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AssignToEventModal position default', () => {
  test('open bartender slot preselects Bartender', async () => {
    mockFeed({ positions_needed: '["Bartender","Barback"]' });
    renderModal();
    expect(await screen.findByText('Assign as Bartender')).toBeInTheDocument();
  });

  test('bartender slot filled falls through to the open Barback slot', async () => {
    mockFeed({
      positions_needed: '["Bartender","Barback"]',
      approved_count: 1,
      approved_by_role: { Bartender: 1 },
    });
    renderModal();
    expect(await screen.findByText('Assign as Barback')).toBeInTheDocument();
  });

  // Regression: POST /shifts stores positions_needed verbatim, so a hand-typed
  // "Bar Back" survives and canonicalizes to nothing. Before the fix that left
  // positionOptions empty, so NO select rendered and the row silently POSTed the
  // 'Bartender' fallback — tip-pool eligible, with no way to correct it.
  test('a roster that canonicalizes to nothing still renders a correctable select', async () => {
    mockFeed({ positions_needed: '["Bar Back"]' });
    renderModal();

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    expect(Array.from(screen.getByRole('combobox').options).map(o => o.value))
      .toEqual(['Bartender', 'Banquet Server', 'Barback']);
  });

  test('a single-role roster needs no select', async () => {
    mockFeed({ positions_needed: '["Bartender","Bartender"]' });
    renderModal();

    expect(await screen.findByText('Assign as Bartender')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
