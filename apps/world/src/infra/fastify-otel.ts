import { matchesPath, pathOf } from '@campus/telemetry/paths';
import type { Span } from '@opentelemetry/api';

/**
 * Options for @fastify/otel. It records the raw request URL as `url.path`,
 * query string and all, so the hook puts the path alone back: spans keep a
 * query's names, on the HTTP span, and never its values.
 */
export function fastifyOtelOptions(quietRoutes: readonly string[]) {
  return {
    registerOnInitialization: true,
    ignorePaths: ({ url }: { url: string }) => matchesPath(url, quietRoutes),
    requestHook: (span: Span, request: { url: string }) => {
      span.setAttribute('url.path', pathOf(request.url));
    },
  };
}
