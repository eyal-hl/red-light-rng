export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  getFirst<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAll<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
