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
const socketMode = z.enum(['avatar', 'watcher']);
const spaceKind = z.enum([
  'open',
  'classroom',
  'meeting_room',
  'mentor_pod',
  'live_coding',
  'desk',
  'town_hall',
  'notice_board',
  'stage',
  'help_desk',
  'unset',
]);
const space = {
  space_id: z.uuid(),
  space_kind: spaceKind,
};
const spaceRefusal = z.enum(['designated', 'locked', 'removed', 'closed']);

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
  'presence.started': event(
    { client, reconnect: z.boolean(), mode: socketMode },
    true,
  ),
  'presence.ended': event(
    {
      client,
      mode: socketMode,
      duration_s: count,
      reason: z.enum([
        'closed',
        'replaced',
        'signed_out',
        'access_ended',
        'lost',
        'shutdown',
        'error',
      ]),
    },
    true,
  ),
  'status.chosen': event(
    { status: z.enum(['available', 'busy', 'away']), timed: z.boolean() },
    true,
  ),
  'space.visited': event(
    {
      ...space,
      access: z.enum(['normal', 'designated']),
      audio_mode: z.enum(['proximity', 'boundary']),
      duration_s: count,
      arrived_by: z.enum([
        'joined',
        'step',
        'go_to',
        'go_to_space',
        'go_to_tile',
        'moved',
      ]),
      lines_said: count,
    },
    true,
  ),
  'space.refused': event(
    {
      ...space,
      reason: z.enum([...spaceRefusal.options, 'full']),
      may_ask: z.boolean(),
    },
    true,
  ),
  'space.lock_changed': event(
    { ...space, locked: z.boolean(), occupants: count },
    true,
  ),
  'entry.request_ended': event(
    {
      ...space,
      reason: spaceRefusal,
      outcome: z.enum([
        'admitted',
        'declined',
        'withdrawn',
        'walked_away',
        'nobody_inside',
        'not_needed',
        'cancelled',
      ]),
      wait_s: count,
    },
    true,
  ),
  'walk.ended': event(
    {
      target: z.enum(['person', 'space', 'tile']),
      reason: z.enum([
        'arrived',
        'stopped',
        'refused',
        'full',
        'gone',
        'elsewhere',
        'no_way',
        'moved_by_staff',
      ]),
      steps: count,
    },
    true,
  ),
  'staff.acted': event({
    action: z.enum(['muted', 'removed']),
    space_kind: spaceKind,
    actor_role: z.enum(['admin', 'professor', 'mentor']),
  }),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventProperties<E extends EventName> = z.input<
  (typeof EVENTS)[E]['schema']
>;
