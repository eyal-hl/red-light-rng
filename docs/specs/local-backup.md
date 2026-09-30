# Local backup format

Versioned portable backup for Red Light RNG. This is a durability file, not cloud sync. The app does not upload it.

## Envelope

Current writers emit `backup_format_version` **2**. Version **1** remains readable and migrates into the version 2 record shape before restore. A higher version is rejected with no database changes.

```text
backup_format_version
created_at_ms
source_schema_version          SQLite user_version at export, informational
source_app_version             app version string, informational
counts                         places, routes, attempts, tracking_sessions, location_samples, settings
integrity.algorithm            "sha256"
integrity.payload_sha256       SHA-256 hex of the canonical JSON for `records`
records
```

`payload_sha256` covers `records` only. Canonical JSON sorts object keys, preserves array order, and uses compact JSON primitives. Declared counts must match the arrays. A truncated file fails JSON parsing or the hash check before any local row is deleted.

The SQLite database file is not the backup contract. Restore writes the current schema columns after the backup migrates to the current format.

## Version 1

Supported predecessor. `active_transportation_mode` is a top-level string. `records` has places, routes, tracking sessions, location samples, and attempts. Route archive/kind/signature/classification and attempt hide, acknowledgement, stored local-start, and reconciliation fields may be absent. Migration fills:

- settings `[{ key: "active_transportation_mode", value }]`
- route `status: "active"`, `kind: "explicit"`, `cluster_signature: null`, `classification_version: 1` when omitted
- attempt `result_acknowledged: false`, `hidden_incomplete: false`, null local-start fields, `reconciliation_status: "pending"`, `reconciliation_version: 0`, and `crossings: []` when omitted

Present values are kept.

## Version 2 records

Journey identity is not a separate collection. It is `origin_place_id + destination_place_id + transportation_mode` on attempts.

Included:

- places, including archive state and radius
- routes/path variants, including name, archive status, kind, cluster signature, classification version, checkpoints, reference geometry, detection zones, and `source_recording_id`
- tracking sessions and location samples those records reference
- attempts, including lifecycle, validity, timing, `hidden_incomplete`, `result_acknowledged`, `started_utc_offset_minutes`, `started_timezone_id`, `started_local_time_source`, reconciliation fields, and checkpoint crossings
- durable product settings. Today that is `active_transportation_mode`

Excluded:

- OS permission state, including `background_permission_confirmed`
- `path_variant_recompute_fingerprint` and other recomputable cache keys
- in-memory derived-view caches
- secrets or token-like setting keys

Unknown object fields are ignored when they cannot change the meaning of known fields. Unknown setting keys are not imported.

## Restore

V1 restore is replace, not merge. The file is parsed and validated with no writes. The preview shows creation time, format version, and counts for places, routes, attempts, and GPS samples. The user must confirm `Replace local data with this backup`.

Restore is refused, with the current database left unchanged, while this device has an open attempt or an `is_active` tracking session.

On commit, the product tables are replaced inside one SQL transaction. A failure rolls the transaction back. Restored open attempts are terminalized from stored place-timing evidence: a trustworthy official start and finish stays a completed result; otherwise the attempt becomes an inspectable `ended` DID NOT START or DID NOT FINISH, not `abandoned`. Restored `is_active` sessions are cleared. Finished route-creation recordings that were already inactive may stay pending review. Restore does not treat `isUpdating()` as proof that a restored row is a live OS task, and it stops leftover location updates before the restored history is shown.

After commit, in-memory Home and journey caches are dropped. Derived analytics are recomputed from the restored source rows. Archived path variants stay archived.
