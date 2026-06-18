import sql from "../db/client";
import { getWorkspaces, type WorkspaceConfig } from "./workspaces";
import {
  adfToText,
  fetchAllIssues,
  fetchIssueInfoBatch,
  fetchWorklogDetails,
  fetchWorklogIdsSince,
  type JiraIssueRaw,
  type JiraWorklogRaw,
} from "./jira";

export type SyncResult = { workspace: string; count: number; error?: string };

async function upsertWorkspace(ws: WorkspaceConfig): Promise<void> {
  await sql`
    INSERT INTO workspaces (id, name, base_url)
    VALUES (${ws.id}, ${ws.name}, ${ws.baseUrl})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url
  `;
}

async function upsertIssues(issues: JiraIssueRaw[], wsId: string): Promise<number> {
  if (issues.length === 0) return 0;

  for (let i = 0; i < issues.length; i += 500) {
    const chunk = issues.slice(i, i + 500);
    const rows = chunk.map((issue) => ({
      id: issue.id,
      key: issue.key,
      workspace_id: wsId,
      summary: issue.fields.summary,
      status_name: issue.fields.status.name,
      status_category: issue.fields.status.statusCategory.key,
      assignee_account_id: issue.fields.assignee?.accountId ?? null,
      assignee_display_name: issue.fields.assignee?.displayName ?? null,
      assignee_email: issue.fields.assignee?.emailAddress ?? null,
      priority_name: issue.fields.priority?.name ?? null,
      project_key: issue.fields.project.key,
      project_name: issue.fields.project.name,
      issue_type_name: issue.fields.issuetype.name,
      is_subtask: issue.fields.issuetype.subtask,
      parent_id: issue.fields.parent?.id ?? null,
      parent_key: issue.fields.parent?.key ?? null,
      due_date: issue.fields.duedate ?? null,
      jira_created_at: new Date(issue.fields.created),
      jira_updated_at: new Date(issue.fields.updated),
    }));

    await sql`
      INSERT INTO issues ${sql(rows)}
      ON CONFLICT (id, workspace_id) DO UPDATE SET
        key                   = EXCLUDED.key,
        summary               = EXCLUDED.summary,
        status_name           = EXCLUDED.status_name,
        status_category       = EXCLUDED.status_category,
        assignee_account_id   = EXCLUDED.assignee_account_id,
        assignee_display_name = EXCLUDED.assignee_display_name,
        assignee_email        = EXCLUDED.assignee_email,
        priority_name         = EXCLUDED.priority_name,
        project_key           = EXCLUDED.project_key,
        project_name          = EXCLUDED.project_name,
        issue_type_name       = EXCLUDED.issue_type_name,
        is_subtask            = EXCLUDED.is_subtask,
        parent_id             = EXCLUDED.parent_id,
        parent_key            = EXCLUDED.parent_key,
        due_date              = EXCLUDED.due_date,
        jira_created_at       = EXCLUDED.jira_created_at,
        jira_updated_at       = EXCLUDED.jira_updated_at,
        synced_at             = NOW()
    `;
  }

  return issues.length;
}

async function upsertWorklogs(
  worklogs: JiraWorklogRaw[],
  issueMap: Map<string, { key: string; summary: string; projectKey: string; projectName: string }>,
  wsId: string,
): Promise<number> {
  if (worklogs.length === 0) return 0;

  for (let i = 0; i < worklogs.length; i += 500) {
    const chunk = worklogs.slice(i, i + 500);
    const rows = chunk.map((wl) => {
      const info = issueMap.get(wl.issueId);
      return {
        id: wl.id,
        workspace_id: wsId,
        issue_id: wl.issueId,
        issue_key: info?.key ?? `#${wl.issueId}`,
        issue_summary: info?.summary ?? null,
        project_key: info?.projectKey ?? null,
        project_name: info?.projectName ?? null,
        author_account_id: wl.author.accountId,
        author_display_name: wl.author.displayName,
        author_email: wl.author.emailAddress ?? null,
        comment_text: wl.comment ? adfToText(wl.comment) : null,
        started_at: new Date(wl.started),
        time_spent_seconds: wl.timeSpentSeconds,
      };
    });

    await sql`
      INSERT INTO worklogs ${sql(rows)}
      ON CONFLICT (id, workspace_id) DO UPDATE SET
        issue_key          = EXCLUDED.issue_key,
        issue_summary      = EXCLUDED.issue_summary,
        project_key        = EXCLUDED.project_key,
        project_name       = EXCLUDED.project_name,
        comment_text       = EXCLUDED.comment_text,
        started_at         = EXCLUDED.started_at,
        time_spent_seconds = EXCLUDED.time_spent_seconds,
        synced_at          = NOW()
    `;
  }

  return worklogs.length;
}

export async function syncIssues(): Promise<SyncResult[]> {
  const workspaces = getWorkspaces();
  if (workspaces.length === 0) throw new Error("No Jira workspaces configured in .env");
  const results: SyncResult[] = [];

  for (const ws of workspaces) {
    try {
      await upsertWorkspace(ws);
      const issues = await fetchAllIssues(ws);
      const count = await upsertIssues(issues, ws.id);
      await sql`UPDATE workspaces SET last_synced_at = NOW() WHERE id = ${ws.id}`;
      results.push({ workspace: ws.name, count });
      console.log(`[sync] ${ws.name}: ${count} issues`);
    } catch (err) {
      results.push({ workspace: ws.name, count: 0, error: String(err) });
      console.error(`[sync] ${ws.name} failed:`, err);
    }
  }

  return results;
}

export async function syncWorklogs(sinceDays = 30): Promise<SyncResult[]> {
  const workspaces = getWorkspaces();
  if (workspaces.length === 0) throw new Error("No Jira workspaces configured in .env");
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const results: SyncResult[] = [];

  for (const ws of workspaces) {
    try {
      await upsertWorkspace(ws);
      const ids = await fetchWorklogIdsSince(sinceMs, ws);
      const worklogs = await fetchWorklogDetails(ids, ws);
      const issueIds = [...new Set(worklogs.map((w) => w.issueId))];
      const issueMap = await fetchIssueInfoBatch(issueIds, ws);
      const count = await upsertWorklogs(worklogs, issueMap, ws.id);
      results.push({ workspace: ws.name, count });
      console.log(`[sync] ${ws.name}: ${count} worklogs`);
    } catch (err) {
      results.push({ workspace: ws.name, count: 0, error: String(err) });
      console.error(`[sync] ${ws.name} worklogs failed:`, err);
    }
  }

  return results;
}
