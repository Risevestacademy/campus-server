import { cleanFileName, contentMatches } from './media-rules.js';

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const WAV = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];

describe('contentMatches', () => {
  it.each([
    ['image/jpeg', JPEG],
    ['image/png', PNG],
    ['image/webp', WEBP],
  ])('knows a %s by its first bytes', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(true);
  });

  it.each([
    ['image/png', JPEG],
    ['image/jpeg', PNG],
    ['image/webp', WAV],
    ['image/png', PNG.slice(0, 4)],
    ['image/gif', PNG],
  ])('refuses a %s that is not one', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(false);
  });
});

const enc = (text: string) => new TextEncoder().encode(text);
const GIF = enc('GIF89a');
const PDF = enc('%PDF-1.7');
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('contentMatches for attachments', () => {
  it.each([
    ['image/gif', [...GIF]],
    ['image/gif', [...enc('GIF87a')]],
    ['application/pdf', [...PDF]],
    [DOCX, ZIP],
    ['application/vnd.ms-excel', OLE],
    ['text/plain', [...enc('Hello, campus')]],
    ['text/csv', [...enc('name,cohort\nAda,C1\n')]],
    ['text/plain', [...enc('Café')]],
    // Excel's default CSV: Windows-1252, where é is 0xE9.
    ['text/csv', [0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x43, 0x31]],
    // Excel's "Unicode Text": UTF-16LE with a byte-order mark.
    ['text/plain', [0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]],
    ['text/plain', [0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]],
  ])('knows a %s', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(true);
  });

  it.each([
    ['application/pdf', [...GIF]],
    [DOCX, OLE],
    ['application/msword', ZIP],
    ['text/plain', [0x68, 0x69, 0x00, 0x21]],
    ['text/plain', [0x68, 0x00, 0x69, 0x00]],
    ['text/csv', [...PDF, 0x00, 0x01]],
    ['text/csv', []],
  ])('refuses a %s that is not one', (type, bytes) => {
    expect(contentMatches(type, Uint8Array.from(bytes))).toBe(false);
  });
});

describe('cleanFileName', () => {
  it.each([
    ['timetable.pdf', 'application/pdf', 'timetable.pdf'],
    ['C:\\Users\\ada\\plan.docx', DOCX, 'plan.docx'],
    ['../../etc/report', 'application/pdf', 'report.pdf'],
    ['  notes\u0000\u200b.txt  ', 'text/plain', 'notes.txt'],
    ['fix.bat', 'text/plain', 'fix.txt'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpg'],
    ['invoice\u202efdp.exe', 'application/pdf', 'invoicefdp.pdf'],
    ['report.pdf. . ', 'application/pdf', 'report.pdf'],
    ['..', 'text/plain', null],
    ['   ', 'text/plain', null],
    [undefined, 'text/plain', null],
  ])('makes %j, a %s, into %j', (name, type, clean) => {
    expect(cleanFileName(name, type)).toBe(clean);
  });

  it('stays fast on a long run of spaces that is not at the end', () => {
    const started = performance.now();

    const clean = cleanFileName(`a${' '.repeat(50_000)}b. . `, 'text/plain');

    expect(performance.now() - started).toBeLessThan(100);
    expect(clean).toHaveLength(255);
  });

  it('keeps at most 255 characters, the extension included', () => {
    const clean = cleanFileName('a'.repeat(300) + '.pdf', 'application/pdf');
    expect(clean).toHaveLength(255);
    expect(clean?.endsWith('.pdf')).toBe(true);
  });
});
