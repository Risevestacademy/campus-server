import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('@campus/telemetry/sql');

/** Long statements are cut: the start says what it is, the rest is cost. */
const MAX_STATEMENT_LENGTH = 2_000;

const TRACED = Symbol.for('@campus/telemetry/sql');

/** What a postgres.js query holds that a span reads. */
interface RunningQuery {
  executed: boolean;
  /** Set on a cursor, whose promise never settles: postgres.js swaps it per batch. */
  cursorRows?: number;
  strings?: readonly string[];
  /** The statement as sent, set while the query is built. */
  string?: string;
}

interface QueryPrototype {
  handle(this: RunningQuery): unknown;
  [TRACED]?: true;
}

/** A tagged-template statement with `$n` in each slot, for before it is built. */
export function statementOf(strings: readonly string[] = []): string {
  return strings
    .reduce((text, part, i) => (i === 0 ? part : `${text}$${i}${part}`), '')
    .trim();
}

export function operationOf(statement: string): string {
  return /^\s*([a-z]+)/i.exec(statement)?.[1]?.toUpperCase() ?? 'QUERY';
}

function finish(span: Span, query: RunningQuery, error?: unknown): void {
  const statement = (query.string ?? statementOf(query.strings)).trim();
  const operation = operationOf(statement);
  span.updateName(operation);
  span.setAttributes({
    'db.operation.name': operation,
    'db.query.text': statement.slice(0, MAX_STATEMENT_LENGTH),
  });
  if (error !== undefined) {
    // The SQLSTATE and the error's type, never its message: Postgres quotes
    // the value it could not use, as in `invalid input syntax for type uuid`.
    const code = (error as { code?: unknown }).code;
    const sqlState = typeof code === 'string' ? code : undefined;
    span.setAttributes({
      'error.type': sqlState ?? (error instanceof Error ? error.name : 'Error'),
      ...(sqlState ? { 'db.response.status_code': sqlState } : {}),
    });
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

/**
 * Gives every query that `sql`'s postgres.js runs a span, from when it runs
 * until it settles: tagged templates, `unsafe` (which drizzle uses), and
 * those inside `begin`, `savepoint`, `reserve` and `forEach`, plus the type
 * lookup postgres.js runs on each new connection. Cursors are left out:
 * their query never settles, so their span would never end.
 *
 * The hook is on postgres.js's own `handle`, which every query passes
 * through exactly once, so any client of the same postgres.js is covered
 * and calling this again does nothing. The statement keeps its `$n`
 * placeholders; values are never recorded.
 *
 * A query's failure is observed for its span, so one that nobody awaits no
 * longer surfaces as an unhandled rejection.
 */
export function tracePostgres<S extends object>(sql: S): S {
  const sample = (sql as unknown as (
    s: TemplateStringsArray,
  ) => object)`select 1`;
  const prototype = Object.getPrototypeOf(sample) as QueryPrototype;
  if (prototype[TRACED]) {
    return sql;
  }
  const handle = prototype.handle;
  prototype.handle = function (this: RunningQuery) {
    if (!this.executed && this.cursorRows === undefined) {
      const span = tracer.startSpan('QUERY', {
        kind: SpanKind.CLIENT,
        attributes: { 'db.system.name': 'postgresql' },
      });
      // Promise's own `then`, not the query's, which would run it again.
      Promise.prototype.then.call(
        this,
        () => finish(span, this),
        (error: unknown) => finish(span, this, error),
      );
    }
    return handle.call(this);
  };
  prototype[TRACED] = true;
  return sql;
}
