/**
 * Writing CSV for people to open in a spreadsheet.
 *
 * RFC 4180: comma-separated, CRLF between records, a field quoted when it
 * holds a comma, a quote or a line break, and a quote inside doubled. A
 * byte-order mark goes first, or Excel reads UTF-8 as its own code page and
 * mangles every accented name.
 *
 * A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 * is read by a spreadsheet as a formula, and a name or a reason is whatever
 * somebody typed. Such a cell gets a leading `'`, which spreadsheets show as
 * text and do not run (OWASP's advice for CSV injection). Numbers are written
 * as they are, so a negative number stays a number.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function toCsv<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
): string {
  const lines = [columns.map((c) => field(c.header))];
  for (const row of rows) {
    lines.push(columns.map((c) => field(c.value(row))));
  }
  return BOM + lines.map((cells) => cells.join(',')).join('\r\n') + '\r\n';
}

function field(value: CsvValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  let text = value instanceof Date ? value.toISOString() : value;
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
