import { DatabaseSync } from 'node:sqlite';

import type { SqlExecutor, SqlValue } from '../../src/persistence/sql-executor';

export function createNodeSqlExecutor(database: DatabaseSync): SqlExecutor {
  return {
    async exec(sql: string) {
      database.exec(sql);
    },
    async run(sql: string, params: SqlValue[] = []) {
      database.prepare(sql).run(...params);
    },
    async getFirst<T>(sql: string, params: SqlValue[] = []) {
      const row = database.prepare(sql).get(...params);
      return (row as T | undefined) ?? null;
    },
    async getAll<T>(sql: string, params: SqlValue[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async withTransaction<T>(fn: () => Promise<T>) {
      database.exec('BEGIN');
      try {
        const result = await fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function createMemorySqlExecutor(): SqlExecutor {
  return createNodeSqlExecutor(new DatabaseSync(':memory:'));
}
