import { downloadMenuPrint } from './downloadMenuPrint';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn() } }));
import api from './api';

// The shared save path for the bar menu print file (staff card + admin card).

let clicked;
beforeEach(() => {
  jest.useFakeTimers();
  clicked = [];
  global.URL.createObjectURL = jest.fn(() => 'blob:menu');
  global.URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    clicked.push({ href: this.getAttribute('href'), download: this.download });
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('asks for a blob and saves it under the filename the server sent', async () => {
  api.get.mockResolvedValue({
    data: new Blob(['x'], { type: 'image/png' }),
    headers: { 'content-disposition': 'attachment; filename="bar-menu-7.png"' },
  });
  await downloadMenuPrint('/proposals/7/menu-print');
  expect(api.get).toHaveBeenCalledWith('/proposals/7/menu-print', { responseType: 'blob' });
  expect(clicked).toEqual([{ href: 'blob:menu', download: 'bar-menu-7.png' }]);
});

test('names the file from the blob type when the header is unreadable', async () => {
  api.get.mockResolvedValue({ data: new Blob(['x'], { type: 'image/jpeg' }), headers: {} });
  await downloadMenuPrint('/shifts/3/menu-print');
  expect(clicked[0].download).toBe('bar-menu.jpg');
});

test('revokes the object URL only after the download has started', async () => {
  api.get.mockResolvedValue({ data: new Blob(['x'], { type: 'application/pdf' }), headers: {} });
  await downloadMenuPrint('/proposals/7/menu-print');
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:menu');
});

// api.js cannot read a Blob error body, so its message is always the generic
// one; the helper says what the status means instead.
test.each([
  [404, 'No menu file is posted for this event.'],
  [403, 'Only assigned staff can download the menu file.'],
  [429, 'Too many downloads in a row. Wait a few minutes and try again.'],
  [502, 'The menu file is temporarily unavailable. Try again in a minute.'],
])('a %i says what it means, not "Something went wrong"', async (status, message) => {
  api.get.mockRejectedValue({ status, message: 'Something went wrong. Please try again.' });
  await expect(downloadMenuPrint('/proposals/7/menu-print')).rejects.toMatchObject({ status, message });
  expect(clicked).toEqual([]);
});

test('an unmapped failure keeps the api message', async () => {
  api.get.mockRejectedValue({ status: 0, message: 'Network Error' });
  await expect(downloadMenuPrint('/proposals/7/menu-print')).rejects.toMatchObject({ message: 'Network Error' });
});
