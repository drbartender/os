import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, within, fireEvent } from '@testing-library/react';
import DocumentsTab from './DocumentsTab';

// The signed agreement PDF is admin-only on the server
// (GET /api/agreement/admin/:userId/pdf): it shows the signature, IP and user
// agent the staff record withholds from a manager. The tab therefore offers
// Open on the agreement row only when the parent says the viewer may open it,
// and offers nothing by default. The resend of the signer's copy stays for a
// manager: it mails the signer and shows the caller nothing.

jest.mock('../../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../../context/ToastContext', () => ({ useToast: () => mockToast }));

const signed = {
  user_id: 303,
  signed_at: '2026-03-01T15:00:00Z',
  pdf_storage_key: 'agreements/303/contractor-agreement-v3-1.pdf',
  pdf_generated_at: '2026-03-01T15:00:05Z',
  pdf_email_sent_at: '2026-03-01T15:00:09Z',
};

const agreementRow = () => screen.getByText('Contractor agreement').closest('.hstack');

test('no Open on the agreement row unless the parent allows it (the default refuses)', () => {
  const previewFile = jest.fn();
  const { rerender } = render(<DocumentsTab agreement={signed} previewFile={previewFile} />);
  expect(within(agreementRow()).queryByRole('button', { name: /open/i })).toBeNull();
  rerender(<DocumentsTab canOpenAgreement={false} agreement={signed} previewFile={previewFile} />);
  expect(within(agreementRow()).queryByRole('button', { name: /open/i })).toBeNull();
});

test('an admin viewer opens the signed PDF through the admin route', () => {
  const previewFile = jest.fn();
  render(<DocumentsTab canOpenAgreement agreement={signed} previewFile={previewFile} />);
  fireEvent.click(within(agreementRow()).getByRole('button', { name: /open/i }));
  expect(previewFile).toHaveBeenCalledWith('/agreement/admin/303/pdf', 'contractor-agreement.pdf', 'Contractor agreement');
});

test('a viewer who cannot open the PDF can still resend a copy that never went out', () => {
  render(<DocumentsTab agreement={{ ...signed, pdf_email_sent_at: null }} previewFile={jest.fn()} />);
  const row = agreementRow();
  expect(within(row).queryByRole('button', { name: /open/i })).toBeNull();
  expect(within(row).getByRole('button', { name: /resend copy/i })).toBeInTheDocument();
});
