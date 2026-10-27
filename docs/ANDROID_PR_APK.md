# Android PR preview APK: provenance and update safety

Workflow: `.github/workflows/pr-android-apk.yml`. Logic and tests: `scripts/apk-provenance.mjs`, `tests/apk-provenance.test.ts`. Dry run (no network, EAS or keys): `npm run apk:dry-run`.

## What a PR build now guarantees

- Built from the explicit PR head commit (`checkout ref: pull_request.head.sha`), re-checked with `git rev-parse HEAD`. The synthetic merge SHA (`context.sha`) is never reported.
- The real APK is inspected before upload: package must be `com.redlightrng.app`, versionCode numeric, one signing certificate with an extractable SHA-256 (`aapt2 dump badging`, `apksigner verify --print-certs`). Anything wrong or unreadable fails the job: no upload, no comment.
- Artifact `red-light-rng-pr-<N>-android-preview-<sha12>` holds the APK and `apk-provenance.json` (SHA, package, versionCode, cert SHA-256; nonsecret only). Retention 14 days.
- Older artifacts of the same PR are deleted only after the new upload succeeded.
- The PR comment is skipped (warning only) if the PR head moved on during the build. Any later push supersedes the candidate.
- Update compatibility is never claimed.

## Versioning analysis (AC3): update compatibility NOT claimed

Source read: `eas-cli@26.0.0` (`npm pack eas-cli`), `build/android/version.js`, function `resolveRemoteVersionCodeAsync` (line 122), called from `build/android/build.js` line 50 for every Android build when `appVersionSource` is `remote`. The `--local` flag does not bypass it; local builds go through the same preparation and only skip the cloud build.

| State | autoIncrement off (preview) |
| --- | --- |
| Remote versionCode exists | `version.js:141-143` returns it; read-only. Every PR build gets the same code. |
| No remote versionCode | `version.js:144-148` calls `createAppVersionAsync`: a WRITE of the shared EAS version state. |
| autoIncrement on | `version.js:169` increments and writes the shared counter; parallel PRs race and mutate shared state. |

Consequences:

- Without autoIncrement the versionCode is the current remote value, identical for all PR builds. It is not monotonic per build and is not known to be newer than the installed app's code. Android refuses to install an APK whose versionCode is lower than the installed one, and same-code installs are not a guaranteed upgrade path.
- autoIncrement is forbidden by the spec (it mutates shared state, and parallel builds are not safe).
- The workflow therefore does not guess a code. It adds a read-only step (`eas build:version:get`) that fails the job if no remote versionCode exists, so the initialization write cannot be triggered by a PR build. The owner can initialize it deliberately with `eas build:version:set`.
- No deterministic, monotonic, non-mutating scheme was found, so the AC3 fallback applies: provenance and signature reporting only, `update compatibility NOT claimed`. The versionCode read from the APK is shown as information.

Open for an owner decision (not done here): a non-mutating scheme would need an explicit policy such as a local versionCode override derived from something monotonic; that changes `eas.json`/`app.json` semantics and was out of scope.

## One-time configuration

- GitHub secret `EXPO_TOKEN` (existing; never printed).
- Optional GitHub repository variable `EXPECTED_ANDROID_CERT_SHA256`: the nonsecret SHA-256 of the cert of the app installed on the owner's phone (64 hex, colons optional). If set and the APK matches, the comment says it matches the owner-supplied expected fingerprint. A mismatch fails the job. A malformed value also fails the job.
- Expo: an Android versionCode must already exist remotely for the preview profile (see above).

## Owner verification of the installed app

On a PC with adb and Android build-tools:

```
adb shell pm path com.redlightrng.app
adb pull <path printed above>/base.apk
apksigner verify --print-certs base.apk
```

Compare `certificate SHA-256 digest` with the value in the PR comment or `apk-provenance.json`. Do not test by overwriting your installed app or data; back up first.

## QA status ladder

1. APK built & inspected (CI; what this workflow proves).
2. Signature parity verified against installed app (owner step above, or variable match).
3. Safe update tested on Android (manual, needs a versionCode guarantee; not available today).
4. Human physical QA.

CI never claims items 2 to 4 unless stated. `npm run build` is an Expo JS export, not an APK.
