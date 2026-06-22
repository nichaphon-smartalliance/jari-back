import { Hono } from "hono";
import { getWorkspace } from "../services/workspaces";
import { createWorklog } from "../services/jira";
import { recordWorklogLocal } from "../services/jiraSync";
import { computeDaily, getWorklogCandidates } from "../services/aggregate";

const worklog = new Hono();

// Done sub-tasks assigned to me with no worklog yet (feature #4).
worklog.get("/worklog/candidates", async (c) => {
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "accountId required" }, 400);
  return c.json({ issues: await getWorklogCandidates(accountId) });
});

interface CreateWorklogBody {
  workspaceId?: string;
  issueKey: string;
  timeSpentSeconds: number;
  comment?: string;
  date: string; // YYYY-MM-DD
}

worklog.post("/worklog", async (c) => {
  const body = await c.req.json<CreateWorklogBody>();
  const ws = getWorkspace(body.workspaceId);

  // Jira requires a timezone offset; the team works in Asia/Bangkok (+07:00).
  const started = `${body.date}T09:00:00.000+0700`;
  const worklog = await createWorklog(ws, body.issueKey, {
    timeSpentSeconds: body.timeSpentSeconds,
    comment: body.comment,
    started,
  });

  // Mirror the new worklog into Postgres so the candidate list and daily total
  // reflect it right away — otherwise the write only lands in Jira and the UI
  // keeps showing the sub-task as "not logged" until the next full sync.
  await recordWorklogLocal(ws.id, worklog);

  return c.json({ ok: true, worklogId: worklog.id });
});

// Per-person daily 8h roll-up (feature #5).
worklog.get("/daily", async (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  return c.json(await computeDaily(date));
});

export default worklog;
