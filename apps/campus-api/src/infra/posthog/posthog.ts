import { PostHog } from 'posthog-node';

export interface PostHogInitOptions {
  apiKey?: string;
  host: string;
  enabled: boolean;
}

export function initPostHog(options: PostHogInitOptions): PostHog | undefined {
  // env.ts validates POSTHOG_API_KEY is present and well-formed whenever
  // FF_POSTHOG_ENABLED is true, so a missing key here should be unreachable.
  // The check stays only to narrow apiKey from `string | undefined`.
  if (!options.enabled || !options.apiKey) {
    return undefined;
  }

  return new PostHog(options.apiKey, { host: options.host });
}
