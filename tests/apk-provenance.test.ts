import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import * as p from '../scripts/apk-provenance.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const MERGE = '2222222222222222222222222222222222222222';
const FP = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const FP_COLON = FP.toUpperCase().match(/../g)!.join(':');
const fx = (name: string) => readFileSync(join(__dirname, 'fixtures/apk', name), 'utf8');

const event = { number: 67, pull_request: { number: 67, head: { sha: HEAD }, merge_commit_sha: MERGE } };

const BADGING = fx('badging.txt');
const CERTS = fx('certs.txt');
const good = () => ({
  badging: p.parseBadging(BADGING),
  certs: p.parseCerts(CERTS),
  headSha: HEAD,
  checkedOutSha: HEAD,
  expectedFingerprint: '',
});

test('event SHA mapping uses PR head, never the merge commit', () => {
  assert.equal(p.resolveHeadSha(event), HEAD);
  assert.notEqual(p.resolveHeadSha(event), MERGE);
  assert.equal(p.resolvePrNumber(event), 67);
  assert.throws(() => p.resolveHeadSha({ pull_request: { head: { sha: 'abc' } } }));
  assert.throws(() => p.resolveHeadSha({}));
});

test('artifact name carries PR number and short SHA', () => {
  assert.equal(p.artifactName(67, HEAD), 'red-light-rng-pr-67-android-preview-111111111111');
});

test('superseded when PR head moved on', () => {
  assert.equal(p.isSuperseded(HEAD, HEAD.toUpperCase()), false);
  assert.equal(p.isSuperseded(HEAD, MERGE), true);
  assert.equal(p.isSuperseded(HEAD, undefined), true);
});

test('artifact pruning is prefix based, per PR, and keeps the new artifact', () => {
  const list = [
    { id: 1, name: 'red-light-rng-pr-67-android-preview' },
    { id: 2, name: 'red-light-rng-pr-67-android-preview-aaaaaaaaaaaa' },
    { id: 3, name: 'red-light-rng-pr-67-android-preview-111111111111' },
    { id: 4, name: 'red-light-rng-pr-670-android-preview-bbbbbbbbbbbb' },
    { id: 5, name: 'red-light-rng-pr-6-android-preview-cccccccccccc' },
    { id: 6, name: 'unrelated' },
  ];
  assert.deepEqual(p.selectArtifactsToDelete(list, 67, 3).map((a: { id: number }) => a.id), [2]);
});

test('parseBadging reads package, versionCode, versionName', () => {
  assert.deepEqual(p.parseBadging(BADGING), { packageName: 'com.redlightrng.app', versionCode: '7', versionName: '0.1.0' });
});

test('parseBadging does not confuse platformBuildVersionCode and handles missing fields', () => {
  const noVc = "package: name='com.redlightrng.app' platformBuildVersionCode='36' versionName='1'";
  assert.equal(p.parseBadging(noVc).versionCode, undefined);
  assert.deepEqual(p.parseBadging(''), { packageName: undefined, versionCode: undefined, versionName: undefined });
  assert.equal(p.parseBadging('garbage').packageName, undefined);
});

test('parseCerts reads one signer, tolerates colons, flags multi-signer and failure', () => {
  assert.deepEqual(p.parseCerts(CERTS).sha256, [FP]);
  const colon = `Signer #1 certificate SHA-256 digest: ${FP_COLON}`;
  assert.deepEqual(p.parseCerts(colon).sha256, [FP]);
  const other = 'f'.repeat(64);
  const multi = `${CERTS}Signer #2 certificate SHA-256 digest: ${other}\n`;
  assert.deepEqual(p.parseCerts(multi).sha256, [FP, other]);
  const dup = `${CERTS}Signer #2 certificate SHA-256 digest: ${FP}\n`;
  assert.deepEqual(p.parseCerts(dup).sha256, [FP]);
  assert.equal(p.parseCerts('DOES NOT VERIFY\nERROR: bad').verifyFailed, true);
  assert.deepEqual(p.parseCerts('').sha256, []);
});

test('fingerprint normalization and comparison', () => {
  assert.equal(p.normalizeFingerprint(FP_COLON), FP);
  assert.equal(p.fingerprintsMatch(FP_COLON, FP), true);
  assert.equal(p.fingerprintsMatch(FP, 'f'.repeat(64)), false);
  assert.equal(p.fingerprintsMatch('', ''), false);
  assert.equal(p.fingerprintsMatch('abc', 'abc'), false);
});

test('valid inspection has no errors', () => {
  assert.deepEqual(p.validate(good()), []);
});

test('fail-closed hard-fails', () => {
  const cases: Array<[string, (i: ReturnType<typeof good>) => void]> = [
    ['wrong package', (i) => { i.badging.packageName = 'com.example.other'; }],
    ['missing package', (i) => { i.badging = p.parseBadging(''); }],
    ['missing versionCode', (i) => { i.badging.versionCode = undefined; }],
    ['non-numeric versionCode', (i) => { i.badging.versionCode = 'abc'; }],
    ['no fingerprint', (i) => { i.certs = p.parseCerts(''); }],
    ['signature does not verify', (i) => { i.certs = p.parseCerts(`DOES NOT VERIFY\n${CERTS}`); }],
    ['multi-signer', (i) => { i.certs = p.parseCerts(`${CERTS}Signer #2 certificate SHA-256 digest: ${'f'.repeat(64)}\n`); }],
    ['sha mismatch (merge sha built)', (i) => { i.checkedOutSha = MERGE; }],
    ['sha unknown', (i) => { i.checkedOutSha = ''; }],
    ['expected fingerprint mismatch', (i) => { i.expectedFingerprint = 'f'.repeat(64); }],
    ['expected fingerprint malformed', (i) => { i.expectedFingerprint = 'nothex'; }],
  ];
  for (const [name, mutate] of cases) {
    const input = good();
    mutate(input);
    assert.ok(p.validate(input).length > 0, name);
  }
});

test('matching expected fingerprint (colons, any case) passes', () => {
  assert.deepEqual(p.validate({ ...good(), expectedFingerprint: FP_COLON }), []);
});

function comment(expected = '') {
  const g = good();
  const meta = p.buildMetadata({
    prNumber: 67, headSha: HEAD, artifact: p.artifactName(67, HEAD), apkFile: 'x.apk',
    badging: g.badging, certs: g.certs, expectedFingerprint: expected, runUrl: 'https://example.invalid/run/1',
  });
  return { meta, body: p.buildComment(meta) as string };
}

test('comment wording: required phrases, no update or data-preservation promise', () => {
  const { meta, body } = comment();
  assert.equal(meta.signature, 'unverified');
  assert.ok(body.includes('built & inspected; signature parity UNVERIFIED; update compatibility NOT claimed; safe-update and physical QA pending'));
  assert.ok(body.includes('SIGNATURE UNVERIFIED'));
  assert.ok(body.includes('adb shell pm path com.redlightrng.app'));
  for (const needle of [HEAD, meta.artifactName, 'com.redlightrng.app', '`7`', FP, 'https://example.invalid/run/1', 'supersedes']) {
    assert.ok(body.includes(needle), needle);
  }
  assert.ok(!/previously installed preview build/i.test(body));
  assert.ok(!/without wiping app data/i.test(body));
  assert.ok(!/expo export/i.test(body));
  assert.ok(!body.includes(MERGE));
});

test('with matching expected fingerprint only the signature clause changes', () => {
  const { meta, body } = comment(FP_COLON);
  assert.equal(meta.signature, 'matches-owner-supplied-expected-fingerprint');
  assert.ok(body.includes('matches owner-supplied expected fingerprint'));
  assert.ok(body.includes('update compatibility NOT claimed'));
  assert.ok(!body.includes('signature parity UNVERIFIED'));
  assert.ok(!/without wiping app data/i.test(body));
  assert.equal(meta.updateCompatibility, 'NOT claimed');
});

test('remote versionCode parsing is fail-closed', () => {
  assert.equal(p.parseRemoteVersionCode('{"versionCode":"12"}'), '12');
  assert.equal(p.parseRemoteVersionCode('{"versionCode":12}'), '12');
  assert.equal(p.parseRemoteVersionCode('{}'), undefined);
  assert.equal(p.parseRemoteVersionCode('not json'), undefined);
  assert.equal(p.parseRemoteVersionCode('{"versionCode":"x"}'), undefined);
});

function runCli(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const sink = { log: (m: string) => out.push(m), error: (m: string) => out.push(m) };
  const code = p.main(argv, env, sink) as number;
  return { code, out: out.join('\n') };
}

test('CLI verify writes metadata and comment files; hard-fail writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-prov-'));
  const evPath = join(dir, 'event.json');
  writeFileSync(evPath, JSON.stringify(event));
  const base = [
    'verify', '--event', evPath,
    '--badging', join(__dirname, 'fixtures/apk/badging.txt'),
    '--certs', join(__dirname, 'fixtures/apk/certs.txt'),
    '--run-url', 'https://example.invalid/run/1',
  ];
  const ok = runCli([...base, '--checked-out-sha', HEAD, '--out-dir', join(dir, 'out')]);
  assert.equal(ok.code, 0);
  const meta = JSON.parse(readFileSync(join(dir, 'out/apk-provenance.json'), 'utf8'));
  assert.equal(meta.headSha, HEAD);
  assert.equal(meta.versionCode, '7');
  assert.ok(readFileSync(join(dir, 'out/comment.md'), 'utf8').includes('update compatibility NOT claimed'));

  const bad = runCli([...base, '--checked-out-sha', MERGE, '--out-dir', join(dir, 'bad')]);
  assert.equal(bad.code, 1);
  assert.throws(() => readFileSync(join(dir, 'bad/comment.md')));

  const mismatch = runCli([...base, '--checked-out-sha', HEAD], { EXPECTED_ANDROID_CERT_SHA256: 'f'.repeat(64) });
  assert.equal(mismatch.code, 1);
  assert.ok(mismatch.out.includes('does NOT match'));

  const missing = runCli([...base, '--checked-out-sha', HEAD, '--badging', join(dir, 'nope.txt')]);
  assert.equal(missing.code, 1);
});

test('CLI check-checkout rejects the merge commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apk-prov-'));
  const evPath = join(dir, 'event.json');
  writeFileSync(evPath, JSON.stringify(event));
  assert.equal(runCli(['check-checkout', '--event', evPath, '--actual', HEAD]).code, 0);
  assert.equal(runCli(['check-checkout', '--event', evPath, '--actual', MERGE]).code, 1);
});
