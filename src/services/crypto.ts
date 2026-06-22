import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Symmetric encryption for secrets we must store and later reuse (each user's
// Jira API token). AES-256-GCM with a per-value random IV; the 32-byte key is
// derived from TOKEN_ENC_KEY (falling back to AUTH_SECRET). Set a strong, stable
// TOKEN_ENC_KEY in .env — rotating it makes existing stored tokens undecryptable.
const SECRET =
  process.env.TOKEN_ENC_KEY ?? process.env.AUTH_SECRET ?? "dev-secret-change-me";
const KEY = createHash("sha256").update(SECRET).digest(); // 32 bytes

/** Encrypt a plaintext secret → "iv:tag:ciphertext" (all base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** Decrypt a value produced by encryptSecret. Throws if tampered or wrong key. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
