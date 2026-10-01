import type { SqlExecutor, SqlValue } from './sql-executor';

export type SqlStatementOps = {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  getFirst<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  getAll<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
};

/**
 * One queue for every statement on this connection.
 *
 * expo-sqlite `withTransactionAsync` is a non-exclusive `BEGIN` on the shared
 * connection: another statement can run between awaits, and a second `BEGIN`
 * plus its `ROLLBACK` ends the first transaction. Holding the queue for a whole
 * transaction keeps a backup snapshot coherent and lets a GPS write wait instead
 * of aborting the export or landing inside it.
 */
export function createSerializedSqlExecutor(ops: SqlStatementOps): SqlExecutor {
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const direct: SqlExecutor = {
    exec: (sql) => ops.exec(sql),
    run: (sql, params) => ops.run(sql, params ?? []),
    getFirst: (sql, params) => ops.getFirst(sql, params ?? []),
    getAll: (sql, params) => ops.getAll(sql, params ?? []),
    withTransaction: (fn) => fn(direct),
  };

  return {
    exec: (sql) => enqueue(() => ops.exec(sql)),
    run: (sql, params) => enqueue(() => ops.run(sql, params ?? [])),
    getFirst: (sql, params) => enqueue(() => ops.getFirst(sql, params ?? [])),
    getAll: (sql, params) => enqueue(() => ops.getAll(sql, params ?? [])),
    withTransaction: (fn) =>
      enqueue(async () => {
        await ops.exec('BEGIN');
        try {
          const result = await fn(direct);
          await ops.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            await ops.exec('ROLLBACK');
          } catch {
            // The original error is the one callers handle.
          }
          throw error;
        }
      }),
  };
}
