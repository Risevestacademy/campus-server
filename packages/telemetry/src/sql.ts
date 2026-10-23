import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('@campus/telemetry/sql');

/** Long statements are cut: the start says what it is, the rest is cost. */
const MAX_STATEMENT_LENGTH = 2_000;

const TRACED = Symbol.for('@campus/telemetry/sql');

/** A Postgres error code; postgres.js's own codes, like `CONNECTION_CLOSED`, are not. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

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

/** Cut without splitting a `$n` placeholder or a surrogate pair. */
function cut(statement: string): string {
  if (statement.length <= MAX_STATEMENT_LENGTH) {
    return statement;
  }
  return statement
    .slice(0, MAX_STATEMENT_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/\$\d*$/, '');
}

function finish(span: Span, query: RunningQuery, error?: unknown): void {
  const statement = (query.string ?? statementOf(query.strings)).trim();
  const operation = operationOf(statement);
  span.updateName(operation);
  span.setAttributes({
    'db.operation.name': operation,
    'db.query.text': cut(statement),
  });
  if (error !== undefined) {
    // The SQLSTATE and the error's type, never its message: Postgres quotes
    // the value it could not use, as in `invalid input syntax for type uuid`.
    const code = (error as { code?: unknown }).code;
    const named = typeof code === 'string' ? code : undefined;
    const sqlState = named && SQLSTATE.test(named) ? named : undefined;
    span.setAttributes({
      'error.type': named ?? (error instanceof Error ? error.name : 'Error'),
      ...(sqlState ? { 'db.response.status_code': sqlState } : {}),
    });
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

/**
 * Hooks the `handle` of the postgres.js `sql` comes from, so every client of
 * that copy is traced, not only `sql`, and installing twice does nothing.
 * Failures are observed, so an unawaited query no longer surfaces as an
 * unhandled rejection. What is traced and left out: the package README.
 */
export function installPostgresTracing(sql: object): void {
  const sample = (sql as unknown as (
    s: TemplateStringsArray,
  ) => object)`select 1`;
  const prototype = Object.getPrototypeOf(sample) as QueryPrototype;
  if (prototype[TRACED]) {
    return;
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
}
