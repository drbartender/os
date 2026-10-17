import {
  PAIRING_IDS, PAIRINGS, DEFAULT_PAIRING_ID, pairingFor, pairingFaces, fontsHref, ensureFontsLink, isPairingId,
} from './fontPairings';

// server/utils/menuFontPairings.js FONT_PAIRING_IDS, copied here on purpose:
// the client and server lists must stay identical (spec 10.3).
const SERVER_IDS = ['elegant-script', 'rustic', 'modern-clean', 'retro', 'spooky', 'tropical'];

const familiesOf = (href) => new URL(href).searchParams.getAll('family');

test('the ids match the server list, and every id has a pairing', () => {
  expect([...PAIRING_IDS]).toEqual(SERVER_IDS);
  SERVER_IDS.forEach((id) => {
    expect(PAIRINGS[id].id).toBe(id);
    expect(isPairingId(id)).toBe(true);
  });
  expect(isPairingId('script')).toBe(false);
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

  test('all six pairings load the sixteen families once each', () => {
    const fams = familiesOf(fontsHref(PAIRING_IDS)).map((f) => f.split(':')[0]);
    expect(fams).toHaveLength(16);
    expect(new Set(fams).size).toBe(16);
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
