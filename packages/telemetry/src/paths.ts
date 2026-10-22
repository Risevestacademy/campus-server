import type { RequestOptions } from 'node:http';

/** A request URL without its query string, which can carry tokens and codes. */
export function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/** Whether the URL is one of the paths, or under one of them. */
export function matchesPath(
  url: string | undefined,
  paths: readonly string[],
): boolean {
  const path = pathOf(url);
  return paths.some(
    (listed) => path === listed || path.startsWith(`${listed}/`),
  );
}

/** Keeps a query string's names and drops its values. */
export function redactQuery(url: string | undefined): string | undefined {
  const query = url?.split('?')[1];
  if (!query) {
    return undefined;
  }
  return [...new URLSearchParams(query).keys()]
    .map((name) => `${name}=REDACTED`)
    .join('&');
}

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
};

/** The full URL of an outgoing request with its query values redacted. */
export function redactedRequestUrl(
  options: Pick<
    RequestOptions,
    'protocol' | 'hostname' | 'host' | 'port' | 'path'
  >,
): string | undefined {
  const query = redactQuery(options.path ?? undefined);
  if (query === undefined) {
    return undefined;
  }
  const protocol = options.protocol ?? 'http:';
  const host = options.hostname ?? options.host ?? 'localhost';
  const port =
    options.port != null && String(options.port) !== DEFAULT_PORTS[protocol]
      ? `:${options.port}`
      : '';
  return `${protocol}//${host}${port}${pathOf(options.path ?? undefined)}?${query}`;
}
