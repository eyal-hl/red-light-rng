// Pure provenance logic for the Android PR APK workflow, plus a small CLI the
// workflow calls. No network, no EAS, no keys: it only reads tool output text.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const EXPECTED_PACKAGE = 'com.redlightrng.app';
export const STATUS_LINE_UNVERIFIED =
  'built & inspected; signature parity UNVERIFIED; update compatibility NOT claimed; safe-update and physical QA pending';
export const STATUS_LINE_EXPECTED_MATCH =
  'built & inspected; signature matches owner-supplied expected fingerprint (installed app NOT compared); update compatibility NOT claimed; safe-update and physical QA pending';

const SHA_RE = /^[0-9a-f]{40}$/i;

/** The reviewed PR head commit. Never `context.sha`, which is the synthetic merge commit. */
export function resolveHeadSha(event) {
  const sha = event?.pull_request?.head?.sha;
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new Error('pull_request.head.sha missing or not a 40-hex commit SHA in event payload');
  }
  return sha.toLowerCase();
}

export function resolvePrNumber(event) {
  const n = event?.pull_request?.number;
  if (!Number.isInteger(n) || n <= 0) throw new Error('pull_request.number missing in event payload');
  return n;
}

export const shortSha = (sha) => sha.slice(0, 12);
export const artifactPrefix = (prNumber) => `red-light-rng-pr-${prNumber}-android-preview`;
export const artifactName = (prNumber, sha) => `${artifactPrefix(prNumber)}-${shortSha(sha)}`;

/** True when the PR head moved on since the build, so no "candidate" may be posted. */
export function isSuperseded(builtSha, currentHeadSha) {
  return typeof currentHeadSha !== 'string' || currentHeadSha.toLowerCase() !== String(builtSha).toLowerCase();
}

/** Artifact ids of older builds of this PR (prefix match; the new artifact is excluded). */
export function selectArtifactsToDelete(artifacts, prNumber, keepId) {
  const prefix = `${artifactPrefix(prNumber)}-`;
  return artifacts.filter((a) => a.id !== keepId && typeof a.name === 'string' && a.name.startsWith(prefix));
}

/** Parse `aapt2 dump badging` output. Missing fields come back undefined. */
export function parseBadging(text) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.startsWith('package:'));
  const out = { packageName: undefined, versionCode: undefined, versionName: undefined };
  if (!line) return out;
  const pick = (key) => new RegExp(`(?:^|\\s)${key}='([^']*)'`).exec(line)?.[1];
  out.packageName = pick('name');
  out.versionCode = pick('versionCode');
  out.versionName = pick('versionName');
  return out;
}

/** Lowercase hex without separators. */
export function normalizeFingerprint(value) {
  return String(value ?? '').replace(/[:\s]/g, '').toLowerCase();
}

export const isSha256Hex = (value) => /^[0-9a-f]{64}$/.test(normalizeFingerprint(value));

export function fingerprintsMatch(a, b) {
  return isSha256Hex(a) && isSha256Hex(b) && normalizeFingerprint(a) === normalizeFingerprint(b);
}

/**
 * Parse `apksigner verify -v --print-certs`: distinct SHA-256 signer digests, and whether it reported failure.
 * Any line with a "certificate SHA-256 digest:" label counts (any prefix such as `Signer #1` or
 * `Signer (minSdkVersion=24, ...)`, any indentation, CRLF). Source Stamp lines are not the signing identity
 * and are ignored. The digest value itself is strict: a non-hex value stays malformed and fails validate().
 */
export function parseCerts(text) {
  const src = String(text ?? '');
  const digests = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (/source\s*stamp/i.test(line)) continue;
    const label = /certificate SHA-256 digest:/i.exec(line);
    if (!label) continue;
    const fp = normalizeFingerprint(line.slice(label.index + label[0].length));
    if (!digests.includes(fp)) digests.push(fp);
  }
  return { sha256: digests, verifyFailed: /DOES NOT VERIFY/i.test(src) };
}

/** Parse `keytool -printcert -jarfile` output (fallback only): the `SHA256: AA:BB:...` fingerprint lines. */
export function parseKeytoolCerts(text) {
  const digests = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*SHA256:\s*(.*?)\s*$/i.exec(raw);
    if (!m) continue;
    const fp = normalizeFingerprint(m[1]);
    if (!digests.includes(fp)) digests.push(fp);
  }
  return { sha256: digests, verifyFailed: false };
}

/** Use keytool's digests only when apksigner produced none. Other checks still apply in validate(). */
export function selectCerts(apkCerts, keytoolCerts) {
  if (apkCerts.sha256.length > 0 || !keytoolCerts) return apkCerts;
  return { sha256: keytoolCerts.sha256, verifyFailed: apkCerts.verifyFailed };
}

/** Parse `eas build:version:get --json` output; undefined when no numeric remote versionCode. */
export function parseRemoteVersionCode(text) {
  try {
    const v = JSON.parse(String(text ?? '').trim()).versionCode;
    const s = typeof v === 'number' ? String(v) : v;
    return typeof s === 'string' && /^[1-9]\d*$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Fail-closed validation; every unreadable or wrong fact is a hard-fail error. */
export function validate({ badging, certs, headSha, checkedOutSha, expectedFingerprint }) {
  const errors = [];
  if (!badging || badging.packageName !== EXPECTED_PACKAGE) {
    errors.push(`APK package is ${JSON.stringify(badging?.packageName ?? null)}, expected ${EXPECTED_PACKAGE}`);
  }
  if (!badging || typeof badging.versionCode !== 'string' || !/^\d+$/.test(badging.versionCode)) {
    errors.push('APK versionCode is missing or non-numeric');
  }
  if (!certs || certs.verifyFailed) errors.push('apksigner reported the APK signature does not verify');
  const fps = certs?.sha256 ?? [];
  if (fps.length === 0) errors.push('APK signing certificate SHA-256 fingerprint could not be extracted');
  else if (fps.length > 1) errors.push(`APK has ${fps.length} distinct signing certificates; refusing to report a single identity`);
  else if (!isSha256Hex(fps[0])) errors.push('APK signing certificate fingerprint is malformed');
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) errors.push('PR head SHA is missing or malformed');
  if (typeof checkedOutSha !== 'string' || !SHA_RE.test(checkedOutSha) ||
      String(checkedOutSha).toLowerCase() !== String(headSha).toLowerCase()) {
    errors.push(`built source SHA ${checkedOutSha ?? '(unknown)'} does not equal PR head SHA ${headSha ?? '(unknown)'}`);
  }
  if (expectedFingerprint) {
    if (!isSha256Hex(expectedFingerprint)) {
      errors.push('EXPECTED_ANDROID_CERT_SHA256 is set but is not a SHA-256 fingerprint (64 hex digits, colons optional)');
    } else if (fps.length === 1 && !fingerprintsMatch(fps[0], expectedFingerprint)) {
      errors.push('APK signing certificate SHA-256 does NOT match EXPECTED_ANDROID_CERT_SHA256');
    }
  }
  return errors;
}

export function buildMetadata({ prNumber, headSha, artifact, apkFile, badging, certs, expectedFingerprint, runUrl }) {
  const apkSha256 = certs.sha256[0];
  const expectedMatch = Boolean(expectedFingerprint) && fingerprintsMatch(apkSha256, expectedFingerprint);
  return {
    schema: 1,
    prNumber,
    headSha,
    artifactName: artifact,
    apkFile,
    package: badging.packageName,
    versionCode: badging.versionCode,
    versionName: badging.versionName ?? null,
    certSha256: apkSha256,
    signature: expectedMatch ? 'matches-owner-supplied-expected-fingerprint' : 'unverified',
    updateCompatibility: 'NOT claimed',
    runUrl,
  };
}

export function buildComment(meta) {
  const matched = meta.signature === 'matches-owner-supplied-expected-fingerprint';
  const lines = [
    `Android preview APK candidate for PR head \`${meta.headSha}\`.`,
    '',
    `Status: ${matched ? STATUS_LINE_EXPECTED_MATCH : STATUS_LINE_UNVERIFIED}`,
    '',
    `- Source commit (PR head, not the merge commit): \`${meta.headSha}\``,
    `- Artifact: \`${meta.artifactName}\` (contains the APK and \`apk-provenance.json\`)`,
    `- Package: \`${meta.package}\``,
    `- versionCode (read from the APK): \`${meta.versionCode}\``,
    `- Signing certificate SHA-256: \`${meta.certSha256}\``,
    `- Run: ${meta.runUrl}`,
    '',
    'Any later push to this PR supersedes this candidate; only use the artifact whose SHA matches the current PR head.',
    '',
    'Checked by CI: the real APK package, versionCode and signing certificate, and that the build source equals the PR head SHA.',
    'Not checked by CI: whether this certificate or versionCode is compatible with any installed app. Installing over an existing app, data preservation and physical-device behaviour are untested.',
  ];
  if (!matched) {
    lines.push(
      '',
      'SIGNATURE UNVERIFIED. To compare with your installed app on a PC with adb and Android build-tools: ' +
        '`adb shell pm path com.redlightrng.app`, then `adb pull <path>/base.apk`, then `apksigner verify --print-certs base.apk`, ' +
        'and compare its SHA-256 value to the one above. Or set the repository variable `EXPECTED_ANDROID_CERT_SHA256`.',
    );
  }
  lines.push(
    '',
    'QA ladder: [x] APK built & inspected; [ ] signature parity verified against installed app; [ ] safe update tested on Android; [ ] human physical QA.',
  );
  return lines.join('\n');
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? '' : argv[++i];
  }
  return args;
}

const readText = (path) => readFileSync(path, 'utf8');

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function main(argv, env = process.env, log = console) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    if (command === 'resolve') {
      const event = JSON.parse(readText(args.event));
      const sha = resolveHeadSha(event);
      const pr = resolvePrNumber(event);
      log.log(`PR #${pr} head SHA ${sha}`);
      setOutput('head_sha', sha);
      setOutput('short_sha', shortSha(sha));
      setOutput('artifact_name', artifactName(pr, sha));
      setOutput('apk_file', `${artifactName(pr, sha)}.apk`);
      return 0;
    }
    if (command === 'check-checkout') {
      const sha = resolveHeadSha(JSON.parse(readText(args.event)));
      if (String(args.actual).toLowerCase() !== sha) {
        log.error(`::error::Checked-out HEAD ${args.actual} is not PR head ${sha}`);
        return 1;
      }
      return 0;
    }
    if (command === 'remote-version') {
      const code = parseRemoteVersionCode(readText(args.file));
      if (!code) {
        log.error('::error::No numeric remote Android versionCode found. A local EAS build without autoIncrement would then WRITE an initial remote version; refusing. Initialize it deliberately with "eas build:version:set" (owner decision).');
        return 1;
      }
      log.log(`Remote Android versionCode is ${code} (read-only; not modified by this workflow)`);
      return 0;
    }
    if (command === 'verify') {
      const event = JSON.parse(readText(args.event));
      const headSha = resolveHeadSha(event);
      const prNumber = resolvePrNumber(event);
      const badging = parseBadging(readText(args.badging));
      const apkCerts = parseCerts(readText(args.certs));
      // keytool is consulted only when apksigner printed no digest; a missing keytool file counts as no digest.
      const keytoolText = apkCerts.sha256.length === 0 && args.keytool
        ? (existsSync(args.keytool) ? readText(args.keytool) : '')
        : undefined;
      const certs = selectCerts(apkCerts, keytoolText === undefined ? undefined : parseKeytoolCerts(keytoolText));
      const expectedFingerprint = (env.EXPECTED_ANDROID_CERT_SHA256 ?? '').trim();
      const errors = validate({ badging, certs, headSha, checkedOutSha: args['checked-out-sha'], expectedFingerprint });
      if (errors.length) {
        for (const e of errors) log.error(`::error::${e}`);
        return 1;
      }
      const artifact = artifactName(prNumber, headSha);
      const meta = buildMetadata({
        prNumber, headSha, artifact, apkFile: `${artifact}.apk`, badging, certs, expectedFingerprint,
        runUrl: args['run-url'] || '(no run URL)',
      });
      const comment = buildComment(meta);
      if (args['out-dir']) {
        mkdirSync(args['out-dir'], { recursive: true });
        writeFileSync(join(args['out-dir'], 'apk-provenance.json'), JSON.stringify(meta, null, 2) + '\n');
        writeFileSync(join(args['out-dir'], 'comment.md'), comment + '\n');
      } else {
        log.log(JSON.stringify(meta, null, 2));
        log.log('\n--- PR comment ---\n' + comment);
      }
      log.log(`Verified ${meta.package} versionCode ${meta.versionCode}; signature ${meta.signature}; update compatibility NOT claimed`);
      return 0;
    }
    log.error('usage: apk-provenance.mjs resolve|check-checkout|remote-version|verify [--flag value ...]');
    return 2;
  } catch (err) {
    log.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
