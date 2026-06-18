import sql from "./client";

// Ported from the previous Jari backend. Three tables drive every feature:
// workspaces, issues (Story + Sub-task), worklogs.
export async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id             VARCHAR(50)  PRIMARY KEY,
      name           VARCHAR(200) NOT NULL,
      base_url       VARCHAR(500) NOT NULL,
      last_synced_at TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS issues (
      id                    VARCHAR(50)  NOT NULL,
      key                   VARCHAR(50)  NOT NULL,
      workspace_id          VARCHAR(50)  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      summary               TEXT         NOT NULL,
      status_name           VARCHAR(100) NOT NULL,
      status_category       VARCHAR(20)  NOT NULL,
      assignee_account_id   VARCHAR(100),
      assignee_display_name VARCHAR(200),
      assignee_email        VARCHAR(200),
      priority_name         VARCHAR(50),
      project_key           VARCHAR(50)  NOT NULL,
      project_name          VARCHAR(200) NOT NULL,
      issue_type_name       VARCHAR(100),
      is_subtask            BOOLEAN      DEFAULT FALSE,
      parent_id             VARCHAR(50),
      parent_key            VARCHAR(50),
      labels                TEXT[],
      due_date              DATE,
      jira_created_at       TIMESTAMPTZ  NOT NULL,
      jira_updated_at       TIMESTAMPTZ  NOT NULL,
      synced_at             TIMESTAMPTZ  DEFAULT NOW(),
      PRIMARY KEY (id, workspace_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_issues_workspace ON issues(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_issues_project   ON issues(project_key, workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_issues_status    ON issues(status_category)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_issues_assignee  ON issues(assignee_account_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_issues_due       ON issues(due_date)`;

  await sql`
    CREATE TABLE IF NOT EXISTS worklogs (
      id                   VARCHAR(50)  NOT NULL,
      workspace_id         VARCHAR(50)  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      issue_id             VARCHAR(50)  NOT NULL,
      issue_key            VARCHAR(50)  NOT NULL,
      issue_summary        TEXT,
      project_key          VARCHAR(50),
      project_name         VARCHAR(200),
      author_account_id    VARCHAR(100) NOT NULL,
      author_display_name  VARCHAR(200) NOT NULL,
      author_email         VARCHAR(200),
      comment_text         TEXT,
      started_at           TIMESTAMPTZ  NOT NULL,
      time_spent_seconds   INT          NOT NULL,
      synced_at            TIMESTAMPTZ  DEFAULT NOW(),
      PRIMARY KEY (id, workspace_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_worklogs_workspace ON worklogs(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_worklogs_started   ON worklogs(started_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_worklogs_author    ON worklogs(author_account_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_worklogs_issue     ON worklogs(issue_id)`;

  // App login accounts (local auth). Each maps a username/password to a Jira
  // account id so "my work / my worklog" knows who you are. Dev seeds rows via
  // src/scripts/seedUser.ts.
  await sql`
    CREATE TABLE IF NOT EXISTS app_users (
      id              SERIAL       PRIMARY KEY,
      username        VARCHAR(100) UNIQUE NOT NULL,
      password_hash   TEXT         NOT NULL,
      jira_account_id VARCHAR(100) NOT NULL,
      display_name    VARCHAR(200) NOT NULL,
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    )
  `;

  console.log("Schema ready");
}
