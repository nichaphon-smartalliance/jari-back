// Dev utility: create/update a login account mapped to a Jira account id.
//
//   bun run src/scripts/seedUser.ts <username> <password> <jiraAccountId> "<Display Name>"
//
// Tip: find Jira account ids with `curl http://localhost:4000/users` (after a sync).

import { initSchema } from "../db/schema";
import { upsertUser } from "../services/auth";

const [username, password, jiraAccountId, ...nameParts] = process.argv.slice(2);
const displayName = nameParts.join(" ");

if (!username || !password || !jiraAccountId || !displayName) {
  console.error(
    'Usage: bun run src/scripts/seedUser.ts <username> <password> <jiraAccountId> "<Display Name>"',
  );
  process.exit(1);
}

await initSchema();
await upsertUser({ username, password, jiraAccountId, displayName });
console.log(`✓ user "${username}" -> ${displayName} (${jiraAccountId})`);
process.exit(0);
