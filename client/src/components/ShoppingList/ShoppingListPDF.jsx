// ShoppingListPDF.jsx — jsPDF implementation for branded shopping list PDF
import { LOGO_BASE64 } from './logoBase64';

const C = {
  bgDark:    [26, 20, 16],    // #1A1410
  charcoal:  [42, 42, 42],    // #2a2a2a
  amber:     [193, 125, 60],  // #C17D3C
  amberLt:   [212, 149, 73],  // #D49549
  cream:     [245, 240, 232], // #F5F0E8
  parchment: [232, 223, 196], // #E8DFC4
  parchDim:  [237, 227, 204], // #EDE3CC
  brownDark: [44, 31, 14],    // #2C1F0E
  brownMed:  [122, 98, 69],   // #7A6245
  rust:      [107, 66, 38],   // #6B4226
  rowBorder: [229, 206, 180], // rgba(193,125,60,0.3) on cream
  divider:   [224, 194, 163], // rgba(193,125,60,0.4) on cream
};

const DISCLAIMER = '*Given the natural variation in preferred drink choices this list represents our best recommendations, drawn from decades of experience in bar service. We advise purchasing refundable alcohol as close to the event date as possible to ensure compliance with return policies from your alcohol supplier.';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
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
  const MX = 22;
  const CW = PW - MX * 2;

  const {
    clientName = 'Event',
    guestCount = 0,
    eventDate,
    signatureCocktailNames = [],
    liquorBeerWine = [],
    everythingElse = [],
  } = listData;

  const maxRows = Math.max(liquorBeerWine.length, everythingElse.length, 1);
  const hasCocktails = signatureCocktailNames.length > 0;

  // ── LAYOUT CALCULATION ──
  // Fixed chrome heights
  const HEADER_H = 84;
  const STRIPE_H = 3;
  const TOP_PAD = 10;
  const BOTTOM_PAD = 16;
  const FOOTER_H = 62;           // amber line + gap + disclaimer text
  const COCKTAIL_H = hasCocktails ? 30 : 0;
  const COCKTAIL_GAP = hasCocktails ? 8 : 0;

  const bodyStart = HEADER_H + STRIPE_H + TOP_PAD;
  const footerStart = PH - BOTTOM_PAD - FOOTER_H;
  const bodyEnd = footerStart - COCKTAIL_GAP - COCKTAIL_H - 8;
  const bodyAvail = bodyEnd - bodyStart;

  // Body = pillH + 4 + thH + 2 + maxRows * rowH
  // With pillH = rowH and thH = rowH: bodyAvail = (maxRows + 2) * rowH + 6
  let rowH = (bodyAvail - 6) / (maxRows + 2);
  rowH = clamp(rowH, 15, 32);

  // Font sizes scale with row height (20pt baseline = 1.0x)
  const sc = rowH / 20;
  const F = {
    pill:  clamp(10 * sc, 8, 14),
    th:    clamp(10 * sc, 8, 14),
    item:  clamp(11 * sc, 9, 15),
    size:  clamp(10 * sc, 8, 14),
    qty:   clamp(12 * sc, 10, 16),
  };
  const pillH = rowH;
  const thH = rowH;

  // ── PAGE BACKGROUND ──
  doc.setFillColor(...C.cream);
  doc.rect(0, 0, PW, PH, 'F');

  // ── HEADER BAR ──
  doc.setFillColor(...C.bgDark);
  doc.rect(0, 0, PW, HEADER_H, 'F');

  try { doc.addImage(LOGO_BASE64, 'PNG', MX, 12, 60, 60); } catch (_) { /* skip */ }

  doc.setFont('times', 'normal');
  doc.setFontSize(22);
  doc.setTextColor(...C.cream);
  doc.text('Dr. Bartender', MX + 72, 40);

  doc.setFont('times', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...C.amberLt);
  doc.text('Premium Bar Services \u00B7 drbartender.com', MX + 72, 53);

  doc.setFont('times', 'normal');
  doc.setFontSize(16);
  doc.setTextColor(...C.cream);
  doc.text(clientName, PW - MX, 40, { align: 'right' });

  const meta = `${guestCount} Guests${eventDate ? `  \u00B7  ${formatDate(eventDate)}` : ''}`;
  doc.setFont('times', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(...C.amberLt);
  doc.text(meta, PW - MX, 55, { align: 'right' });

  doc.setDrawColor(...C.amber);
  doc.setLineWidth(2);
  doc.line(0, HEADER_H - 2, PW, HEADER_H - 2);

  // ── AMBER STRIPE ──
  doc.setFillColor(...C.amber);
  doc.rect(0, HEADER_H, PW, STRIPE_H, 'F');

  // ── TWO-COLUMN TABLES ──
  let y = bodyStart;
  const colGap = 12;
  const colW = (CW - colGap) / 2;
  const leftX = MX;
  const rightX = MX + colW + colGap;

  function drawColumn(title, items, colX, startY) {
    let cy = startY;

    // Section pill
    doc.setFillColor(...C.bgDark);
    doc.rect(colX, cy, colW, pillH, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(F.pill);
    doc.setTextColor(...C.parchment);
    doc.text(title, colX + colW / 2, cy + pillH * 0.65, { align: 'center' });
    cy += pillH + 4;

    // Table header
    doc.setFillColor(...C.charcoal);
    doc.rect(colX, cy, colW, thH, 'F');
    doc.setDrawColor(...C.amber);
    doc.setLineWidth(1.5);
    doc.line(colX, cy + thH, colX + colW, cy + thH);

    doc.setFont('times', 'normal');
    doc.setFontSize(F.th);
    doc.setTextColor(...C.parchment);
    doc.text('Item', colX + 5, cy + thH * 0.65);
    doc.text('Size', colX + colW - 50, cy + thH * 0.65, { align: 'center' });
    doc.text('Qty', colX + colW - 14, cy + thH * 0.65, { align: 'center' });
    cy += thH + 2;

    // Data rows
    items.forEach((row, i) => {
      const bg = i % 2 === 0 ? C.cream : C.parchDim;
      doc.setFillColor(...bg);
      doc.rect(colX, cy, colW, rowH, 'F');

      doc.setDrawColor(...C.rowBorder);
      doc.setLineWidth(0.5);
      doc.line(colX, cy + rowH, colX + colW, cy + rowH);

      // Item name
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(F.item);
      doc.setTextColor(...C.brownDark);
      const maxItemW = colW - 80;
      doc.text(truncateText(doc, row.item || '', maxItemW), colX + 5, cy + rowH * 0.65);

      // Size
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(F.size);
      doc.setTextColor(...C.brownMed);
      doc.text(String(row.size || ''), colX + colW - 50, cy + rowH * 0.65, { align: 'center' });

      // Qty
      doc.setFont('times', 'normal');
      doc.setFontSize(F.qty);
      doc.setTextColor(...C.rust);
      doc.text(String(row.qty || ''), colX + colW - 14, cy + rowH * 0.65, { align: 'center' });

      cy += rowH;
    });

    return cy;
  }

  const leftEndY = drawColumn('Liquor \u00B7 Beer \u00B7 Wine', liquorBeerWine, leftX, y);
  const rightEndY = drawColumn('Everything Else', everythingElse, rightX, y);
  const tableEndY = Math.max(leftEndY, rightEndY);

  // Vertical divider between columns
  const dividerX = MX + colW + colGap / 2;
  doc.setDrawColor(...C.divider);
  doc.setLineWidth(1);
  doc.line(dividerX, bodyStart + pillH + 4, dividerX, tableEndY);

  // ── SIGNATURE COCKTAILS BAR (anchored below tables or above footer) ──
  if (hasCocktails) {
    const cocktailY = footerStart - COCKTAIL_GAP - COCKTAIL_H;
    doc.setFillColor(...C.bgDark);
    doc.rect(MX, cocktailY, CW, COCKTAIL_H, 'F');
    doc.setDrawColor(...C.amber);
    doc.setLineWidth(1);
    doc.rect(MX, cocktailY, CW, COCKTAIL_H, 'S');

    doc.setFont('times', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(...C.amberLt);
    doc.text('Signature Cocktails:', MX + 12, cocktailY + COCKTAIL_H * 0.6);

    const labelW = doc.getTextWidth('Signature Cocktails:  ');
    doc.setFontSize(11);
    doc.setTextColor(...C.parchment);
    doc.text(
      signatureCocktailNames.join('  \u00B7  '),
      MX + 12 + labelW,
      cocktailY + COCKTAIL_H * 0.6,
      { maxWidth: CW - 24 - labelW },
    );
  }

  // ── FOOTER (anchored at page bottom) ──
  const footerLineY = footerStart;
  doc.setDrawColor(...C.amber);
  doc.setLineWidth(1);
  doc.line(MX, footerLineY, PW - MX, footerLineY);

  const footerTextY = footerLineY + 14;
  doc.setFont('times', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(...C.brownMed);
  doc.text(DISCLAIMER, MX, footerTextY, { maxWidth: CW - 110 });

  doc.setFont('times', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...C.amber);
  doc.text('drbartender.com', PW - MX, footerTextY, { align: 'right' });

  return doc.output('blob');
}
