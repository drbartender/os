import downscaleImage from './downscaleImage';
import { DOWNSCALE_THRESHOLD_BYTES } from './uploadLimits';

const file = (name, size) => {
  const f = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

it('passes non-images straight through', async () => {
  const pdf = file('resume.pdf', 20 * 1024 * 1024);
  expect(await downscaleImage(pdf)).toBe(pdf);
});

it('passes small images straight through', async () => {
  const small = file('photo.jpg', DOWNSCALE_THRESHOLD_BYTES - 1);
  expect(await downscaleImage(small)).toBe(small);
});

it('passes the original back when the browser cannot decode it', async () => {
  // jsdom has no createImageBitmap, which is exactly the HEIC-in-Chrome path.
  const heic = file('photo.heic', 8 * 1024 * 1024);
  expect(await downscaleImage(heic)).toBe(heic);
});

it('never rejects, whatever it is handed', async () => {
  await expect(downscaleImage(null)).resolves.toBeNull();
  await expect(downscaleImage(undefined)).resolves.toBeUndefined();
});
