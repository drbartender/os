// ShoppingListPDF.jsx — jsPDF implementation for branded shopping list PDF.
//
// Ink-friendly print treatment: white page, brass hairlines for brand chrome,
// light hairlines between rows, no filled bars or zebra stripes. Color is
// reserved for the data that earns it (Qty number) and the brand footer link.
//
import { LOGO_BASE64 } from './logoBase64';

const C = {
  page:          [255, 255, 255], // page background — white
  ink:           [28, 22, 16],    // primary text — deep brown
  inkMed:        [90, 80, 72],    // secondary text — size, tagline, meta
  inkSoft:       [150, 140, 128], // disclaimer / fine print
  brass:         [184, 146, 74],  // brand chrome — hairlines, kickers, rules
  teal:          [29, 140, 137],  // brand accent — footer URL only
  qtyTeal:       [19, 69, 68],    // Qty number — dark warm teal (legible on white)
  hairline:      [220, 213, 200], // row separator
};

const DISCLAIMER = '*Given the natural variation in preferred drink choices this list represents our best recommendations, drawn from decades of experience in bar service. We advise purchasing refundable alcohol as close to the event date as possible to ensure compliance with return policies from your alcohol supplier.';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function truncateText(doc, text, maxWidth) {
  if (!text) return '';
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && doc.getTextWidth(t + '\u2026') > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '\u2026';
}

export async function generateShoppingListPDF(listData) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  const PW = 612;
  const PH = 792;
  const MX = 36;                   // a touch more margin since there's no header band to frame the page
  const CW = PW - MX * 2;

  const {
    clientName = 'Event',
    eventTypeLabel = 'event',
    guestCount = 0,
    eventDate,
    signatureCocktailNames = [],
    liquorBeerWine = [],
    everythingElse = [],
    needsRecipe = [],
  } = listData;

  const maxRows = Math.max(liquorBeerWine.length, everythingElse.length, 1);
  const hasCocktails = signatureCocktailNames.length > 0;
  const hasNeeds = Array.isArray(needsRecipe) && needsRecipe.length > 0;

  // ── LAYOUT CALCULATION ──
  const HEADER_H = 84;             // chrome height (logo + brand block)
  const HEADER_RULE_GAP = 4;
  const TOP_PAD = 12;
  const BOTTOM_PAD = 24;
  const FOOTER_H = 56;
  const COCKTAIL_H = hasCocktails ? 28 : 0;
  const COCKTAIL_GAP = hasCocktails ? 10 : 0;
  const NEEDS_H = hasNeeds ? 28 : 0;
  const NEEDS_GAP = hasNeeds ? 10 : 0;

  const bodyStart = HEADER_H + HEADER_RULE_GAP + TOP_PAD;
  const footerStart = PH - BOTTOM_PAD - FOOTER_H;
  const bodyEnd = footerStart - COCKTAIL_GAP - COCKTAIL_H - NEEDS_GAP - NEEDS_H - 10;
  const bodyAvail = bodyEnd - bodyStart;

  // Body grid: kickerH + 6 + thH + 2 + maxRows * rowH
  // With kickerH = rowH * 0.85 and thH = rowH * 0.85
  let rowH = (bodyAvail - 8) / (maxRows + 1.7);
  rowH = clamp(rowH, 15, 30);

  const sc = rowH / 20;
  const F = {
    kicker: clamp(9  * sc, 7.5, 11),
    th:     clamp(8.5 * sc, 7.5, 10.5),
    item:   clamp(11 * sc, 9,   14),
    size:   clamp(10 * sc, 8.5, 13),
    qty:    clamp(12 * sc, 10,  16),
  };
  const kickerH = rowH * 0.85;
  const thH = rowH * 0.85;

  // ── PAGE BACKGROUND ──
  doc.setFillColor(...C.page);
  doc.rect(0, 0, PW, PH, 'F');

  // ── HEADER (no fill — text + hairline rule beneath) ──
  try { doc.addImage(LOGO_BASE64, 'PNG', MX, 12, 60, 60); } catch (_) { /* skip */ }

  // Left side: brand wordmark
  doc.setFont('times', 'normal');
  doc.setFontSize(22);
  doc.setTextColor(...C.ink);
  doc.text('Dr. Bartender', MX + 72, 38);

  // Brass kicker under the wordmark
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...C.brass);
  doc.setCharSpace(2);
  doc.text('PREMIUM BAR SERVICES', MX + 72, 52);
  doc.setCharSpace(0);

  // Right side: client + event meta
  doc.setFont('times', 'normal');
  doc.setFontSize(15);
  doc.setTextColor(...C.ink);
  doc.text(clientName, PW - MX, 38, { align: 'right' });

  doc.setFont('times', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(...C.inkMed);
  doc.text(`Event type: ${eventTypeLabel}`, PW - MX, 52, { align: 'right' });

  const meta = `${guestCount} Guests${eventDate ? `  \u00B7  ${formatDate(eventDate)}` : ''}`;
  doc.text(meta, PW - MX, 66, { align: 'right' });

  // Brass hairline under the header band
  doc.setDrawColor(...C.brass);
  doc.setLineWidth(0.75);
  doc.line(MX, HEADER_H, PW - MX, HEADER_H);

  // ── TWO-COLUMN TABLES ──
  const colGap = 18;
  const colW = (CW - colGap) / 2;
  const leftX = MX;
  const rightX = MX + colW + colGap;

  function drawColumn(title, items, colX, startY) {
    let cy = startY;

    // Section kicker — small caps brass, hairline under
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(F.kicker);
    doc.setTextColor(...C.brass);
    doc.setCharSpace(2.4);
    doc.text(title.toUpperCase(), colX, cy + kickerH * 0.7);
    doc.setCharSpace(0);

    cy += kickerH;
    doc.setDrawColor(...C.brass);
    doc.setLineWidth(0.6);
    doc.line(colX, cy, colX + colW, cy);
    cy += 8;

    // Column header row — small caps grey labels, fine hairline under
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(F.th);
    doc.setTextColor(...C.inkMed);
    doc.setCharSpace(1.6);
    doc.text('ITEM', colX, cy + thH * 0.6);
    doc.text('SIZE', colX + colW - 58, cy + thH * 0.6, { align: 'center' });
    doc.text('QTY',  colX + colW - 8,  cy + thH * 0.6, { align: 'right' });
    doc.setCharSpace(0);

    cy += thH;
    doc.setDrawColor(...C.hairline);
    doc.setLineWidth(0.5);
    doc.line(colX, cy, colX + colW, cy);
    cy += 2;

    // Body rows — no fills; one hairline per row
    items.forEach((row) => {
      // Item name
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(F.item);
      doc.setTextColor(...C.ink);
      const maxItemW = colW - 90;
      doc.text(truncateText(doc, row.item || '', maxItemW), colX, cy + rowH * 0.65);

      // Size
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(F.size);
      doc.setTextColor(...C.inkMed);
      doc.text(String(row.size || ''), colX + colW - 58, cy + rowH * 0.65, { align: 'center' });

      // Qty — only colored data point on the page
      doc.setFont('times', 'bold');
      doc.setFontSize(F.qty);
      doc.setTextColor(...C.qtyTeal);
      doc.text(String(row.qty || ''), colX + colW - 8, cy + rowH * 0.65, { align: 'right' });

      cy += rowH;
      doc.setDrawColor(...C.hairline);
      doc.setLineWidth(0.4);
      doc.line(colX, cy, colX + colW, cy);
    });

    return cy;
  }

  const leftEndY = drawColumn('Liquor \u00B7 Beer \u00B7 Wine', liquorBeerWine, leftX, bodyStart);
  const rightEndY = drawColumn('Everything Else', everythingElse, rightX, bodyStart);
  const tableEndY = Math.max(leftEndY, rightEndY);

  // Brass vertical column divider — the one "fine detail" beat
  const dividerX = MX + colW + colGap / 2;
  doc.setDrawColor(...C.brass);
  doc.setLineWidth(0.4);
  doc.line(dividerX, bodyStart + kickerH + 8, dividerX, tableEndY);

  // ── SIGNATURE COCKTAILS (hairline rule above, no filled bar) ──
  if (hasCocktails) {
    const cocktailY = footerStart - COCKTAIL_GAP - COCKTAIL_H;

    doc.setDrawColor(...C.brass);
    doc.setLineWidth(0.5);
    doc.line(MX, cocktailY, PW - MX, cocktailY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C.brass);
    doc.setCharSpace(2);
    doc.text('SIGNATURE COCKTAILS', MX, cocktailY + 13);
    doc.setCharSpace(0);

    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...C.ink);
    doc.text(
      signatureCocktailNames.join('   \u00B7   '),
      MX, cocktailY + 25,
      { maxWidth: CW },
    );
  }

  // ── SPECIAL REQUESTS (client-requested drinks the bar lead sources) ──
  if (hasNeeds) {
    const needsY = footerStart - COCKTAIL_GAP - COCKTAIL_H - NEEDS_GAP - NEEDS_H;

    doc.setDrawColor(...C.brass);
    doc.setLineWidth(0.5);
    doc.line(MX, needsY, PW - MX, needsY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C.brass);
    doc.setCharSpace(2);
    doc.text('SPECIAL REQUESTS: YOUR BAR LEAD WILL SOURCE THESE', MX, needsY + 13);
    doc.setCharSpace(0);

    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...C.ink);
    doc.text(
      needsRecipe.map(r => r.name).join('   ·   '),
      MX, needsY + 25,
      { maxWidth: CW },
    );
  }

  // ── FOOTER (hairline + fine print + brand URL) ──
  const footerLineY = footerStart;
  doc.setDrawColor(...C.brass);
  doc.setLineWidth(0.5);
  doc.line(MX, footerLineY, PW - MX, footerLineY);

  const footerTextY = footerLineY + 14;
  doc.setFont('times', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.inkSoft);
  doc.text(DISCLAIMER, MX, footerTextY, { maxWidth: CW - 120 });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...C.teal);
  doc.text('drbartender.com', PW - MX, footerTextY, { align: 'right' });

  return doc.output('blob');
}
