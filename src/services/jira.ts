import { jiraHeaders, type WorkspaceConfig } from "./workspaces";
import type { Priority } from "../types";

// ─── Raw Jira API types ───────────────────────────────────────────────────────

export interface JiraIssueRaw {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    assignee: { accountId: string; displayName: string; emailAddress?: string } | null;
    priority: { name: string } | null;
    project: { key: string; name: string };
    created: string;
    updated: string;
    duedate: string | null;
    issuetype: { name: string; subtask: boolean };
    labels: string[];
    parent?: { id: string; key: string };
  };
}

interface JiraSearchPage {
  issues: JiraIssueRaw[];
  nextPageToken?: string;
  isLast?: boolean;
}

export interface JiraWorklogRaw {
  id: string;
  issueId: string;
  author: { accountId: string; displayName: string; emailAddress?: string };
  comment?: AdfNode;
  started: string;
  timeSpentSeconds: number;
}

interface WorklogUpdatedResponse {
  values: { worklogId: number }[];
  lastPage: boolean;
  until: number;
}

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

// ─── ADF helpers ────────────────────────────────────────────────────────────

/** Wrap plain text into a minimal ADF document (for description / worklog comment). */
export function textToAdf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: text || " " }] }],
  };
}

/** Flatten an ADF node back to plain text (for reads / display). */
export function adfToText(node: AdfNode | unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as AdfNode;
  if (n.type === "text" && n.text) return n.text;
  if (Array.isArray(n.content)) return n.content.map(adfToText).join("").trim();
  return "";
}

const ISSUE_FIELDS = [
  "summary", "status", "assignee", "priority", "project",
  "created", "updated", "duedate", "issuetype", "labels", "parent",
];

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function searchIssues(ws: WorkspaceConfig, jql: string): Promise<JiraIssueRaw[]> {
  const issues: JiraIssueRaw[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { jql, fields: ISSUE_FIELDS, maxResults: 100 };
    if (cursor) body.nextPageToken = cursor;

    const res = await fetch(`${ws.baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: jiraHeaders(ws),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`[${ws.name}] Jira search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as JiraSearchPage;
    issues.push(...data.issues);
    cursor = data.nextPageToken;
    if (data.isLast || !cursor) break;
  } while (true);

  return issues;
}

export const fetchAllIssues = (ws: WorkspaceConfig) => searchIssues(ws, "status != ''");

/** Ids of issues currently in an open/active sprint (`sprint in openSprints()`).
 *  Lightweight (ids only). Throws if the JQL is unsupported (e.g. no Scrum board)
 *  — the caller treats that as "nothing to mark". */
export async function fetchOpenSprintIssueIds(ws: WorkspaceConfig): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql: "sprint in openSprints()",
      fields: ["id"],
      maxResults: 100,
    };
    if (cursor) body.nextPageToken = cursor;

    const res = await fetch(`${ws.baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: jiraHeaders(ws),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`[${ws.name}] open-sprint search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as JiraSearchPage;
    for (const issue of data.issues) ids.push(issue.id);
    cursor = data.nextPageToken;
    if (data.isLast || !cursor) break;
  } while (true);

  return ids;
}

export async function fetchWorklogIdsSince(sinceMs: number, ws: WorkspaceConfig): Promise<number[]> {
  const allIds: number[] = [];
  let since = sinceMs;

  for (let page = 0; page < 20; page++) {
    const res = await fetch(`${ws.baseUrl}/rest/api/3/worklog/updated?since=${since}`, {
      headers: jiraHeaders(ws),
    });
    if (!res.ok) throw new Error(`[${ws.name}] worklog/updated ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as WorklogUpdatedResponse;
    for (const e of data.values) allIds.push(e.worklogId);
    if (data.lastPage) break;
    since = data.until;
  }

  return allIds;
}

export async function fetchWorklogDetails(ids: number[], ws: WorkspaceConfig): Promise<JiraWorklogRaw[]> {
  if (ids.length === 0) return [];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 1000) chunks.push(ids.slice(i, i + 1000));

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const res = await fetch(`${ws.baseUrl}/rest/api/3/worklog/list`, {
        method: "POST",
        headers: jiraHeaders(ws),
        body: JSON.stringify({ ids: chunk }),
      });
      if (!res.ok) throw new Error(`[${ws.name}] worklog/list ${res.status}: ${await res.text()}`);
      return (await res.json()) as JiraWorklogRaw[];
    }),
  );

  return results.flat();
}

export async function fetchIssueInfoBatch(
  issueIds: string[],
  ws: WorkspaceConfig,
): Promise<Map<string, { key: string; summary: string; projectKey: string; projectName: string }>> {
  const map = new Map<string, { key: string; summary: string; projectKey: string; projectName: string }>();
  if (issueIds.length === 0) return map;

  for (let i = 0; i < issueIds.length; i += 50) {
    const batch = issueIds.slice(i, i + 50);
    try {
      const res = await fetch(`${ws.baseUrl}/rest/api/3/search/jql`, {
        method: "POST",
        headers: jiraHeaders(ws),
        body: JSON.stringify({ jql: `id in (${batch.join(",")})`, fields: ["summary", "project"], maxResults: 50 }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { issues?: JiraIssueRaw[] };
      for (const issue of data.issues ?? []) {
        map.set(issue.id, {
          key: issue.key,
          summary: issue.fields.summary ?? "",
          projectKey: issue.fields.project?.key ?? "",
          projectName: issue.fields.project?.name ?? "",
        });
      }
    } catch {
      /* skip batch on error */
    }
  }

  return map;
}

export async function getIssueWorklogs(ws: WorkspaceConfig, issueKey: string): Promise<JiraWorklogRaw[]> {
  const res = await fetch(`${ws.baseUrl}/rest/api/3/issue/${issueKey}/worklog`, {
    headers: jiraHeaders(ws),
  });
  if (!res.ok) throw new Error(`[${ws.name}] issue worklog ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { worklogs: JiraWorklogRaw[] };
  return data.worklogs ?? [];
}

/** The Jira account that owns the given credentials — used to validate a user's
 *  email + API token and resolve their accountId when they link an account. */
export async function getMyself(
  ws: WorkspaceConfig,
): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
  const res = await fetch(`${ws.baseUrl}/rest/api/3/myself`, { headers: jiraHeaders(ws) });
  if (!res.ok) throw new Error(`[${ws.name}] myself ${res.status}: ${await res.text()}`);
  return (await res.json()) as { accountId: string; displayName: string; emailAddress?: string };
}

export async function searchUser(ws: WorkspaceConfig, query: string) {
  const res = await fetch(
    `${ws.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(query)}`,
    { headers: jiraHeaders(ws) },
  );
  if (!res.ok) throw new Error(`[${ws.name}] user search ${res.status}: ${await res.text()}`);
  return (await res.json()) as { accountId: string; displayName: string; emailAddress?: string }[];
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface CreateStoryArgs {
  projectKey: string;
  summary: string;
  description?: string;
  priority?: Priority;
  assigneeAccountId?: string;
}

export async function createStory(ws: WorkspaceConfig, args: CreateStoryArgs): Promise<{ id: string; key: string }> {
  const fields: Record<string, unknown> = {
    project: { key: args.projectKey },
    summary: args.summary,
    issuetype: { name: "Story" },
    description: textToAdf(args.description ?? ""),
  };
  if (args.priority) fields.priority = { name: args.priority };
  if (args.assigneeAccountId) fields.assignee = { accountId: args.assigneeAccountId };

  return createIssue(ws, fields);
}

export interface CreateSubtaskArgs {
  projectKey: string;
  parentKey: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
}

export async function createSubtask(ws: WorkspaceConfig, args: CreateSubtaskArgs): Promise<{ id: string; key: string }> {
  const fields: Record<string, unknown> = {
    project: { key: args.projectKey },
    parent: { key: args.parentKey },
    summary: args.summary,
    issuetype: { name: "Sub-task" },
    description: textToAdf(args.description ?? ""),
  };
  if (args.assigneeAccountId) fields.assignee = { accountId: args.assigneeAccountId };

  return createIssue(ws, fields);
}

async function createIssue(ws: WorkspaceConfig, fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const res = await fetch(`${ws.baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: jiraHeaders(ws),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`[${ws.name}] create issue ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; key: string };
}

export async function createWorklog(
  ws: WorkspaceConfig,
  issueKey: string,
  args: { timeSpentSeconds: number; comment?: string; started: string },
): Promise<JiraWorklogRaw> {
  const res = await fetch(`${ws.baseUrl}/rest/api/3/issue/${issueKey}/worklog`, {
    method: "POST",
    headers: jiraHeaders(ws),
    body: JSON.stringify({
      comment: textToAdf(args.comment ?? ""),
      timeSpentSeconds: args.timeSpentSeconds,
      started: args.started,
    }),
  });
  if (!res.ok) throw new Error(`[${ws.name}] create worklog ${res.status}: ${await res.text()}`);
  // Jira echoes the full worklog (id, issueId, author, started, …) — the caller
  // uses it to mirror the entry into Postgres so reads reflect it immediately.
  return (await res.json()) as JiraWorklogRaw;
}

/** Move an issue to its "Done" transition (feature #3, one-click done). */
export async function transitionToDone(ws: WorkspaceConfig, issueKey: string): Promise<void> {
  const listRes = await fetch(`${ws.baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
    headers: jiraHeaders(ws),
  });
  if (!listRes.ok) throw new Error(`[${ws.name}] get transitions ${listRes.status}: ${await listRes.text()}`);
  const data = (await listRes.json()) as {
    transitions: { id: string; name: string; to: { statusCategory: { key: string } } }[];
  };

  const done =
    data.transitions.find((t) => t.to.statusCategory.key === "done") ??
    data.transitions.find((t) => /done|complete|ปิด|เสร็จ/i.test(t.name));
  if (!done) throw new Error(`[${ws.name}] no 'Done' transition available for ${issueKey}`);

  const res = await fetch(`${ws.baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    headers: jiraHeaders(ws),
    body: JSON.stringify({ transition: { id: done.id } }),
  });
  if (!res.ok) throw new Error(`[${ws.name}] transition ${res.status}: ${await res.text()}`);
}
