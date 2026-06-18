export interface WorkspaceConfig {
  id: string;
  name: string;
  baseUrl: string;
  email: string;
  token: string;
}

/** Reads JIRA_WORKSPACE_1_* .. JIRA_WORKSPACE_20_* from env. */
export function getWorkspaces(): WorkspaceConfig[] {
  const workspaces: WorkspaceConfig[] = [];

  for (let i = 1; i <= 20; i++) {
    const url = process.env[`JIRA_WORKSPACE_${i}_URL`];
    const email = process.env[`JIRA_WORKSPACE_${i}_EMAIL`];
    const token = process.env[`JIRA_WORKSPACE_${i}_TOKEN`];
    const name = process.env[`JIRA_WORKSPACE_${i}_NAME`] ?? `Workspace ${i}`;
    if (!url || !email || !token) continue;
    workspaces.push({ id: `ws${i}`, name, baseUrl: url.replace(/\/$/, ""), email, token });
  }

  if (workspaces.length === 0) {
    const url = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    if (url && email && token) {
      workspaces.push({
        id: "ws1",
        name: "Default",
        baseUrl: url.replace(/\/$/, ""),
        email,
        token,
      });
    }
  }

  return workspaces;
}

export function getWorkspace(id?: string): WorkspaceConfig {
  const all = getWorkspaces();
  if (all.length === 0) throw new Error("No Jira workspaces configured in .env");
  if (!id) return all[0]!;
  const ws = all.find((w) => w.id === id);
  if (!ws) throw new Error(`Workspace ${id} not found`);
  return ws;
}

export function jiraHeaders(ws: WorkspaceConfig): Record<string, string> {
  const creds = Buffer.from(`${ws.email}:${ws.token}`).toString("base64");
  return {
    Authorization: `Basic ${creds}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
