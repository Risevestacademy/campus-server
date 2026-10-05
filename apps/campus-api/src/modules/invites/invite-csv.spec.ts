import { CohortRole } from '../cohorts/schema.js';
import { INVITE_CSV_MAX_ROWS, parseCsv, parseInviteCsv } from './invite-csv.js';
import { InviteInvalidArgumentException } from './invites.exceptions.js';

const parse = (text: string) => parseInviteCsv(Buffer.from(text, 'utf8'));

describe('parseCsv', () => {
  const cells = (text: string) => parseCsv(text).map((row) => row.cells);

  it('splits lines and cells', () => {
    expect(cells('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('reads CRLF line endings, as Excel writes them', () => {
    expect(cells('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('reads the last line when the file has no final line break', () => {
    expect(cells('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a comma, a quote and a line break inside a quoted cell', () => {
    expect(cells('"Lovelace, Ada","she said ""hi""","two\nlines"\n')).toEqual([
      ['Lovelace, Ada', 'she said "hi"', 'two\nlines'],
    ]);
  });

  it('refuses a quoted cell that is never closed, naming where it starts', () => {
    expect(() => parseCsv('h\n"ada,mentor\ngrace,mentor\n')).toThrow(
      /quoted value that starts on line 2 is never closed/,
    );
  });

  it.each([
    ['a letter', 'h\n"ada@campus.local"x,mentor\n'],
    ['a space', 'h\n"ada@campus.local" ,mentor\n'],
    ['in a column nobody reads', 'a,b\nada,"fine"oops\n'],
  ])('refuses text straight after a closing quote: %s', (_label, text) => {
    expect(() => parseCsv(text)).toThrow(
      /Line 2 has text straight after a closing quote/,
    );
  });

  it('takes a comma, a line end or the end of the file after a closing quote', () => {
    expect(cells('"a","b"\r\n"c","d"')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps empty cells, so columns stay in place', () => {
    expect(cells('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('numbers each row by the line it starts on', () => {
    expect(parseCsv('h\n"two\nlines"\nlast\n').map((row) => row.line)).toEqual([
      1, 2, 4,
    ]);
  });
});

describe('parseInviteCsv', () => {
  it('reads one invite per row', () => {
    const { rows, errors } = parse(
      'email,role,track\nada@campus.local,student,SE\ngrace@campus.local,professor,\n',
    );

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        email: 'ada@campus.local',
        role: CohortRole.Student,
        track: 'SE',
        visitEnds: null,
      },
      {
        line: 3,
        email: 'grace@campus.local',
        role: CohortRole.Professor,
        track: null,
        visitEnds: null,
      },
    ]);
  });

  it('tidies what a spreadsheet leaves behind', () => {
    const { rows } = parse(
      '﻿ Email , ROLE ,Track,Visit Ends\r\n  Ada@Campus.Local , Student , se ,\r\n',
    );

    expect(rows).toEqual([
      {
        line: 2,
        email: 'ada@campus.local',
        role: CohortRole.Student,
        track: 'SE',
        visitEnds: null,
      },
    ]);
  });

  it('takes the columns in any order, and ignores ones it does not know', () => {
    const { rows } = parse(
      'name,track,role,email\nAda,SE,student,ada@campus.local\n',
    );

    expect(rows[0]).toMatchObject({
      email: 'ada@campus.local',
      role: CohortRole.Student,
      track: 'SE',
    });
  });

  it('does not need the optional columns', () => {
    const { rows } = parse('email,role\ngrace@campus.local,mentor\n');

    expect(rows[0]).toMatchObject({ track: null, visitEnds: null });
  });

  it('carries a guest visit end through as written', () => {
    const { rows } = parse(
      'email,role,visit_ends\nguest@campus.local,guest,2026-11-30T17:00:00Z\n',
    );

    expect(rows[0].visitEnds).toBe('2026-11-30T17:00:00Z');
  });

  it('skips blank lines, and still numbers rows as the file has them', () => {
    const { rows } = parse(
      'email,role\n\nada@campus.local,mentor\n,\ngrace@campus.local,mentor\n',
    );

    expect(rows.map((row) => row.line)).toEqual([3, 5]);
  });

  it('reports a bad row against its line, and reads the rest', () => {
    const { rows, errors } = parse(
      [
        'email,role',
        'not-an-address,mentor',
        ',mentor',
        'ada@campus.local,janitor',
        'grace@campus.local,',
        'ok@campus.local,mentor',
      ].join('\n'),
    );

    expect(rows.map((row) => row.email)).toEqual(['ok@campus.local']);
    expect(errors).toEqual([
      {
        line: 2,
        email: 'not-an-address',
        reason: 'email is not a valid address',
      },
      { line: 3, email: '', reason: 'email is missing' },
      {
        line: 4,
        email: 'ada@campus.local',
        reason: 'role must be one of: student, professor, mentor, guest',
      },
      { line: 5, email: 'grace@campus.local', reason: 'role is missing' },
    ]);
  });

  describe('a file that cannot be read as a list of invites', () => {
    it.each([
      ['an empty file', ''],
      ['only blank lines', '\n\n \n'],
      ['a header and nothing else', 'email,role\n'],
      ['no email column', 'role,track\nstudent,SE\n'],
      ['no role column', 'email,track\nada@campus.local,SE\n'],
      // The first row is data, not a header: there is no "email" column.
      ['no header at all', 'ada@campus.local,student,SE\n'],
      ['a column named twice', 'email,role,email\na@b.co,mentor,c@d.co\n'],
      ['a binary file', 'email,role\n\u0000\u0001\u0002'],
    ])('refuses %s', (_label, text) => {
      expect(() => parse(text)).toThrow(InviteInvalidArgumentException);
    });

    it('refuses more rows than the limit, and says how many it found', () => {
      const text =
        'email,role\n' +
        Array.from(
          { length: INVITE_CSV_MAX_ROWS + 1 },
          (_, i) => `p${i}@campus.local,mentor`,
        ).join('\n');

      expect(() => parse(text)).toThrow(/at most 500 invites.*has 501/);
    });

    it('accepts exactly the limit', () => {
      const text =
        'email,role\n' +
        Array.from(
          { length: INVITE_CSV_MAX_ROWS },
          (_, i) => `p${i}@campus.local,mentor`,
        ).join('\n');

      expect(parse(text).rows).toHaveLength(INVITE_CSV_MAX_ROWS);
    });
  });
});
