import { Hono } from "hono";
import { login, verifyToken } from "../services/auth";

const auth = new Hono();

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
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) return c.json({ error: "invalid token" }, 401);

  return c.json({
    user: {
      username: payload.username,
      accountId: payload.accountId,
      displayName: payload.displayName,
    },
  });
});

export default auth;
