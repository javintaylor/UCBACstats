# UCBACstats source mirror

UCBACstats.com uses Google Sites and Google Apps Script, backed by Google Sheets. This repository is a sanitized code mirror for review and collaboration; Apps Script is the source authority. GitHub does not host or deploy the live portal.

## Source coverage and provenance

Read-only `clasp clone` captures made October 10, 2026 using the owner's existing authorization:

- Root `.js` / `.html` files and `appsscript.json` (also `src/` in source-mirror.zip): current editor source, 55 files (including Apps Script manifest).
- `snapshots/v221/` inside source-mirror.zip: immutable Apps Script version 221, 53 files. The production deployment was verified as version 221 during the same day's investigation.
- Editor adds DailySummaryAppAdapter.js and DailySummaryAppRuntime.js. Advertising.js, AppPublicRefreshAdapter.js and appsscript.json differ from v221. Do not treat editor HEAD as deployed production.
- Each packaged directory's manifest.json lists file coverage, byte counts, SHA-256 hashes of sanitized files and whether sanitization changed the file.

Production IDs, folder IDs, email contacts, coach seed contacts, historical player merge/cleanup datasets and player-specific comments are removed or replaced. All executable source files remain represented. Empty private dataset arrays deliberately disable those historical operations in this mirror. Secrets are retrieved by production code from Script Properties; no property values, database exports, account records, birthdays, sessions or credentials were collected. This is not a deployable production configuration.

The Google Sites page configuration/content is not included: this capture covers its Apps Script backend and HTML frontend, including embedded assets. Site ownership and page editing remain in Google Sites.

## Repeatable update workflow

1. Use an existing authorized `clasp` installation. Do not add credentials or expand OAuth permissions without owner approval.
2. Capture into a new private directory outside this checkout: `clasp -P . clone "$UCBAC_SCRIPT_ID"`. Use the locally supplied production script ID, never the backup-bound script (it also uses the production database).
3. Determine the live deployment version read-only (`clasp deployments` / Apps Script Manage deployments). Capture that exact version separately: `clasp -P . clone "$UCBAC_SCRIPT_ID" "$LIVE_VERSION"` in another new directory.
4. Run `python3 prepare_snapshot.py /absolute/private/editor-capture /absolute/staging/src` and again for the deployed version into staging `snapshots/vNNN`. It only reads local captures and writes sanitized local output. It does not upload or deploy.
5. Review EVERY staged source change before copying to this checkout. The sanitizer is a starting point, not a proof of safety: newly embedded datasets or new secret formats require manual removal. Check emails, DOB values, account/player fixtures, tokens, private IDs, URLs with credentials and large hardcoded arrays. Keep private captures outside Git and never upload them.
6. Compare inventories/hashes, update this provenance section, replace `src/` with the reviewed snapshot, and retain immutable version snapshots. Review `git diff --stat`, `git diff`, and `git status --short`; run syntax checks with `node --check` on JavaScript files. No application functions should be executed against production.
7. Commit the reviewed files and push normally to this repository using existing authorized access. Fetch remote HEAD and verify commit SHA plus file coverage. If remote work changed concurrently, preserve it and reconcile before pushing. Never force-push.
8. Give the exact Claude UCBACstats (DOT) session the new commit link and ask it to fetch that commit and verify manifest counts. A private link alone does not demonstrate access.

No automatic synchronization or production deployment is configured. Repeat this process after every approved Apps Script change to prevent drift. Never run `clasp push`, version creation, deployment commands, or database functions as part of mirror updates.

The source-mirror.zip package preserves the full directory structure, tooling and both versions. Root manifest.json describes the editor files. SOURCE-SNAPSHOT.txt is the current editor code as a single text attachment for Claude.
