export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  getFirst<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAll<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /**
   * Run `fn` on this connection with other executor calls waiting outside it.
   * Statements inside `fn` must use the provided handle so they stay in the
   * open transaction instead of queueing behind it.
   */
  withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
