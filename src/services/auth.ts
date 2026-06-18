import { createHmac, timingSafeEqual } from "node:crypto";
import sql from "../db/client";

const SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me";
const TOKEN_TTL_SEC = 7 * 24 * 3600; // 7 days

export interface AppUser {
  username: string;
  jiraAccountId: string;
  displayName: string;
}

interface AppUserRow {
  username: string;
  password_hash: string;
  jira_account_id: string;
  display_name: string;
}

// ─── Password hashing (Bun's built-in argon2id) ───────────────────────────────

export const hashPassword = (pw: string) => Bun.password.hash(pw);
export const verifyPassword = (pw: string, hash: string) => Bun.password.verify(pw, hash);

// ─── Stateless HMAC token (no external JWT dependency) ────────────────────────

interface TokenPayload {
  username: string;
  accountId: string;
  displayName: string;
  exp: number;
}

const sign = (data: string) => createHmac("sha256", SECRET).update(data).digest("base64url");

export function signToken(user: AppUser): string {
  const body = Buffer.from(
    JSON.stringify({
      username: user.username,
      accountId: user.jiraAccountId,
      displayName: user.displayName,
      exp: Date.now() + TOKEN_TTL_SEC * 1000,
    } satisfies TokenPayload),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  // constant-time compare
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── User store ───────────────────────────────────────────────────────────────

export async function findUser(username: string): Promise<AppUserRow | null> {
  const rows = await sql<AppUserRow[]>`
    SELECT username, password_hash, jira_account_id, display_name
    FROM app_users WHERE username = ${username}
  `;
  return rows[0] ?? null;
}

export async function upsertUser(args: {
  username: string;
  password: string;
  jiraAccountId: string;
  displayName: string;
}): Promise<void> {
  const password_hash = await hashPassword(args.password);
  await sql`
    INSERT INTO app_users (username, password_hash, jira_account_id, display_name)
    VALUES (${args.username}, ${password_hash}, ${args.jiraAccountId}, ${args.displayName})
    ON CONFLICT (username) DO UPDATE SET
      password_hash   = EXCLUDED.password_hash,
      jira_account_id = EXCLUDED.jira_account_id,
      display_name    = EXCLUDED.display_name
  `;
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: AppUser } | null> {
  const row = await findUser(username);
  if (!row) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;

  const user: AppUser = {
    username: row.username,
    jiraAccountId: row.jira_account_id,
    displayName: row.display_name,
  };
  return { token: signToken(user), user };
}
