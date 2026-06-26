import { Hono } from "hono";
import {
  findUser,
  login,
  setUserJiraAccount,
  signToken,
  verifyToken,
  type AppUser,
} from "../services/auth";
import { getWorkspace } from "../services/workspaces";
import { getMyself } from "../services/jira";

const auth = new Hono();

/** Verify the Bearer token on a request → its payload, or null. */
function authUser(c: { req: { header: (n: string) => string | undefined } }) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifyToken(token);
}

auth.post("/auth/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) return c.json({ error: "username and password required" }, 400);

  const result = await login(username, password);
  if (!result) return c.json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);

  return c.json({
    token: result.token,
    user: {
      username: result.user.username,
      accountId: result.user.jiraAccountId,
      displayName: result.user.displayName,
    },
  });
});

// Validate a stored token on app load.
auth.get("/auth/me", (c) => {
  const payload = authUser(c);
  if (!payload) return c.json({ error: "invalid token" }, 401);

  return c.json({
    user: {
      username: payload.username,
      accountId: payload.accountId,
      displayName: payload.displayName,
    },
  });
});

// ─── Per-user Jira account linking (Settings page) ───────────────────────────

// Current link status — drives the Settings form (shows linked email/account).
auth.get("/auth/jira-account", async (c) => {
  const payload = authUser(c);
  if (!payload) return c.json({ error: "invalid token" }, 401);

  const row = await findUser(payload.username);
  if (!row) return c.json({ error: "user not found" }, 404);

  const today = new Date().toISOString().slice(0, 10);
  const tokenExpiresAt = row.jira_token_expires_at;

  return c.json({
    username: row.username,
    displayName: row.display_name,
    jiraEmail: row.jira_email ?? "",
    accountId: row.jira_account_id ?? "",
    hasToken: !!row.jira_api_token_enc,
    tokenExpiresAt,
    tokenExpired: !!tokenExpiresAt && tokenExpiresAt < today,
  });
});

// Link/update the user's own Jira email + API token. The token is validated
// against Jira (GET /myself) so we can store the real accountId and reject bad
// tokens up front. A fresh app token is returned because accountId/displayName
// may have changed.
auth.post("/auth/jira-account", async (c) => {
  const payload = authUser(c);
  if (!payload) return c.json({ error: "invalid token" }, 401);

  const { email, token, expiresAt } = await c.req.json<{
    email?: string;
    token?: string;
    expiresAt?: string;
  }>();
  if (!email || !token) return c.json({ error: "email และ token จำเป็นต้องกรอก" }, 400);
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    return c.json({ error: "วันหมดอายุของ token ไม่ถูกต้อง" }, 400);
  }

  // Validate the credentials against the configured Jira site before storing.
  const base = getWorkspace();
  let me: { accountId: string; displayName: string; emailAddress?: string };
  try {
    me = await getMyself({ ...base, email: email.trim(), token: token.trim() });
  } catch {
    return c.json(
      { error: "เชื่อมต่อ Jira ไม่สำเร็จ — ตรวจสอบ email และ API token อีกครั้ง" },
      400,
    );
  }

  await setUserJiraAccount({
    username: payload.username,
    email: email.trim(),
    token: token.trim(),
    accountId: me.accountId,
    displayName: me.displayName,
    expiresAt: expiresAt ?? null,
  });

  const user: AppUser = {
    username: payload.username,
    jiraAccountId: me.accountId,
    displayName: me.displayName,
  };
  return c.json({
    token: signToken(user),
    user: {
      username: user.username,
      accountId: user.jiraAccountId,
      displayName: user.displayName,
    },
    jiraEmail: email.trim(),
  });
});

export default auth;
