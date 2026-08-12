// One render path for every tip-sign download. JPG, PNG, and PDF all come off
// the SAME html2canvas capture: if two formats ever disagree, that is a bug in
// this file, not a reason to give a format its own capture.
//
// Layouts are authored at 150 DPI of their real size (see ./sizes.js), so
// scale 2 is exactly 300 DPI, which is what a photo counter wants.
//
// MenuPNG.jsx is the precedent for the off-screen surface, `useCORS`, and the
// download anchor. It is NOT a precedent for the scale (it uses 3), for JPG, or
// for PDF: no canvas-into-jsPDF path exists anywhere else in this client.

// Fonts and images must be settled BEFORE capture. The sign uses self-hosted
// woff2 (--drb-font-display) and the card back embeds an <img> logo; a capture
// that wins the race silently ships fallback glyphs and a blank logo, at 300
// DPI, onto paper. MenuPNG has this same hole and gets away with it because an
// admin eyeballs the result on screen. This output goes to a photo counter.
async function waitForPaint(node) {
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  const imgs = Array.from(node.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => (
    img.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })
  )));
  // Two frames so React's commit and the font swap have both painted.
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export async function captureNode(node, { scale = 2, backgroundColor = '#ffffff' } = {}) {
  if (!node) throw new Error('Render surface not ready.');
  await waitForPaint(node);
  const html2canvas = (await import('html2canvas')).default;
  // Opaque background floor: JPEG has no alpha, so a transparent capture
  // encodes to BLACK. The layouts paint their own opaque backgrounds, so this
  // only ever shows through as a hairline at the trim edge.
  return html2canvas(node, { scale, backgroundColor, useCORS: true, logging: false });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Deferred, not synchronous: Firefox has historically aborted a multi-MB blob
  // download when the object URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadCanvasImage(canvas, filename, format) {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpg' ? 0.94 : undefined;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not generate the image.'));
        return;
      }
      triggerDownload(blob, filename);
      resolve();
    }, mime, quality);
  });
}

export async function downloadCanvasesPdf(canvases, filename, { inW, inH }) {
  if (!canvases.length) throw new Error('Nothing to put in the PDF.');
  const { jsPDF } = await import('jspdf');
  // 3.5x2 is landscape; the 5x7 sign is portrait. Derived, never assumed.
  const orientation = inW > inH ? 'landscape' : 'portrait';
  const doc = new jsPDF({ unit: 'in', format: [inW, inH], orientation });
  canvases.forEach((canvas, i) => {
    if (i > 0) doc.addPage([inW, inH], orientation);
    // JPEG at 0.95, not PNG. Measured 2026-08-11: jsPDF's PNG embedding put a
    // 5x7 sheet at 9.4 MB and the two-page card at 3.8 MB, which is a lot to
    // hand a bartender on mobile data. JPEG lands the same pages at 202 KB and
    // 135 KB, 47x and 28x smaller. The QR was the reason to prefer lossless, so
    // it was checked rather than assumed: decoded out of the rendered PDF with
    // jsQR at both 300 and 150 DPI, exact-matching the tip URL both times. At
    // 300 DPI a QR module is far wider than an 8x8 JPEG block, so the artifacts
    // cannot merge modules.
    doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, inW, inH);
  });
  triggerDownload(doc.output('blob'), filename);
}
