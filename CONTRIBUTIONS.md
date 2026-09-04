# Contributing

## Branches

| Branch                              | Purpose                                       | Merges via    |
| ----------------------------------- | --------------------------------------------- | ------------- |
| `main`                              | Production. Tagged releases.                  | PR from `dev` |
| `dev`                               | Default branch. Staging. Branch from here.    | Squashed PRs  |
| `feat/*` `fix/*` `chore/*` `docs/*` | Branch out for Your work with this convention | PR into `dev` |

Nobody pushes directly to `dev` or `main`, branch off dev then create a pr

## Who approves

**Only the two repo admins.** Approvals from anyone else do not unblock a merge but they are still useful, but the merge button stays grey until an
admin approves.

GitHub blocks approving your own PR, so when one admin opens a PR the other admin
must approve it.

## Naming

```
feat/checkout-retry
fix/PROJ-412-null-session
chore/bump-deps
docs/api-auth
```

Lowercase, hyphens, ticket ID where you have one.

## Daily flow

```bash
git checkout dev && git pull
git checkout -b feat/your-thing

# work, commit

git push -u origin feat/your-thing
gh pr create --base dev
```

Four things must be true to merge:

1. CI passes
2. An admin has approved
3. All review comments resolved
4. Branch is up to date with `dev` — click **Update branch** if prompted

Then **Squash merge**. Your branch auto-deletes.

## Keeping your branch fresh

```bash
git checkout dev && git pull
git checkout feat/your-thing
git rebase dev
git push --force-with-lease
```

`--force-with-lease`, please don't use just force `--force`.

## PR titles

The squash-merge title becomes the commit on `dev`, so the **PR title** is the
thing that matters:

```
feat: add retry to checkout
fix: handle null session on refresh
chore: update dependency version
docs: document auth flow
```

## PR size

Please try and avoid large PRs, to avoid confusion.

## Releases (admins)

1. Open a PR `dev` → `main`, titled `Release v1.4.0`
2. One admin approval — the other admin, since you can't approve your own
3. **Merge commit**,
4. Tag it:

```bash
git checkout main && git pull
git tag -a v1.4.0 -m "Release v1.4.0"
git push origin v1.4.0
```

## Hotfixes (admins)

Production is broken for some reason and `dev` isn't ready

```bash
git checkout main && git pull
git checkout -b fix/urgent-thing
# fix, commit, push
then create pr to main
```

After it merges, **back-merge immediately**:

```bash
git checkout dev && git pull
git merge main
git push          # this will need a PR; open one titled "chore: back-merge main"
```

Skipping the back-merge is how `dev` and `main` drift apart until a release
becomes a conflict-resolution exercise. Do not skip it.

## Environments

- `dev` → **staging**
- `main` → **production**
