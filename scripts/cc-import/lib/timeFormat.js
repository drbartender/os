function parseAmPmToMinutes(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s).trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]); const period = m[3].toUpperCase();
  if (h === 12) h = 0;
  if (period === 'PM') h += 12;
  return h * 60 + min;
}

function minutesToAmPm(totalMinutes) {
  const t = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60); const min = t % 60;
  const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(min).padStart(2, '0')} ${ampm}`;
}

function addHours(timeAmPm, hours) {
  const start = parseAmPmToMinutes(timeAmPm);
  if (start == null) return null;
  return minutesToAmPm(start + Math.round(hours * 60));
}

module.exports = { parseAmPmToMinutes, minutesToAmPm, addHours };
