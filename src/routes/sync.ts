import { Hono } from "hono";
import sql from "../db/client";
import { syncIssues, syncWorklogs } from "../services/jiraSync";

const sync = new Hono();

sync.get("/sync/status", async (c) => {
  const workspaces = await sql`SELECT id, name, last_synced_at FROM workspaces ORDER BY id`;
  const issueCounts = await sql`SELECT workspace_id, COUNT(*)::int AS count FROM issues GROUP BY workspace_id`;
  const wlogCounts = await sql`SELECT workspace_id, COUNT(*)::int AS count FROM worklogs GROUP BY workspace_id`;
  return c.json({ workspaces, issueCounts, wlogCounts });
});

sync.post("/sync/issues", async (c) => c.json({ ok: true, results: await syncIssues() }));

sync.post("/sync/worklogs", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  return c.json({ ok: true, results: await syncWorklogs(days) });
});

sync.post("/sync", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const [issues, worklogs] = await Promise.all([syncIssues(), syncWorklogs(days)]);
  return c.json({ ok: true, issues, worklogs });
});

export default sync;
