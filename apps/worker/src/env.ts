export interface Env {
  DB: D1Database;
  PIPELINE: Queue<PipelineMessage>;
  AI: Ai;
  ADMIN_KEY: string;
  APP_ORIGIN: string;
  REDDIT_USER_AGENT: string;
}

export type PipelineMessage =
  | { stage: "discover"; runId: string }
  | { stage: "comments"; runId: string; itemId: string }
  | { stage: "summarize"; runId: string; itemId: string; regeneration?: { id: string; nonce: string } };
