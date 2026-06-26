import { Hono } from "hono";
import {
  draftStory,
  estimateWorklogHours,
  packBackfill,
  planWorklogs,
  rewriteText,
  suggestSubtasks,
} from "../services/ai";
import { getLoggedSecondsByDay } from "../services/aggregate";

const ai = new Hono();

const WORKDAY_SECONDS = 8 * 3600;

// #2 — one free-form brief in, a ready-to-create Story (title + description + sub-tasks) out.
ai.post("/ai/draft-story", async (c) => {
  const { brief } = await c.req.json<{ brief: string }>();
  if (!brief?.trim()) return c.json({ error: "brief required" }, 400);
  return c.json(await draftStory(brief));
});

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

// Multi-day backfill: estimate each Done sub-task, then pack them into past
// workdays (8h/day, skipping weekends), backward from startDate.
ai.post("/ai/backfill-worklogs", async (c) => {
  const body = await c.req.json<{
    candidates: { issueKey: string; summary: string }[];
    accountId: string;
    startDate: string; // YYYY-MM-DD
    skipWeekends?: boolean;
  }>();
  if (!body.candidates?.length || !body.accountId || !body.startDate) {
    return c.json({ error: "candidates, accountId, startDate required" }, 400);
  }

  const estimates = await estimateWorklogHours(body.candidates);
  const byKey = new Map(estimates.map((e) => [e.issueKey, e]));
  // Keep every candidate (candidate order = most-recently-done first); default
  // anything the AI dropped to 1h so nothing is silently skipped.
  const full = body.candidates.map(
    (c) => byKey.get(c.issueKey) ?? { issueKey: c.issueKey, hours: 1, comment: c.summary },
  );

  const since = new Date(`${body.startDate}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 90);
  const loggedByDay = await getLoggedSecondsByDay(body.accountId, since.toISOString().slice(0, 10));

  const plan = packBackfill(full, {
    startDate: body.startDate,
    workdaySeconds: WORKDAY_SECONDS,
    skipWeekends: body.skipWeekends ?? true,
    loggedByDay,
  });
  return c.json({ plan });
});

export default ai;
