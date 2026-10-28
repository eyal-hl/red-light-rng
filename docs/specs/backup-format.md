# Local backup format and restore (issue #72)

Status: implemented. Supersedes the unimplemented #43 design. No cloud, no account, no new OS permission.

## User behavior

Settings -> Data:

- **Export backup** shows a warning that the file contains precise location history, then opens the OS share/save sheet. The file goes only where the user sends it. A failed export never writes to the database (export is read-only).
- **Restore backup** picks a file, parses and validates all of it without any database write, then shows format version, creation date, source app/schema version and counts (places, routes/path variants, attempts, tracking sessions, GPS samples). Nothing changes until the user presses the separate button **Replace local data with this backup**. Restore is replace-only, never a merge.
- Restore is refused (before any mutation) while this device has an armed/active attempt or an active tracking session.

## File format (`backup_format_version` 1)

One UTF-8 JSON file, deterministic: keys sorted recursively, no whitespace, arrays in a fixed order (records by id; samples by session then time; reference points by sequence). Equal data is byte-identical.

```
{
  "format": "red-light-rng-backup",
  "backup_format_version": 1,        // product format, independent of SQLite user_version
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

Record fields use the database column names (`snake_case`). Nested: `routes[].reference_path[]`, `routes[].checkpoints[]`, `attempts[].crossings[]`.

### What is included

Every durable table and column: `place`, `tracking_session`, `location_sample`, `route` (path variants: archive `status`, `kind`, `cluster_signature`, `classification_version`, radiuses, progress, `source_recording_id`), `route_reference_point`, `route_checkpoint`, `attempt` (every persisted column including `hidden_incomplete`, `result_acknowledged`, `started_utc_offset_minutes`, `started_timezone_id`, `started_local_time_source`, journey identity via origin/destination/mode, reconciliation state), `attempt_checkpoint_crossing`, and the durable setting `active_transportation_mode`.

`BACKUP_SCHEMA_COVERAGE` in `src/persistence/backup-snapshot.ts` maps every schema column to its backup field; a test compares it with the migrated schema so a future column cannot be dropped silently.

### What is excluded

- `app_setting.path_variant_recompute_fingerprint` (recomputable cache key; restore clears it so discovery recomputes).
- OS permission state, secrets (none are stored), in-memory derived-view caches.

### Validation (all before any write)

Supported version; digest; exact field sets (unknown fields are rejected, so nothing can be silently dropped); types, enums, finite coordinates in range, non-negative finite millisecond timestamps (GPS-derived times may be fractional; device wall-clock session and attempt times are not ordered against each other, since a clock correction can move them backwards); unique ids (places, sessions, samples, routes, route source recordings, attempts, attempt sessions, checkpoint and crossing ids); every reference resolves (samples/attempts/routes -> sessions, attempts -> places/routes); attempt finish not before start; file counts equal the real counts.

### Versioning and migration

- A file with a newer `backup_format_version` than the app supports is rejected with an "update the app" message.
- Older versions are upgraded in memory by explicit adapters (`BACKUP_MIGRATIONS[n]` converts version `n` to `n + 1`), after the digest of the original file is verified and before validation. Adapters must be pure and deterministic. Version 1 is the first version, so the production registry is empty; the mechanism is covered by a synthetic legacy fixture test.
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
