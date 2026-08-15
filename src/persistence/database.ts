import * as SQLite from 'expo-sqlite';

import { createExpoSqlExecutor } from './expo-sql-executor';
import { applyMigrations } from './migrations';
import type { SqlExecutor } from './sql-executor';

const DATABASE_NAME = 'red-light-rng.db';

let executorPromise: Promise<SqlExecutor> | null = null;

async function openSqlExecutor(): Promise<SqlExecutor> {
  const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
  const sql = createExpoSqlExecutor(database);
  await applyMigrations(sql);
  return sql;
}

export function getSqlExecutor(): Promise<SqlExecutor> {
  if (!executorPromise) {
    executorPromise = openSqlExecutor();
  }
  return executorPromise;
}
