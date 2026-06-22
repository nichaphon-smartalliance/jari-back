import { SQL } from "bun";

// Bun's built-in PostgreSQL client (porsager/postgres-compatible API:
// tagged templates, sql(obj) / sql(rows) inserts, sql.unsafe()).
const url =
  process.env.DATABASE_URL ?? "postgresql://postgres:smart2026@localhost:5432/jari_db";

// Cache the pool on globalThis so Bun's `--hot` reload reuses a single pool
// instead of opening a brand-new one on every file change. Without this, each
// reload leaks a pool and its connections accumulate on the server until
// Postgres refuses new ones ("sorry, too many clients already").
const globalForSql = globalThis as unknown as { __jariSql?: SQL };

const sql =
  globalForSql.__jariSql ??
  new SQL({
    url,
    max: 5, // small bounded pool — several dev instances share one Postgres
    idleTimeout: 20, // drop idle connections after 20s so they don't pile up
    connectionTimeout: 10, // fail fast if the DB is unreachable
  });

globalForSql.__jariSql = sql;

export default sql;
