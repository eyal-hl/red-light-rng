import { clonePlace, type Place } from '../domain/place';
import type { PlaceStore } from './place-store';
import { PlaceInUseError } from './place-store';
import type { SqlExecutor } from './sql-executor';

type PlaceRow = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Legacy single-radius column (pre v12). Mirrors the departure radius; never read for timing. */
  radius_meters: number;
  departure_radius_meters: number;
  arrival_radius_meters: number;
  status: string;
  created_at_ms: number;
};

function mapPlace(row: PlaceRow): Place {
  return {
    id: row.id,
    name: row.name,
    center: { latitude: row.latitude, longitude: row.longitude },
    departureRadiusMeters: row.departure_radius_meters,
    arrivalRadiusMeters: row.arrival_radius_meters,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAtMs: row.created_at_ms,
  };
}

export class SqlitePlaceStore implements PlaceStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async createPlace(place: Place): Promise<void> {
    const sql = await this.getSql();
    await sql.run(
      `INSERT INTO place (id, name, latitude, longitude, radius_meters,
                          departure_radius_meters, arrival_radius_meters, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        place.id,
        place.name,
        place.center.latitude,
        place.center.longitude,
        place.departureRadiusMeters,
        place.departureRadiusMeters,
        place.arrivalRadiusMeters,
        place.status,
        place.createdAtMs,
      ],
    );
  }

  async savePlace(place: Place): Promise<void> {
    const sql = await this.getSql();
    await sql.run(
      `UPDATE place
       SET name = ?, latitude = ?, longitude = ?, radius_meters = ?,
           departure_radius_meters = ?, arrival_radius_meters = ?, status = ?
       WHERE id = ?`,
      [
        place.name,
        place.center.latitude,
        place.center.longitude,
        place.departureRadiusMeters,
        place.departureRadiusMeters,
        place.arrivalRadiusMeters,
        place.status,
        place.id,
      ],
    );
  }

  async getPlace(placeId: string): Promise<Place | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<PlaceRow>('SELECT * FROM place WHERE id = ?', [placeId]);
    return row ? clonePlace(mapPlace(row)) : null;
  }

  async listPlaces(): Promise<Place[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<PlaceRow>(
      'SELECT * FROM place ORDER BY created_at_ms ASC, id ASC',
    );
    return rows.map((row) => clonePlace(mapPlace(row)));
  }

  async listActivePlaces(): Promise<Place[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<PlaceRow>(
      `SELECT * FROM place WHERE status = 'active' ORDER BY created_at_ms ASC, id ASC`,
    );
    return rows.map((row) => clonePlace(mapPlace(row)));
  }

  async archivePlace(placeId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run(`UPDATE place SET status = 'archived' WHERE id = ?`, [placeId]);
  }

  async deletePlace(placeId: string): Promise<void> {
    const sql = await this.getSql();
    if (await this.isPlaceReferenced(placeId)) {
      throw new PlaceInUseError(placeId);
    }
    await sql.run('DELETE FROM place WHERE id = ?', [placeId]);
  }

  async isPlaceReferenced(placeId: string): Promise<boolean> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ id: string }>(
      `SELECT id FROM attempt
       WHERE origin_place_id = ? OR destination_place_id = ?
       LIMIT 1`,
      [placeId, placeId],
    );
    return row != null;
  }
}
