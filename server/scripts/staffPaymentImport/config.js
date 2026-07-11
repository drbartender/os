// Staff payment import — pipeline config: boundary date, CLI dir resolution,
// and the canonical enumeration of every source account (spec 2026-07-10 §2).
//
// This module has NO DB and NO side effects at require time. `routeFile` reads
// files only to sniff ambiguous cases (Venmo personal vs business layout;
// PayPal account by dominant own-email). Real data lives on the share and is
// never committed; fixtures under __fixtures__/ are synthetic.

const fs = require('fs');
const path = require('path');

// Rows dated on/after this NEVER enter the ledger (spec §4).
const BOUNDARY = '2026-06-02';

// PayPal own-account emails → source_account (routing by which appears most).
const PAYPAL_ACCOUNTS = [
  { email: 'contact@drbartender.com', source_account: 'paypal_contact' },
  { email: 'doctorbartending@gmail.com', source_account: 'paypal_doctorbartending' },
  { email: 'wildskybooks@gmail.com', source_account: 'paypal_wildskybooks' },
];

// Canonical enumeration of every source (spec §2). `parser` picks the module;
// `platform` is the ledger platform enum (null for the CC cross-check reports,
// which are consumed by dictionary/eventMatch, not emitted as ledger rows —
// except cc_expense_log, importable only as cash_other).
const SOURCE_ACCOUNTS = {
  venmo_business: { platform: 'venmo', source_account: 'venmo_business', parser: 'venmoCsv' },
  venmo_personal: { platform: 'venmo', source_account: 'venmo_personal', parser: 'venmoCsv' },
  cashapp_business: { platform: 'cashapp', source_account: 'cashapp_business', parser: 'cashappPdf' },
  cashapp_personal: { platform: 'cashapp', source_account: 'cashapp_personal', parser: 'cashappPdf' },
  chase_6835: { platform: 'zelle', source_account: 'chase_6835', parser: 'chasePdf' },
  chase_7570: { platform: 'zelle', source_account: 'chase_7570', parser: 'chasePdf' },
  chase_8700: { platform: 'zelle', source_account: 'chase_8700', parser: 'chasePdf' },
  paypal_contact: { platform: 'paypal', source_account: 'paypal_contact', parser: 'paypalCsv' },
  paypal_doctorbartending: { platform: 'paypal', source_account: 'paypal_doctorbartending', parser: 'paypalCsv' },
  paypal_wildskybooks: { platform: 'paypal', source_account: 'paypal_wildskybooks', parser: 'paypalCsv' },
  cc_expense_log: { platform: 'cash_other', source_account: 'cc_expense_log', parser: 'ccExpense' },
  cc_contacts: { platform: null, source_account: 'cc_contacts', parser: 'ccContacts' },
  cc_bookings: { platform: null, source_account: 'cc_bookings', parser: 'ccBookings' },
};

// --- CLI dir resolution -----------------------------------------------------
function getArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}
function dataDir(argv) {
  const d = getArg(argv, '--data-dir');
  if (!d) throw new Error('--data-dir <path> is required');
  return path.resolve(d.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
}
function reviewDir(argv) {
  const r = getArg(argv, '--review-dir');
  if (r) return path.resolve(r.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  return path.join(dataDir(argv), 'review');
}

// --- statement period from a Chase PDF file name ----------------------------
// Subfolder form "2025-01 January.pdf" → {year:2025,month:1}; root form
// "20250114-statements-6835-.pdf" → {year:2025,month:1}.
function parseStatementPeriod(fileName) {
  let m = fileName.match(/(\d{4})-(\d{2})/);
  if (m) return { year: +m[1], month: +m[2] };
  m = fileName.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return { year: +m[1], month: +m[2] };
  return { year: null, month: null };
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Chase account number → source_account, by subfolder name or root file name.
function chaseAccount(relPath) {
  if (/6835/.test(relPath)) return 'chase_6835';
  if (/7570/.test(relPath)) return 'chase_7570';
  if (/8700/.test(relPath)) return 'chase_8700';
  return null;
}

// --- file routing -----------------------------------------------------------
// Returns the SOURCE_ACCOUNTS spec for a data file, or null to skip.
// `absPath` is the file; `dataDir` is the walked root (for relative location).
function routeFile(absPath, rootDir) {
  const rel = path.relative(rootDir, absPath);
  const base = path.basename(absPath);
  const lower = base.toLowerCase();
  const ext = path.extname(base).toLowerCase();
  const inNewFolder = /(^|\/)New folder\//i.test(rel + '/') || /(^|\/)New folder(\/|$)/i.test(rel);
  const inChaseDir = /Chase Statements/i.test(rel);

  // Skip non-data files.
  if (/shoppinglist/i.test(lower) || /whatsapp/i.test(lower)) return null;

  // Chase statements (subfolder per account, plus root "*-statements-NNNN-*.pdf").
  // .txt is accepted as pre-extracted pdftotext output (used by fixtures/tests).
  if ((ext === '.pdf' || ext === '.txt') && (inChaseDir || /statements-\d{4}/.test(lower))) {
    const acct = chaseAccount(rel);
    return acct ? SOURCE_ACCOUNTS[acct] : null;
  }

  // Venmo CSVs: "*-statement.csv" (business at root, personal in New folder).
  if (ext === '.csv' && /statement/i.test(lower) && !/download/i.test(lower)) {
    let firstLine = '';
    try { firstLine = fs.readFileSync(absPath, 'utf8').split(/\r?\n/, 1)[0] || ''; } catch { /* ignore */ }
    if (/^﻿?Account Statement -/i.test(firstLine)) return SOURCE_ACCOUNTS.venmo_personal;
    if (inNewFolder && !/^Transaction ID/i.test(firstLine)) return SOURCE_ACCOUNTS.venmo_personal;
    return SOURCE_ACCOUNTS.venmo_business;
  }

  // PayPal exports: "Download*.CSV" routed by dominant own-account email.
  if (ext === '.csv' && /download/i.test(lower)) {
    let content = '';
    try { content = fs.readFileSync(absPath, 'utf8'); } catch { /* ignore */ }
    let best = null; let bestN = -1;
    for (const acct of PAYPAL_ACCOUNTS) {
      const n = (content.match(new RegExp(acct.email.replace(/[.]/g, '\\.'), 'gi')) || []).length;
      if (n > bestN) { bestN = n; best = acct; }
    }
    return best ? SOURCE_ACCOUNTS[best.source_account] : SOURCE_ACCOUNTS.paypal_contact;
  }

  // Cash App month PDFs: "<Month> <Year>.pdf" (business at root, personal in New folder).
  // .txt accepted as pre-extracted pdftotext output (fixtures/tests).
  if (ext === '.pdf' || ext === '.txt') {
    const isMonthPdf = MONTH_NAMES.some((mn) => new RegExp('^' + mn + '\\s+20\\d\\d', 'i').test(lower));
    if (isMonthPdf) {
      return inNewFolder ? SOURCE_ACCOUNTS.cashapp_personal : SOURCE_ACCOUNTS.cashapp_business;
    }
    return null;
  }

  // CC reports (report 4/5 + bookings). Routed by a caller-provided allowlist
  // in buildReviewSheet (their names vary); not auto-routed here.
  return null;
}

module.exports = {
  BOUNDARY,
  SOURCE_ACCOUNTS,
  PAYPAL_ACCOUNTS,
  MONTH_NAMES,
  dataDir,
  reviewDir,
  reviewDirFrom: (dataDirPath) => path.join(dataDirPath, 'review'),
  getArg,
  parseStatementPeriod,
  chaseAccount,
  routeFile,
};
