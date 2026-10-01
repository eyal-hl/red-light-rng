import { DatabaseSync } from 'node:sqlite';

import {
  createSerializedSqlExecutor,
  type SqlStatementOps,
} from '../../src/persistence/serialized-sql-executor';
import type { SqlExecutor, SqlValue } from '../../src/persistence/sql-executor';

export function createNodeStatementOps(database: DatabaseSync): SqlStatementOps {
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
  };
}

export function createNodeSqlExecutor(database: DatabaseSync): SqlExecutor {
  return createSerializedSqlExecutor(createNodeStatementOps(database));
}

export function createMemorySqlExecutor(): SqlExecutor {
  return createNodeSqlExecutor(new DatabaseSync(':memory:'));
}
