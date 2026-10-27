export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  getFirst<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAll<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Optional: run `fn` against a separate, exclusive connection so that unrelated async queries on
   * the shared connection cannot interleave with it (expo-sqlite's plain transaction is not
   * isolated). Backup export/restore use it when available; see `runIsolated`.
   */
  withExclusiveTransaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Runs `fn` in an isolated transaction when the executor supports it, else in a normal one. */
export function runIsolated<T>(sql: SqlExecutor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  if (sql.withExclusiveTransaction) {
    return sql.withExclusiveTransaction(fn);
  }
  return sql.withTransaction(() => fn(sql));
}
