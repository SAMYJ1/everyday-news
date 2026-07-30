export type CardStatus = "draft" | "approved" | "rejected";
export type RunStatus = "queued" | "running" | "partial" | "completed" | "failed";

export interface FetchRun {
  id: string;
  localDate: string;
  status: RunStatus;
  discoveredCount: number;
  selectedCount: number;
  summarizedCount: number;
  failedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface KnowledgeCard {
  id: string;
  candidateId: string;
  status: CardStatus;
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
  reviewedAt: string | null;
  titleEn: string | null;
  redditUrl: string;
  sourceUrl: string | null;
  candidateScore: number;
  selectionReasons: string[];
  commentLinks: string[];
  warnings: Array<{ code: string; message: string }>;
  runLocalDate: string;
}

export interface AnonymousCollection {
  enabled: boolean;
  consecutiveFailures: number;
}

export interface PublicKnowledgeCard {
  id: string;
  status: "draft" | "approved";
  titleZh: string;
  oneLineFact: string;
  whyInteresting: string;
  commentInsights: string[];
  caveats: string[];
  confidenceNote: string;
  generatedAt: string;
  titleEn: string | null;
  redditUrl: string;
  sourceUrl: string | null;
  runLocalDate: string;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body: T | ErrorEnvelope = await response.json();
  if (!response.ok) {
    const error = body as ErrorEnvelope;
    throw new ApiError(
      response.status,
      error.error?.code ?? "request_failed",
      error.error?.message ?? "Request failed",
    );
  }
  return body as T;
}

export function createApiClient(baseUrl: string, getAdminKey: () => string) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(apiUrl(baseUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${getAdminKey()}`,
        ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    return parseResponse<T>(response);
  }

  return {
    getLatestRun: async (init?: RequestInit) => (await request<{ run: FetchRun | null }>("/api/runs/latest", init)).run,
    listRuns: async (date?: string, init?: RequestInit) => {
      const dateQuery = date === undefined ? "" : `?date=${encodeURIComponent(date)}`;
      return (await request<{ runs: FetchRun[] }>(`/api/runs${dateQuery}`, init)).runs;
    },
    listCards: async (status: CardStatus, dateOrInit?: string | RequestInit, requestInit?: RequestInit) => {
      const date = typeof dateOrInit === "string" ? dateOrInit : undefined;
      const init = typeof dateOrInit === "string" ? requestInit : dateOrInit;
      const dateQuery = date === undefined ? "" : `&date=${encodeURIComponent(date)}`;
      return (await request<{ cards: KnowledgeCard[] }>(
        `/api/cards?status=${encodeURIComponent(status)}${dateQuery}`,
        init,
      )).cards;
    },
    getCard: async (id: string, init?: RequestInit) => (await request<{ card: KnowledgeCard }>(`/api/cards/${encodeURIComponent(id)}`, init)).card,
    approve: async (id: string) => (await request<{ card: KnowledgeCard }>(`/api/cards/${encodeURIComponent(id)}/approve`, { method: "POST" })).card,
    reject: async (id: string) => (await request<{ card: KnowledgeCard }>(`/api/cards/${encodeURIComponent(id)}/reject`, { method: "POST" })).card,
    regenerate: async (id: string) => (await request<{ card: KnowledgeCard }>(`/api/cards/${encodeURIComponent(id)}/regenerate`, { method: "POST" })).card,
    startRun: async () => (await request<{ run: { id: string } }>("/api/runs", { method: "POST" })).run,
    setAnonymousCollection: async (enabled: boolean) => (
      await request<{ anonymousCollection: AnonymousCollection }>("/api/settings/anonymous-collection", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      })
    ).anonymousCollection,
  };
}

export function createPublicApiClient(baseUrl: string) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(apiUrl(baseUrl, path), { ...init });
    return parseResponse<T>(response);
  }

  return {
    listDates: async (init?: RequestInit) => (
      await request<{ dates: string[] }>("/api/public/dates", init)
    ).dates,
    listCards: async (date: string, init?: RequestInit) => (
      await request<{ date: string | null; cards: PublicKnowledgeCard[] }>(
        `/api/public/cards?date=${encodeURIComponent(date)}`,
        init,
      )
    ),
  };
}
