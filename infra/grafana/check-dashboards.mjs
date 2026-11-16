// Checks the dashboards against what the services export, without Grafana:
// every Prometheus metric a query names must come from an instrument that
// world or the runtime instrumentation creates, translated the way Grafana
// Cloud stores OTLP metrics. Also checks data sources, variables, ids and
// layout. Run with `pnpm grafana:check`.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dashboardsDir = join(root, 'infra/grafana/dashboards');

const UNIT_SUFFIX = { By: 'bytes', s: 'seconds', ms: 'milliseconds' };
const COUNTERS = new Set(['Counter', 'ObservableCounter']);
const GAUGES = new Set(['Gauge', 'ObservableGauge']);

/** The names Grafana Cloud's OTLP translation gives one instrument. */
export function prometheusNames(kind, name, unit) {
  let base = name.replaceAll('.', '_');
  const suffix =
    UNIT_SUFFIX[unit] ?? (unit === '1' && GAUGES.has(kind) ? 'ratio' : '');
  if (suffix && !base.endsWith(`_${suffix}`)) base += `_${suffix}`;
  if (COUNTERS.has(kind)) return [`${base}_total`];
  if (kind === 'Histogram') {
    return [`${base}_bucket`, `${base}_sum`, `${base}_count`];
  }
  return [base];
}

function instrumentsIn(source, nameOf) {
  const found = [];
  const create =
    /meter\s*\.create(\w+)\(\s*([\w.]+|'[^']+')\s*(?:,\s*\{([^}]*)\})?/g;
  for (const [, kind, nameRef, options = ''] of source.matchAll(create)) {
    const name = nameOf(nameRef);
    if (!name) throw new Error(`Cannot resolve instrument name ${nameRef}`);
    const unit = /unit:\s*'([^']*)'/.exec(options)?.[1];
    found.push(...prometheusNames(kind, name, unit));
  }
  return found;
}

function exportedMetrics() {
  const names = new Set();

  const world = readFileSync(join(root, 'apps/world/src/infra/metrics.ts'), {
    encoding: 'utf8',
  });
  for (const name of instrumentsIn(world, (ref) => ref.slice(1, -1))) {
    names.add(name);
  }

  const require = createRequire(join(root, 'packages/telemetry/package.json'));
  const runtimeDir = join(
    dirname(require.resolve('@opentelemetry/instrumentation-runtime-node')),
  );
  const semconv = readFileSync(join(runtimeDir, 'semconv.js'), 'utf8');
  const constants = Object.fromEntries(
    [...semconv.matchAll(/exports\.(\w+) = '([^']+)';/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const metricsDir = join(runtimeDir, 'metrics');
  for (const file of readdirSync(metricsDir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(metricsDir, file), 'utf8');
    for (const name of instrumentsIn(source, (ref) =>
      ref.startsWith('semconv_1.') ? constants[ref.slice(10)] : undefined,
    )) {
      names.add(name);
    }
  }
  return names;
}

function panelsOf(panels) {
  return panels.flatMap((p) => [p, ...panelsOf(p.panels ?? [])]);
}

function overlaps(a, b) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

function variableRefs(text) {
  return [...text.matchAll(/\$\{?(\w+)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith('__'));
}

export function checkDashboard(file, dashboard, metrics) {
  const problems = [];
  const fail = (message) => problems.push(`${file}: ${message}`);

  if (!dashboard.uid) fail('has no uid');
  if (!dashboard.title) fail('has no title');

  const variables = new Map(
    (dashboard.templating?.list ?? []).map((v) => [v.name, v]),
  );
  const datasourceTypes = new Map(
    [...variables.values()]
      .filter((v) => v.type === 'datasource')
      .map((v) => [v.name, v.query]),
  );

  const checkDatasource = (where, ds) => {
    if (!ds) return;
    const name = /^\$\{?(\w+)\}?$/.exec(ds.uid ?? '')?.[1];
    if (!name) return fail(`${where} names a data source by a fixed uid`);
    if (!datasourceTypes.has(name)) {
      return fail(`${where} uses undefined data source variable $${name}`);
    }
    if (ds.type !== datasourceTypes.get(name)) {
      fail(
        `${where} is ${ds.type} but $${name} is ${datasourceTypes.get(name)}`,
      );
    }
  };

  const checkPromql = (where, expr) => {
    const selectors = [
      ...expr.matchAll(/([a-zA-Z_:][\w:]*)\s*\{/g),
      ...expr.matchAll(/label_values\(\s*([a-zA-Z_:][\w:]*)/g),
    ];
    for (const [, name] of selectors) {
      if (!metrics.has(name))
        fail(`${where} queries ${name}, which nothing exports`);
    }
  };

  for (const v of variables.values()) {
    if (v.type === 'query') {
      checkDatasource(`variable ${v.name}`, v.datasource);
      const query = typeof v.query === 'string' ? v.query : v.query?.query;
      if (query) checkPromql(`variable ${v.name}`, query);
    }
  }

  const panels = panelsOf(dashboard.panels ?? []);
  const ids = new Set();
  for (const panel of panels) {
    const where = `panel ${panel.id} "${panel.title}"`;
    if (ids.has(panel.id)) fail(`${where} reuses its id`);
    ids.add(panel.id);
    if (panel.type === 'row') continue;

    checkDatasource(where, panel.datasource);
    for (const target of panel.targets ?? []) {
      const ds = target.datasource ?? panel.datasource;
      checkDatasource(`${where}, query ${target.refId}`, ds);
      if (ds?.type === 'prometheus' && target.expr !== undefined) {
        checkPromql(`${where}, query ${target.refId}`, target.expr);
      }
      for (const text of [target.expr, target.query].filter(
        (t) => typeof t === 'string',
      )) {
        for (const name of variableRefs(text)) {
          if (!variables.has(name)) {
            fail(`${where}, query ${target.refId} uses undefined $${name}`);
          }
        }
      }
    }
  }

  const top = dashboard.panels ?? [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if (overlaps(top[i].gridPos, top[j].gridPos)) {
        fail(`panels ${top[i].id} and ${top[j].id} overlap`);
      }
    }
  }
  return problems;
}

function main() {
  const metrics = exportedMetrics();
  const problems = [];
  const uids = new Map();
  const files = readdirSync(dashboardsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    let dashboard;
    try {
      dashboard = JSON.parse(readFileSync(join(dashboardsDir, file), 'utf8'));
    } catch (err) {
      problems.push(`${file}: is not valid JSON (${err.message})`);
      continue;
    }
    if (uids.has(dashboard.uid)) {
      problems.push(`${file}: shares its uid with ${uids.get(dashboard.uid)}`);
    }
    uids.set(dashboard.uid, file);
    problems.push(...checkDashboard(file, dashboard, metrics));
  }

  if (problems.length > 0) {
    console.error([...new Set(problems)].join('\n'));
    process.exit(1);
  }
  console.log(
    `${files.length} dashboards checked against ${metrics.size} exported metrics.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
