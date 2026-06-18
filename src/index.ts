import { Hono } from "hono";
import { cors } from "hono/cors";
import { initSchema } from "./db/schema";
import dataRoutes from "./routes/data";
import syncRoutes from "./routes/sync";
import createRoutes from "./routes/create";
import actionRoutes from "./routes/actions";
import worklogRoutes from "./routes/worklog";
import aiRoutes from "./routes/ai";
import authRoutes from "./routes/auth";

// Boot even if the DB is unreachable (e.g. dev without Postgres) — endpoints
// that hit the DB will surface the error per-request instead of crashing boot.
try {
  await initSchema();
} catch (err) {
  console.warn("[init] schema init failed (continuing):", String(err));
}

const app = new Hono();

app.use("*", cors());
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ ok: false, error: String(err) }, 500);
});

app.get("/health", (c) => c.json({ ok: true, service: "jari-api" }));

app.route("/", authRoutes);
app.route("/", dataRoutes);
app.route("/", syncRoutes);
app.route("/", createRoutes);
app.route("/", actionRoutes);
app.route("/", worklogRoutes);
app.route("/", aiRoutes);

const port = Number(process.env.PORT ?? 4000);
console.log(`Jari API running on http://localhost:${port}`);

export default { port, fetch: app.fetch };
