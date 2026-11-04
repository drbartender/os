import {
  PAIRING_IDS, PAIRINGS, DEFAULT_PAIRING_ID, pairingFor, pairingFaces, fontsHref, ensureFontsLink, isPairingId,
} from './fontPairings';
// The server's list itself, so the two lists cannot drift apart (spec
// 2026-10-01 10.3; v2 spec 6): the server validates and the words schema
// offers exactly these ids, and the client must draw every one.
import { FONT_PAIRING_IDS as SERVER_IDS } from '../../../../../server/utils/menuFontPairings';

// Table P's six, then v2 spec 6's six, in the order the Design tab lists them.
const TWELVE = [
  'elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical',
  'art-deco', 'botanical', 'hand-lettered', 'fiesta', 'editorial', 'black-tie',
];

const familiesOf = (href) => new URL(href).searchParams.getAll('family');

test('the ids match the server list, and every id has a pairing', () => {
  expect([...PAIRING_IDS]).toEqual([...SERVER_IDS]);
  SERVER_IDS.forEach((id) => {
    expect(PAIRINGS[id].id).toBe(id);
    expect(isPairingId(id)).toBe(true);
  });
  expect(isPairingId('script')).toBe(false);
  expect(Object.keys(PAIRINGS).sort()).toEqual([...PAIRING_IDS].sort());
});

test('twelve pairings: table P\'s six, then v2 spec 6\'s six', () => {
  expect([...PAIRING_IDS]).toEqual(TWELVE);
});

// v2 spec 6's table, as given: id, name and theme, then title, heading and
// body as [family, size, weight, case, tracking], then the light and dark sets.
const V2_ROWS = [
  ['art-deco', 'Gatsby', 'Art deco',
    ['Limelight', 56, 400, 'uppercase', '.12em'], ['Josefin Sans', 18, 600, 'none', '.08em'], ['Josefin Sans', 15, 400, 'none', '0'],
    ['#1b1b1f', '#a8842e'], ['#f3ead6', '#e3c56a']],
  ['botanical', 'Conservatory', 'Botanical serif',
    ['Playfair Display', 62, 700, 'none', '0'], ['Lora', 22, 600, 'none', '0'], ['Lora', 16, 400, 'none', '0'],
    ['#2f3b2a', '#6d7f4c'], ['#eef3e6', '#b7cf8a']],
  ['hand-lettered', 'Chalkboard', 'Hand lettered',
    ['Caveat', 76, 700, 'none', '0'], ['Patrick Hand', 24, 400, 'none', '0'], ['Nunito', 15, 400, 'none', '0'],
    ['#2b2b2b', '#b8433a'], ['#f6f1e8', '#f4b183']],
  ['fiesta', 'Fiesta', 'Bold festive',
    ['Lilita One', 66, 400, 'none', '0'], ['Baloo 2', 22, 700, 'none', '0'], ['Baloo 2', 15.5, 500, 'none', '0'],
    ['#2a1a3a', '#e4572e'], ['#fff4e6', '#ffcf5c']],
  ['editorial', 'Masthead', 'Minimal serif',
    ['DM Serif Display', 62, 400, 'none', '0'], ['DM Sans', 18, 600, 'uppercase', '.06em'], ['DM Sans', 15, 400, 'none', '0'],
    ['#141414', '#8a1c1c'], ['#f5f5f0', '#e8b4a0']],
  ['black-tie', 'Black Tie', 'Formal',
    ['Cinzel', 54, 700, 'none', '.1em'], ['Cinzel', 18, 500, 'none', '.06em'], ['Cormorant Garamond', 17, 500, 'none', '0'],
    ['#15161d', '#7d6a3c'], ['#f1ede4', '#d6c08a']],
];

test.each(V2_ROWS)('v2 spec 6: %s carries the table\'s faces, sizes, tracking and colors', (id, name, theme, title, heading, body, light, dark) => {
  const p = PAIRINGS[id];
  const faceOf = ([family, size, weight, transform, tracking]) => ({ family, size, weight, transform, tracking });
  expect(p).toMatchObject({ id, designKey: id, name, theme });
  expect(p.title).toMatchObject(faceOf(title));
  expect(p.heading).toMatchObject(faceOf(heading));
  expect(p.body).toMatchObject(faceOf(body));
  [p.title, p.heading, p.body].forEach((f) => expect(f.stack.startsWith(`'${f.family}', `)).toBe(true));
  expect(p.light).toEqual({ ink: light[0], accent: light[1] });
  expect(p.dark).toEqual({ ink: dark[0], accent: dark[1] });
});

test('table P: faces, sizes and the light and dark sets', () => {
  const p = PAIRINGS['elegant-script'];
  expect(p.designKey).toBe('script');
  expect(p.title).toMatchObject({ family: 'Pinyon Script', size: 88, weight: 400 });
  expect(p.heading).toMatchObject({ family: 'Cormorant Garamond', size: 25, weight: 700 });
  expect(p.body).toMatchObject({ family: 'Cormorant Garamond', size: 17.5, weight: 500 });
  expect(p.light).toEqual({ ink: '#2c2238', accent: '#8a6a2f' });
  expect(p.dark).toEqual({ ink: '#f5eedf', accent: '#dcbc6e' });
  expect(PAIRINGS['modern-clean'].title).toMatchObject({ weight: 300, transform: 'uppercase', tracking: '.32em' });
  expect(PAIRINGS.retro.designKey).toBe('disco');
  expect(PAIRINGS.spooky.title).toMatchObject({ family: 'Creepster', size: 84, tracking: '.03em' });
  expect(PAIRINGS.tropical.dark).toEqual({ ink: '#f2fbf6', accent: '#ffb27a' });
});

test('an unknown pairing reads as the default', () => {
  expect(pairingFor('nope').id).toBe(DEFAULT_PAIRING_ID);
  expect(pairingFor(undefined).id).toBe('elegant-script');
});

test('pairingFaces lists each family and weight once', () => {
  expect(pairingFaces('elegant-script')).toEqual([
    { family: 'Pinyon Script', weight: 400 },
    { family: 'Cormorant Garamond', weight: 700 },
    { family: 'Cormorant Garamond', weight: 500 },
  ]);
  expect(pairingFaces('spooky')).toHaveLength(3);
});

describe('fontsHref', () => {
  test('one pairing: exactly its families, weights ascending', () => {
    const href = fontsHref(['elegant-script']);
    expect(href.startsWith('https://fonts.googleapis.com/css2?')).toBe(true);
    expect(familiesOf(href)).toEqual(['Pinyon Script', 'Cormorant Garamond:wght@500;700']);
    expect(new URL(href).searchParams.get('display')).toBe('swap');
  });

  test('a family at two weights in one pairing merges', () => {
    expect(familiesOf(fontsHref(['modern-clean']))).toEqual(['Josefin Sans:wght@300;600', 'Karla']);
  });

  test('two pairings: both sets and nothing else', () => {
    expect(familiesOf(fontsHref(['rustic', 'tropical']))).toEqual([
      'Rye', 'Alegreya SC:wght@700', 'Alegreya', 'Pacifico', 'Fredoka:wght@600', 'Nunito Sans',
    ]);
  });

  test('all twelve pairings load the twenty-seven families once each', () => {
    const fams = familiesOf(fontsHref(PAIRING_IDS)).map((f) => f.split(':')[0]);
    expect(fams).toHaveLength(27);
    expect(new Set(fams).size).toBe(27);
  });

  test('all twelve: shared families merge their weights ascending; spaced and numbered names are spelled right', () => {
    const href = fontsHref(PAIRING_IDS);
    const fams = familiesOf(href);
    // Josefin Sans at 300 and 600 (Gallery) and 400 and 600 (Gatsby).
    expect(fams).toContain('Josefin Sans:wght@300;400;600');
    expect(fams).toContain('Cormorant Garamond:wght@500;700');
    expect(fams).toContain('Cinzel:wght@500;700');
    expect(fams).toContain('Baloo 2:wght@500;700');
    expect(fams).toContain('DM Serif Display');
    expect(fams).toContain('DM Sans:wght@400;600');
    expect(fams).toContain('Lora:wght@400;600');
    expect(href).toContain('family=Baloo+2:wght@500;700');
    expect(href).toContain('family=DM+Serif+Display&');
    // The six new pairings add these, after table P's sixteen, in first-seen order.
    expect(fams.slice(16).map((f) => f.split(':')[0])).toEqual([
      'Limelight', 'Playfair Display', 'Lora', 'Caveat', 'Patrick Hand', 'Nunito', 'Lilita One', 'Baloo 2',
      'DM Serif Display', 'DM Sans', 'Cinzel',
    ]);
  });

  test('one new pairing: exactly its families', () => {
    expect(familiesOf(fontsHref(['fiesta']))).toEqual(['Lilita One', 'Baloo 2:wght@500;700']);
    expect(familiesOf(fontsHref(['black-tie']))).toEqual(['Cinzel:wght@500;700', 'Cormorant Garamond:wght@500']);
    expect(pairingFaces('art-deco')).toEqual([
      { family: 'Limelight', weight: 400 },
      { family: 'Josefin Sans', weight: 600 },
      { family: 'Josefin Sans', weight: 400 },
    ]);
  });

  test('a single id string works; unknown ids and none give no URL', () => {
    expect(fontsHref('spooky')).toBe(fontsHref(['spooky']));
    expect(fontsHref([])).toBe('');
    expect(fontsHref(['nope'])).toBe('');
  });
});

describe('ensureFontsLink', () => {
  afterEach(() => {
    document.head.querySelectorAll('link[data-menu-fonts]').forEach((l) => l.remove());
  });

  test('adds one plain stylesheet link per URL, never a media swap', () => {
    const a = ensureFontsLink(['retro']);
    const b = ensureFontsLink(['retro']);
    expect(a).toBe(b);
    expect(document.head.querySelectorAll('link[data-menu-fonts]')).toHaveLength(1);
    expect(a.rel).toBe('stylesheet');
    expect(a.getAttribute('href')).toBe(fontsHref(['retro']));
    expect(a.getAttribute('media')).toBeNull();
  });

  test('marks itself loaded when its load fires', () => {
    const link = ensureFontsLink(['spooky']);
    expect(link.getAttribute('data-loaded')).toBeNull();
    link.dispatchEvent(new Event('load'));
    expect(link.getAttribute('data-loaded')).toBe('true');
  });

  test('a different set gets its own link; nothing for no pairings', () => {
    ensureFontsLink(['retro']);
    ensureFontsLink(['retro', 'rustic']);
    expect(document.head.querySelectorAll('link[data-menu-fonts]')).toHaveLength(2);
    expect(ensureFontsLink([])).toBeNull();
  });
});
