import { Hono } from "hono";
import { getWorkspace } from "../services/workspaces";
import { createWorklog } from "../services/jira";
import { recordWorklogLocal } from "../services/jiraSync";
import { getUserJiraCredentials, verifyToken } from "../services/auth";
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
  // Identify the logged-in user and use THEIR Jira credentials so the worklog is
  // attributed to them in Jira — not to the shared workspace token owner.
  const header = c.req.header("Authorization") ?? "";
  const payload = verifyToken(header.startsWith("Bearer ") ? header.slice(7) : "");
  if (!payload) return c.json({ error: "unauthorized" }, 401);

  const creds = await getUserJiraCredentials(payload.username);
  if (!creds) {
    return c.json(
      {
        error:
          "ยังไม่ได้เชื่อมบัญชี Jira ของคุณ — ไปที่หน้า Settings เพื่อใส่ email และ API token ก่อนลงเวลา",
        code: "NO_JIRA_TOKEN",
      },
      400,
    );
  }

  const body = await c.req.json<CreateWorklogBody>();
  const base = getWorkspace(body.workspaceId);
  // Same Jira site (baseUrl), but authenticate as the logged-in user.
  const ws = { ...base, email: creds.email, token: creds.token };

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
