import type { CourseLayout, RouteCheckpoint } from '../domain/course-layout';
import type { GeoZone, LatLng } from '../domain/geo';
import type { Route, TransportationMode } from '../domain/route';
import type { RouteStore } from './route-store';
import type { RouteCheckpointRow, RouteReferencePointRow, RouteRow } from './schema';
import type { SqlExecutor } from './sql-executor';

function mapRoute(row: RouteRow, referencePath: LatLng[], checkpoints: RouteCheckpoint[]): Route {
  const startZone: GeoZone = {
    center: { latitude: row.start_latitude, longitude: row.start_longitude },
    radiusMeters: row.start_radius_meters,
  };
  const finishZone: GeoZone = {
    center: { latitude: row.finish_latitude, longitude: row.finish_longitude },
    radiusMeters: row.finish_radius_meters,
  };
  return {
    id: row.id,
    name: row.name,
    transportationMode: row.transportation_mode as TransportationMode,
    createdAtMs: row.created_at_ms,
    sourceRecordingId: row.source_recording_id,
    referencePath,
    startZone,
    finishZone,
    startProgressMeters: row.start_progress_m,
    finishProgressMeters: row.finish_progress_m,
    checkpoints,
  };
}

export class SqliteRouteStore implements RouteStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async createRoute(route: Route): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      const existing = await sql.getFirst<{ id: string }>(
        'SELECT id FROM route WHERE source_recording_id = ?',
        [route.sourceRecordingId],
      );
      if (existing) {
        return;
      }
      await sql.run(
        `INSERT INTO route (
           id, name, transportation_mode, created_at_ms, source_recording_id,
           start_latitude, start_longitude, start_radius_meters,
           finish_latitude, finish_longitude, finish_radius_meters,
           start_progress_m, finish_progress_m
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          route.id,
          route.name,
          route.transportationMode,
          route.createdAtMs,
          route.sourceRecordingId,
          route.startZone.center.latitude,
          route.startZone.center.longitude,
          route.startZone.radiusMeters,
          route.finishZone.center.latitude,
          route.finishZone.center.longitude,
          route.finishZone.radiusMeters,
          route.startProgressMeters,
          route.finishProgressMeters,
        ],
      );
      for (const [index, point] of route.referencePath.entries()) {
        await sql.run(
          `INSERT INTO route_reference_point (route_id, seq, latitude, longitude) VALUES (?, ?, ?, ?)`,
          [route.id, index, point.latitude, point.longitude],
        );
      }
      await this.replaceCheckpoints(sql, route.id, route.checkpoints);
    });
  }

  async listRoutes(): Promise<Route[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<RouteRow>('SELECT * FROM route ORDER BY created_at_ms DESC');
    const routes: Route[] = [];
    for (const row of rows) {
      routes.push(
        mapRoute(row, await this.loadPath(sql, row.id), await this.loadCheckpoints(sql, row.id)),
      );
    }
    return routes;
  }

  async getRoute(routeId: string): Promise<Route | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<RouteRow>('SELECT * FROM route WHERE id = ?', [routeId]);
    if (!row) {
      return null;
    }
    return mapRoute(row, await this.loadPath(sql, routeId), await this.loadCheckpoints(sql, routeId));
  }

  async replaceCourseLayout(routeId: string, layout: CourseLayout): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      const existing = await sql.getFirst<{ id: string }>('SELECT id FROM route WHERE id = ?', [routeId]);
      if (!existing) {
        throw new Error(`Route not found: ${routeId}`);
      }
      await sql.run(
        `UPDATE route SET
           start_latitude = ?,
           start_longitude = ?,
           start_radius_meters = ?,
           finish_latitude = ?,
           finish_longitude = ?,
           finish_radius_meters = ?,
           start_progress_m = ?,
           finish_progress_m = ?
         WHERE id = ?`,
        [
          layout.startZone.center.latitude,
          layout.startZone.center.longitude,
          layout.startZone.radiusMeters,
          layout.finishZone.center.latitude,
          layout.finishZone.center.longitude,
          layout.finishZone.radiusMeters,
          layout.startProgressMeters,
          layout.finishProgressMeters,
          routeId,
        ],
      );
      await this.replaceCheckpoints(sql, routeId, layout.checkpoints);
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run('DELETE FROM route WHERE id = ?', [routeId]);
  }

  private async loadPath(sql: SqlExecutor, routeId: string): Promise<LatLng[]> {
    const points = await sql.getAll<RouteReferencePointRow>(
      'SELECT route_id, seq, latitude, longitude FROM route_reference_point WHERE route_id = ? ORDER BY seq ASC',
      [routeId],
    );
    return points.map((point) => ({ latitude: point.latitude, longitude: point.longitude }));
  }

  private async loadCheckpoints(sql: SqlExecutor, routeId: string): Promise<RouteCheckpoint[]> {
    const rows = await sql.getAll<RouteCheckpointRow>(
      'SELECT id, route_id, name, progress_m FROM route_checkpoint WHERE route_id = ? ORDER BY progress_m ASC, id ASC',
      [routeId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      progressMeters: row.progress_m,
    }));
  }

  private async replaceCheckpoints(
    sql: SqlExecutor,
    routeId: string,
    checkpoints: RouteCheckpoint[],
  ): Promise<void> {
    await sql.run('DELETE FROM route_checkpoint WHERE route_id = ?', [routeId]);
    for (const checkpoint of checkpoints) {
      await sql.run(
        `INSERT INTO route_checkpoint (id, route_id, name, progress_m) VALUES (?, ?, ?, ?)`,
        [checkpoint.id, routeId, checkpoint.name, checkpoint.progressMeters],
      );
    }
  }
}
