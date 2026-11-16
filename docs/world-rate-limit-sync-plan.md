# World rate-limit synchronization plan

## Outcome

Close an over-budget socket immediately instead of silently dropping a frame,
so predicted client movement cannot remain out of sync with server state.

## TDD

1. Require the first frame beyond the burst budget to return `close`.
2. Verify the current implementation fails by returning `drop`.
3. Remove silent dropping and make the regression pass.

## Verification

```sh
pnpm --filter world exec vitest run src/socket/frame-budget.spec.ts
pnpm --filter world test
pnpm --filter world build
pnpm --filter world lint
```

Restart `world` after deployment. No migration is required.
