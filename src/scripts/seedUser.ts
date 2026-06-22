// Dev utility: create/update a login account (username + password only).
//
//   bun run src/scripts/seedUser.ts <username> <password> ["Display Name"]
//
// The user then links their own Jira account (email + API token) from the
// Settings page in the app — that is what sets their Jira accountId and makes
// worklogs post as them. Re-running only resets the password.

import { initSchema } from "../db/schema";
import { upsertUser } from "../services/auth";

const [username, password, ...nameParts] = process.argv.slice(2);
const displayName = nameParts.join(" ") || undefined;

if (!username || !password) {
  console.error('Usage: bun run src/scripts/seedUser.ts <username> <password> ["Display Name"]');
  process.exit(1);
}

await initSchema();
await upsertUser({ username, password, displayName });
console.log(`✓ user "${username}" seeded — link Jira account from the Settings page`);
process.exit(0);
