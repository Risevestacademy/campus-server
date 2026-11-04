import { z } from 'zod';

const client = z.enum(['web', 'mobile']);
const cohortRole = z.enum(['student', 'professor', 'mentor', 'guest']);
const cohortStatus = z.enum(['upcoming', 'active', 'completed']);
const memberStatus = z.enum([
  'active',
  'dismissed',
  'graduated',
  'withdrawn',
  'deferred',
]);
const signInFailure = z.enum([
  'invalid_state',
  'expired_state',
  'denied',
  'missing_code',
  'exchange_failed',
  'unverified_email',
  'incomplete_profile',
  'invite_required',
  'account_suspended',
  'invalid_request',
  'rate_limited',
  'server_error',
]);
const feedbackCategory = z.enum(['bug', 'idea', 'report']);
const count = z.number().int().nonnegative();

function event<S extends z.ZodRawShape>(shape: S, consent = false) {
  return { schema: z.strictObject(shape), consent };
}

/**
 * Every event, its fields, and whether it needs consent. Fields are enums,
 * numbers, booleans and UUIDs only, so a name, an email or a URL cannot pass.
 */
export const EVENTS = {
  'auth.signed_in': event({ client, first_sign_in: z.boolean() }),
  'auth.sign_in_failed': event({ reason: signInFailure, client }),
  'auth.signed_out': event({ client }),
  'invite.sent': event({
    role: cohortRole,
    via: z.enum(['single', 'import']),
  }),
  'invite.resent': event({ role: cohortRole }),
  'invite.revoked': event({ role: cohortRole }),
  'invite.accepted': event({ role: cohortRole, days_since_sent: count }),
  'invite.declined': event({ role: cohortRole }),
  'cohort.created': event({ status: cohortStatus }),
  'member.status_changed': event({
    from: memberStatus,
    to: memberStatus,
    subject_user_id: z.uuid(),
  }),
  'member.track_changed': event({
    track_id: z.uuid(),
    subject_user_id: z.uuid(),
  }),
  'profile.completed': event({}),
  'mentorship_group.created': event({ size: count }),
  'feedback.submitted': event({ category: feedbackCategory }),
  'presence.started': event({ client, reconnect: z.boolean() }, true),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventProperties<E extends EventName> = z.input<
  (typeof EVENTS)[E]['schema']
>;
