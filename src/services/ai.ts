// AI Center (Develyst AI) client — see ../../docs/03-ai-center.md
// One gateway, provider-agnostic. We omit `provider` to use the fallback chain
// (deepseek -> xai -> gemini -> openai) unless a specific model is needed.

import { getWorkspace } from "./workspaces";
import { fetchIssueDetails } from "./jira";

const AI_BASE_URL = process.env.AI_API_BASE_URL ?? "http://localhost:3009";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

interface AIResponse {
  success: boolean;
  data?: { provider: string; model: string; content: string; latency_ms: number };
  error?: string;
}

async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const res = await fetch(`${AI_BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...opts }),
  });
  const body = (await res.json()) as AIResponse;
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error ?? `AI Center ${res.status}`);
  }
  return body.data.content.trim();
}

// ─── Feature helpers ──────────────────────────────────────────────────────────

/** #6 — clean up a roughly-typed Jira title/description. */
export async function rewriteText(raw: string, kind: "title" | "description"): Promise<string> {
  const guide =
    kind === "title"
      ? "ปรับหัวข้องาน (Jira Story title) ให้กระชับ ชัดเจน เป็นมืออาชีพ ตอบกลับเฉพาะหัวข้อที่ปรับแล้วบรรทัดเดียว ไม่ต้องมีคำอธิบายเพิ่ม"
      : "ขยายและจัดรูปแบบรายละเอียดงาน (Jira Story description) ให้ชัดเจน มีวัตถุประสงค์ ขอบเขตงาน และเกณฑ์การยอมรับ ตอบกลับเป็นข้อความที่ใช้ได้ทันที";
  return chat(
    [
      { role: "system", content: `คุณคือผู้ช่วยเขียนงานในภาษาเดียวกับผู้ใช้. ${guide}` },
      { role: "user", content: raw },
    ],
    { temperature: 0.6 },
  );
}

export interface StoryDraft {
  title: string;
  description: string;
  subtasks: string[];
}

/** #2 — turn a free-form brief ("เล่าเรื่องงานที่อยากสร้าง...") into a ready-to-create
 *  Story: a clean title, a structured description, and actionable sub-tasks — all in
 *  one call so the user types once and reviews. Replies in the user's own language. */
export async function draftStory(brief: string): Promise<StoryDraft> {
  const content = await chat(
    [
      {
        role: "system",
        content:
          "คุณคือผู้ช่วยวางแผนงานใน Jira ผู้ใช้จะเล่างานที่อยากสร้างแบบคร่าว ๆ ด้วยภาษาธรรมชาติ " +
          "ให้คุณแปลงเป็น Story ที่พร้อมสร้างทันที ประกอบด้วย " +
          "(1) หัวข้อที่กระชับ ชัดเจน เป็นมืออาชีพ บรรทัดเดียว, " +
          "(2) รายละเอียดที่จัดรูปแบบดี มีวัตถุประสงค์ ขอบเขตงาน และเกณฑ์การยอมรับ (acceptance criteria), " +
          "(3) รายการ sub-task ที่แบ่งงานเป็นขั้นตอนปฏิบัติได้จริง 3-6 ข้อ เรียงตามลำดับการทำงาน " +
          "ตอบกลับเป็น JSON object เท่านั้น ไม่มีข้อความอื่นหรือ markdown fence " +
          'รูปแบบ {"title":"...","description":"...","subtasks":["...","..."]} ' +
          "ใช้ภาษาเดียวกับที่ผู้ใช้เล่ามา",
      },
      { role: "user", content: brief },
    ],
    { temperature: 0.5, max_tokens: 2000 },
  );

  const obj = parseJsonObject(content);
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const subtasks = Array.isArray(obj.subtasks)
    ? obj.subtasks.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  if (!title) {
    console.error("[ai.draftStory] unusable content:", content);
    throw new Error("AI ไม่สามารถร่างงานได้ ลองเล่ารายละเอียดเพิ่มแล้วลองใหม่");
  }
  return { title, description, subtasks };
}

/** #2 — suggest sub-task titles. Returns a parsed JSON array (best-effort). */
export async function suggestSubtasks(title: string, description: string): Promise<string[]> {
  const content = await chat(
    [
      {
        role: "system",
        content:
          "เสนอรายการ sub-task สำหรับ Story ที่ให้มา ตอบกลับเป็น JSON array ของสตริงเท่านั้น ไม่ต้องมีข้อความอื่น เช่น [\"...\",\"...\"]",
      },
      { role: "user", content: `หัวข้อ: ${title}\nรายละเอียด: ${description}` },
    ],
    { temperature: 0.4 },
  );
  return parseJsonArray(content);
}

export interface PlanInput {
  candidates: { issueKey: string; summary: string }[];
  remainingSeconds: number;
}

export interface PlanItem {
  issueKey: string;
  timeSpentSeconds: number;
  comment: string;
}

/** #6 — split remaining hours across Done sub-tasks to hit the target, writing a
 *  worklog comment per sub-task grounded in the real Story + sub-task descriptions
 *  (not just titles) so the text actually reflects what was done. */
export async function planWorklogs(input: PlanInput): Promise<PlanItem[]> {
  console.log("[ai.planWorklogs] input:", input);
  if (input.candidates.length === 0 || input.remainingSeconds <= 0) return [];
  const hoursLeft = Math.round((input.remainingSeconds / 3600) * 10) / 10;

  const context = await buildCandidateContext(input.candidates);

  const content = await chat(
    [
      {
        role: "system",
        content:
          "คุณช่วยกระจายชั่วโมงทำงานลง worklog ของ sub-task ที่เสร็จแล้ว ให้รวมได้พอดีกับชั่วโมงที่เหลือ " +
          "และเขียนคอมเมนต์ worklog ของแต่ละ sub-task โดยอ้างอิงจากรายละเอียดของ Story และ sub-task ที่ให้มาจริง " +
          "ไม่ใช่แค่คัดลอกหัวข้อ ตอบกลับเป็น JSON array เท่านั้น ไม่ต้องมีข้อความอื่นหรือ markdown fence " +
          'รูปแบบ [{"issueKey":"...","hours":1.5,"comment":"..."}] ผลรวม hours ต้องเท่ากับชั่วโมงที่เหลือ',
      },
      {
        role: "user",
        content: `ชั่วโมงที่เหลือ: ${hoursLeft}\nรายการ sub-task:\n${context}`,
      },
    ],
    { temperature: 0.3 ,max_tokens: 9000},
  );

  const parsed = parseJsonObjects(content);
  const plan = parsed
    .filter((p) => typeof p.issueKey === "string" && typeof p.hours === "number")
    .map((p) => ({
      issueKey: String(p.issueKey),
      timeSpentSeconds: Math.round(Number(p.hours) * 3600),
      comment: typeof p.comment === "string" ? p.comment : "",
    }));
  console.log("[ai.planWorklogs] plan:", plan);
  if (plan.length === 0) {
    console.error("[ai.planWorklogs] AI Center returned unusable content:", content);
    throw new Error("AI ไม่สามารถสร้างแผนลงเวลาได้ ลองอีกครั้ง");
  }
  return plan;
}

/** Build the grounded context (real Story + sub-task summaries/descriptions)
 *  shared by the worklog planners. */
async function buildCandidateContext(
  candidates: { issueKey: string; summary: string }[],
): Promise<string> {
  const ws = getWorkspace();
  const subtaskDetails = await fetchIssueDetails(ws, candidates.map((c) => c.issueKey));
  const parentKeys = [
    ...new Set(
      [...subtaskDetails.values()].map((d) => d.parentKey).filter((k): k is string => Boolean(k)),
    ),
  ];
  const parentDetails = await fetchIssueDetails(ws, parentKeys);

  return candidates
    .map((c) => {
      const sub = subtaskDetails.get(c.issueKey);
      const parent = sub?.parentKey ? parentDetails.get(sub.parentKey) : undefined;
      const lines = [`- ${c.issueKey}: ${sub?.summary ?? c.summary}`];
      if (sub?.description) lines.push(`  รายละเอียด sub-task: ${sub.description}`);
      if (parent?.summary) lines.push(`  Story: ${parent.summary}`);
      if (parent?.description) lines.push(`  รายละเอียด Story: ${parent.description}`);
      return lines.join("\n");
    })
    .join("\n");
}

// ─── Multi-day backfill (#6+) ────────────────────────────────────────────────

export interface BackfillItem {
  issueKey: string;
  date: string; // YYYY-MM-DD
  timeSpentSeconds: number;
  comment: string;
}

/** AI estimates a realistic per-sub-task duration (0.5–8h) + a grounded comment,
 *  NOT forced to a daily total — the packer then spreads them across days. */
export async function estimateWorklogHours(
  candidates: { issueKey: string; summary: string }[],
): Promise<{ issueKey: string; hours: number; comment: string }[]> {
  if (candidates.length === 0) return [];
  const context = await buildCandidateContext(candidates);

  const content = await chat(
    [
      {
        role: "system",
        content:
          "คุณช่วยประเมินชั่วโมงทำงานที่สมเหตุสมผลของแต่ละ sub-task ที่เสร็จแล้ว ระหว่าง 0.5 ถึง 8 ชม.ต่อชิ้น " +
          "ตามความซับซ้อนจากรายละเอียดที่ให้มา และเขียนคอมเมนต์ worklog ของแต่ละชิ้นโดยอ้างอิงรายละเอียด Story และ sub-task จริง " +
          "ตอบกลับเป็น JSON array เท่านั้น ไม่มีข้อความอื่นหรือ markdown fence " +
          'รูปแบบ [{"issueKey":"...","hours":1.5,"comment":"..."}]',
      },
      { role: "user", content: `รายการ sub-task:\n${context}` },
    ],
    { temperature: 0.3, max_tokens: 9000 },
  );

  const parsed = parseJsonObjects(content);
  const out = parsed
    .filter((p) => typeof p.issueKey === "string" && typeof p.hours === "number")
    .map((p) => ({
      issueKey: String(p.issueKey),
      hours: Number(p.hours),
      comment: typeof p.comment === "string" ? p.comment : "",
    }));
  if (out.length === 0) {
    console.error("[ai.estimateWorklogHours] unusable content:", content);
    throw new Error("AI ไม่สามารถประเมินเวลาได้ ลองอีกครั้ง");
  }
  return out;
}

/** Pack estimated sub-tasks into past workdays, going backward from startDate,
 *  filling each day up to `workdaySeconds` (minus what's already logged that
 *  day), optionally skipping weekends. Whole sub-tasks only (no splitting). */
export function packBackfill(
  estimates: { issueKey: string; hours: number; comment: string }[],
  opts: {
    startDate: string;
    workdaySeconds: number;
    skipWeekends: boolean;
    loggedByDay: Record<string, number>;
  },
): BackfillItem[] {
  const { startDate, workdaySeconds, skipWeekends, loggedByDay } = opts;
  const items: BackfillItem[] = [];

  const dayStr = (d: Date) => d.toISOString().slice(0, 10);
  const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const backToWorkday = (d: Date) => {
    while (skipWeekends && isWeekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  };

  const cur = new Date(`${startDate}T12:00:00Z`);
  backToWorkday(cur);
  let used = loggedByDay[dayStr(cur)] ?? 0;

  const prevWorkday = () => {
    cur.setUTCDate(cur.getUTCDate() - 1);
    backToWorkday(cur);
    used = loggedByDay[dayStr(cur)] ?? 0;
  };

  for (const est of estimates) {
    let secs = Math.max(0, Math.round((est.hours || 0) * 3600));
    if (secs === 0) continue;
    secs = Math.min(secs, workdaySeconds); // a single item never exceeds one day
    if (used > 0 && used + secs > workdaySeconds) prevWorkday();
    items.push({ issueKey: est.issueKey, date: dayStr(cur), timeSpentSeconds: secs, comment: est.comment });
    used += secs;
    if (used >= workdaySeconds) prevWorkday();
  }
  return items;
}

// ─── JSON extraction helpers (LLMs sometimes wrap output in prose/fences) ─────

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

function parseJsonArray(text: string): string[] {
  try {
    const arr = JSON.parse(extractJson(text));
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(extractJson(text));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch (err) {
    console.error("[ai.parseJsonObject] failed to parse AI response:", text, err);
    return {};
  }
}

function parseJsonObjects(text: string): Record<string, unknown>[] {
  try {
    console.log("[ai.parseJsonObjects] parsing AI response:", text);
    const arr = JSON.parse(extractJson(text));
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error("[ai.parseJsonObjects] failed to parse AI response:", text, err);
    return [];
  }
}
