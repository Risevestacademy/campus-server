import { toCsv, type CsvColumn } from './csv.js';

interface Row {
  name: string | null;
  count: number;
  at?: Date;
}

const columns: CsvColumn<Row>[] = [
  { header: 'name', value: (r) => r.name },
  { header: 'count', value: (r) => r.count },
];

const body = (csv: string) => csv.replace(/^﻿/, '');

describe('toCsv', () => {
  it('starts with a byte-order mark and ends every record with CRLF', () => {
    const csv = toCsv(columns, [{ name: 'Ada', count: 3 }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(body(csv)).toBe('name,count\r\nAda,3\r\n');
  });

  it('writes the header alone for no rows', () => {
    expect(body(toCsv(columns, []))).toBe('name,count\r\n');
  });

  it('leaves null empty and writes dates as ISO', () => {
    const csv = toCsv(
      [
        { header: 'name', value: (r: Row) => r.name },
        { header: 'at', value: (r: Row) => r.at },
      ],
      [{ name: null, count: 0, at: new Date('2026-11-05T10:00:00Z') }],
    );
    expect(body(csv)).toBe('name,at\r\n,2026-11-05T10:00:00.000Z\r\n');
  });

  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    const csv = toCsv(columns, [
      { name: 'Lovelace, Ada', count: 1 },
      { name: 'Ada "the first"', count: 2 },
      { name: 'two\nlines', count: 3 },
    ]);
    expect(body(csv)).toBe(
      'name,count\r\n' +
        '"Lovelace, Ada",1\r\n' +
        '"Ada ""the first""",2\r\n' +
        '"two\nlines",3\r\n',
    );
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'keeps a spreadsheet from running %j as a formula',
    (name) => {
      const [, record] = body(toCsv(columns, [{ name, count: 0 }])).split(
        '\r\n',
      );
      expect(record.replace(/^"/, '').startsWith(`'${name[0]}`)).toBe(true);
    },
  );

  it('leaves negative numbers as numbers', () => {
    expect(body(toCsv(columns, [{ name: 'x', count: -2 }]))).toBe(
      'name,count\r\nx,-2\r\n',
    );
  });
});
