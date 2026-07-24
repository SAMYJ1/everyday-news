export type RunStatus = "queued" | "running" | "partial" | "completed" | "failed";

export type CandidateStatus =
  | "selected"
  | "comments_ready"
  | "summarizing"
  | "summarized"
  | "failed";

export type SummaryStatus = "draft" | "approved" | "rejected" | "failed" | "source_deleted";

export interface FetchRun {
  id: string;
  localDate: string;
  status: RunStatus;
  discoveredCount: number;
  selectedCount: number;
  summarizedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SourceItem {
  id: string;
  source: string;
  externalId: string;
  title: string | null;
  author: string | null;
  redditUrl: string;
  sourceUrl: string | null;
  score: number;
  upvoteRatio: number | null;
  commentCount: number;
  publishedAt: string;
  fetchedAt: string;
  lastCheckedAt: string;
  deletedAt: string | null;
  stickied?: boolean;
  over18?: boolean;
  deleted?: boolean;
}

export interface SourceComment {
  id: string;
  itemId: string;
  externalId: string;
  parentExternalId: string | null;
  author: string | null;
  body: string;
  score: number;
  depth: number;
  redditUrl: string;
  publishedAt?: string | null;
  fetchedAt: string;
  deletedAt: string | null;
  deleted: boolean;
}

export interface Candidate {
  id: string;
  runId: string;
  itemId: string;
  score: number;
  reasons: string[];
  rank: number;
  status: CandidateStatus;
  selectedAt: string;
}

export interface KnowledgeCardRecord {
  id: string;
  candidateId: string;
  status: SummaryStatus;
  titleZh: string;
  oneLineFact: string;
  whyInteresting: string;
  commentInsights: string[];
  caveats: string[];
  confidenceNote: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  generatedAt: string;
  reviewedAt?: string | null;
}

export interface KnowledgeCard extends KnowledgeCardRecord {
  titleEn: string | null;
  redditUrl: string;
  sourceUrl: string | null;
}

export interface AnonymousCollection {
  enabled: boolean;
  consecutiveFailures: number;
}
