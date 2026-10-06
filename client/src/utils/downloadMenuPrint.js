import api from './api';

// The print file's accepted types (server/routes/proposals/menuPrint.js sniffs
// PDF/PNG/JPEG), used to name the download only when the server's filename is
// unreadable.
const MENU_EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' };

// A blob request's error body is a Blob, so api.js cannot read the server's
// `error` text off it and every failure would read "Something went wrong".
// The status is still there; say what each one means.
const MESSAGE_BY_STATUS = {
  403: 'Only assigned staff can download the menu file.',
  404: 'No menu file is posted for this event.',
  429: 'Too many downloads in a row. Wait a few minutes and try again.',
  502: 'The menu file is temporarily unavailable. Try again in a minute.',
};

/**
 * Save the bar menu print file from an authed API path: staff use
 * `/shifts/:shiftId/menu-print`, admin `/proposals/:id/menu-print`. Both
 * stream the same bytes (server/utils/menuPrintFile.js). Rejects with the
 * api.js error, its message replaced by a status-specific one where the status
 * is known; each caller shows `err.message`.
 */
export async function downloadMenuPrint(path) {
  let res;
  try {
    res = await api.get(path, { responseType: 'blob' });
  } catch (err) {
    const message = (err && MESSAGE_BY_STATUS[err.status]) || (err && err.message) || 'Could not download the menu file.';
    // An Error carrying api.js's fields (status, code), so callers read
    // err.message / err.status exactly as from any api.js rejection.
    throw Object.assign(new Error(message), err, { message });
  }
  // Honor the server's filename so a PNG or JPG menu is not saved as .pdf.
  // The API is cross-origin, so the header is only readable because the
  // server exposes it (middleware/corsOptions.js); if a proxy ever strips
  // it, the blob's own type still names the file correctly.
  const cd = (res.headers && res.headers['content-disposition']) || '';
  const m = cd.match(/filename="([^"]+)"/);
  const ext = MENU_EXT_BY_TYPE[res.data && res.data.type] || 'pdf';
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = m ? m[1] : `bar-menu.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred: revoking in the same task cancels the in-flight download in
  // Firefox and some Safari versions, silently and with nothing to catch.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
