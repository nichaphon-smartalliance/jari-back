import { Hono } from "hono";
import {
  computeDashboard,
  getIssues,
  getMyOpenIssues,
  getProjects,
  getProjectStatus,
  getSprintIssues,
  getSprintTimeline,
  getSprintWorkload,
  getUsers,
  getWorklogs,
} from "../services/aggregate";
import { getWorkspace, getWorkspaces } from "../services/workspaces";
import { listEpics } from "../services/jira";

const data = new Hono();

data.get("/workspaces", (c) =>
  c.json(getWorkspaces().map((w) => ({ id: w.id, name: w.name, baseUrl: w.baseUrl }))),
);

data.get("/users", async (c) => c.json(await getUsers()));

data.get("/projects", async (c) => c.json(await getProjects()));

// Optional Epic picker for the create page (#2). Best-effort, live from Jira.
data.get("/epics", async (c) => {
  const projectKey = c.req.query("projectKey");
  if (!projectKey) return c.json({ epics: [] });
  return c.json({ epics: await listEpics(getWorkspace(), projectKey) });
});

data.get("/dashboard", async (c) => c.json(await computeDashboard()));

// Dashboard report sections (#1 workload, #2 timeline, #3 project status).
data.get("/reports/workload", async (c) => c.json({ people: await getSprintWorkload() }));
data.get("/reports/timeline", async (c) => c.json(await getSprintTimeline()));
data.get("/reports/project-status", async (c) => c.json({ projects: await getProjectStatus() }));

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
  const status = c.req.query("status");
  const statusCategories = status ? status.split(",").filter(Boolean) : undefined;
  return c.json({ issues: await getMyOpenIssues(accountId, statusCategories) });
});

data.get("/worklogs", async (c) => {
  const from = c.req.query("from") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
  return c.json({ worklogs: await getWorklogs(from, to), dateRange: { from, to } });
});

export default data;
