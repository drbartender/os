import { useEffect } from 'react';

const STOPS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The keyboard half of a modal sheet. Focus moves into the sheet when it opens
// and back to whatever opened it when it closes; Tab stays inside; Escape
// closes. `handlersRef.current.onClose` is read at the time of the key press,
// so the owner can pass a new function on every render.
export default function useSheetFocus(sheetRef, handlersRef) {
  useEffect(() => {
    const opener = document.activeElement;
    const sheet = sheetRef.current;
    if (sheet) sheet.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // In a search field that holds text, Escape clears the field (the
        // browser does that itself). It closes the sheet from an empty one.
        if (e.target && e.target.type === 'search' && e.target.value) return;
        const close = handlersRef.current && handlersRef.current.onClose;
        if (close) close();
        return;
      }
      if (e.key !== 'Tab' || !sheet) return;
      const stops = Array.from(sheet.querySelectorAll(STOPS));
      const at = document.activeElement;
      const inside = sheet.contains(at) && at !== sheet;
      if (stops.length === 0) {
        e.preventDefault();
        sheet.focus();
      } else if (e.shiftKey && (!inside || at === stops[0])) {
        e.preventDefault();
        stops[stops.length - 1].focus();
      } else if (!e.shiftKey && (!inside || at === stops[stops.length - 1])) {
        e.preventDefault();
        stops[0].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [sheetRef, handlersRef]);
}
