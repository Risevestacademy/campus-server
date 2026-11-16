// Writes every dashboard in infra/grafana/dashboards to a Grafana stack,
// replacing the one with the same uid. Run with `pnpm grafana:deploy` and
// GRAFANA_URL, GRAFANA_TOKEN and, optionally, GRAFANA_FOLDER_UID set.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'dashboards',
);

export async function deployDashboards({
  url,
  token,
  folderUid,
  message,
  dir = dashboardsDir,
  fetch = globalThis.fetch,
}) {
  const endpoint = `${url.replace(/\/+$/, '')}/api/dashboards/db`;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const failures = [];
  for (const file of files) {
    const dashboard = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dashboard: { ...dashboard, id: null },
        overwrite: true,
        ...(folderUid ? { folderUid } : {}),
        ...(message ? { message } : {}),
      }),
    });
    if (response.ok) {
      console.log(`${file}: deployed as ${dashboard.uid}`);
    } else {
      const body = await response.json().catch(() => ({}));
      failures.push(
        `${file}: ${response.status} ${body.message ?? response.statusText}`,
      );
    }
  }
  return failures;
}

async function main() {
  const { GRAFANA_URL, GRAFANA_TOKEN, GRAFANA_FOLDER_UID, GITHUB_SHA } =
    process.env;
  if (!GRAFANA_URL || !GRAFANA_TOKEN) {
    console.error('GRAFANA_URL and GRAFANA_TOKEN must be set.');
    process.exit(1);
  }
  const failures = await deployDashboards({
    url: GRAFANA_URL,
    token: GRAFANA_TOKEN,
    folderUid: GRAFANA_FOLDER_UID,
    message: GITHUB_SHA ? `Deployed ${GITHUB_SHA.slice(0, 7)}` : undefined,
  });
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
