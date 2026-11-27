import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import type { CompetitiveCheckpoint } from '../src/domain/competitive-checkpoint';
import { sha256Hex } from '../src/domain/sha256';
import {
  BackupError,
  BACKUP_MIGRATIONS,
  canonicalStringify,
  CURRENT_BACKUP_FORMAT_VERSION,
  parseBackup,
  type BackupErrorCode,
} from '../src/persistence/backup-format';
import { BACKUP_SCHEMA_COVERAGE, exportBackup, readBackupSnapshot } from '../src/persistence/backup-snapshot';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteCompetitiveCheckpointStore } from '../src/persistence/sqlite-competitive-checkpoint-store';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { restoreBackupPayload, terminalizeRestoredLiveState } from '../src/product/backup-restore';
import type { AttemptSegmentResult } from '../src/domain/segment-derivation';
import {
  BASE_MS,
  baseAttempt,
  dumpDatabase,
  HOME,
  openMigratedDb,
  seedRepresentativeHistory,
  seedSession,
  WORK,
} from './helpers/backup-fixtures';
import { offsetLatLng } from './helpers/samples';

const POOL = { originPlaceId: HOME.id, destinationPlaceId: WORK.id, transportationMode: 'scooter' as const };
const NOW = BASE_MS + 9_000_000;

function cp(id: string, north: number, radiusMeters = 20): CompetitiveCheckpoint {
  const center = offsetLatLng(HOME.center.latitude, HOME.center.longitude, north, 0);
  return { id, name: id.toUpperCase(), center, radiusMeters };
}

function resign(document: Record<string, unknown>): string {
  const { integrity: _ignored, ...body } = document;
  return canonicalStringify({
    ...body,
    integrity: { algorithm: 'sha256', digest: sha256Hex(canonicalStringify(body)) },
  });
}

async function expectBackupError(run: () => unknown, code: BackupErrorCode) {
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => {
      assert.ok(error instanceof BackupError, `expected BackupError, got ${String(error)}`);
      assert.equal(error.code, code, error.message);
      return true;
    },
  );
}

/** Representative history plus two configuration versions, a partial attempt and derived results. */
async function seedCompetitiveHistory(sql: SqlExecutor): Promise<void> {
  await seedRepresentativeHistory(sql);
  const places = await new SqlitePlaceStore(async () => sql).listPlaces();
  const checkpoints = new SqliteCompetitiveCheckpointStore(async () => sql);
  const attempts = new SqliteAttemptStore(async () => sql);
  await checkpoints.saveConfig({ pool: POOL, checkpoints: [cp('b', 500)], places, nowMs: BASE_MS + 1 });
  await checkpoints.saveConfig({ pool: POOL, checkpoints: [cp('b', 500, 25), cp('b2', 700)], places, nowMs: BASE_MS + 2 });

  await seedSession(sql, {
    id: 's-partial',
    startedAtMs: BASE_MS + 100_000,
    stoppedAtMs: BASE_MS + 200_000,
    purpose: 'attempt',
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });
  const partial: Attempt = baseAttempt({
    id: 'attempt-partial',
    sessionId: 's-partial',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    armedAtMs: BASE_MS + 100_000,
    startedAtMs: BASE_MS + 110_000.5,
    finishedAtMs: BASE_MS + 150_000.25,
    kind: 'partial',
    startCheckpointId: 'b',
    checkpointConfigVersion: 2,
  });
  await attempts.saveAttempt(partial);

  const rows = (attemptId: string): AttemptSegmentResult[] => [
    {
      id: `${attemptId}:v2:C:b>F`,
      attemptId,
      configVersion: 2,
      derivationVersion: 1,
      fromCheckpointId: 'b',
      toCheckpointId: null,
      status: 'valid',
      unavailableReason: null,
      startedAtMs: BASE_MS + 110_000.5,
      endedAtMs: BASE_MS + 150_000.25,
      durationMs: 39_999.75,
      derivedAtMs: NOW,
    },
    {
      id: `${attemptId}:v2:C:b>C:b2`,
      attemptId,
      configVersion: 2,
      derivationVersion: 1,
      fromCheckpointId: 'b',
      toCheckpointId: 'b2',
      status: 'unavailable',
      unavailableReason: 'gap_too_large',
      startedAtMs: null,
      endedAtMs: null,
      durationMs: null,
      derivedAtMs: NOW,
    },
  ];
  await checkpoints.replaceSegmentResults([
    { attemptId: 'attempt-partial', configVersion: 2, results: rows('attempt-partial') },
    // A stale result computed for version 1 of the full attempt: kept, identified by its version.
    {
      attemptId: 'attempt-complete',
      configVersion: 1,
      results: [{ ...rows('attempt-complete')[0]!, id: 'attempt-complete:v1:C:b>F', configVersion: 1 }],
    },
  ]);
}

describe('backup format 3: competitive checkpoints and partial attempts (#81)', () => {
  it('declares format 3 and maps every new column in the coverage map', () => {
    assert.equal(CURRENT_BACKUP_FORMAT_VERSION, 3);
    assert.equal(BACKUP_SCHEMA_COVERAGE.attempt!.kind, 'attempts[].kind');
    assert.equal(BACKUP_SCHEMA_COVERAGE.attempt!.start_checkpoint_id, 'attempts[].start_checkpoint_id');
    assert.equal(BACKUP_SCHEMA_COVERAGE.attempt!.checkpoint_config_version, 'attempts[].checkpoint_config_version');
    for (const table of ['competitive_checkpoint_config', 'competitive_checkpoint', 'attempt_segment_result']) {
      assert.ok(BACKUP_SCHEMA_COVERAGE[table], `${table} must be covered (DEC-013)`);
    }
    assert.ok(BACKUP_MIGRATIONS[2], 'a 2 -> 3 adapter exists');
  });

  it('round-trips configurations, partial attempts and segment results byte-for-byte', async () => {
    const source = await openMigratedDb();
    await seedCompetitiveHistory(source);
    const exported = await exportBackup(source, { nowMs: NOW, appVersion: '0.1.0' });
    const document = JSON.parse(exported.text);
    assert.equal(document.backup_format_version, 3);
    assert.equal(document.counts.competitive_checkpoint_configs, 2);
    assert.equal(document.counts.competitive_checkpoints, 3);
    assert.equal(document.counts.attempt_segment_results, 3);
    const configs = document.payload.competitive_checkpoint_configs;
    assert.deepEqual(configs.map((c: any) => [c.version, c.status]), [[1, 'superseded'], [2, 'current']]);
    assert.deepEqual(configs[1].checkpoints.map((c: any) => c.checkpoint_id), ['b', 'b2'], 'route order kept');
    const partial = document.payload.attempts.find((a: any) => a.id === 'attempt-partial');
    assert.equal(partial.kind, 'partial');
    assert.equal(partial.start_checkpoint_id, 'b');
    assert.equal(partial.checkpoint_config_version, 2);
    assert.equal(partial.started_at_ms, BASE_MS + 110_000.5, 'fractional official times preserved');

    const parsed = parseBackup(exported.text);
    assert.equal(parsed.preview.migratedFromVersion, null);
    const target = await openMigratedDb();
    await restoreBackupPayload(target, parsed.payload);
    const original = await dumpDatabase(source);
    const restored = await dumpDatabase(target);
    const byId = (rows: unknown[]) =>
      [...rows].sort((a: any, b: any) => String(a.id ?? a.config_id).localeCompare(String(b.id ?? b.config_id)));
    for (const table of ['competitive_checkpoint_config', 'attempt_segment_result', 'attempt']) {
      assert.deepEqual(byId(restored[table]!), byId(original[table]!), `${table} restored exactly`);
    }
    assert.deepEqual(restored.competitive_checkpoint!.length, 3);
    assert.equal((await exportBackup(target, { nowMs: NOW, appVersion: '0.1.0' })).text, exported.text);
  });

  it('restoring replaces competitive data instead of merging it', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const parsed = parseBackup((await exportBackup(source, { nowMs: NOW, appVersion: '0.1.0' })).text);
    const target = await openMigratedDb();
    await seedCompetitiveHistory(target);
    await restoreBackupPayload(target, parsed.payload);
    const after = await dumpDatabase(target);
    assert.deepEqual(after.competitive_checkpoint_config, []);
    assert.deepEqual(after.competitive_checkpoint, []);
    assert.deepEqual(after.attempt_segment_result, []);
    assert.equal((after.attempt as any[]).every((row) => row.kind === 'full'), true);
  });

  it('imports an older format 2 backup: legacy attempts become full with no checkpoint data', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const current = JSON.parse((await exportBackup(source, { nowMs: NOW, appVersion: '0.1.0' })).text);
    const legacy = structuredClone(current);
    legacy.backup_format_version = 2;
    legacy.source.schema_version = 13;
    delete legacy.payload.competitive_checkpoint_configs;
    legacy.payload.attempts = legacy.payload.attempts.map((attempt: Record<string, unknown>) => {
      const { kind: _k, start_checkpoint_id: _s, checkpoint_config_version: _c, segment_results: _r, ...rest } = attempt;
      return rest;
    });
    delete legacy.counts.competitive_checkpoint_configs;
    delete legacy.counts.competitive_checkpoints;
    delete legacy.counts.attempt_segment_results;
    const legacyText = resign(legacy);

    const parsed = parseBackup(legacyText);
    assert.equal(parsed.preview.formatVersion, 2);
    assert.equal(parsed.preview.migratedFromVersion, 2);
    assert.deepEqual(parsed.payload.competitive_checkpoint_configs, []);
    assert.deepEqual(parsed.payload.attempts, current.payload.attempts);
    assert.ok(parsed.payload.attempts.every((a) => a.kind === 'full' && a.start_checkpoint_id == null && a.segment_results.length === 0));

    // Tampering is still caught by the ORIGINAL file's integrity check.
    await expectBackupError(() => parseBackup(legacyText.replace('Home', 'Hxme')), 'checksum_mismatch');
    // A format-2 file may not smuggle in new-format fields.
    const smuggled = structuredClone(legacy);
    smuggled.payload.attempts[0].kind = 'partial';
    await expectBackupError(() => parseBackup(resign(smuggled)), 'invalid_structure');

    const target = await openMigratedDb();
    await restoreBackupPayload(target, parsed.payload);
    const sourceDump = await dumpDatabase(source);
    const restoredDump = await dumpDatabase(target);
    const byId = (rows: unknown[]) => [...rows].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(byId(restoredDump.attempt!), byId(sourceDump.attempt!));
    assert.equal(restoredDump.location_sample!.length, sourceDump.location_sample!.length);
  });

  it('rejects inconsistent competitive data before any write', async () => {
    const source = await openMigratedDb();
    await seedCompetitiveHistory(source);
    const text = (await exportBackup(source, { nowMs: NOW, appVersion: '0.1.0' })).text;
    const mutate = (change: (payload: Record<string, any>) => void) => {
      const document = JSON.parse(text);
      change(document.payload);
      return resign(document);
    };
    const partialIndex = (payload: Record<string, any>) => payload.attempts.findIndex((a: any) => a.kind === 'partial');

    await expectBackupError(
      () => parseBackup(mutate((p) => { p.attempts[partialIndex(p)].start_checkpoint_id = 'ghost'; })),
      'broken_reference',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.attempts[partialIndex(p)].checkpoint_config_version = 9; })),
      'broken_reference',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.attempts[partialIndex(p)].start_checkpoint_id = null; })),
      'invalid_structure',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.attempts.find((a: any) => a.kind === 'full').start_checkpoint_id = 'b'; })),
      'invalid_structure',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.competitive_checkpoint_configs[0].status = 'current'; })),
      'duplicate_id',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.competitive_checkpoint_configs[1].checkpoints[0].radius_meters = 300; })),
      'invalid_structure',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.competitive_checkpoint_configs[1].origin_place_id = 'nowhere'; })),
      'broken_reference',
    );
    await expectBackupError(
      () => parseBackup(mutate((p) => { p.competitive_checkpoint_configs[1].checkpoints[1].checkpoint_id = 'b'; })),
      'duplicate_id',
    );
    const withResult = (change: (result: Record<string, any>) => void) =>
      mutate((p) => change(p.attempts.find((a: any) => a.id === 'attempt-partial').segment_results.find((r: any) => r.status === 'valid')));
    await expectBackupError(() => parseBackup(withResult((r) => { r.duration_ms = null; })), 'invalid_structure');
    await expectBackupError(
      () => parseBackup(withResult((r) => { r.from_checkpoint_id = null; r.to_checkpoint_id = null; })),
      'invalid_structure',
    );
    await expectBackupError(() => parseBackup(withResult((r) => { r.status = 'maybe'; })), 'invalid_structure');
    await expectBackupError(() => parseBackup(withResult((r) => { r.surprise = 1; })), 'invalid_structure');
    // Counts must match the contents.
    const wrongCounts = JSON.parse(text);
    wrongCounts.counts.attempt_segment_results = 99;
    await expectBackupError(() => parseBackup(resign(wrongCounts)), 'count_mismatch');
  });

  it('a restored open partial attempt is never trusted as live: it becomes a labeled partial non-result', async () => {
    const sql = await openMigratedDb();
    await seedCompetitiveHistory(sql);
    await seedSession(sql, {
      id: 's-open',
      startedAtMs: BASE_MS + 500_000,
      stoppedAtMs: null,
      isActive: true,
      purpose: 'attempt',
      captureOutcome: 'active',
      reviewDisposition: 'pending',
    });
    await new SqliteAttemptStore(async () => sql).saveAttempt(
      baseAttempt({
        id: 'open-partial',
        sessionId: 's-open',
        originPlaceId: HOME.id,
        destinationPlaceId: WORK.id,
        lifecycle: 'active',
        validity: 'pending',
        armedAtMs: BASE_MS + 500_000,
        startedAtMs: BASE_MS + 501_000,
        kind: 'partial',
        startCheckpointId: 'b',
        checkpointConfigVersion: 2,
      }),
    );
    const { payload, report } = terminalizeRestoredLiveState(await readBackupSnapshot(sql));
    const restored = payload.attempts.find((a) => a.id === 'open-partial')!;
    assert.equal(restored.lifecycle, 'ended');
    assert.equal(restored.validity, 'unranked');
    assert.equal(restored.kind, 'partial');
    assert.equal(restored.start_checkpoint_id, 'b');
    assert.equal(restored.finished_at_ms, null);
    assert.deepEqual(restored.segment_results, []);
    assert.ok(report.attempts.some((a) => a.attemptId === 'open-partial' && a.outcome === 'incomplete'));
    // And it can be written back and re-exported.
    const target = await openMigratedDb();
    await restoreBackupPayload(target, payload);
    assert.equal(
      ((await dumpDatabase(target)).attempt as any[]).find((row) => row.id === 'open-partial').lifecycle,
      'ended',
    );
  });
});
