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
  // Express matches routes regardless of case, so this does too.
  const path = pathOf(url).toLowerCase();
  return paths.some((listed) => {
    const quiet = listed.toLowerCase();
    return path === quiet || path.startsWith(`${quiet}/`);
  });
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

/**
 * A request's full URL with its query values redacted, and the redacted
 * query on its own. Undefined without a query string: nothing to hide.
 */
export function redactedUrlParts(
  origin: string,
  path: string,
): { full: string; query: string } | undefined {
  const query = redactQuery(path);
  if (query === undefined) {
    return undefined;
  }
  return { full: `${normalised(origin, pathOf(path))}?${query}`, query };
}

/** URL drops a port that is the scheme's default; it throws on a zone id. */
function normalised(origin: string, path: string): string {
  try {
    return new URL(path, origin).toString();
  } catch {
    return `${origin}${path}`;
  }
}

/** A host's name and port, the port taken off and an IPv6 address bracketed. */
function splitHost(host: string): { name: string; port?: string } {
  const bracketed = /^(\[[^\]]+\])(?::(\d+))?$/.exec(host);
  if (bracketed) {
    return { name: bracketed[1], port: bracketed[2] };
  }
  const parts = host.split(':');
  if (parts.length === 2) {
    return { name: parts[0], port: parts[1] };
  }
  // More than one colon and no brackets: a bare IPv6 address.
  return { name: parts.length > 2 ? `[${host}]` : host };
}

/** The full URL of an outgoing `http` request with its query values redacted. */
export function redactedRequestUrl(
  options: Pick<
    RequestOptions,
    'protocol' | 'hostname' | 'host' | 'port' | 'path'
  >,
): string | undefined {
  const protocol = options.protocol ?? 'http:';
  const host = splitHost(options.hostname ?? options.host ?? 'localhost');
  const port = options.port ?? host.port;
  const portText = port != null ? `:${port}` : '';
  return redactedUrlParts(
    `${protocol}//${host.name}${portText}`,
    options.path ?? '',
  )?.full;
}
