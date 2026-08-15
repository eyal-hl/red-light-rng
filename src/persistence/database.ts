import * as SQLite from 'expo-sqlite';

import { LOCATION_SPIKE_SCHEMA } from './schema';

const DATABASE_NAME = 'red-light-rng.db';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await database.execAsync('PRAGMA foreign_keys = ON;');
  await database.execAsync(LOCATION_SPIKE_SCHEMA);
  return database;
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openDatabase();
  }
  return databasePromise;
}
