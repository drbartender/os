// The tone of a menu background (spec 2026-10-01 section 5.4, Background
// tone; section 12; plan Task E3). Pure: sharp only, no database.
//
// readTone(buffer) -> { tone: 'light' | 'dark', ground_rgb: 'r,g,b' }
//                  or { tone: null, ground_rgb: null } on any sharp error.
//
// The central 60% (width and height) is where the menu text sits, so that is
// what is measured. sharp's stats() measures the ORIGINAL input even after
// extract(), so the crop is written out with toBuffer() first and measured as
// a new image. ground_rgb is the crop's mean color (rounded channel means),
// which colors the Soft and Panel text backings; tone is 'dark' when that
// color's sRGB relative luminance is below 0.4, otherwise 'light'. A null tone
// means the light set applies and the piece is still done (section 12).

const sharp = require('sharp');

const CROP_SHARE = 0.6;
const DARK_BELOW = 0.4;
// The r2Proxy ceiling: a background is about 8 MP, and anything far past that
// is refused at its header instead of decoded.
const PIXEL_LIMIT = 50_000_000;
const SHARP_INPUT = { limitInputPixels: PIXEL_LIMIT };

// sRGB channel (0..255) to linear light.
function linear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// The central box covering CROP_SHARE of each side, at least 1 px.
function centralBox(width, height) {
  const w = Math.max(1, Math.round(width * CROP_SHARE));
  const h = Math.max(1, Math.round(height * CROP_SHARE));
  return { left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h };
}

async function readTone(buffer) {
  try {
    const { width, height } = await sharp(buffer, SHARP_INPUT).metadata();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return { tone: null, ground_rgb: null };
    }
    // Raw sRGB pixels of the crop, so the measurement is lossless and the
    // channels are always red, green, blue (a grey or CMYK input converts).
    const { data, info } = await sharp(buffer, SHARP_INPUT)
      .extract(centralBox(width, height))
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { channels } = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).stats();
    if (!Array.isArray(channels) || channels.length < 3) return { tone: null, ground_rgb: null };
    const rgb = channels.slice(0, 3).map((c) => Math.min(255, Math.max(0, Math.round(c.mean))));
    return { tone: relativeLuminance(rgb) < DARK_BELOW ? 'dark' : 'light', ground_rgb: rgb.join(',') };
  } catch {
    return { tone: null, ground_rgb: null };
  }
}

module.exports = { readTone, relativeLuminance, DARK_BELOW };
