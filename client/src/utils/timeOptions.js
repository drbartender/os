/**
 * Generate 30-minute time slot options.
 * @param {number} startHour - Inclusive start hour (24h, 0–23). Default 0.
 * @param {number} endHour - Exclusive end hour (24h, 1–24). Default 24. Last slot is (endHour - 1):30.
 * @returns {Array<{value: string, label: string}>} e.g. [{ value: "06:00", label: "6:00 AM" }, ...]
 */
export function generateTimeOptions(startHour = 0, endHour = 24) {
  const options = [];
  for (let h = startHour; h < endHour; h++) {
    for (const m of ['00', '30']) {
      const value = `${String(h).padStart(2, '0')}:${m}`;
      const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const label = `${displayHour}:${m} ${ampm}`;
      options.push({ value, label });
    }
  }
  return options;
}

/**
 * Format a 24h "HH:MM" string as "H:MM AM/PM".
 * Empty or falsy input returns "".
 */
export function formatTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const h = parseInt(match[1], 10);
  const m = match[2];
  if (isNaN(h) || h < 0 || h > 23) return '';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${m} ${ampm}`;
}

/**
 * Parse a free-form time string into canonical 24h "HH:MM".
 * Accepts: "6:30 PM", "6:30pm", "6:30p", "6 PM", "6pm", "18:30", "1830", "630pm".
 * Returns null if the input can't be parsed or falls outside [minHour, maxHour].
 *
 * @param {string} raw
 * @param {{ minHour?: number, maxHour?: number }} [bounds]
 * @returns {string|null} "HH:MM" or null
 */
export function parseTimeInput(raw, { minHour = 0, maxHour = 23 } = {}) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (cleaned === '') return null;

  // Detect AM/PM suffix (accept "am", "a", "pm", "p")
  let ampm = null;
  let timePart = cleaned;
  const suffixMatch = cleaned.match(/(a|am|p|pm)$/);
  if (suffixMatch) {
    const s = suffixMatch[1];
    ampm = (s === 'a' || s === 'am') ? 'am' : 'pm';
    timePart = cleaned.slice(0, cleaned.length - s.length);
  }

  if (timePart === '' || !/^\d+:?\d*$/.test(timePart)) return null;

  let hour;
  let minute;
  if (timePart.includes(':')) {
    const [hStr, mStr] = timePart.split(':');
    if (hStr === '' || hStr.length > 2) return null;
    if (mStr === '' || mStr === undefined) return null;
    hour = parseInt(hStr, 10);
    minute = parseInt(mStr, 10);
    if (mStr.length > 2) return null;
  } else if (timePart.length <= 2) {
    hour = parseInt(timePart, 10);
    minute = 0;
  } else if (timePart.length === 3) {
    hour = parseInt(timePart[0], 10);
    minute = parseInt(timePart.slice(1), 10);
  } else if (timePart.length === 4) {
    hour = parseInt(timePart.slice(0, 2), 10);
    minute = parseInt(timePart.slice(2), 10);
  } else {
    return null;
  }

  if (isNaN(hour) || isNaN(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  // 12h input with AM/PM: hour must be 1–12
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }

  if (hour < 0 || hour > 23) return null;
  if (hour < minHour || hour > maxHour) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
