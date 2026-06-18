import { SQL } from "bun";

// Bun's built-in PostgreSQL client (porsager/postgres-compatible API:
// tagged templates, sql(obj) / sql(rows) inserts, sql.unsafe()).
const sql = new SQL(
  process.env.DATABASE_URL ?? "postgresql://postgres:smart2026@localhost:5432/jari_db",
);

export default sql;
