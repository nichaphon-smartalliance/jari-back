// Domain types. These match jari-front/src/types/app/jira exactly so the
// frontend can swap its mock services for fetch() against this API with no
// shape changes.

export type StatusCategory = "todo" | "inprogress" | "done";
export type Priority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

export interface JiraUser {
  accountId: string;
  displayName: string;
  email: string;
}

export interface Issue {
  id: string;
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  issueType: string; // "Story" | "Sub-task" | "Task" | ...
  isSubtask: boolean;
  parentKey?: string;
  assignee?: JiraUser;
  priority?: Priority;
  projectKey: string;
  projectName: string;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  hasWorklog: boolean;
}

export interface Worklog {
  id: string;
  issueKey: string;
  issueSummary: string;
  author: JiraUser;
  comment: string;
  startedAt: string;
  timeSpentSeconds: number;
}

export interface DashboardData {
  kpis: {
    totalIssues: number;
    completed: number;
    inProgress: number;
    blockedOrOverdue: number;
    completionRate: number;
    onTimeRate: number;
  };
  trend: { month: string; created: number; completed: number }[];
  workload: {
    accountId: string;
    displayName: string;
    todo: number;
    inProgress: number;
    done: number;
    loggedHoursToday: number;
  }[];
  projects: {
    projectKey: string;
    projectName: string;
    total: number;
    done: number;
    overdue: number;
    healthScore: number;
  }[];
  sprint: { name: string; committed: number; completed: number; carryover: number };
}

export interface DailyData {
  date: string;
  targetHours: number;
  people: {
    accountId: string;
    displayName: string;
    totalSeconds: number;
    targetSeconds: number;
    status: "under" | "ok" | "over";
    entries: { issueKey: string; issueSummary: string; hours: number }[];
  }[];
}

/** Jira's statusCategory key -> our simplified category. */
export function mapStatusCategory(key: string): StatusCategory {
  if (key === "done") return "done";
  if (key === "indeterminate") return "inprogress";
  return "todo"; // "new" and anything else
}
