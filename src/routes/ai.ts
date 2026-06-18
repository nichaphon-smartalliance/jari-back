import { Hono } from "hono";
import { planWorklogs, rewriteText, suggestSubtasks } from "../services/ai";

const ai = new Hono();

ai.post("/ai/rewrite", async (c) => {
  const { raw, kind } = await c.req.json<{ raw: string; kind: "title" | "description" }>();
  return c.json({ content: await rewriteText(raw, kind) });
});

ai.post("/ai/suggest-subtasks", async (c) => {
  const { title, description } = await c.req.json<{ title: string; description?: string }>();
  return c.json({ subtasks: await suggestSubtasks(title, description ?? "") });
});

ai.post("/ai/plan-worklogs", async (c) => {
  const body = await c.req.json<{
    candidates: { issueKey: string; summary: string }[];
    remainingSeconds: number;
  }>();
  return c.json({ plan: await planWorklogs(body) });
});

export default ai;
