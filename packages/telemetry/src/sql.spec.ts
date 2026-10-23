import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { operationOf, statementOf, tracePostgres } from './sql.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
});

afterAll(() => {
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
});

function spans() {
  return exporter.getFinishedSpans();
}

describe('statementOf', () => {
  it('puts a numbered placeholder in each slot', () => {
    expect(statementOf(['select * from users where id = ', ''])).toBe(
      'select * from users where id = $1',
    );
    expect(statementOf(undefined)).toBe('');
  });
});

describe('operationOf', () => {
  it('names the statement by its first word', () => {
    expect(operationOf('select 1')).toBe('SELECT');
    expect(operationOf('  insert into x values ($1)')).toBe('INSERT');
    expect(operationOf('')).toBe('QUERY');
  });
});

/**
 * Shaped like a postgres.js query: a promise that runs once, in `handle`,
 * whichever of `then`, `catch` or `execute` gets there first.
 */
class FakeQuery extends Promise<unknown> {
  static get [Symbol.species]() {
    return Promise;
  }
  executed = false;
  string?: string;
  readonly settle: {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  constructor(
    readonly strings: readonly string[],
    private readonly sent: string,
    private readonly outcome: () => Promise<unknown>,
  ) {
    let settle!: FakeQuery['settle'];
    super((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.settle = settle;
  }
  async handle() {
    if (this.executed) return;
    this.executed = true;
    this.string = this.sent;
    await this.outcome().then(this.settle.resolve, this.settle.reject);
  }
  // oxlint-disable-next-line unicorn/no-thenable
  then<A = unknown, B = never>(
    onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    void this.handle();
    return super.then(onFulfilled, onRejected);
  }
  catch<B = never>(
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<unknown> {
    void this.handle();
    return super.catch(onRejected);
  }
}

function fakeSql(sent: string, outcome: () => Promise<unknown>) {
  return (strings: TemplateStringsArray, ..._values: unknown[]) =>
    new FakeQuery(strings, sent, outcome);
}

describe('tracePostgres', () => {
  it('spans a query once, however often it is awaited, with the statement as sent', async () => {
    const sql = tracePostgres(
      fakeSql('select * from users where id in ($1, $2)', async () => [
        { id: 1 },
      ]),
    );
    const query = sql`select * from users where id in ${['a', 'b']}`;

    expect(spans()).toHaveLength(0);
    query.catch(() => undefined);
    expect(await query).toEqual([{ id: 1 }]);
    await query;

    expect(spans()).toHaveLength(1);
    expect(spans()[0].name).toBe('SELECT');
    expect(spans()[0].attributes).toEqual({
      'db.system.name': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.query.text': 'select * from users where id in ($1, $2)',
    });
  });

  it('records a failure by its code, never its message', async () => {
    const sql = tracePostgres(
      fakeSql('select $1::uuid', async () => {
        throw Object.assign(
          new Error('invalid input syntax for type uuid: "not-a-uuid"'),
          { code: '22P02' },
        );
      }),
    );

    await expect(sql`select ${'not-a-uuid'}::uuid`).rejects.toThrow();

    const [span] = spans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['db.response.status_code']).toBe('22P02');
    expect(span.attributes['error.type']).toBe('22P02');
    expect(
      JSON.stringify([span.attributes, span.events, span.status]),
    ).not.toContain('not-a-uuid');
  });

  it('hooks a postgres.js only once', async () => {
    const sql = fakeSql('select 1', async () => []);
    tracePostgres(sql);
    tracePostgres(sql);

    await sql`select 1`;

    expect(spans()).toHaveLength(1);
  });
});

const databaseUrl = process.env.CAMPUS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('tracePostgres against Postgres', () => {
  // No type lookup on connect: it is traced too, and would come first.
  const sql = tracePostgres(
    postgres(databaseUrl ?? '', { max: 2, fetch_types: false }),
  );

  afterAll(async () => {
    await sql.end();
  });

  function statements(): unknown[] {
    return spans().map((s) => s.attributes['db.query.text']);
  }

  it('gives the same results, one span per query, as drizzle and world call it', async () => {
    const tagged = await sql`select ${41}::int + 1 as answer`;
    const values = await sql.unsafe('select $1::int as n', [7]).values();

    expect(tagged).toEqual([{ answer: 42 }]);
    expect(values).toEqual([[7]]);
    expect(statements()).toEqual([
      'select $1::int + 1 as answer',
      'select $1::int as n',
    ]);
  });

  it('records the statement as sent, helpers expanded', async () => {
    await sql`select ${sql(['a', 'b'])} from (select 1 as a, 2 as b) t`;

    expect(statements()).toEqual([
      'select "a","b" from (select 1 as a, 2 as b) t',
    ]);
  });

  it('spans what runs inside a transaction and a savepoint', async () => {
    const result = await sql.begin(async (tx) => {
      await tx`select 1 as outer_query`;
      return tx.savepoint(async (sp) => {
        const [{ n }] = await sp`select 2 as n`;
        return n;
      });
    });

    expect(result).toBe(2);
    expect(statements()).toEqual(
      expect.arrayContaining(['select 1 as outer_query', 'select 2 as n']),
    );
  });

  it('spans a reserved connection, and leaves a cursor working and untraced', async () => {
    const reserved = await sql.reserve();
    await reserved`select 3 as reserved_query`;
    reserved.release();
    const rows: unknown[] = [];
    const cursor = sql`select generate_series(1, 3) as i`.cursor(2);
    for await (const batch of cursor) {
      rows.push(...batch);
    }

    expect(rows).toHaveLength(3);
    expect(statements()).toEqual(['select 3 as reserved_query']);
  });

  it('keeps a value Postgres rejects out of the span', async () => {
    await expect(sql`select ${'not-a-uuid'}::uuid`).rejects.toThrow(
      /not-a-uuid/,
    );

    const [span] = spans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['db.response.status_code']).toBe('22P02');
    expect(
      JSON.stringify([span.attributes, span.events, span.status]),
    ).not.toContain('not-a-uuid');
  });
});
