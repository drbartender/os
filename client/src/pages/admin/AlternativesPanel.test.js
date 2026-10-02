import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), delete: jest.fn() } }));
jest.mock('../../components/SendModal', () => ({
  __esModule: true,
  default: () => <div data-testid="send-modal" />,
  describeSendResult: () => ({ hadFailure: false, message: '' }),
}));
import { MemoryRouter } from 'react-router-dom';
import AlternativesPanel from './AlternativesPanel';

// "Copy compare link" used to render on every grouped proposal, so Dallas copied
// it while an option was still a draft and the client page skipped straight to the
// sign page (fix list, 2026-09-22). Copy is offered only when the link really shows
// a comparison; Preview comparison is how admin sees it before sending.

const TOKEN = '75826cda-553a-4827-80eb-a4215a0bb313';
const proposal = { id: 1, status: 'viewed', amount_paid: 0 };
const member = (id, status, name) => ({ id, status, package_name: name, total_price: 1000 });

const mount = (group) => render(
  <MemoryRouter>
    <AlternativesPanel proposalId={1} proposal={proposal} group={{ grouped: true, group_token: TOKEN, ...group }} onChanged={jest.fn()} />
  </MemoryRouter>,
);

test('a draft option hides Copy, explains why, and offers the preview', () => {
  mount({
    decided: false,
    compare_visible_count: 1,
    members: [member(1, 'viewed', 'The Core Reaction'), member(2, 'draft', 'The Enhanced Solution')],
  });
  expect(screen.queryByText('Copy compare link')).toBeNull();
  expect(screen.getByText(/only shows sent options/)).toBeInTheDocument();
  expect(screen.getByText('Send options')).toBeInTheDocument();
  const preview = screen.getByText('Preview comparison').closest('a');
  expect(preview).toHaveAttribute('href', `/compare/${TOKEN}/preview`);
  expect(preview).toHaveAttribute('target', '_blank');
});

test('every option sent and two visible: Copy is offered, no hint', () => {
  mount({
    decided: false,
    compare_visible_count: 2,
    members: [member(1, 'viewed', 'The Core Reaction'), member(2, 'sent', 'The Enhanced Solution')],
  });
  expect(screen.getByText('Copy compare link')).toBeInTheDocument();
  expect(screen.getByText('Preview comparison')).toBeInTheDocument();
  expect(screen.queryByText(/only shows sent options/)).toBeNull();
  expect(screen.queryByText(/Fewer than two options/)).toBeNull();
});

test('no drafts but fewer than two visible (one archived): no Copy, says why', () => {
  mount({
    decided: false,
    compare_visible_count: 1,
    members: [member(1, 'viewed', 'The Core Reaction'), member(2, 'archived', 'The Enhanced Solution')],
  });
  expect(screen.queryByText('Copy compare link')).toBeNull();
  expect(screen.getByText(/Fewer than two options are live/)).toBeInTheDocument();
});

test('a decided group offers neither Copy nor Preview', () => {
  mount({
    decided: true,
    compare_visible_count: 1,
    members: [member(1, 'deposit_paid', 'The Core Reaction'), member(2, 'archived', 'The Enhanced Solution')],
  });
  expect(screen.queryByText('Copy compare link')).toBeNull();
  expect(screen.queryByText('Preview comparison')).toBeNull();
  expect(screen.getByText(/The client booked one of these options/)).toBeInTheDocument();
});

test('two sent and one draft: no Copy, and the hint says the draft would be left out', () => {
  mount({
    decided: false,
    compare_visible_count: 2,
    members: [
      member(1, 'viewed', 'The Core Reaction'),
      member(2, 'sent', 'The Enhanced Solution'),
      member(3, 'draft', 'The Premium Formula'),
    ],
  });
  expect(screen.queryByText('Copy compare link')).toBeNull();
  expect(screen.getByText(/would leave it out/)).toBeInTheDocument();
  expect(screen.queryByText(/only shows sent options/)).toBeNull();
});
