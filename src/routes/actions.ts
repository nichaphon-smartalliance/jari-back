import { Hono } from "hono";
import { getWorkspace } from "../services/workspaces";
import { transitionToDone } from "../services/jira";
import { setIssueDoneLocal } from "../services/aggregate";

const actions = new Hono();

// One-click "Done" (feature #3): transition in Jira, then reflect locally.
actions.post("/issues/:key/done", async (c) => {
  const key = c.req.param("key");
  const workspaceId = c.req.query("workspaceId");
  const ws = getWorkspace(workspaceId);

  await transitionToDone(ws, key);
  await setIssueDoneLocal(key);

  return c.json({ ok: true, key });
});

export default actions;
