# OMBrain SDLC

OMBrain is its own product and repository. Development happens on **omdev
(192.168.1.254)**. Releases are **versions**, not a copy of whatever happens
to be running on the dev host.

## Source of truth

| Item | Value |
|------|--------|
| Repository | [omrecords82/ombrain](https://github.com/omrecords82/ombrain) |
| Dev host | `192.168.1.254` (`omdev`) |
| Dev checkout | `/var/www/ombrain` |
| Runtime (service) | `/opt/om-brain` — `om-brain.service` |
| Runtime (console) | `/opt/om-brain-console` — `om-brain-console.service` |
| Env / secrets | `/etc/om-brain/` (never in git) |
| State | `/var/lib/om-brain` |

The copies under `omai/om-brain` and `omai/om-brain-console` are **parked**.
Do not treat them as the source of truth.

## Version model

- Semver: `MAJOR.MINOR.PATCH` in `package.json` and `VERSION`.
- Every shippable baseline is a **git tag** `vX.Y.Z`.
- `main` holds released / release-candidate history.
- `dev` is the integration branch for the current development sprint on `.254`.
- Feature work uses `feature|fix|chore/<id>/<yyyy-mm-dd>/<slug>` off `dev`.

## What we do **not** do

After this initial baseline, **do not promote the live `.254` working tree
to production**. Production (when it exists) installs a **tagged version**.

Wrong: rsync `/opt/om-brain` or a dirty `/var/www/ombrain` onto `.239`.
Right: `git checkout vX.Y.Z` then run the install/sync for that tag.

## Dev loop on `.254`

1. Work in `/var/www/ombrain` on `dev` or a task branch.
2. Commit and push to `origin`.
3. Install that checkout into the runtime dirs:

   ```bash
   sudo /var/www/ombrain/deploy/sync-runtime-on-dev.sh
   ```

4. When a sprint cut is ready: merge to `main`, bump `VERSION` /
   `package.json`, tag `vX.Y.Z`, push the tag.

## Baseline

`v1.0.0` is the extract from OMAI `origin/main` (`d1c9edc`, last om-brain
commit `e45ad64`). See `EXTRACT.md`.

## omdev runtime restart

`/var/lib/om-brain/brain.db` is multi-GB. Do **not** run `scripts/init-db.js`
as `ExecStartPre` on `.254`. Install `deploy/skip-init-db.conf` as
`/etc/systemd/system/om-brain.service.d/skip-init-db.conf`. Use
`deploy/sync-runtime-on-dev.sh --no-restart` when you only need to refresh
files.

## GitHub Actions

The inherited CI/deploy workflow lives at `deploy/ci-deploy.workflow.yml`.
It is not installed under `.github/workflows/` on this first push because
the available GitHub token lacks the `workflow` scope. Restore it when a
credential with that scope is available; do not auto-deploy from `.254`.
