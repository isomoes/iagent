# Release prompt

Cut a new release of iagent. Follow this exactly; it matches how `0.1.1` was released.

## How releases work (context)

A release is driven entirely by pushing a `vX.Y.Z` git tag. The two GitHub Actions
(`.github/workflows/`) run as a **chained pipeline**:

- **publish.yml** (triggered by the tag) — stamps `packages/cli` version from the tag
  (`vX.Y.Z` → `X.Y.Z`), runs `bun run typecheck`, then `npm publish --provenance` of
  `@isomoes/iagent` via npm OIDC **trusted publishing** (no `NPM_TOKEN`). The publish runs
  `prepack` (`bun run build.ts`) to produce `dist/`.
- **release.yml** (triggered by publish.yml completing via `workflow_run`, **not** the tag) —
  only runs if the publish **succeeded**; extracts the `## X.Y.Z` block from `CHANGELOG.md`
  and cuts a GitHub Release with it as the body. A failed publish therefore leaves no Release.

So the agent's job is only: bump versions, write the changelog section, commit, tag, push.

## Steps

Let `X.Y.Z` be the new version (decide the bump from the commits: feat → minor, fix/chore/docs → patch).

1. **Find the baseline.** The last release is the top `## a.b.c` heading in `CHANGELOG.md`.
   List commits since it:
   ```
   git log <last-version-hash>..HEAD --pretty=format:'%h %an %s'
   ```
   (The bottom entry of each changelog section carries its commit hash — use it as the range start.)

2. **Bump every package version** from the old version to `X.Y.Z`. There are 5 files, all must match:
   - `package.json` (workspace root)
   - `packages/cli/package.json`   (`@isomoes/iagent` — the published one)
   - `packages/client/package.json`
   - `packages/server/package.json`
   - `packages/shared/package.json`

3. **Add a `## X.Y.Z` section to `CHANGELOG.md`** directly above the previous version section.
   Format per line: `- <type>: <commit message> (@who) <hash>`, newest commit first.
   Map the emoji prefix of each commit to a type:
   `✨ feat` · `🐛 fix` · `📝 docs` · `🔧 chore` · `👷 ci` · `🔒 security` · `♻️ refactor` · `⚡ perf` · `✅ test`.
   Strip the emoji from the message text. Skip purely-mechanical commits if noise (use judgement).

4. **Gate on typecheck** (publish.yml will fail otherwise):
   ```
   bun run typecheck
   ```

5. **Commit** all the above together:
   ```
   git add -A
   git commit -m "🔖 Release X.Y.Z"
   ```

6. **Tag** (annotated) and **push** the commit then the tag:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm** both workflows started:
   ```
   gh run list --limit 5
   ```
   Optionally `gh run watch <id>` and report any failure (common ones: trusted-publishing not
   configured on npmjs for this workflow, or the `## X.Y.Z` changelog section missing/misnamed).

## If a release needs to be re-cut (publish failed after tag push)

Because release.yml chains off a *successful* publish, a failed Publish leaves only the tag —
no GitHub Release, and nothing on npm (`npm view @isomoes/iagent versions` to confirm). Easiest
recovery is to bump to the next patch and release again (a skipped npm version number is fine).
If you instead want to reuse the same version, fix the cause, then move the tag onto the fix:
```
git commit ...                                       # the fix
git push origin :vX.Y.Z && git tag -d vX.Y.Z         # drop remote + local tag
git tag -a vX.Y.Z -m vX.Y.Z                          # re-tag on the fixed commit
git push origin main && git push origin vX.Y.Z       # re-triggers publish → release
```

## Notes

- Don't run `npm publish` locally — publishing is the workflow's job via OIDC.
- publish.yml stamps the cli version with `npm pkg set version` (a pure JSON edit). Do **not**
  use `npm version` there — it reconciles the dep tree and dies with `EUNSUPPORTEDPROTOCOL` on the
  `workspace:*` devDeps (npm can't resolve Bun's workspace protocol run standalone in packages/cli).
- The cli version is re-stamped from the tag in CI, but still bump it in-repo so the tree is consistent.
- One-time npm setup (already done for `@isomoes/iagent`): Package settings → Trusted publishing →
  repo `isomoes/iagent`, workflow `.github/workflows/publish.yml`, blank environment.
