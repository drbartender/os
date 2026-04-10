/**
 * Generate time slot options for select dropdowns.
 * @param {number} startHour - Starting hour (24h format, default 6)
 * @param {number} endHour - Ending hour (24h format, default 24 = midnight)
 * @returns {string[]} Array of time strings like "6:00 AM", "6:30 AM", etc.
 */
export function generateTimeOptions(startHour = 6, endHour = 24) {
  const options = [];
  for (let h = startHour; h < endHour; h++) {
    for (const m of ['00', '30']) {
      const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      options.push(`${displayHour}:${m} ${ampm}`);
    }
  }
  return options;
}

export const TIME_OPTIONS = generateTimeOptions(6, 24);
export const EVENT_TIME_OPTIONS = generateTimeOptions(8, 24);
