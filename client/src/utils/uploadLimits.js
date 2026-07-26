// Client-side upload rules.
//
// MAX_UPLOAD_BYTES MUST stay equal to the server's MAX_FILE_SIZE (see the
// Environment Variables table in CLAUDE.md; server default is the same 10MB in
// server/index.js). If the two drift, an oversized file gets past this check,
// express-fileupload's abortOnLimit resets the stream mid-body, and the browser
// reports a bare "network error" instead of anything useful. That is the exact
// failure that stranded a recruit on 2026-07-23.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Images above this get downscaled in the browser before upload. Well under
// the cap on purpose: the point is that a phone photo never approaches it.
export const DOWNSCALE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2000;
export const IMAGE_QUALITY = 0.85;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

// Each kind MUST mirror the server validator used by its destination route. A
// client that accepts more than the server does just relocates the original bug:
// the user picks a file, waits through an upload, and gets rejected at the end.
//
//   narrow   -> server/utils/fileValidation.js isValidUpload
//               (W-9 via payment.js:92, headshots, blog, staff portal)
//   document -> server/utils/fileValidation.js isValidOnboardingDocument
//               (resume and alcohol certification only)
export const UPLOAD_KINDS = {
  narrow: ['.pdf', '.jpg', '.jpeg', '.png', '.webp'],
  document: ['.pdf', '.doc', '.docx', ...IMAGE_EXTS],
};

// Default to the narrow set. A field must opt IN to the wider one, so a new
// FileUpload added later cannot silently outrun its server validator.
export const DEFAULT_KIND = 'narrow';

function extsFor(kind) {
  return UPLOAD_KINDS[kind] || UPLOAD_KINDS[DEFAULT_KIND];
}

// The file input's accept attribute for a given kind. Kept as wide as the
// server allows, because a too-narrow accept greys files out in the iOS Files
// picker with no explanation, which reads to the user as a broken page.
export function acceptFor(kind) {
  return extsFor(kind).join(',');
}

export function extOf(name) {
  if (typeof name !== 'string') return '';
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function isImageName(name) {
  return IMAGE_EXTS.includes(extOf(name));
}

export function formatBytes(n) {
  const mb = n / (1024 * 1024);
  if (mb >= 1) {
    const rounded = Math.round(mb * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}MB`;
  }
  return `${Math.round(n / 1024)}KB`;
}

export function checkFile(file, kind = DEFAULT_KIND) {
  if (!file) return { ok: false, message: 'No file selected.' };
  if (!file.size) return { ok: false, message: 'That file is empty. Try picking it again.' };

  const allowed = extsFor(kind);
  const ext = extOf(file.name);
  if (!allowed.includes(ext)) {
    const wording = allowed.includes('.docx')
      ? 'Use a PDF, a Word document, or a photo (JPG, PNG, HEIC).'
      : 'Use a PDF or a photo (JPG, PNG).';
    return { ok: false, message: `We cannot read ${ext || 'that file type'}. ${wording}` };
  }

  // >=, not >. busboy fires its limit at `fileSize === fileSizeLimit`
  // (busboy/lib/types/multipart.js:476), so a file of EXACTLY the cap is
  // rejected server-side. A `>` here would wave that one size through to a
  // round trip that 413s, which is the pattern this module exists to prevent.
  if (file.size >= MAX_UPLOAD_BYTES) {
    const shown = formatBytes(file.size);
    const cap = formatBytes(MAX_UPLOAD_BYTES);
    // formatBytes rounds to one decimal, so anything in the ~51KB band just over
    // the cap renders identically to the cap and produces the self-contradictory
    // "That file is 10MB, and the limit is 10MB." Say it a different way rather
    // than hand the user a sentence that argues with itself.
    return {
      ok: false,
      message: shown === cap
        ? `That file is just over the ${cap} limit. Try a smaller photo or scan.`
        : `That file is ${shown}, and the limit is ${cap}. Try a smaller photo or scan.`,
    };
  }

  return { ok: true };
}
