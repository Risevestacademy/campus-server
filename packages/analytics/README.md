# @campus/analytics

Product events to PostHog. The only code that knows PostHog exists for events;
errors go through `@campus/error-reporting`.

```ts
analytics.track(
  'invite.sent',
  admin.id,
  { role: 'student', via: 'single' },
  { cohortId, correlationId },
);
```

Call it on the line after the transaction resolves, in the service that owns
the change. A refused or failed change sends nothing, and analytics can never
fail a request: `track` queues the event and never throws.

## Adding an event

Add it to `EVENTS` in `src/events.ts`. Fields are enums, numbers, booleans and
UUIDs only, and `events.spec.ts` fails if any field would admit an email, a URL
or free text. An event that fails its schema at runtime is dropped, and the log
line names the event and the field, never the value.

## Who an event is about

- The distinct id is always `users.id`.
- `trackAnonymous` is for an event with no known person, such as a failed
  sign-in: a random id, and PostHog makes no person from it.
- An event marked as needing consent goes out de-identified unless the caller
  passes `consented: true`: the session's stand-in id instead of `users.id`, and
  no person.
- A cohort is a PostHog group rather than a person property, because a person
  can belong to several at once. PostHog links no group to an event without a
  person, so every event also carries `cohort_id`: count by that property, not
  the group, when a total has to include de-identified events.
- A correlation id is sent only if it is a UUID, which is what the services
  generate. A caller can send anything, so any other one is left off.

## Tests

`@campus/analytics/testing` has `createTestAnalytics()`: the real validation,
with lists in place of PostHog.
