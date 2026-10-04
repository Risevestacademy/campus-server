import { isEmail } from 'class-validator';

import { CohortRole } from '../cohorts/schema.js';
import { InviteInvalidArgumentException } from './invites.exceptions.js';

/** The most invites one file may ask for. */
export const INVITE_CSV_MAX_ROWS = 500;

/** The largest file accepted. 500 rows of addresses are a small fraction. */
export const INVITE_CSV_MAX_BYTES = 256 * 1024;

/** A row that can be turned into an invite. */
export interface InviteCsvRow {
  /** The line it came from, counting the header as 1, as a spreadsheet does. */
  line: number;
  email: string;
  role: CohortRole;
  /** A track code, uppercased. Null when the cell was empty. */
  track: string | null;
  /** Guests only: when the visit ends. */
  visitEnds: string | null;
}

/** A row that cannot, with why. The other rows are still tried. */
export interface InviteCsvRowError {
  line: number;
  /** The address as written, so the admin can find the row. */
  email: string;
  reason: string;
}

export interface ParsedInviteCsv {
  rows: InviteCsvRow[];
  errors: InviteCsvRowError[];
}

const REQUIRED_COLUMNS = ['email', 'role'] as const;
const KNOWN_COLUMNS = ['email', 'role', 'track', 'visit_ends'] as const;
type Column = (typeof KNOWN_COLUMNS)[number];

/**
 * Reads an invite file: a header row naming the columns, then one invite per
 * line.
 *
 *     email,role,track
 *     ada@campus.local,student,SE
 *     grace@campus.local,professor,
 *
 * Two kinds of problem, answered differently. A file that cannot be read as
 * what it claims to be — no header, a column missing, too many rows — is
 * refused whole, since there is no telling what its rows mean. A row that is
 * wrong on its own — a bad address, a role that does not exist — is reported
 * against its line and the rest of the file goes ahead.
 *
 * What a row means against the database — whether the cohort runs that
 * track, whether the address is already invited — is not decided here.
 */
export function parseInviteCsv(buffer: Buffer): ParsedInviteCsv {
  // A file saved by Excel starts with a byte-order mark, which would
  // otherwise become part of the first column's name.
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  if (text.includes('\u0000')) {
    throw invalid('The file is not a text file');
  }

  // Blank lines are skipped, wherever they fall.
  const table = parseCsv(text).filter(({ cells }) =>
    cells.some((cell) => cell.trim() !== ''),
  );
  const [header, ...lines] = table;
  if (!header) {
    throw invalid('The file is empty');
  }

  const columns = header.cells.map((name) =>
    name.trim().toLowerCase().replace(/\s+/g, '_'),
  );
  for (const required of REQUIRED_COLUMNS) {
    if (!columns.includes(required)) {
      throw invalid(
        `The first row must name the columns, and "${required}" is missing`,
        { columns },
      );
    }
  }
  const duplicate = columns.find(
    (name, i) => name !== '' && columns.indexOf(name) !== i,
  );
  if (duplicate) {
    throw invalid(`The column "${duplicate}" appears twice`, { columns });
  }
  if (lines.length === 0) {
    throw invalid('The file has a header but no rows to invite');
  }
  if (lines.length > INVITE_CSV_MAX_ROWS) {
    throw invalid(
      `A file may hold at most ${INVITE_CSV_MAX_ROWS} invites, and this one has ${lines.length}`,
      { rows: lines.length, max: INVITE_CSV_MAX_ROWS },
    );
  }

  const at = (cells: string[], column: Column): string => {
    const index = columns.indexOf(column);
    return index === -1 ? '' : (cells[index] ?? '').trim();
  };

  const rows: InviteCsvRow[] = [];
  const errors: InviteCsvRowError[] = [];
  for (const { cells, line } of lines) {
    const email = at(cells, 'email').toLowerCase();
    const role = at(cells, 'role').toLowerCase();
    const track = at(cells, 'track').toUpperCase();
    const visitEnds = at(cells, 'visit_ends');

    const fail = (reason: string) => errors.push({ line, email, reason });

    if (email === '') {
      fail('email is missing');
    } else if (!isEmail(email)) {
      fail('email is not a valid address');
    } else if (!isCohortRole(role)) {
      fail(
        role === ''
          ? 'role is missing'
          : `role must be one of: ${Object.values(CohortRole).join(', ')}`,
      );
    } else {
      rows.push({
        line,
        email,
        role,
        track: track === '' ? null : track,
        visitEnds: visitEnds === '' ? null : visitEnds,
      });
    }
  }
  return { rows, errors };
}

function isCohortRole(value: string): value is CohortRole {
  return (Object.values(CohortRole) as string[]).includes(value);
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): InviteInvalidArgumentException {
  return new InviteInvalidArgumentException(message, details);
}

/**
 * Splits CSV text into rows of cells, each with the line it started on.
 *
 * The usual rules: commas separate cells, a cell may be wrapped in double
 * quotes to hold a comma or a line break, and a quote inside a quoted cell
 * is written twice. Lines end with LF or CRLF.
 *
 * Written out rather than pulled in: it is thirty lines, and a spreadsheet
 * export is the only thing it has to read.
 */
export function parseCsv(text: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startedOn = 1;

  const endRow = () => {
    cells.push(cell);
    rows.push({ cells, line: startedOn });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      startedOn = line;
    } else {
      cell += char;
    }
  }
  // The last line, when the file does not end with a line break.
  if (cell !== '' || cells.length > 0) {
    endRow();
  }
  return rows;
}
