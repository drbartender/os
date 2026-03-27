// ShoppingListPDF.jsx — branded react-pdf Document for the shopping list
import React from 'react';
import { Document, Page, View, Text, Image, StyleSheet, Font } from '@react-pdf/renderer';
import { LOGO_BASE64 } from './logoBase64';

// Register IM Fell English fonts from Google Fonts
Font.register({
  family: 'IMFell',
  fonts: [
    { src: 'https://fonts.gstatic.com/s/imfellenglish/v14/Ktk1ALSLW8zDe0rthJysWo9gQzmMr67pkA.ttf' },
    { src: 'https://fonts.gstatic.com/s/imfellenglish/v14/Ktk3ALSLW8zDe0rthJysWo9gQzmMqxktS6LBWB8.ttf', fontStyle: 'italic' },
  ],
});

const C = {
  bgDark:    '#1A1410',
  charcoal:  '#2a2a2a',
  amber:     '#C17D3C',
  amberLt:   '#D49549',
  cream:     '#F5F0E8',
  parchment: '#E8DFC4',
  parchDim:  '#EDE3CC',
  brownDark: '#2C1F0E',
  brownMed:  '#7A6245',
  rust:      '#6B4226',
};

const s = StyleSheet.create({
  page:        { backgroundColor: C.cream, fontFamily: 'Helvetica', size: 'LETTER' },
  header:      { backgroundColor: C.bgDark, padding: '12 22 10', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottom: `2 solid ${C.amber}` },
  logo:        { width: 60, height: 60, borderRadius: 30 },
  brandName:   { fontSize: 20, color: C.cream, fontFamily: 'IMFell' },
  brandTag:    { fontSize: 8, color: C.amberLt, fontFamily: 'IMFell', fontStyle: 'italic', marginTop: 4 },
  clientName:  { fontSize: 15, color: C.cream, fontFamily: 'IMFell', textAlign: 'right' },
  clientMeta:  { fontSize: 9, color: C.amberLt, fontFamily: 'IMFell', fontStyle: 'italic', textAlign: 'right', marginTop: 3 },
  stripe:      { height: 3, backgroundColor: C.amber },
  body:        { padding: '10 22', flexDirection: 'row', gap: 10, flex: 1 },
  col:         { flex: 1 },
  pill:        { backgroundColor: C.bgDark, color: C.parchment, fontSize: 8, textAlign: 'center', padding: '4 8', marginBottom: 4, borderRadius: 2 },
  tableHead:   { flexDirection: 'row', backgroundColor: C.charcoal, borderBottom: `1.5 solid ${C.amber}`, padding: '3 5' },
  thText:      { fontSize: 8, color: C.parchment, fontFamily: 'IMFell' },
  row:         { flexDirection: 'row', padding: '3 5', borderBottom: `0.5 solid rgba(193,125,60,0.3)` },
  rowEven:     { backgroundColor: C.parchDim },
  rowOdd:      { backgroundColor: C.cream },
  tdItem:      { fontSize: 9, color: C.brownDark, fontWeight: 'bold', flex: 1 },
  tdSize:      { fontSize: 9, color: C.brownMed, width: 45, textAlign: 'center' },
  tdQty:       { fontSize: 10, color: C.rust, width: 25, textAlign: 'center', fontFamily: 'IMFell', fontWeight: 'bold' },
  cocktailBox: { backgroundColor: C.bgDark, border: `1 solid ${C.amber}`, borderRadius: 3, padding: '6 12', flexDirection: 'row', marginTop: 8, alignItems: 'center' },
  cocktailLbl: { fontSize: 8, color: C.amberLt, fontFamily: 'IMFell', marginRight: 8 },
  cocktailList:{ fontSize: 9, color: C.parchment, fontFamily: 'IMFell', fontStyle: 'italic' },
  footer:      { borderTop: `1 solid ${C.amber}`, margin: '0 22', padding: '6 0 12', flexDirection: 'row', justifyContent: 'space-between' },
  disclaimer:  { fontSize: 8, color: C.brownMed, fontFamily: 'IMFell', fontStyle: 'italic', flex: 1, lineHeight: 1.5 },
  footerBrand: { fontSize: 8, color: C.amber, fontFamily: 'IMFell' },
  divider:     { width: 1, backgroundColor: 'rgba(193,125,60,0.4)', marginTop: 20 },
});

const DISCLAIMER = '*Given the natural variation in preferred drink choices this list represents our best recommendations, drawn from decades of experience in bar service. We advise purchasing refundable alcohol as close to the event date as possible to ensure compliance with return policies from your alcohol supplier.';

function TableSection({ title, items }) {
  return (
    <View style={s.col}>
      <Text style={s.pill}>{title}</Text>
      <View style={s.tableHead}>
        <Text style={[s.thText, { flex: 1 }]}>Item</Text>
        <Text style={[s.thText, { width: 45, textAlign: 'center' }]}>Size</Text>
        <Text style={[s.thText, { width: 25, textAlign: 'center' }]}>Qty</Text>
      </View>
      {items.map((row, i) => (
        <View key={i} style={[s.row, i % 2 === 0 ? s.rowOdd : s.rowEven]}>
          <Text style={s.tdItem}>{row.item}</Text>
          <Text style={s.tdSize}>{row.size}</Text>
          <Text style={s.tdQty}>{row.qty}</Text>
        </View>
      ))}
    </View>
  );
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function ShoppingListPDF({ listData }) {
  const { clientName, guestCount, eventDate, signatureCocktailNames = [], liquorBeerWine, everythingElse } = listData;

  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        {/* HEADER */}
        <View style={s.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Image style={s.logo} src={LOGO_BASE64} />
            <View>
              <Text style={s.brandName}>Dr. Bartender</Text>
              <Text style={s.brandTag}>Premium Bar Services · drbartender.com</Text>
            </View>
          </View>
          <View>
            <Text style={s.clientName}>{clientName}</Text>
            <Text style={s.clientMeta}>
              {guestCount} Guests{eventDate ? `  ·  ${formatDate(eventDate)}` : ''}
            </Text>
          </View>
        </View>

        {/* AMBER STRIPE */}
        <View style={s.stripe} />

        {/* TWO-COLUMN TABLES */}
        <View style={s.body}>
          <TableSection title="Liquor · Beer · Wine" items={liquorBeerWine} />
          <View style={s.divider} />
          <TableSection title="Everything Else" items={everythingElse} />
        </View>

        {/* SIGNATURE COCKTAILS BAR */}
        {signatureCocktailNames.length > 0 && (
          <View style={[s.cocktailBox, { margin: '0 22' }]}>
            <Text style={s.cocktailLbl}>Signature Cocktails:</Text>
            <Text style={s.cocktailList}>{signatureCocktailNames.join('  ·  ')}</Text>
          </View>
        )}

        {/* FOOTER */}
        <View style={s.footer}>
          <Text style={s.disclaimer}>{DISCLAIMER}</Text>
          <Text style={s.footerBrand}>drbartender.com</Text>
        </View>
      </Page>
    </Document>
  );
}
