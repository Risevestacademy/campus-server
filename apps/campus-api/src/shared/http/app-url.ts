import type { Env } from '../../infra/config/config.module.js';

/** A page of the web app: `path` may carry a query. */
export function appUrl(config: Env, path: string): string {
  return `${config.APP_PUBLIC_URL.replace(/\/+$/, '')}${path}`;
}
