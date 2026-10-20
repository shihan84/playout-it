# Branch Protection & Merge Governance

Owner action required — these are GitHub **repository settings**; nothing in
the repo can enable them. CODEOWNERS alone does **not** enforce approvals.
Apply via **Settings → Branches → Add branch ruleset** (or *Branch protection
rule*) for `main`.

## Required CI check names (exact)

The `validate` job in `.github/workflows/security-ci.yml` runs these steps —
required status checks must reference the **job** name:

| GitHub check name | What it runs |
|---|---|
| `validate` | `npm ci` → `npm run lint` (tsc) → `npx tsx --test tests/security-regression.test.ts` → `npx tsx --test tests/*.test.ts` → `npm run build` |

When adding a required status check, select **`validate`** (the job). Do not
require individual step names — GitHub reports at job level.

## Pending CI improvement (owner apply — needs `workflow` scope)

The automation token cannot push workflow edits, so this addition is **not**
in this PR's diff. A ready-to-apply patch ships at
`docs/patches/security-ci-npm-audit.patch`:

```bash
git checkout main && git pull
git apply docs/patches/security-ci-npm-audit.patch
git add .github/workflows/security-ci.yml
git commit -m "ci: add npm audit gate to validate job" && git push
```

It adds two lines after the Build step:

```diff
       - name: Build
         run: npm run build
+      - name: Dependency vulnerabilities
+        run: npm audit --audit-level=high
```

After applying, the `validate` job also gates on `npm audit`.

## Recommended ruleset for `main`

| Setting | Value |
|---|---|
| Require a pull request before merging | **On** |
| Required approvals | **1** |
| Require review from Code Owners | **On** |
| Dismiss stale pull request approvals when new commits are pushed | **On** |
| Require approval of the most recent reviewable push | **On** |
| Require status checks to pass before merging | **On** — required check: `validate` |
| Require branches to be up to date before merging | **On** |
| Require conversation resolution before merging | **On** |
| Allowed merge methods | Merge commit (or owner preference); **disable auto-merge** unless explicitly authorized |
| Block force pushes | **On** |
| Block deletions | **On** |
| Require signed commits | Optional (recommended if contributors sign) |
| Restrict who can push to matching branches | **On** — restrict to `@shihan84` only if collaborators should open PRs instead of pushing; otherwise leave unrestricted so the PR flow works |
| Do not allow bypassing the above settings (ruleset "bypass" / "Do not allow bypassing") | **On** — prevents administrators and automation from bypassing |
| Allow force pushes for admins | **Off** |

## Enforcement caveats

- **Free GitHub plan + private repo:** code-owner review requirement,
  branch rulesets and some protections are only fully available on public
  repos or paid plans. On a private free repo, classic *branch protection
  rules* still cover the essentials (PR required, approvals, status checks,
  force-push/delete blocks) — verify what the Settings page offers.
- **CODEOWNERS scope:** `.github/CODEOWNERS` marks `@shihan84` as owner of
  `*` (everything). Enforcement only happens when *Require review from
  Code Owners* is enabled; otherwise it is informational.
- **Auto-merge:** leave repository *Allow auto-merge* **off** so a green CI
  cannot silently merge while a review is pending.
- **Admin bypass:** with classic branch protection, *"Do not allow
  bypassing the above settings"* (or ruleset enforcement set to *Active*
  with no bypass actors) must be enabled, otherwise repo admins can still
  merge/push directly.

## Verification (do NOT test by attempting an unauthorized merge)

After enabling, verify on a throwaway PR that:
1. The merge button is blocked until `validate` passes.
2. The merge button is blocked until `@shihan84` approves.
3. A new push after approval re-requests review (stale dismissal).
4. `git push --force` to `main` is rejected.
