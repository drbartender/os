import { sanitizeFilenamePart, buildDownloadFilename } from './downloadFilename';

describe('sanitizeFilenamePart', () => {
  test('passes a clean name through', () => {
    expect(sanitizeFilenamePart('Marcus')).toBe('Marcus');
  });

  test('strips path and reserved characters', () => {
    expect(sanitizeFilenamePart('a/b\\c:d"e*f?g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  test('collapses dash runs and trims edges', () => {
    expect(sanitizeFilenamePart('--Marcus///Reyes--')).toBe('Marcus-Reyes');
  });

  test('strips trailing dots so a display name like "Marcus R." works', () => {
    // Staff display names carry the seniority disambiguator, so this is the
    // common shape, not an edge case. Windows rejects a trailing dot outright.
    expect(sanitizeFilenamePart('Marcus R.')).toBe('Marcus R');
    expect(sanitizeFilenamePart('Marcus R. ')).toBe('Marcus R');
    expect(sanitizeFilenamePart('J.R.')).toBe('J.R');
    expect(sanitizeFilenamePart('...')).toBe('');
  });

  test('empty-ish input yields an empty string', () => {
    expect(sanitizeFilenamePart('')).toBe('');
    expect(sanitizeFilenamePart(null)).toBe('');
    expect(sanitizeFilenamePart(undefined)).toBe('');
    expect(sanitizeFilenamePart('///')).toBe('');
  });
});

describe('buildDownloadFilename', () => {
  test('includes the part when there is one', () => {
    expect(buildDownloadFilename('Tip Sign 4x6', 'Marcus', 'jpg'))
      .toBe('Tip Sign 4x6 - Marcus.jpg');
  });

  test('omits the separator when the part sanitizes away', () => {
    expect(buildDownloadFilename('Tip Sign 4x6', '///', 'jpg')).toBe('Tip Sign 4x6.jpg');
    expect(buildDownloadFilename('Tip Sign 4x6', null, 'pdf')).toBe('Tip Sign 4x6.pdf');
  });
});
