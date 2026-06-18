import { Hono } from "hono";
import { getWorkspace } from "../services/workspaces";
import { createStory, createSubtask } from "../services/jira";
import type { Priority } from "../types";

const create = new Hono();

interface CreateStoryBody {
  workspaceId?: string;
  projectKey: string;
  summary: string;
  description?: string;
  priority?: Priority;
  assigneeAccountId?: string;
  subtasks?: string[];
}

// Create a Story plus any sub-tasks under it (feature #2).
create.post("/stories", async (c) => {
  const body = await c.req.json<CreateStoryBody>();
  const ws = getWorkspace(body.workspaceId);

  const story = await createStory(ws, {
    projectKey: body.projectKey,
    summary: body.summary,
    description: body.description,
    priority: body.priority,
    assigneeAccountId: body.assigneeAccountId,
  });

  const subtaskKeys: string[] = [];
  for (const summary of body.subtasks ?? []) {
    if (!summary.trim()) continue;
    const st = await createSubtask(ws, {
      projectKey: body.projectKey,
      parentKey: story.key,
      summary,
      assigneeAccountId: body.assigneeAccountId,
    });
    subtaskKeys.push(st.key);
  }

  return c.json({ storyKey: story.key, subtaskKeys });
});

interface CreateSubtaskBody {
  workspaceId?: string;
  projectKey: string;
  parentKey: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
}

create.post("/subtasks", async (c) => {
  const body = await c.req.json<CreateSubtaskBody>();
  const ws = getWorkspace(body.workspaceId);
  const st = await createSubtask(ws, body);
  return c.json({ subtaskKey: st.key });
});

export default create;
