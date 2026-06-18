import sql from "../db/client";
import {
  mapStatusCategory,
  type DailyData,
  type DashboardData,
  type Issue,
  type JiraUser,
  type Priority,
  type Worklog,
} from "../types";

const WORKDAY_SECONDS = 8 * 3600;

// ─── Row shapes ───────────────────────────────────────────────────────────────

interface IssueRow {
  id: string;
  key: string;
  summary: string;
  status_name: string;
  status_category: string;
  assignee_account_id: string | null;
  assignee_display_name: string | null;
  assignee_email: string | null;
  priority_name: string | null;
  project_key: string;
  project_name: string;
  issue_type_name: string | null;
  is_subtask: boolean;
  parent_key: string | null;
  due_date: string | null;
  jira_created_at: Date | string;
  jira_updated_at: Date | string;
  has_worklog?: boolean;
}

const toISO = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    key: row.key,
    summary: row.summary,
    statusName: row.status_name,
    statusCategory: mapStatusCategory(row.status_category),
    issueType: row.issue_type_name ?? "Task",
    isSubtask: row.is_subtask ?? false,
    parentKey: row.parent_key ?? undefined,
    assignee: row.assignee_account_id
      ? {
          accountId: row.assignee_account_id,
          displayName: row.assignee_display_name ?? "",
          email: row.assignee_email ?? "",
        }
      : undefined,
    priority: (row.priority_name as Priority) ?? undefined,
    projectKey: row.project_key,
    projectName: row.project_name,
    dueDate: row.due_date ?? undefined,
    createdAt: toISO(row.jira_created_at),
    updatedAt: toISO(row.jira_updated_at),
    hasWorklog: row.has_worklog ?? false,
  };
}

// Reusable literal kept as a string so it can be embedded in static SQL or
// composed by sql.unsafe — avoids relying on nested sql`` fragment support.
const HAS_WORKLOG_SQL =
  "EXISTS (SELECT 1 FROM worklogs wl WHERE wl.issue_id = i.id AND wl.workspace_id = i.workspace_id) AS has_worklog";

// ─── Issue queries ──────────────────────────────────────────────────────────

export async function getIssues(filters: {
  project?: string;
  status?: string;
  subtasks?: string;
}): Promise<Issue[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.project) {
    params.push(filters.project);
    conditions.push(`i.project_key = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`i.status_category = $${params.length}`);
  }
  if (filters.subtasks === "false") conditions.push("i.is_subtask = false");

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = (await sql.unsafe(
    `SELECT i.*, ${HAS_WORKLOG_SQL} FROM issues i ${where} ORDER BY i.jira_updated_at DESC LIMIT 1000`,
    params,
  )) as unknown as IssueRow[];
  return rows.map(rowToIssue);
}

export async function getSprintIssues(): Promise<Issue[]> {
  const rows = await sql<IssueRow[]>`
    SELECT i.*,
      EXISTS (SELECT 1 FROM worklogs wl WHERE wl.issue_id = i.id AND wl.workspace_id = i.workspace_id) AS has_worklog
    FROM issues i
    WHERE i.status_category != 'done'
       OR (i.status_category = 'done' AND i.jira_updated_at >= NOW() - INTERVAL '14 days')
    ORDER BY i.due_date ASC NULLS LAST, i.jira_updated_at DESC
  `;
  return rows.map(rowToIssue);
}

export async function getMyOpenIssues(accountId: string): Promise<Issue[]> {
  const rows = await sql<IssueRow[]>`
    SELECT i.*,
      EXISTS (SELECT 1 FROM worklogs wl WHERE wl.issue_id = i.id AND wl.workspace_id = i.workspace_id) AS has_worklog
    FROM issues i
    WHERE i.assignee_account_id = ${accountId}
      AND i.status_category != 'done'
    ORDER BY i.due_date ASC NULLS LAST
  `;
  return rows.map(rowToIssue);
}

/** Done sub-tasks assigned to me that have no worklog yet (feature #4). */
export async function getWorklogCandidates(accountId: string): Promise<Issue[]> {
  const rows = await sql<IssueRow[]>`
    SELECT i.*, FALSE AS has_worklog
    FROM issues i
    WHERE i.is_subtask = true
      AND i.status_category = 'done'
      AND i.assignee_account_id = ${accountId}
      AND NOT EXISTS (
        SELECT 1 FROM worklogs wl WHERE wl.issue_id = i.id AND wl.workspace_id = i.workspace_id
      )
    ORDER BY i.jira_updated_at DESC
  `;
  return rows.map(rowToIssue);
}

// ─── Dashboard (#1) ───────────────────────────────────────────────────────────

export async function computeDashboard(): Promise<DashboardData> {
  const issues = await sql<IssueRow[]>`SELECT i.* FROM issues i`;
  const today = new Date().toISOString().slice(0, 10);

  const total = issues.length;
  const completed = issues.filter((i) => i.status_category === "done").length;
  const inProgress = issues.filter((i) => i.status_category === "indeterminate").length;
  const overdue = issues.filter(
    (i) => i.status_category !== "done" && i.due_date && i.due_date < today,
  ).length;

  const doneOnTime = issues.filter((i) => {
    if (i.status_category !== "done") return false;
    if (!i.due_date) return true;
    return new Date(i.due_date) >= new Date(toISO(i.jira_updated_at).slice(0, 10));
  }).length;

  // logged seconds today, per assignee
  const loggedRows = await sql<{ author_account_id: string; secs: number }[]>`
    SELECT author_account_id, COALESCE(SUM(time_spent_seconds), 0)::int AS secs
    FROM worklogs
    WHERE started_at >= ${today}::date AND started_at < ${today}::date + 1
    GROUP BY author_account_id
  `;
  const loggedToday = new Map(loggedRows.map((r) => [r.author_account_id, r.secs]));

  const workloadMap = new Map<string, DashboardData["workload"][number]>();
  for (const i of issues) {
    if (!i.assignee_account_id) continue;
    const w =
      workloadMap.get(i.assignee_account_id) ??
      {
        accountId: i.assignee_account_id,
        displayName: i.assignee_display_name ?? i.assignee_account_id,
        todo: 0,
        inProgress: 0,
        done: 0,
        loggedHoursToday:
          Math.round(((loggedToday.get(i.assignee_account_id) ?? 0) / 3600) * 10) / 10,
      };
    if (i.status_category === "done") w.done++;
    else if (i.status_category === "indeterminate") w.inProgress++;
    else w.todo++;
    workloadMap.set(i.assignee_account_id, w);
  }

  const projectMap = new Map<string, DashboardData["projects"][number]>();
  for (const i of issues) {
    const p =
      projectMap.get(i.project_key) ??
      { projectKey: i.project_key, projectName: i.project_name, total: 0, done: 0, overdue: 0, healthScore: 100 };
    p.total++;
    if (i.status_category === "done") p.done++;
    if (i.status_category !== "done" && i.due_date && i.due_date < today) p.overdue++;
    projectMap.set(i.project_key, p);
  }
  const projects = [...projectMap.values()].map((p) => ({
    ...p,
    healthScore: Math.max(0, Math.round((p.done / Math.max(1, p.total)) * 100 - p.overdue * 10)),
  }));

  return {
    kpis: {
      totalIssues: total,
      completed,
      inProgress,
      blockedOrOverdue: overdue,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      onTimeRate: completed > 0 ? Math.round((doneOnTime / completed) * 100) : 0,
    },
    trend: computeTrend(issues),
    workload: [...workloadMap.values()].sort(
      (a, b) => b.todo + b.inProgress + b.done - (a.todo + a.inProgress + a.done),
    ),
    projects: projects.sort((a, b) => b.total - a.total),
    sprint: {
      name: "Active Sprint",
      committed: total,
      completed,
      carryover: Math.max(0, total - completed),
    },
  };
}

function computeTrend(issues: IssueRow[]): DashboardData["trend"] {
  const now = new Date();
  const out: DashboardData["trend"] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-GB", { month: "short" });
    const created = issues.filter((r) => toISO(r.jira_created_at).startsWith(key)).length;
    const completed = issues.filter(
      (r) => r.status_category === "done" && toISO(r.jira_updated_at).startsWith(key),
    ).length;
    out.push({ month: label, created, completed });
  }
  return out;
}

// ─── Daily 8h view (#5) ─────────────────────────────────────────────────────

export async function computeDaily(date: string): Promise<DailyData> {
  const rows = await sql<
    {
      author_account_id: string;
      author_display_name: string;
      issue_key: string;
      issue_summary: string | null;
      secs: number;
    }[]
  >`
    SELECT author_account_id, author_display_name, issue_key,
           MAX(issue_summary) AS issue_summary,
           COALESCE(SUM(time_spent_seconds), 0)::int AS secs
    FROM worklogs
    WHERE started_at >= ${date}::date AND started_at < ${date}::date + 1
    GROUP BY author_account_id, author_display_name, issue_key
    ORDER BY author_display_name
  `;

  const peopleMap = new Map<string, DailyData["people"][number]>();
  for (const r of rows) {
    const p =
      peopleMap.get(r.author_account_id) ??
      {
        accountId: r.author_account_id,
        displayName: r.author_display_name,
        totalSeconds: 0,
        targetSeconds: WORKDAY_SECONDS,
        status: "under" as const,
        entries: [],
      };
    p.totalSeconds += r.secs;
    p.entries.push({
      issueKey: r.issue_key,
      issueSummary: r.issue_summary ?? r.issue_key,
      hours: Math.round((r.secs / 3600) * 10) / 10,
    });
    peopleMap.set(r.author_account_id, p);
  }

  const people = [...peopleMap.values()].map((p) => ({
    ...p,
    status:
      p.totalSeconds < WORKDAY_SECONDS
        ? ("under" as const)
        : p.totalSeconds > WORKDAY_SECONDS
          ? ("over" as const)
          : ("ok" as const),
  }));

  return { date, targetHours: 8, people };
}

// ─── Worklogs list ────────────────────────────────────────────────────────────

interface WorklogRow {
  id: string;
  issue_key: string;
  issue_summary: string | null;
  author_account_id: string;
  author_display_name: string;
  author_email: string | null;
  comment_text: string | null;
  started_at: Date | string;
  time_spent_seconds: number;
}

export async function getWorklogs(from: string, to: string): Promise<Worklog[]> {
  const rows = await sql<WorklogRow[]>`
    SELECT * FROM worklogs
    WHERE started_at >= ${from}::date AND started_at < ${to}::date + 1
    ORDER BY started_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    issueKey: r.issue_key,
    issueSummary: r.issue_summary ?? r.issue_key,
    author: {
      accountId: r.author_account_id,
      displayName: r.author_display_name,
      email: r.author_email ?? "",
    },
    comment: r.comment_text ?? "",
    startedAt: toISO(r.started_at),
    timeSpentSeconds: r.time_spent_seconds,
  }));
}

// ─── Reference data derived from synced rows ──────────────────────────────────

/** Distinct people seen as issue assignees or worklog authors. */
export async function getUsers(): Promise<JiraUser[]> {
  const rows = await sql<{ account_id: string; display_name: string | null; email: string | null }[]>`
    SELECT account_id, MAX(display_name) AS display_name, MAX(email) AS email FROM (
      SELECT assignee_account_id AS account_id, assignee_display_name AS display_name, assignee_email AS email
        FROM issues WHERE assignee_account_id IS NOT NULL
      UNION ALL
      SELECT author_account_id, author_display_name, author_email FROM worklogs
    ) t
    GROUP BY account_id
    ORDER BY display_name
  `;
  return rows.map((r) => ({
    accountId: r.account_id,
    displayName: r.display_name ?? r.account_id,
    email: r.email ?? "",
  }));
}

/** Distinct projects present in synced issues. */
export async function getProjects(): Promise<{ key: string; name: string }[]> {
  const rows = await sql<{ project_key: string; project_name: string }[]>`
    SELECT DISTINCT project_key, project_name FROM issues ORDER BY project_name
  `;
  return rows.map((r) => ({ key: r.project_key, name: r.project_name }));
}

/** Mark an issue done in the local DB after a successful Jira transition. */
export async function setIssueDoneLocal(key: string): Promise<void> {
  await sql`
    UPDATE issues
    SET status_category = 'done', status_name = 'Done', jira_updated_at = NOW(), synced_at = NOW()
    WHERE key = ${key}
  `;
}
