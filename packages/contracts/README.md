# @campus/contracts

What campus-api and world must agree on, defined once. If both services have
to read or write a value, key, claim or channel the same way, it belongs here;
if only one service needs it, it belongs in that service.

It began with the session token and has grown into the rest of the contract:
the rules, keys and channel names that would be a security or protocol bug if
the two copies drifted.

## What belongs here

- **Session tokens** (`src/session-token.ts`): `SessionScope`,
  `SessionClaims`, `SessionTokenSettings`, `signSessionToken`,
  `verifySessionToken` and `InvalidSessionTokenError`. campus-api mints and
  verifies a token; world verifies it on socket upgrade.
- **Session lifetimes** (`src/session-policy.ts`):
  `MAX_ACCESS_TOKEN_TTL_MINUTES`, `SESSION_REFRESH_SLACK_SECONDS`,
  `MIN_SESSION_REFRESH_WINDOW_SECONDS`, `RefreshTokenLiveness` and
  `isRefreshTokenLive`. campus-api caps the access-token TTL and checks a
  refresh; world keeps a socket open for the sign-in behind it.
- **System roles** (`src/system-role.ts`): `SystemRole` and
  `hasAdminPowers`, so "who is an admin" has one answer.
- **Sprites and profile changes** (`src/profile.ts`): `SPRITE_KEYS`,
  `SpriteKey`, `spriteKeyOrNone` and `PROFILE_CHANGED_CHANNEL`.
- **The default space** (`src/spaces.ts`): `DEFAULT_SPACE_KEY`.
- **Desk changes** (`src/desks.ts`): `DESKS_CHANGED_CHANNEL`.
- **Notification pushes** (`src/notifications.ts`):
  `NOTIFICATION_CREATED_CHANNEL` and `NotificationCreated`.

The test for "does this belong here" is one line: if both services must read
or write it the same way, it belongs here; if one service can own it, it does
not.

## What does not belong here

- A rule only one service needs: it belongs in campus-api or world.
- A dependency only one service would otherwise carry, or anything heavy:
  keep this package small and dependency-free apart from the JWT library.
- App code: HTTP routes, Nest or Fastify wiring, database access, Redis
  clients, sockets, LiveKit or PostHog.
- `@campus/media`: LiveKit is its own contract and has its own package.

## Building and testing

The package ships compiled output, so an app that depends on it needs it built
first. The root scripts do that through each app's `...` filter:

```bash
pnpm build:api      # builds @campus/contracts and the rest of campus-api's deps
pnpm build:world    # builds @campus/contracts and the rest of world's deps
pnpm --filter @campus/contracts build   # this package alone
pnpm --filter @campus/contracts test    # its own tests
```

Tests resolve the package from source in each app's vitest config, so a test
run does not depend on a build.
