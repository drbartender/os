// Loaders for the CheckCherry cross-check reports + the OS known-people export.
// All tolerate a missing file (return []) — CC reports and known-people.csv are
// pulled fresh at operation time and may be absent during the offline smoke.
const fs = require('fs');
const { parseCsv } = require('./parsers/csvUtil');
const { parseMoney } = require('./staging');

function loadRecords(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { header: [], rows: [] };
  const records = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!records.length) return { header: [], rows: [] };
  const header = records[0].map((c) => c.trim());
  return { header, rows: records.slice(1) };
}

function indexer(header) {
  const col = {};
  header.forEach((name, idx) => { col[name] = idx; });
  return (rec, name) => (col[name] !== undefined ? (rec[col[name]] || '').trim() : '');
}

// OS export: user_id,name,preferred_name,email,phone,onboarding_status
function loadKnownPeople(filePath) {
  const { header, rows } = loadRecords(filePath);
  const get = indexer(header);
  return rows.filter((r) => r.length).map((r) => ({
    userId: get(r, 'user_id') ? Number(get(r, 'user_id')) : null,
    name: get(r, 'name'),
    preferredName: get(r, 'preferred_name'),
    email: get(r, 'email'),
    phone: get(r, 'phone'),
    onboardingStatus: get(r, 'onboarding_status'),
  })).filter((p) => p.name || p.preferredName || p.email);
}

// CC contacts (report 5): ID,Name,First Name,Last Name,Email,Phone,...,Roles,...
function loadContacts(filePath) {
  const { header, rows } = loadRecords(filePath);
  const get = indexer(header);
  return rows.filter((r) => r.length).map((r) => ({
    name: get(r, 'Name') || `${get(r, 'First Name')} ${get(r, 'Last Name')}`.trim(),
    email: get(r, 'Email'),
    phone: get(r, 'Phone'),
    roles: get(r, 'Roles'),
  })).filter((c) => c.name);
}

// CC expenses (report 4): ID,Date,Amount,Category,Payee,Reference,...,Booking: Title,Booking: Date,...
function loadExpenses(filePath) {
  const { header, rows } = loadRecords(filePath);
  const get = indexer(header);
  return rows.filter((r) => r.length).map((r) => ({
    id: get(r, 'ID'),
    date: get(r, 'Date'),
    amountCents: parseMoney(get(r, 'Amount')),
    category: get(r, 'Category'),
    payee: get(r, 'Payee'),
    bookingTitle: get(r, 'Booking: Title'),
    bookingDate: get(r, 'Booking: Date'),
  })).filter((e) => e.payee);
}

// CC bookings (report.csv): ...,Title,...,Event Date,...,Assigned Staff,...
function loadBookings(filePath) {
  const { header, rows } = loadRecords(filePath);
  const get = indexer(header);
  return rows.filter((r) => r.length).map((r) => ({
    title: get(r, 'Title'),
    eventDate: get(r, 'Event Date'),
    assignedStaff: (get(r, 'Assigned Staff') || '')
      .split(/[;,]/).map((s) => s.trim()).filter(Boolean),
  })).filter((b) => b.title);
}

module.exports = { loadKnownPeople, loadContacts, loadExpenses, loadBookings };
