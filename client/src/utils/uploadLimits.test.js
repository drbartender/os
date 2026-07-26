import {
  MAX_UPLOAD_BYTES, formatBytes, extOf, isImageName, checkFile, acceptFor,
} from './uploadLimits';

const f = (name, size) => ({ name, size });

describe('formatBytes', () => {
  it('renders whole megabytes without decimals', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10MB');
  });
  it('renders partial megabytes with one decimal', () => {
    expect(formatBytes(13.7 * 1024 * 1024)).toBe('13.7MB');
  });
  it('falls back to KB under a megabyte', () => {
    expect(formatBytes(300 * 1024)).toBe('300KB');
  });
});

describe('extOf', () => {
  it('lowercases and includes the dot', () => {
    expect(extOf('Resume.DOCX')).toBe('.docx');
  });
  it('returns empty for no extension', () => {
    expect(extOf('resume')).toBe('');
  });
});

describe('isImageName', () => {
  it('recognises the image extensions we downscale', () => {
    ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.heic', 'a.heif'].forEach(n =>
      expect(isImageName(n)).toBe(true));
  });
  it('does not treat documents as images', () => {
    ['a.pdf', 'a.doc', 'a.docx'].forEach(n => expect(isImageName(n)).toBe(false));
  });
});

describe('kinds mirror the server validators', () => {
  it('defaults to the narrow set, matching isValidUpload', () => {
    expect(checkFile(f('w9.pdf', 1000))).toEqual({ ok: true });
    expect(checkFile(f('w9.docx', 1000)).ok).toBe(false);
    expect(checkFile(f('w9.heic', 1000)).ok).toBe(false);
  });

  it('accepts Word and HEIC only under the document kind', () => {
    expect(checkFile(f('resume.docx', 1000), 'document')).toEqual({ ok: true });
    expect(checkFile(f('cert.heic', 1000), 'document')).toEqual({ ok: true });
  });

  it('acceptFor emits an attribute string per kind', () => {
    expect(acceptFor('document')).toContain('.docx');
    expect(acceptFor('narrow')).not.toContain('.docx');
    expect(acceptFor(undefined)).toBe(acceptFor('narrow'));
  });

  it('an unknown kind falls back to narrow rather than accepting everything', () => {
    expect(checkFile(f('resume.docx', 1000), 'bogus').ok).toBe(false);
  });
});

describe('checkFile', () => {
  it('accepts a normal PDF', () => {
    expect(checkFile(f('resume.pdf', 900 * 1024))).toEqual({ ok: true });
  });

  it('accepts a Word document under the document kind', () => {
    expect(checkFile(f('resume.docx', 40 * 1024), 'document')).toEqual({ ok: true });
  });

  it('rejects an unsupported type by naming what works', () => {
    const r = checkFile(f('resume.pages', 1000), 'document');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PDF/);
    expect(r.message).toMatch(/\.pages/);
  });

  it('rejects an oversized file naming both the real size and the limit', () => {
    const r = checkFile(f('scan.pdf', 14 * 1024 * 1024));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('14MB');
    expect(r.message).toContain(formatBytes(MAX_UPLOAD_BYTES));
  });

  it('rejects a file of exactly the cap, because busboy does too', () => {
    // busboy fires its limit at `fileSize === fileSizeLimit`, so letting exactly
    // MAX through would mean a round trip that 413s at the far end.
    expect(checkFile(f('scan.pdf', MAX_UPLOAD_BYTES)).ok).toBe(false);
    expect(checkFile(f('scan.pdf', MAX_UPLOAD_BYTES - 1))).toEqual({ ok: true });
  });

  it('never produces a message that argues with itself', () => {
    // One decimal of rounding makes anything in the ~51KB band just over the cap
    // render as "10MB", the same as the cap itself.
    const r = checkFile(f('scan.pdf', MAX_UPLOAD_BYTES + 1024));
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/is 10MB, and the limit is 10MB/);
    expect(r.message).toMatch(/just over the 10MB limit/);
  });

  it('rejects an empty file', () => {
    const r = checkFile(f('resume.pdf', 0));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/empty/i);
  });

  it('uses no em dashes in any message', () => {
    const messages = [
      checkFile(f('a.pages', 10)).message,
      checkFile(f('a.pdf', 99 * 1024 * 1024)).message,
      checkFile(f('a.pdf', 0)).message,
    ];
    messages.forEach(m => expect(m).not.toContain('—'));
  });
});
