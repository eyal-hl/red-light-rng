import type { SQLiteDatabase } from 'expo-sqlite';

import type { SqlExecutor, SqlValue } from './sql-executor';

export function createExpoSqlExecutor(database: SQLiteDatabase): SqlExecutor {
  return {
    async exec(sql: string) {
      await database.execAsync(sql);
    },
    async run(sql: string, params: SqlValue[] = []) {
      await database.runAsync(sql, ...params);
    },
    async getFirst<T>(sql: string, params: SqlValue[] = []) {
      const row = await database.getFirstAsync<T>(sql, ...params);
      return row ?? null;
    },
    async getAll<T>(sql: string, params: SqlValue[] = []) {
      return database.getAllAsync<T>(sql, ...params);
    },
    async withTransaction<T>(fn: () => Promise<T>) {
      let result: T | undefined;
      await database.withTransactionAsync(async () => {
        result = await fn();
      });
      return result as T;
    },
  };
}
