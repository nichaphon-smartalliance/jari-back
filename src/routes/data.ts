import { Hono } from "hono";
import {
  computeDashboard,
  getIssues,
  getMyOpenIssues,
  getProjects,
  getSprintIssues,
  getUsers,
  getWorklogs,
} from "../services/aggregate";
import { getWorkspaces } from "../services/workspaces";

const data = new Hono();

data.get("/workspaces", (c) =>
  c.json(getWorkspaces().map((w) => ({ id: w.id, name: w.name, baseUrl: w.baseUrl }))),
);

data.get("/users", async (c) => c.json(await getUsers()));

data.get("/projects", async (c) => c.json(await getProjects()));

data.get("/dashboard", async (c) => c.json(await computeDashboard()));

data.get("/issues", async (c) => {
  const issues = await getIssues({
    project: c.req.query("project"),
    status: c.req.query("status"),
    subtasks: c.req.query("subtasks"),
  });
  return c.json({ issues, total: issues.length });
});

data.get("/sprint", async (c) => c.json({ issues: await getSprintIssues() }));

data.get("/my-issues", async (c) => {
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "accountId required" }, 400);
  return c.json({ issues: await getMyOpenIssues(accountId) });
});

data.get("/worklogs", async (c) => {
  const from = c.req.query("from") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
  return c.json({ worklogs: await getWorklogs(from, to), dateRange: { from, to } });
});

export default data;
