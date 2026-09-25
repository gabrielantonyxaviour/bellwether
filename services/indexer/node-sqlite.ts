/**
 * SqlDriver on node:sqlite (Node ≥ 22.13, no native build). WAL lets the API read while the
 * indexer writes; integers come back as bigint so u64 amounts stay exact.
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import type { Row, SqlDriver, SqlValue } from "./sql-store.js"

export interface NodeSqliteDriver extends SqlDriver {
  close(): void
}

export function openNodeSqlite(path: string, options: { readOnly?: boolean } = {}): NodeSqliteDriver {
  if (path !== ":memory:" && !options.readOnly) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
  db.exec("PRAGMA busy_timeout = 5000")
  if (path !== ":memory:" && !options.readOnly) db.exec("PRAGMA journal_mode = WAL")
  const cache = new Map<string, StatementSync>()
  const prepare = (sql: string) => {
    let st = cache.get(sql)
    if (!st) {
      st = db.prepare(sql)
      st.setReadBigInts(true)
      cache.set(sql, st)
    }
    return st
  }
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params: SqlValue[] = []) => prepare(sql).all(...params) as Row[],
    run: (sql, params: SqlValue[] = []) => ({ changes: Number(prepare(sql).run(...params).changes) }),
    close: () => db.close(),
  }
}
