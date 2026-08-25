import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import DownloadTipSign from './DownloadTipSign';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));
// The sign artwork needs canvas, fonts and html2canvas; none of that is under
// test here. Structure is.
jest.mock('./tipCard/SignLayout', () => () =>
  require('react').createElement('div', { 'data-testid': 'sign-layout' }));
jest.mock('./tipCard/BizCardLayout', () => ({
  BizCardFront: () => require('react').createElement('div', { 'data-testid': 'card-front' }),
  BizCardBack: () => require('react').createElement('div', { 'data-testid': 'card-back' }),
}));
jest.mock('./tipCard/renderToFile', () => ({
  captureNode: jest.fn(), downloadCanvasImage: jest.fn(), downloadCanvasesPdf: jest.fn(),
}));

// Regression (2026-08-25): the page root carried the `.drb` design-system
// class, whose base rules paint h1/h2/p cream in the display face at marketing
// sizes. The download panel is a white card, so its title and help copy were
// cream-on-white in both portal skins. The chalkboard scope belongs on the
// sign surfaces only.
test('the white panel sits outside the .drb chalkboard scope; the sign surfaces sit inside it', async () => {
  api.get.mockResolvedValue({
    data: { active: true, url: 'https://drbartender.com/tip/abc', display_name: 'Dallas', methods: [] },
  });
  render(<DownloadTipSign />);
  const h1 = await screen.findByRole('heading', { name: 'Download your sign' });
  expect(h1.closest('.drb')).toBeNull();
  expect(screen.getByText(/JPG is the safest bet/).closest('.drb')).toBeNull();
  for (const el of screen.getAllByTestId('sign-layout')) expect(el.closest('.drb')).not.toBeNull();
  expect(screen.getByTestId('card-front').closest('.drb')).not.toBeNull();
  expect(screen.getByTestId('card-back').closest('.drb')).not.toBeNull();
});
