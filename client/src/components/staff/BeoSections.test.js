import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BarMenuCard } from './BeoSections';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), defaults: { baseURL: '/api' } },
}));

// Regression (2026-08-25): the API is cross-origin from the portal, and a
// proxy or a missing expose can hide Content-Disposition from the browser. The
// old fallback named every such file bar-menu.pdf, so a PNG menu would not
// open on a desktop. The blob's own type is the second source of truth.
describe('BarMenuCard download filename', () => {
  let clicks;
  let clickSpy;
  beforeEach(() => {
    clicks = [];
    global.URL.createObjectURL = jest.fn(() => 'blob:menu');
    global.URL.revokeObjectURL = jest.fn();
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function click() { clicks.push(this.getAttribute('download')); });
  });
  afterEach(() => clickSpy.mockRestore());

  test('honors the server filename when the header is readable', async () => {
    api.get.mockResolvedValue({
      data: new Blob(['x'], { type: 'image/png' }),
      headers: { 'content-disposition': 'attachment; filename="bar-menu-602.png"' },
    });
    render(<BarMenuCard menuPrint={{ status: 'ready' }} shiftId={350} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download print file' }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]).toBe('bar-menu-602.png');
  });

  test('falls back to the blob type, not .pdf, when the header is hidden', async () => {
    api.get.mockResolvedValue({ data: new Blob(['x'], { type: 'image/png' }), headers: {} });
    render(<BarMenuCard menuPrint={{ status: 'ready' }} shiftId={350} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download print file' }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]).toBe('bar-menu.png');
  });
});
