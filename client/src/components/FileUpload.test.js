import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FileUpload from './FileUpload';

jest.mock('../utils/downscaleImage', () => ({
  __esModule: true,
  default: jest.fn(async f => f),
}));

function makeFile(name, size, type = 'application/pdf') {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function setup(props = {}) {
  const onChange = jest.fn();
  render(<FileUpload label="Upload Your Resume" name="resume" kind="document" onChange={onChange} {...props} />);
  return { onChange, input: document.querySelector('input[type="file"]') };
}

// CRA sets resetMocks: true, which strips the module-factory implementation
// above before EVERY test. Without re-arming, downscaleImage resolves undefined,
// checkFile(undefined) returns "No file selected.", and every case that does not
// call mockResolvedValueOnce fails. clearAllMocks does NOT restore it.
beforeEach(() => {
  require('../utils/downscaleImage').default.mockImplementation(f => Promise.resolve(f));
});

it('accepts a normal file and reports it upward', async () => {
  const { onChange, input } = setup();
  const file = makeFile('resume.pdf', 900 * 1024);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', file));
});

it('rejects an oversized file inline and never calls onChange', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('scan.pdf', 14 * 1024 * 1024)] } });
  expect(await screen.findByText(/that file is 14MB/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it('rejects an unsupported type and says what works', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('resume.pages', 5000)] } });
  expect(await screen.findByText(/we cannot read \.pages/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it('clears a previous error once a good file is picked', async () => {
  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('a.pages', 10)] } });
  expect(await screen.findByText(/we cannot read/i)).toBeInTheDocument();

  const good = makeFile('resume.pdf', 1000);
  fireEvent.change(input, { target: { files: [good] } });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', good));
  expect(screen.queryByText(/we cannot read/i)).not.toBeInTheDocument();
});

it('routes images through the downscaler before accepting', async () => {
  const downscale = require('../utils/downscaleImage').default;
  const small = makeFile('small.jpg', 200 * 1024, 'image/jpeg');
  downscale.mockResolvedValueOnce(small);

  const { onChange, input } = setup();
  const huge = makeFile('huge.jpg', 9 * 1024 * 1024, 'image/jpeg');
  fireEvent.change(input, { target: { files: [huge] } });

  await waitFor(() => expect(onChange).toHaveBeenCalledWith('resume', small));
  expect(downscale).toHaveBeenCalledWith(huge);
});

it('accepts an image that only fits after downscaling', async () => {
  const downscale = require('../utils/downscaleImage').default;
  downscale.mockResolvedValueOnce(makeFile('shrunk.jpg', 300 * 1024, 'image/jpeg'));

  const { onChange, input } = setup();
  fireEvent.change(input, { target: { files: [makeFile('huge.heic', 18 * 1024 * 1024, 'image/heic')] } });

  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(screen.queryByText(/the limit is/i)).not.toBeInTheDocument();
});

// Regression guard. PaydayProtocols renders the W-9 field with no `kind`, and
// payment.js:92 validates it with the narrow isValidUpload. If the default ever
// widens, a .docx W-9 passes here and is rejected only after a full upload,
// which is the exact failure this component exists to prevent.
it('defaults to the narrow kind so the W-9 field matches its server validator', async () => {
  const onChange = jest.fn();
  render(<FileUpload label="Upload Your Signed W-9" name="w9" onChange={onChange} />);
  const input = document.querySelectorAll('input[type="file"]')[0];

  fireEvent.change(input, { target: { files: [makeFile('w9.docx', 40 * 1024)] } });
  expect(await screen.findByText(/we cannot read \.docx/i)).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
