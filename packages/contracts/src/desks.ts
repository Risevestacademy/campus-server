/**
 * The Postgres channel campus-api notifies when who holds a desk may have
 * changed: a claim, a release, a membership or an account ending, a sync
 * adding or retiring desks. The payload is the cohort id, or empty when
 * every cohort is touched. world tells the people in that cohort, who fetch
 * the desks again from campus-api.
 */
export const DESKS_CHANGED_CHANNEL = 'desks_changed';
