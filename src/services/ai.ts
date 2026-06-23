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

  const ws = getWorkspace();
  const subtaskKeys = input.candidates.map((c) => c.issueKey);
  const subtaskDetails = await fetchIssueDetails(ws, subtaskKeys);

  const parentKeys = [
    ...new Set(
      [...subtaskDetails.values()]
        .map((d) => d.parentKey)
        .filter((k): k is string => Boolean(k)),
    ),
  ];
  const parentDetails = await fetchIssueDetails(ws, parentKeys);

  const context = input.candidates
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
