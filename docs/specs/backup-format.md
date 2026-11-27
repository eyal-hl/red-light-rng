# Local backup format and restore (issue #72)

Status: implemented. Supersedes the unimplemented #43 design. No cloud, no account, no new OS permission.

## User behavior

Settings -> Data:

- **Export backup** shows a warning that the file contains precise location history, then opens the OS share/save sheet. The file goes only where the user sends it. A failed export never writes to the database (export is read-only).
- **Restore backup** picks a file, parses and validates all of it without any database write, then shows format version, creation date, source app/schema version and counts (places, routes/path variants, attempts, tracking sessions, GPS samples). Nothing changes until the user presses the separate button **Replace local data with this backup**. Restore is replace-only, never a merge.
- Restore is refused (before any mutation) while this device has an armed/active attempt or an active tracking session.

## File format (`backup_format_version` 3)

One UTF-8 JSON file, deterministic: keys sorted recursively, no whitespace, arrays in a fixed order (records by id; samples by session then time; reference points by sequence). Equal data is byte-identical.

```
{
  "format": "red-light-rng-backup",
  "backup_format_version": 3,        // product format, independent of SQLite user_version
  "created_at_ms": 1700000000000,
  "created_at_utc": "2023-11-14T22:13:20.000Z",
  "source": { "app_version": "0.1.0", "schema_version": 11 },   // informational only
  "counts": { places, routes, attempts, tracking_sessions, location_samples,
              route_reference_points, route_checkpoints, attempt_checkpoint_crossings, settings },
  "payload": { places[], tracking_sessions[], location_samples[], routes[], attempts[], settings{} },
  "integrity": { "algorithm": "sha256", "digest": "<64 hex>" }
}
```

`integrity.digest` is SHA-256 of the canonical serialization of the whole document without the `integrity` member (version, timestamps, source, counts and payload are all covered). Truncation and corruption are detected either as unreadable JSON or as a digest mismatch. The digest is implemented in dependency-free TypeScript (`src/domain/sha256.ts`).

Record fields use the database column names (`snake_case`). Nested: `routes[].reference_path[]`, `routes[].checkpoints[]`, `attempts[].crossings[]`, `attempts[].segment_results[]`, `competitive_checkpoint_configs[].checkpoints[]` (array order is the route order).

### What is included

Every durable table and column: `place`, `tracking_session`, `location_sample`, `route` (path variants: archive `status`, `kind`, `cluster_signature`, `classification_version`, radiuses, progress, `source_recording_id`), `route_reference_point`, `route_checkpoint`, `attempt` (every persisted column including the #81 `kind`, `start_checkpoint_id` and `checkpoint_config_version`, `hidden_incomplete`, `result_acknowledged`, `started_utc_offset_minutes`, `started_timezone_id`, `started_local_time_source`, journey identity via origin/destination/mode, reconciliation state), `attempt_checkpoint_crossing`, the competitive checkpoint tables `competitive_checkpoint_config` / `competitive_checkpoint` (every immutable configuration version, current and superseded) and `attempt_segment_result` (derived segment results, including `unavailable` rows and results of older configuration versions, which stay identifiable as stale by `config_version`), and the durable setting `active_transportation_mode`.

`BACKUP_SCHEMA_COVERAGE` in `src/persistence/backup-snapshot.ts` maps every schema column to its backup field; a test compares it with the migrated schema so a future column cannot be dropped silently.

### What is excluded

- The manual history-recalculation tables `recalc_job` and `recalc_job_item` (schema v13; v15 adds the job `kind` / `scope_json` and `staged_segments_json` columns for the #81 segment recalculation, which are excluded the same way; job, staging and checkpoint state of issue #77). They are local operational state, not user-authored history: they only exist to resume or atomically publish a user-started batch on this device, and a staged result is meaningless on another device or after the Places change. They are never exported, and a restore deletes every row of both tables inside the same atomic transaction (and verifies they are empty), so an orphaned or in-progress job can never survive a restore and half-committed results cannot be restored. Published results live in `attempt` / `attempt_checkpoint_crossing`, which are exported like any other history. `BACKUP_SCHEMA_COVERAGE` lists their columns as explicitly excluded. Backups from every earlier format still import unchanged.
- `app_setting.path_variant_recompute_fingerprint` (recomputable cache key; restore clears it so discovery recomputes).
- OS permission state, secrets (none are stored), in-memory derived-view caches.

Competitive checkpoints and partial attempts (#81, DEC-016) are part of the portable history: a restored partial attempt keeps its `kind`, start checkpoint and configuration version, and a restored configuration keeps its version history, so derived results restored with it still match their definition.

### Validation (all before any write)

Supported version; digest; exact field sets (unknown fields are rejected, so nothing can be silently dropped); types, enums, finite coordinates in range, non-negative finite millisecond timestamps (GPS-derived times may be fractional; device wall-clock session and attempt times are not ordered against each other, since a clock correction can move them backwards); unique ids (places, sessions, samples, routes, route source recordings, attempts, attempt sessions, checkpoint and crossing ids); every reference resolves (samples/attempts/routes -> sessions, attempts -> places/routes, configurations -> places, a partial attempt -> an existing checkpoint of an existing configuration version of its own pool); full attempts carry no checkpoint reference, partial attempts must; at most one current configuration per pool and unique pool versions; checkpoint radius 8-250 m; a valid segment result has times and an unavailable one a reason, none duplicates the official start->finish pair; attempt finish not before start; file counts equal the real counts.

### Versioning and migration

- A file with a newer `backup_format_version` than the app supports is rejected with an "update the app" message.
- Older versions are upgraded in memory by explicit adapters (`BACKUP_MIGRATIONS[n]` converts version `n` to `n + 1`), after the digest of the original file is verified and before validation. Adapters must be pure and deterministic. Version 1 -> 2 (#77) replaces each place's single `radius_meters` with `departure_radius_meters` and `arrival_radius_meters`; a format-1 place gets its old radius in both, so pre-feature backups import with unchanged behavior. Format-1 places that already carry the new fields (or format-2 places that carry the old one) fail validation. The legacy SQLite `place.radius_meters` column is not exported.
- Version 2 -> 3 (#81) adds `attempts[].kind`, `start_checkpoint_id`, `checkpoint_config_version`, `attempts[].segment_results[]` and `payload.competitive_checkpoint_configs[]`. A format-2 attempt becomes a legacy `full` attempt with no checkpoint reference or segment results, and a format-2 payload has no configurations. A format-2 file that already carries any of the new fields fails validation. Segment results are derived data that can always be recomputed from the raw samples, but they are exported so an upgrade or device move does not require a re-run of the manual recalculation.
- Restore never trusts a backed-up armed/active **partial** attempt as live: it is replayed with the partial (checkpoint-start) engine against the configuration version stored on the attempt and the journey destination from the backup. A trustworthy start and finish keeps a completed partial result; anything else (or a missing configuration) becomes an `ended` partial non-result with no official times. Partial attempts are never path-reconciled.
- A future format that changes the integrity scheme must keep verifying older files before migrating them.

## Export consistency

All tables are read inside one transaction. On Android/iOS the executor provides `withExclusiveTransaction` (expo-sqlite `withExclusiveTransactionAsync`, a separate isolated connection) so unrelated async queries on the shared connection cannot interleave. Export is read-only.

## Restore semantics

One atomic transaction on the isolated connection: re-check no live attempt/session, wipe every user table, insert the validated payload (multi-row statements), `PRAGMA foreign_key_check`, compare table counts with the file. Any error rolls back to the exact original database.

Restored live state is never trusted as live (`terminalizeRestoredLiveState`, pure and deterministic):

- Formerly ARMED/ACTIVE attempts are replayed through the same place-timing engine used by `AttemptRuntime.endAndInspect` on their stored samples. A trustworthy official start + finish keeps a true `completed` result (reconciliation `pending`, so path assignment is recomputed on startup). Otherwise the attempt becomes an inspectable `ended` incomplete (DID NOT START / DID NOT FINISH), acknowledged so it does not pop up, never hidden `abandoned`.
- `is_active` tracking sessions are terminalized (attempt sessions from the attempt outcome; an unfinished route recording becomes `interrupted` + `pending` review, as tracker recovery does). The stop time is derived from the backup's own samples, not the clock.
- After commit the app stops any leftover OS location updates, invalidates all derived-view caches, then runs attempt reconciliation and path-variant recomputation from the restored raw data. Archived path variants stay archived; repeating the restore of the same file yields the same database.

## Limitations

- The whole file is held in memory (parse + hash); very large histories are slower on low-end devices.
- A restore stops OS location updates only through the existing tracker boundary; physical-device behavior is unverified (see below).
- iOS is unvalidated (no physical iPhone), same as the rest of the app.

## Safe physical QA procedure (owner)

Never run a destructive restore against the only copy of real history.

1. Use a disposable install: either a separate test install of the signed PR APK, or the owner's install after a **verified separate backup**. Verify a backup by exporting it, saving it outside the app (e.g. cloud drive or computer), and confirming the file opens and the restore *preview* shows the expected counts. Do this before anything destructive.
2. Create disposable data: two places, one short recorded attempt, optionally one path variant. Archive a discovered path variant if one exists.
3. Export. Confirm the warning about precise location history appears before the share sheet. Save the file.
4. Make a visible change (add a place, delete an attempt, switch the transportation mode), then Restore the file. Confirm the preview (version, date, counts) before pressing **Replace local data with this backup**. Confirm the changes are undone, the archived variant is still archived, hidden incomplete attempts are still hidden, and Home/statistics match the pre-export screenshots.
5. Restore the same file a second time and confirm nothing is duplicated.
6. Negative checks: START an attempt, open Settings -> Restore backup, pick the file, and confirm it is refused with no change; pick a truncated or edited copy of the file and confirm it is rejected with no change.
7. Backup taken during an armed attempt: restore it on the disposable install and confirm no tracking notification appears, START still works, and the old run shows as an incomplete (or completed, if it truly finished) attempt.
