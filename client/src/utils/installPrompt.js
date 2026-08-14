// Capture Chrome's beforeinstallprompt so the More tab can offer an explicit
// "Install app" row instead of depending on the browser banner's mood
// (spec section 7). Captured at module import: the event fires early,
// usually before any React mount.
let deferred = null;
const subs = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    subs.forEach((fn) => fn(true));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    subs.forEach((fn) => fn(false));
  });
}

export function canInstall() {
  return !!deferred;
}

export function onInstallAvailability(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function promptInstall() {
  if (!deferred) return { outcome: 'unavailable' };
  const e = deferred;
  deferred = null;
  e.prompt();
  const choice = await e.userChoice;
  subs.forEach((fn) => fn(false));
  return choice;
}
