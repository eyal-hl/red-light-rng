import type { SQLiteDatabase } from 'expo-sqlite';

import { createSerializedSqlExecutor } from './serialized-sql-executor';
import type { SqlExecutor, SqlValue } from './sql-executor';

export function createExpoSqlExecutor(database: SQLiteDatabase): SqlExecutor {
  return createSerializedSqlExecutor({
    exec: (sql) => database.execAsync(sql),
    run: async (sql, params: SqlValue[] = []) => {
      await database.runAsync(sql, ...params);
    },
    getFirst: async <T>(sql: string, params: SqlValue[] = []) => {
      const row = await database.getFirstAsync<T>(sql, ...params);
      return row ?? null;
    },
    getAll: <T>(sql: string, params: SqlValue[] = []) => database.getAllAsync<T>(sql, ...params),
  });
}
